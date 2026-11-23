'use strict';
// Simulate-only Withdraw probe (sigVerify:false). Loads no keypair; takes a pubkey.
//   node withdraw-probe.js <userPubkey> <lamports> <label>
const SRC = '~/.cache/mgk-issue-40/src-aac36b5';
const { Connection, PublicKey, Transaction, TransactionInstruction } = require(`${SRC}/tools/node_modules/@solana/web3.js`);
const { encodeInstruction } = require(`${SRC}/mgk-frontend/packages/layout/instructions`);
const { createMarketContext } = require(`${SRC}/tools/market-context`);
const manifest = require(`${SRC}/deployments/devnet.json`);

const [user, amount, label] = process.argv.slice(2);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const core = new PublicKey(manifest.programs.perps_core.address ?? manifest.programs.perps_core);
const ctx = createMarketContext(core, null);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const pk = new PublicKey(user);
const meta = (pubkey, w = true, s = false) => ({ pubkey, isWritable: w, isSigner: s });
const ix = new TransactionInstruction({
  programId: core,
  keys: [meta(ctx.pda([Buffer.from('portfolio'), pk.toBuffer()])[0]), meta(pk, true, true),
    meta(ctx.pda([Buffer.from('vault')])[0]), meta(ctx.registry, false),
    meta(ctx.pda([Buffer.from('instrument'), u16(0)])[0], false), meta(new PublicKey(manifest.accounts.oracle.address), false)],
  data: Buffer.from(encodeInstruction('core', 'Withdraw', { amount: BigInt(amount) }, null)),
});
(async () => {
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: pk, recentBlockhash: blockhash }).add(ix);
  const msg = tx.compileMessage();
  const { VersionedTransaction, VersionedMessage } = require(`${SRC}/tools/node_modules/@solana/web3.js`);
  const vtx = new VersionedTransaction(VersionedMessage.deserialize(msg.serialize()));
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
  const err = sim.value.err;
  const custom = err?.InstructionError?.[1]?.Custom ?? null;
  console.log(JSON.stringify({ label, observedAt: new Date().toISOString(), slot: sim.context.slot, user, amount,
    simulateOnly: true, err, customCode: custom, logs: sim.value.logs }, null, 2));
})().catch(e => { console.error(e.message); process.exit(2); });
