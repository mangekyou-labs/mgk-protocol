'use strict';
// P0-31 maker-depth drill: CancelAllRestingOrders for the demo maker (mgk-demo-maker.json).
// Simulates by default; pass --send to sign and send. Public devnet RPC only. No admin key.
//   node cancel-maker.js [--send] > out.json
const SRC = '~/.cache/mgk-issue-40/src-aac36b5';
const W3 = require(`${SRC}/tools/node_modules/@solana/web3.js`);
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } = W3;
const { encodeInstruction } = require(`${SRC}/mgk-frontend/packages/layout/instructions`);
const { createMarketContext } = require(`${SRC}/tools/market-context`);
const manifest = require(`${SRC}/deployments/devnet.json`);
const fs = require('fs');

const send = process.argv.includes('--send');
const addr = v => new PublicKey(typeof v === 'string' ? v : v.address);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
  `${process.env.HOME}/.config/solana/mgk-demo-maker.json`, 'utf8'))));
if (payer.publicKey.toBase58() !== 'DPs1NM3TeR9f9WQBgqrT27dmf8F4DoJJVyBpqT5NGr4o') throw Error('unexpected maker key');
const core = addr(manifest.programs.perps_core), matcher = addr(manifest.programs.perps_matcher);
const ctx = createMarketContext(core, manifest.marketSeed);
const pda = (seeds, owner = core) => ctx.pda(seeds, owner)[0];
const registry = addr(manifest.accounts.registry);
const id = Buffer.alloc(2); id.writeUInt16LE(0);
const portfolio = pda([Buffer.from('portfolio'), payer.publicKey.toBuffer()]);
const book = pda([Buffer.from('book'), id], matcher);
const meta = (pubkey, w = true, s = false) => ({ pubkey, isWritable: w, isSigner: s });
const ix = new TransactionInstruction({ programId: core,
  keys: [meta(portfolio), meta(payer.publicKey, false, true), meta(matcher, false), meta(book), meta(registry, false)],
  data: Buffer.from(encodeInstruction('core', 'CancelAllRestingOrders', { numBooks: 1 }, manifest.marketSeed)) });
(async () => {
  const latest = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(ix);
  tx.sign(payer);
  const sim = await conn.simulateTransaction(tx);
  const out = { action: 'cancel-maker', observedAt: new Date().toISOString(), signer: payer.publicKey.toBase58(),
    portfolio: portfolio.toBase58(), book: book.toBase58(), simulation: { slot: sim.context.slot, err: sim.value.err, logs: sim.value.logs } };
  if (send && !sim.value.err) {
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    const conf = await conn.confirmTransaction({ signature, ...latest }, 'confirmed');
    out.signature = signature; out.confirmErr = conf.value.err; out.confirmedSlot = conf.context.slot;
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(sim.value.err || out.confirmErr ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(2); });
