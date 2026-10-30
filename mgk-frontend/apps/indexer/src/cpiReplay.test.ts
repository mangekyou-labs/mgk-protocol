import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {describe, it, expect} from 'vitest';
import {Connection, Keypair, PublicKey, MessageV0} from '@solana/web3.js';
import bs58 from 'bs58';
import Fastify from 'fastify';
import * as sdk from '@mgk/sdk';
import {statusRoutes} from './rest/status.js';
import type {DeploymentManifest} from '../../../packages/layout/manifest.js';
import {createStore} from './store.js';
import {syncChunk} from './syncer.js';
import {layouts} from '../../../packages/layout/index.js';
import {instructions} from '../../../packages/layout/instructions.js';

const core = Keypair.generate().publicKey, matcher = Keypair.generate().publicKey;
const wrapper = Keypair.generate().publicKey;
const batch = Keypair.generate().publicKey, results = Keypair.generate().publicKey;
function receipt(batchId: bigint, qty: bigint) {
  const data = Buffer.alloc(18); data.writeBigUInt64LE(batchId); data.writeUInt16LE(1, 8); data.writeBigUInt64LE(qty, 10);
  return `Program data: ${Buffer.from('mgk-settlement-v1').toString('base64')} ${data.toString('base64')}`;
}
function accounts(batchId = 1n) {
  const batchData = Buffer.alloc(layouts.Batch.size); batchData[0] = layouts.Batch.discriminator!; batchData[1] = 1;
  batchData.writeBigUInt64LE(batchId, 8); batchData[16] = 3;
  const resultsData = Buffer.alloc(51 + 58); resultsData[0] = 8; resultsData[1] = 1;
  resultsData.writeBigUInt64LE(batchId, 8); resultsData[16] = 1; resultsData.writeUInt16LE(1, 49);
  resultsData.fill(22, 51, 83); resultsData.writeBigUInt64LE(10n, 91); resultsData.writeBigInt64LE(100_000_000n, 99);
  return {batchData, resultsData};
}
function nestedTransaction() {
  return {meta: {err: null, loadedAddresses: {writable: [batch, results], readonly: [] as PublicKey[]},
    innerInstructions: [{index: 0, instructions: [{programIdIndex: 1, accounts: [2, 1, 0, 3], data: bs58.encode([instructions.core.SettleBatch.disc]), stackHeight: 2}]}],
    logMessages: [`Program ${wrapper} invoke [1]`, `Program ${core} invoke [2]`, receipt(1n, 3n), `Program ${core} success`, `Program ${wrapper} success`]},
    transaction: {signatures: ['nested-settlement'], message: new MessageV0({
      header: {numRequiredSignatures: 0, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2},
      staticAccountKeys: [wrapper, core], recentBlockhash: PublicKey.default.toBase58(),
      compiledInstructions: [{programIdIndex: 0, accountKeyIndexes: [], data: new Uint8Array([0])}],
      addressTableLookups: [{accountKey: Keypair.generate().publicKey, writableIndexes: [0, 1], readonlyIndexes: []}],
    })}};
}
function rollbackAncestor(tx: ReturnType<typeof nestedTransaction>) {
  const outer = Keypair.generate().publicKey;
  tx.transaction.message.staticAccountKeys[0] = outer;
  tx.transaction.message.staticAccountKeys.push(wrapper);
  const coreIx = tx.meta.innerInstructions[0]!.instructions[0]!;
  coreIx.accounts = coreIx.accounts.map(i => i >= 2 ? i + 1 : i);
  coreIx.stackHeight = 3;
  tx.meta.innerInstructions[0]!.instructions.unshift({programIdIndex: 2, accounts: [], data: bs58.encode([0]), stackHeight: 2});
  tx.meta.logMessages = [`Program ${outer} invoke [1]`, `Program ${wrapper} invoke [2]`, `Program ${core} invoke [3]`, receipt(1n, 3n),
    `Program ${core} success`, `Program ${wrapper} failed: custom program error: 0x1`, `Program ${outer} success`];
}

async function replay(tx = nestedTransaction(), getInfo?: (pk: PublicKey) => unknown, store = createStore(':memory:')) { const fills: Record<string, unknown>[] = [];
  const {batchData, resultsData} = accounts();
  const connection = {getBlocks: async () => [100], getBlock: async () => ({blockTime: 1700000000, transactions: [tx]}),
    getAccountInfo: async (pk: PublicKey) => getInfo ? getInfo(pk) : ({owner: pk.equals(batch) ? core : matcher, data: pk.equals(batch) ? batchData : resultsData})} as unknown as Connection;
  const result = await syncChunk({connection, store, corePk: core, matcherPk: matcher, startSlot: 100, endSlot: 100, onFill: fill => fills.push(fill)});
  return {result, fills, store, connection};
}
describe('CPI settlement history through syncChunk', () => {
  it('recovers effective fills from a nested settlement with lookup-table addresses', async () => {
    const {result, fills, store} = await replay();
    try {expect(result.success).toBe(true); expect(result.fillsInserted).toBe(1); expect(fills[0]?.qty).toBe(3);} finally {store.close();}
  });
  it('resolves the core program itself from a lookup table', async () => {
    const tx = nestedTransaction();
    tx.transaction.message.staticAccountKeys.pop();
    tx.meta.loadedAddresses.readonly.push(core);
    tx.transaction.message.addressTableLookups[0]!.readonlyIndexes.push(2);
    const ix = tx.meta.innerInstructions[0]!.instructions[0]!;
    ix.programIdIndex = 3; ix.accounts = [1, 3, 0, 2];
    const {result, fills, store} = await replay(tx);
    try {expect(result.success).toBe(true); expect(fills[0]?.qty).toBe(3);} finally {store.close();}
  });
  it('ignores a caught failed attempt and binds the receipt to the successful retry', async () => {
    const tx = nestedTransaction();
    tx.meta.innerInstructions[0]!.instructions.push({...tx.meta.innerInstructions[0]!.instructions[0]!});
    tx.meta.logMessages.splice(1, 0, `Program ${core} invoke [2]`, receipt(1n, 9n), `Program ${core} failed: custom program error: 0x1`);
    const {result, fills, store} = await replay(tx);
    try {expect(result.success).toBe(true); expect(result.fillsInserted).toBe(1); expect(fills[0]?.qty).toBe(3);} finally {store.close();}
  });
  it('never reuses a receipt from a failed attempt for a successful call without a receipt', async () => {
    const tx = nestedTransaction();
    tx.meta.innerInstructions[0]!.instructions.push({...tx.meta.innerInstructions[0]!.instructions[0]!});
    tx.meta.logMessages = [`Program ${wrapper} invoke [1]`, `Program ${core} invoke [2]`, receipt(1n, 9n),
      `Program ${core} failed: custom program error: 0x1`, `Program ${core} invoke [2]`, `Program ${core} success`, `Program ${wrapper} success`];
    const {result, fills, store} = await replay(tx);
    try {expect(result.success).toBe(false); expect(fills).toHaveLength(0); expect(store.getSyncState().processedThroughSlot).toBeNull();} finally {store.close();}
  });
  it('discards a successful core call rolled back by a caught failing ancestor', async () => {
    const tx = nestedTransaction();
    rollbackAncestor(tx);
    const {result, fills, store} = await replay(tx);
    try {expect(result.success).toBe(true); expect(fills).toHaveLength(0);} finally {store.close();}
  });
  it.each(['empty disk', 'previous fill-index cache'])('keeps both settled batches and deduplicates retries from %s', async cache => {
    const directory = mkdtempSync(join(tmpdir(), 'mgk-cpi-cache-'));
    const dbPath = join(directory, 'history.db');
    if (cache === 'previous fill-index cache') {
      const legacy = new Database(dbPath);
      legacy.exec(`CREATE TABLE fills (id INTEGER PRIMARY KEY AUTOINCREMENT, fill_index INTEGER NOT NULL DEFAULT 0,
        slot INTEGER NOT NULL, batch_id INTEGER NOT NULL, instrument_id INTEGER NOT NULL, taker_side INTEGER NOT NULL,
        price INTEGER NOT NULL, qty INTEGER NOT NULL, taker_pubkey BLOB NOT NULL, maker_pubkey BLOB NOT NULL,
        tx_signature BLOB NOT NULL, is_maker INTEGER NOT NULL DEFAULT 0, UNIQUE(tx_signature, slot, fill_index));
        INSERT INTO fills VALUES(1,0,100,1,0,0,100000000,3,X'00',X'00',X'00',0);
        CREATE TABLE sync_state (id INTEGER PRIMARY KEY, processed_through_slot INTEGER, last_successful_sync_at INTEGER, last_sync_error_at INTEGER);
        INSERT INTO sync_state VALUES(1,100,1000,NULL);`);
      for (const resolution of ['1m', '5m', '1h']) legacy.exec(`
        CREATE TABLE candles_${resolution} (instrument_id INTEGER NOT NULL, open_ts INTEGER NOT NULL,
          open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY(instrument_id, open_ts));
        INSERT INTO candles_${resolution} VALUES(0,1700000000000,100,100,100,100,99);`);
      legacy.close();
    }
    const migrated = createStore(dbPath);
    expect(migrated.getSyncState().processedThroughSlot).toBeNull();
    for (const resolution of ['1m', '5m', '1h']) expect(migrated.db.prepare(`SELECT count(*) AS n FROM candles_${resolution}`).get()).toEqual({n: 0});
    const tx = nestedTransaction();
    const secondBatch = Keypair.generate().publicKey, secondResults = Keypair.generate().publicKey;
    tx.meta.loadedAddresses.writable.push(secondBatch, secondResults);
    tx.transaction.message.addressTableLookups[0]!.writableIndexes.push(2, 3);
    tx.meta.innerInstructions[0]!.instructions.push({...tx.meta.innerInstructions[0]!.instructions[0]!, accounts: [4, 1, 0, 5]});
    tx.meta.logMessages.splice(-1, 0, `Program ${core} invoke [2]`, receipt(2n, 7n), `Program ${core} success`);
    const one = accounts(), two = accounts(2n);
    const {result, fills, store, connection} = await replay(tx, pk => ({
      owner: pk.equals(batch) || pk.equals(secondBatch) ? core : matcher,
      data: pk.equals(batch) ? one.batchData : pk.equals(secondBatch) ? two.batchData : pk.equals(results) ? one.resultsData : two.resultsData,
    }), migrated);
    try {
      expect(result.success).toBe(true); expect(result.fillsInserted).toBe(2); expect(fills.map(f => f.qty)).toEqual([3, 7]);
      const retry = await syncChunk({connection, store, corePk: core, matcherPk: matcher, startSlot: 100, endSlot: 100});
      expect(retry.success).toBe(true); expect(retry.fillsInserted).toBe(0);
    } finally {store.close(); rmSync(directory, {recursive: true, force: true});}
  });
  it.each(['missing', 'truncated', 'depth mismatch'])('holds the replay cursor on %s invocation logs', async fault => {
    const tx = nestedTransaction();
    if (fault === 'missing') tx.meta.logMessages = [];
    else if (fault === 'truncated') tx.meta.logMessages.pop();
    else tx.meta.innerInstructions[0]!.instructions[0]!.stackHeight = 3;
    const {result, store} = await replay(tx);
    try {expect(result.success).toBe(false); expect(store.getSyncState().processedThroughSlot).toBeNull();} finally {store.close();}
  });

});


describe('nested ClearBatch history through HTTP status', () => {
  async function status(fault = '') {
    const store = createStore(':memory:'), app = Fastify();
    const registry = Keypair.generate().publicKey;
    const batchPk = sdk.deriveBatchPda(0n, core)[0];
    const regData = Buffer.alloc(layouts.Registry.size); regData[0] = layouts.Registry.discriminator!; regData[1] = 1;
    regData.writeBigUInt64LE(1n, layouts.Registry.fields.batchIdCounter![0]);
    const batchData = accounts(0n).batchData; batchData[16] = 4;
    const tx = nestedTransaction();
    tx.meta.loadedAddresses.writable[0] = batchPk;
    tx.meta.innerInstructions[0]!.instructions[0]!.data = bs58.encode([instructions.core.ClearBatch.disc]);
    tx.meta.logMessages = [`Program ${wrapper} invoke [1]`, `Program ${core} invoke [2]`, `Program ${core} success`, `Program ${wrapper} success`];
    if (fault === 'caught failure') tx.meta.logMessages[2] = `Program ${core} failed: custom program error: 0x1`;
    if (fault === 'ancestor rollback') rollbackAncestor(tx);
    if (fault === 'missing logs') tx.meta.logMessages = [];
    const now = Math.floor(Date.now()/1000);
    const connection = {getSlot: async () => 100,
      getAccountInfo: async (pk: PublicKey) => pk.equals(registry) ? {owner: core, data: regData} : pk.equals(batchPk) ? {owner: core, data: batchData} : null,
      getSignaturesForAddress: async (_pk: PublicKey, options: {before?: string}) => options.before ? [] : [{signature: 'nested-clear', slot: 100, err: null}],
      getTransaction: async () => ({...tx, blockTime: now - 121}),
    } as unknown as Connection;
    const manifest: DeploymentManifest = {name: 'cpi', cluster: 'localnet', ready: true, startSlot: 100,
      programs: {perps_core: String(core), perps_matcher: String(matcher), oracle: String(core)},
      accounts: {registry: String(registry), instrument: null, oracle: null, insurance: null, maker: null}};
    await statusRoutes(app, {connection, store, manifest, monitoring: {feePayers: {keeper: null, oracle: null, maker: null}, feeFloorLamports: '1', insuranceFloorLamports: '1'}});
    try {const response = await app.inject({method: 'GET', url: '/api/status'}); expect(response.statusCode).toBe(200); return response.json();}
    finally {await app.close(); store.close();}
  }
  it('uses the committed nested ClearBatch block time for the current batch', async () => {
    const observed = await status();
    expect(observed.checks.batch.phase).toBe(4); expect(observed.checks.batch.ageSeconds).toBeGreaterThanOrEqual(121);
    expect(observed.checks.batch.severity).toBe('critical'); expect(observed.checks.batch.available).not.toBe(false);
  });
  it.each(['caught failure', 'ancestor rollback', 'missing logs'])('fails closed for %s', async fault => {
    const observed = await status(fault);
    expect(observed.checks.batch.available).toBe(false); expect(observed.checks.batch.ageSeconds).toBeUndefined();
  });
});
