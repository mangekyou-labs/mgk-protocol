import Database from 'better-sqlite3';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from './store.js';

describe('store - multiple fills per transaction', () => {
  it('stores multiple fills from the same transaction and slot without primary key collision', () => {
    const store = createStore(':memory:');
    const txSig = '4apD1UuMX5Zfmxu9AnW9LFtBeMdhZ8t3bhWEcq84yvnfKyvvLG5389FgUCR2X8M8wGkUXhWRtLSNt2aqPhEqQRgR';
    const slot = 487207426;
    const batchId = 19;
    const instrumentId = 0;

    const makerPk = Buffer.from(new Uint8Array(32).fill(0x11));
    const takerPk = Buffer.from(new Uint8Array(32).fill(0x22));

    // Fill 1: Maker in Bid auction
    store.insertFill.run([
      slot,
      batchId,
      instrumentId,
      1, // takerSide
      50000,
      10000,
      makerPk,
      makerPk,
      Buffer.from(txSig, 'utf-8'),
      1, // isMaker
      0, // fill index
    ]);

    // Fill 2: Taker in Bid auction (same txSig, instrumentId, slot)
    store.insertFill.run([
      slot,
      batchId,
      instrumentId,
      1, // takerSide
      50000,
      10000,
      takerPk,
      takerPk,
      Buffer.from(txSig, 'utf-8'),
      0, // isMaker
      1, // fill index
    ]);

    const totalFills = store.db.prepare('SELECT COUNT(*) as count FROM fills WHERE tx_signature = ?').get(Buffer.from(txSig, 'utf-8')) as { count: number };
    expect(totalFills.count).toBe(2);

    const makerFills = store.db.prepare('SELECT * FROM fills WHERE taker_pubkey = ? OR maker_pubkey = ?').all(makerPk, makerPk);
    expect(makerFills).toHaveLength(1);

    const takerFills = store.db.prepare('SELECT * FROM fills WHERE taker_pubkey = ? OR maker_pubkey = ?').all(takerPk, takerPk);
    expect(takerFills).toHaveLength(1);
  });

  it('initializes sync_state with null values and advances cursor monotonically', () => {
    const store = createStore(':memory:');
    const initial = store.getSyncState();
    expect(initial).toEqual({
      processedThroughSlot: null,
      lastSuccessfulSyncAt: null,
      lastSyncErrorAt: null,
    });

    // Advance cursor
    store.updateSyncSuccess(100, 1700000000000);
    const afterFirst = store.getSyncState();
    expect(afterFirst.processedThroughSlot).toBe(100);
    expect(afterFirst.lastSuccessfulSyncAt).toBe(1700000000000);
    expect(afterFirst.lastSyncErrorAt).toBeNull();

    // Record error
    store.updateSyncError(1700000005000);
    const afterError = store.getSyncState();
    expect(afterError.processedThroughSlot).toBe(100);
    expect(afterError.lastSuccessfulSyncAt).toBe(1700000000000);
    expect(afterError.lastSyncErrorAt).toBe(1700000005000);

    // Update with lower slot does not regress cursor
    store.updateSyncSuccess(90, 1700000010000);
    expect(store.getSyncState().processedThroughSlot).toBe(100);

    // Update with higher slot advances cursor
    store.updateSyncSuccess(256, 1700000020000);
    expect(store.getSyncState().processedThroughSlot).toBe(256);
  });

  it('supports setSyncCursor for seeding bootstrap without backfill', () => {
    const store = createStore(':memory:');
    store.setSyncCursor(5000);
    expect(store.getSyncState().processedThroughSlot).toBe(5000);
  });

  it('checks SQLite writability correctly', () => {
    const store = createStore(':memory:');
    expect(store.isWritable()).toBe(true);
  });
});


it('preserves identical orders by ordinal and makes replay idempotent', () => {
  const store = createStore(':memory:');
  const row = [10, 1, 0, 1, 100, 4, Buffer.alloc(32), Buffer.alloc(32), Buffer.from('signature'), 1];
  for (const ordinal of [0, 1, 0, 1]) store.insertFill.run([...row, ordinal]);
  expect(store.db.prepare('SELECT count(*) AS n FROM fills').get()).toEqual({n: 2});
  store.close();
});
it('invalidates legacy collapsed history and its durable cursor for complete replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mgk-store-'));
  const path = join(directory, 'history.db');
  try {
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE fills (slot INTEGER, batch_id INTEGER, instrument_id INTEGER,
      taker_side INTEGER, price INTEGER, qty INTEGER, taker_pubkey BLOB,
      maker_pubkey BLOB, tx_signature BLOB, is_maker INTEGER);
      INSERT INTO fills VALUES (99,1,0,1,100,2,X'00',X'00',X'00',1);
      CREATE TABLE sync_state (id INTEGER PRIMARY KEY, processed_through_slot INTEGER,
        last_successful_sync_at INTEGER, last_sync_error_at INTEGER);
      INSERT INTO sync_state VALUES (1,99,1000,NULL);`);
    legacy.close();
    const store = createStore(path);
    expect(store.getSyncState().processedThroughSlot).toBeNull();
    expect(store.db.prepare('SELECT count(*) AS n FROM fills').get()).toEqual({n: 0});
    store.close();
  } finally {rmSync(directory, {recursive:true, force:true});}
});
