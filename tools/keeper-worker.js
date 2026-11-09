"use strict";
const {createMarketContext}=require("./market-context");
const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
} = require("@solana/web3.js");
const {
  decodeAccount,
  decodeResults,
} = require("../mgk-frontend/packages/layout");
const {
  encodeInstruction,
} = require("../mgk-frontend/packages/layout/instructions");
const { loadManifest } = require("../mgk-frontend/packages/layout/manifest");
const {
  confirmSignature,
} = require("../mgk-frontend/packages/layout/confirmation");
const {
  CONFIRM_OPTIONS,
  createBlockhashCache,
  lamportsOf,
  readAccounts,
} = require("./rpc-budget");
const INTERVAL_MS = 2000;
// While a batch collects, sleep until its deadline instead of polling.
const SLOT_MS = 400;
const MAX_WAIT_MS = 30_000;
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const meta = (pubkey, isWritable = true, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
async function createKeeperWorker({
  manifest: rawManifest,
  payer,
  connection,
  now = Date.now,
  alert = (value) => console.error(JSON.stringify(value)),
  feeFloorLamports = 10000000n,
  resendIntervalMs = 2000,
  confirmPollMs = CONFIRM_OPTIONS.pollIntervalMs,
}) {
  if (typeof feeFloorLamports !== "bigint" || feeFloorLamports < 0n)
    throw Error("Invalid fee floor");
  const manifest = loadManifest(rawManifest);
  if (!manifest.ready || !payer?.publicKey)
    throw Error("Ready manifest and explicit keeper payer required");
  if (!["localnet", "devnet"].includes(manifest.cluster))
    throw Error("Keeper supports devnet/localnet only");
  if (
    manifest.cluster === "devnet" &&
    (await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw Error("RPC cluster differs from manifest");
  const core = new PublicKey(manifest.programs.perps_core),
    matcher = new PublicKey(manifest.programs.perps_matcher);
  const context=createMarketContext(core,manifest.marketSeed);
  const pda = (seeds, owner = core) => context.pda(seeds,owner);
  const registry = new PublicKey(manifest.accounts.registry),
    instrument = new PublicKey(manifest.accounts.instrument),
    vault = new PublicKey(manifest.accounts.insurance),
    oracle = new PublicKey(manifest.accounts.oracle);
  for (const [actual, seed] of [
    [registry, "registry"],
    [vault, "vault"],
  ])
    if (!actual.equals(pda([Buffer.from(seed)])[0]))
      throw Error("Noncanonical manifest PDA");
  function decodeOwned(a, name, owner = core) {
    if (!a || !a.owner.equals(owner))
      throw Error("Missing or foreign owned account");
    return name === "Results"
      ? decodeResults(a.data)
      : decodeAccount(name, a.data);
  }
  async function account(key, name, owner = core) {
    return decodeOwned(await connection.getAccountInfo(key, "confirmed"), name, owner);
  }
  async function bindings() {
    const i = await account(instrument, "Instrument");
    const id = Buffer.alloc(2);
    id.writeUInt16LE(i.instrumentId);
    if (
      !instrument.equals(pda([Buffer.from("instrument"), id])[0]) ||
      !oracle.equals(new PublicKey(i.oracleAddr))
    )
      throw Error("Instrument binding mismatch");
    return id;
  }
  // The instrument binding is fixed at deployment; validate it once at startup.
  const id = await bindings(),
    book = pda([Buffer.from("book"), id], matcher)[0];
  const blockhashes = createBlockhashCache(connection, now);
  async function send(name, params, keys) {
    const latest = await blockhashes.get();
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
      new TransactionInstruction({
        programId: core,
        keys,
        data: Buffer.from(encodeInstruction("core", name, params, manifest.marketSeed)),
      }),
    );
    tx.sign(payer);
    const raw = tx.serialize();
    try {
      // Preflight simulates before broadcast, so a rejected crank is never sent.
      const signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      });
      await confirmSignature(connection, signature, {
        ...CONFIRM_OPTIONS,
        pollIntervalMs: confirmPollMs,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        resend: () =>
          connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
        resendIntervalMs,
      });
      return signature;
    } catch (error) {
      blockhashes.invalidate();
      throw error;
    }
  }
  // The registry counter the next tick expects, so one batched read also
  // fetches the current batch. A wrong guess costs one extra read.
  let expectedCounter = null;
  let halted = false,
    retryKey = "",
    attempts = 0,
    retryAt = 0;
  async function tick() {
    if (halted) return { status: "halted" };
    const guess =
      expectedCounter > 0n
        ? pda([Buffer.from("batch"), u64(expectedCounter - 1n)])[0]
        : null;
    const snapshot = await readAccounts(
      connection,
      guess ? [registry, payer.publicKey, guess] : [registry, payer.publicKey],
    );
    const counter = decodeOwned(snapshot.accounts[0], "Registry").batchIdCounter;
    if (counter === 0n) throw Error("No current batch");
    const batchId = counter - 1n,
      batch = pda([Buffer.from("batch"), u64(batchId)])[0];
    const raw = guess?.equals(batch)
      ? snapshot.accounts[2]
      : await connection.getAccountInfo(batch, "confirmed");
    expectedCounter = counter;
    if (!raw) {
      const reread = (await account(registry, "Registry")).batchIdCounter;
      if (reread > counter) return { status: "advanced", batchId };
      if (reread !== counter) throw Error("Inconsistent registry counter");
      halted = true;
      alert({
        service: "keeper",
        severity: "critical",
        code: "missing_batch",
        batchAddress: batch.toBase58(),
        action:
          "Halted; verify deployment and current batch before restarting keeper",
        batchId: String(batchId),
      });
      return { status: "halted", batchId };
    }
    if (!raw.owner.equals(core)) throw Error("Foreign batch owner");
    const state = decodeAccount("Batch", raw.data);
    if (state.batchId !== batchId) throw Error("Batch identity mismatch");
    const balance = lamportsOf(snapshot.accounts[1]);
    if (BigInt(balance) < feeFloorLamports) {
      alert({
        service: "keeper",
        severity: "critical",
        code: "low_fee_sol",
        feePayer: payer.publicKey.toBase58(),
        action: "Top up keeper SOL; this batch will resume automatically",
        batchId: String(batchId),
        balanceLamports: String(balance),
        feeFloorLamports: String(feeFloorLamports),
      });
      return { status: "low_fee_sol", batchId };
    }
    const key = `${batchId}:${state.status}`;
    if (key !== retryKey) {
      retryKey = key;
      attempts = 0;
      retryAt = 0;
    }
    if (now() < retryAt) return { status: "backoff", batchId, retryAt };
    try {
      const results = pda([Buffer.from("results"), u64(batchId)], matcher)[0];
      if (state.status === 0 && BigInt(snapshot.slot) < state.commitDeadlineSlot) {
        const slotsLeft = state.commitDeadlineSlot - BigInt(snapshot.slot);
        const waitMs = Math.min(MAX_WAIT_MS, Number(slotsLeft) * SLOT_MS);
        return { status: "collecting", batchId, waitMs };
      }
      let signature, status;
      if (state.status === 0) {
        signature = await send("CloseCommitting", {}, [
          meta(batch),
          meta(registry),
        ]);
        status = "closed";
      } else if (state.status === 2) {
        signature = await send(
          "ClearBatch",
          { numCommitments: 0, numInstruments: 1, numPortfolios: 0 },
          [
            meta(batch),
            meta(book),
            meta(results),
            meta(matcher, false),
            meta(registry),
            meta(instrument, false),
            meta(payer.publicKey, true, true),
            meta(SystemProgram.programId, false),
          ],
        );
        status = "cleared";
      } else if (state.status === 4) {
        const fills = await account(results, "Results", matcher);
        if (fills.batchId !== batchId || fills.spent)
          throw Error("Invalid current results");
        const users = [
          ...new Set(fills.fills.map((f) => new PublicKey(f.user).toBase58())),
        ];
        const portfolios = users.map(
          (user) =>
            pda([Buffer.from("portfolio"), new PublicKey(user).toBuffer()])[0],
        );
        const [next, bump] = pda([Buffer.from("batch"), u64(batchId + 1n)]);
        signature = await send(
          "SettleBatch",
          {
            numCommitments: 0,
            numPortfolios: portfolios.length,
            nextBatchBump: bump,
          },
          [
            meta(batch),
            meta(registry),
            meta(vault),
            meta(results),
            meta(instrument),
            meta(book),
            meta(oracle, false),
            meta(matcher, false),
            ...portfolios.map((p) => meta(p)),
            meta(next),
            meta(payer.publicKey, true, true),
            meta(SystemProgram.programId, false),
          ],
        );
        status = "settled";
        expectedCounter = counter + 1n;
      } else if (state.status === 3) status = "settled";
      else throw Error("Unsupported batch phase");
      attempts = 0;
      retryAt = 0;
      return { status, batchId, signature };
    } catch {
      retryAt = now() + Math.min(30000, 2000 * 2 ** Math.min(attempts++, 4));
      // Reconcile only monotonic chain progress; a failed read retains the retry schedule.
      try {
        const fresh = (await account(registry, "Registry")).batchIdCounter;
        if (fresh > counter) return { status: "advanced", batchId };
        if (fresh === counter) {
          const current = await account(batch, "Batch");
          const phases = [0, 2, 4, 3];
          if (
            current.batchId === batchId &&
            phases.indexOf(current.status) > phases.indexOf(state.status) &&
            phases.includes(state.status)
          )
            return { status: "advanced", batchId };
        }
      } catch {}
      alert({
        service: "keeper",
        severity: "error",
        code: state.status === 4 ? "settlement_retry" : "crank_retry",
        action:
          "Check current phase accounts, oracle freshness and RPC; same batch retries with backoff",
        batchId: String(batchId),
        retryAt,
      });
      return { status: "retry", batchId, retryAt };
    }
  }
  return { tick };
}
module.exports = { createKeeperWorker, INTERVAL_MS };
