"use strict";
const {createMarketContext}=require("./market-context");
const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  CONFIRM_OPTIONS,
  createBlockhashCache,
  lamportsOf,
  readAccounts,
} = require("./rpc-budget");
const { decodeAccount, layouts } = require("../mgk-frontend/packages/layout");
const {
  encodeInstruction,
} = require("../mgk-frontend/packages/layout/instructions");
const { loadManifest } = require("../mgk-frontend/packages/layout/manifest");
const {
  confirmSignature,
} = require("../mgk-frontend/packages/layout/confirmation");
const { decodePortfolioHealth } = require("./ops-liquidate");
const INTERVAL_MS = 5000;
// The portfolio scan is a 10-credit getProgramAccounts call; run it at most this often.
const SCAN_INTERVAL_MS = 60_000;
// Resting quotes within this distance of the desired ladder are kept, not replaced.
const REQUOTE_BPS = 5n;
const meta = (pubkey, isWritable = true, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
const abs = (n) => (n < 0n ? -n : n);
const ceil = (n, d) => (n + d - 1n) / d;
const byPrice = (a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0);
/** True when the resting orders match the desired ladder level by level within REQUOTE_BPS. */
function ladderHolds(orders, desired) {
  if (orders.length !== desired.length) return false;
  for (const side of [0, 1]) {
    const have = orders.filter((o) => o.side === side).sort(byPrice),
      want = desired.filter((d) => d.side === side).sort(byPrice);
    if (have.length !== want.length) return false;
    for (let k = 0; k < want.length; k++) {
      const o = have[k],
        d = want[k];
      if (
        o.remainingQty !== d.qty ||
        o.reduceOnly !== 0 ||
        abs(o.price - d.price) * 10000n > d.price * REQUOTE_BPS
      )
        return false;
    }
  }
  return true;
}
async function createMakerWorker({
  manifest: rawManifest,
  payer,
  connection,
  now = Date.now,
  alert = (value) => console.error(JSON.stringify(value)),
  feeFloorLamports = 10000000n,
  quantityLots = 100n,
  scanIntervalMs = SCAN_INTERVAL_MS,
}) {
  const manifest = loadManifest(rawManifest);
  if (
    !manifest.ready ||
    !payer?.publicKey ||
    String(payer.publicKey) !== manifest.accounts.maker
  )
    throw Error("Explicit manifest maker signer required");
  if (!["localnet", "devnet"].includes(manifest.cluster))
    throw Error("Maker supports devnet/localnet only");
  if (
    typeof quantityLots !== "bigint" ||
    quantityLots <= 0n ||
    quantityLots > 1000n ||
    typeof feeFloorLamports !== "bigint" ||
    feeFloorLamports < 0n
  )
    throw Error("Invalid maker limits");
  if (
    manifest.cluster === "devnet" &&
    (await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw Error("RPC cluster differs from manifest");
  const core = new PublicKey(manifest.programs.perps_core),
    matcher = new PublicKey(manifest.programs.perps_matcher),
    oracleProgram = new PublicKey(manifest.programs.oracle);
  const context=createMarketContext(core,manifest.marketSeed);
  const pda = (seeds, owner = core) => context.pda(seeds,owner)[0];
  const registry = new PublicKey(manifest.accounts.registry),
    instrument = new PublicKey(manifest.accounts.instrument),
    vault = new PublicKey(manifest.accounts.insurance),
    oracle = new PublicKey(manifest.accounts.oracle);
  if (
    !registry.equals(pda([Buffer.from("registry")])) ||
    !vault.equals(pda([Buffer.from("vault")]))
  )
    throw Error("Noncanonical manifest PDA");
  const portfolio = pda([Buffer.from("portfolio"), payer.publicKey.toBuffer()]);
  function decodeOwned(raw, name, owner = core) {
    if (!raw || !raw.owner.equals(owner))
      throw Error("Missing or foreign account");
    return { state: decodeAccount(name, raw.data), raw };
  }
  async function account(key, name, owner = core) {
    return decodeOwned(await connection.getAccountInfo(key, "confirmed"), name, owner);
  }
  function bindings(raw) {
    const { state: i } = decodeOwned(raw, "Instrument");
    const id = Buffer.alloc(2);
    id.writeUInt16LE(i.instrumentId);
    if (
      i.instrumentId !== 0 ||
      !instrument.equals(pda([Buffer.from("instrument"), id])) ||
      !oracle.equals(new PublicKey(i.oracleAddr))
    )
      throw Error("Instrument binding mismatch");
    return { i, book: pda([Buffer.from("book"), id], matcher) };
  }
  bindings(await connection.getAccountInfo(instrument, "confirmed"));
  const ix = (name, params, keys) =>
    new TransactionInstruction({
      programId: core,
      keys,
      data: Buffer.from(encodeInstruction("core", name, params, manifest.marketSeed)),
    });
  const blockhashes = createBlockhashCache(connection, now);
  // Preflight already rejects a failing transaction before broadcast. Only a
  // liquidation simulates separately, to tell an unserviceable victim from an
  // RPC failure.
  async function send(instructions, { simulate = false } = {}) {
    const latest = await blockhashes.get();
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
      ...instructions,
    );
    tx.sign(payer);
    const raw = tx.serialize();
    try {
      if (simulate) {
        const simulation = await connection.simulateTransaction(
          VersionedTransaction.deserialize(raw),
          { sigVerify: true, commitment: "confirmed" },
        );
        if (simulation.value.err) {
          const error = Error("Simulation failed");
          error.code = "simulation_failed";
          throw error;
        }
      }
      const signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      });
      await confirmSignature(connection, signature, {
        ...CONFIRM_OPTIONS,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      return signature;
    } catch (error) {
      blockhashes.invalidate();
      throw error;
    }
  }
  const batchKey = (batchId) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(batchId);
    return pda([Buffer.from("batch"), b]);
  };
  // The registry counter the next tick expects, so one batched read also
  // fetches the current batch.
  let expectedCounter = null,
    lastScanAt = -Infinity,
    liquidationBlocked = false;
  let running = false;
  async function tick() {
    if (running) return { status: "busy" };
    running = true;
    try {
      return await step();
    } catch {
      alert({
        service: "maker",
        severity: "error",
        code: "cycle_failed",
        action:
          "Check RPC, account bindings, maker collateral and oracle; retry reconciles chain state",
      });
      return { status: "retry" };
    } finally {
      running = false;
    }
  }
  async function step() {
    const guess = expectedCounter > 0n ? batchKey(expectedCounter - 1n) : null;
    const keys = [instrument, registry, portfolio, payer.publicKey, oracle, vault];
    if (guess) keys.push(guess);
    const {
      accounts: [iRaw, rRaw, portfolioRaw, payerRaw, oracleRaw, vaultRaw, guessRaw],
    } = await readAccounts(connection, keys);
    const { i, book } = bindings(iRaw),
      { state: r } = decodeOwned(rRaw, "Registry");
    if (r.batchIdCounter === 0n) throw Error("No current batch");
    const batchId = r.batchIdCounter - 1n,
      batch = batchKey(batchId),
      { state: batchState } = decodeOwned(
        guess?.equals(batch)
          ? guessRaw
          : await connection.getAccountInfo(batch, "confirmed"),
        "Batch",
      );
    if (batchState.batchId !== batchId) throw Error("Batch identity mismatch");
    expectedCounter = r.batchIdCounter;
    const { state: p, raw: pRaw } = decodeOwned(portfolioRaw, "Portfolio");
    if (
      !new PublicKey(p.user).equals(payer.publicKey) ||
      p.positionsLen > p.positions.length
    )
      throw Error("Invalid maker portfolio");
    const orders = p.orders.filter((o) => o.remainingQty > 0n);
    const cancel = () =>
      ix("CancelAllRestingOrders", { numBooks: 1 }, [
        meta(portfolio),
        meta(payer.publicKey, false, true),
        meta(matcher, false),
        meta(book),
        meta(registry, false),
      ]);
    if (batchState.status === 4)
      return { status: "awaiting_settlement", batchId };
    const balance = lamportsOf(payerRaw);
    if (BigInt(balance) < feeFloorLamports) {
      alert({
        service: "maker",
        severity: "critical",
        code: "low_fee_sol",
        action: "Top up maker fee SOL",
        balanceLamports: String(balance),
      });
      return { status: "low_fee_sol", batchId };
    }
    let price;
    try {
      const { state: o } = decodeOwned(oracleRaw, "PriceOracle", oracleProgram),
        time = BigInt(Math.floor(now() / 1000));
      if (
        !o.isActive ||
        !new PublicKey(o.instrument).equals(instrument) ||
        o.price <= 0n ||
        o.confidence < 0n ||
        o.confidence * 100n > o.price ||
        o.timestamp > time ||
        time - o.timestamp > 60n
      )
        throw Error("Invalid price");
      price = o.price;
    } catch {
      const signature = orders.length ? await send([cancel()]) : undefined;
      alert({
        service: "maker",
        severity: "critical",
        code: "invalid_price",
        action:
          "Restore fresh bound oracle; existing quotes cancelled when unlocked",
      });
      return { status: "invalid_price", batchId, signature };
    }
    const liquidating = !(r.pauseFlags & 4);
    if (liquidating && now() - lastScanAt >= scanIntervalMs) {
      const candidates = await connection.getProgramAccounts(core, {
        commitment: "confirmed",
        filters: [{ dataSize: layouts.Portfolio.size }],
      });
      lastScanAt = now();
      liquidationBlocked = false;
      let unserviceable = false;
      for (const candidate of candidates) {
        if (candidate.pubkey.equals(portfolio)) continue;
        const raw = candidate.account;
        if (!raw.owner.equals(core))
          throw Error("Foreign portfolio scan result");
        const victim = decodeAccount("Portfolio", raw.data),
          canonical = pda([Buffer.from("portfolio"), Buffer.from(victim.user)]);
        if (!canonical.equals(candidate.pubkey))
          continue; // Other market namespaces share this program and account layout.
        if (
          decodePortfolioHealth(raw.data, price).health >= 0n ||
          !victim.positionsLen
        )
          continue;
        const instructions = orders.length ? [cancel()] : [];
        instructions.push(
          ix("LiquidateUser", { numInstruments: 1 }, [
            meta(candidate.pubkey),
            meta(registry),
            meta(vault),
            meta(payer.publicKey, false, true),
            meta(portfolio),
            meta(instrument, false),
            meta(oracle, false),
            meta(book),
            meta(matcher, false),
          ]),
        );
        try {
          const signature = await send(instructions, { simulate: true });
          // Rescan next tick: other portfolios may also be underwater.
          lastScanAt = -Infinity;
          return {
            status: "liquidated",
            batchId,
            signature,
            victim: canonical.toBase58(),
          };
        } catch (error) {
          if (error.code !== "simulation_failed") throw error;
          unserviceable = true;
          alert({
            service: "maker",
            severity: "critical",
            code: "liquidation_capacity",
            victim: canonical.toBase58(),
            action:
              "Fund maker collateral or release exposure; trying other eligible portfolios",
          });
        }
      }
      liquidationBlocked = unserviceable;
    }
    // Between scans, an unserviceable victim keeps quotes withdrawn.
    if (liquidating && liquidationBlocked) {
      const signature = orders.length ? await send([cancel()]) : undefined;
      return {
        status: "blocked",
        reason: "liquidation_capacity",
        batchId,
        signature,
      };
    }
    if (!i.isActive || r.pauseFlags & 17) {
      const signature = orders.length ? await send([cancel()]) : undefined;
      return { status: "blocked", reason: "paused", batchId, signature };
    }
    if (batchState.status !== 0) return { status: "waiting_batch", batchId };
    const prices = [1n, 2n, 3n].map(
      (level) => (price * (1000n - level)) / 1000n,
    );
    prices.push(
      ...[1n, 2n, 3n].map((level) => ceil(price * (1000n + level), 1000n)),
    );
    if (prices[0] <= 0n || new Set(prices.map(String)).size !== 6)
      return { status: "blocked", reason: "price_resolution", batchId };
    const desired = prices.map((limit, index) => ({
      side: index < 3 ? 0 : 1,
      price: limit,
      qty: quantityLots,
    }));
    const { state: v } = decodeOwned(vaultRaw, "Vault");
    const positions = p.positions.slice(0, p.positionsLen),
      held = positions.reduce((n, pos) => n + abs(pos.qty), 0n);
    const { unrealizedPnl: pnl } = decodePortfolioHealth(pRaw.data, price);
    const available = p.equity + (pnl < 0n ? pnl : 0n) - held * 200000n;
    const reserve = desired.reduce((sum, d) => {
      const notional = d.qty * (d.price > price ? d.price : price) * 1000000n;
      return sum + ceil(notional, price * 5n) + ceil(notional, price * 2000n);
    }, 0n);
    const sideLots = 3n * quantityLots,
      largest =
        v.openInterestLong > v.openInterestShort
          ? v.openInterestLong
          : v.openInterestShort;
    const reason =
      held + sideLots > 10000n
        ? "portfolio_exposure"
        : largest + sideLots > 50000n
          ? "market_exposure"
          : v.insuranceFund < (largest + sideLots) * 400000n
            ? "insurance_floor"
            : available < reserve
              ? "collateral"
              : undefined;
    if (reason) {
      const signature = orders.length ? await send([cancel()]) : undefined;
      alert({
        service: "maker",
        severity: "critical",
        code: "risk_limit",
        reason,
        action: "Restore maker collateral or exposure and insurance capacity",
      });
      return { status: "blocked", reason, batchId, signature };
    }
    if (ladderHolds(orders, desired)) return { status: "resting", batchId };
    // On-chain simulation is the final margin/exposure gate, including concurrent changes.
    const instructions = orders.length ? [cancel()] : [];
    for (const d of desired)
      instructions.push(
        ix(
          "PostOrder",
          { ...d, isMaker: true, instrumentId: 0, reduceOnly: false },
          [
            meta(portfolio),
            meta(payer.publicKey, false, true),
            meta(batch),
            meta(registry, false),
            meta(book),
            meta(matcher, false),
            meta(instrument, false),
            meta(oracle, false),
            meta(vault, false),
          ],
        ),
      );
    const signature = await send(instructions);
    return { status: "quoted", batchId, signature };
  }
  return { tick };
}
module.exports = { createMakerWorker, INTERVAL_MS };
