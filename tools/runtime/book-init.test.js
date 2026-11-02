'use strict';
// Issue #69: the order book PDA must be creatable through core InitializeBook
// alone. Unlike the other runtime tests, nothing here is pre-allocated with
// setAccount, so the runtime's 10 KiB inner-instruction growth limit applies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { LocalRuntime } = require('./harness');
const { encodeInstruction } = require('../../mgk-frontend/packages/layout/instructions');
const { Keypair, PublicKey, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const deployment = require('../../deployments/devnet.json');
const CORE = new PublicKey(deployment.programs.perps_core);
const MATCHER = new PublicKey(deployment.programs.perps_matcher);
const BOOK_SIZE = 27712;
const { layouts } = require('../../mgk-frontend/packages/layout');
const pda = (seeds, owner = CORE) => PublicKey.findProgramAddressSync(seeds, owner);
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const ix = (name, params, keys) => new TransactionInstruction({
  programId: CORE, keys, data: Buffer.from(encodeInstruction('core', name, params)),
});

test('core InitializeBook creates and grows the book PDA to full size without pre-allocation', async t => {
  assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST is required; see tools/runtime/README.md');
  const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST, 'utf8'));
  const runtime = await LocalRuntime.start({ candidates: candidate.programs, port: 18799 });
  t.after(() => runtime.close());
  const payer = Keypair.generate();
  await runtime.setAccount(payer.publicKey, { owner: SystemProgram.programId, lamports: 10_000_000_000 });
  const [registry, registryBump] = pda([Buffer.from('registry')]);
  const [instrument, instrumentBump] = pda([Buffer.from('instrument'), Buffer.alloc(2)]);
  const [vault, vaultBump] = pda([Buffer.from('vault')]);
  const [book] = pda([Buffer.from('book'), Buffer.alloc(2)], MATCHER);
  await runtime.send('initialize', [ix('Initialize', {
    governance: payer.publicKey.toBytes(), instrumentCount: 1, volatilityMultiplier: 10000,
    batchIdCounter: 0n, baseDeposit: 1000000n, nMin: 1, tMinSlots: 10n, tMaxSlots: 25n,
    tRevealSlots: 25n, instrumentId: 0, tickSize: 1n, lotSize: 1n, imrBps: 2000, mmrBps: 1000,
    takerFeeBps: 5, makerFeeBps: 0, oracleAddr: Keypair.generate().publicKey.toBytes(),
    registryBump, instrumentBump, vaultBump,
  }, [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
    meta(SystemProgram.programId, false), meta(vault)])], [payer]);

  const initializeBook = () => ix('InitializeBook', { instrumentId: 0 },
    [meta(registry, false), meta(book), meta(payer.publicKey, true, true),
      meta(SystemProgram.programId, false), meta(MATCHER, false)]);
  // Each call adds at most 10 KiB; three calls in one transaction finish the book.
  await runtime.send('initialize book', [initializeBook(), initializeBook(), initializeBook()], [payer]);

  const created = await runtime.account(book);
  assert.equal(created.owner, MATCHER.toBase58(), 'book is matcher-owned');
  assert.equal(created.data.length, BOOK_SIZE);
  assert.equal(created.data[0], layouts.OrderBook.discriminator, 'full-size book is stamped');
  assert.equal(created.data.readUInt16LE(8), 0, 'instrument id');
  assert.equal(created.lamports,
    BigInt(await runtime.rpc('getMinimumBalanceForRentExemption', [BOOK_SIZE])), 'rent-exempt at full size');

  await runtime.send('initialize book again', [initializeBook()], [payer]);
  const again = await runtime.account(book);
  assert.deepEqual(again.data, created.data, 'a finished book is left untouched');
  assert.equal(again.lamports, created.lamports);
});
