import {describe, expect, it} from 'vitest';
import Fastify from 'fastify';
import {Keypair, type Connection} from '@solana/web3.js';
import {createStore} from './store.js';
import {INDEXER_CAUGHT_UP_LAG_SLOTS, indexerCheck, statusRoutes} from './rest/status.js';
import type {DeploymentManifest} from '../../../packages/layout/manifest.js';

describe('indexer syncing flag', () => {
  it('is syncing before the first processed slot', () => {
    expect(indexerCheck(1_000, null, 900)).toEqual({severity: 'warn', lagSlots: 101, syncing: true});
  });

  it('clears once lag is within the caught-up threshold, even though lag never reaches 0', () => {
    expect(indexerCheck(10_000, 3_000, 900)).toMatchObject({syncing: true, severity: 'warn'});
    // P0-30 drill: lag 22 after recovery was still reported as syncing.
    expect(indexerCheck(10_022, 10_000, 900)).toEqual({severity: 'ok', lagSlots: 22, syncing: false});
    expect(indexerCheck(10_000 + INDEXER_CAUGHT_UP_LAG_SLOTS, 10_000, 900).syncing).toBe(false);
    expect(indexerCheck(10_001 + INDEXER_CAUGHT_UP_LAG_SLOTS, 10_000, 900).syncing).toBe(true);
  });

  it('transitions from syncing to caught up through GET /api/status as the cursor advances', async () => {
    const store = createStore(':memory:'), app = Fastify();
    let tip = 50_000;
    const connection = {getSlot: async () => tip, getAccountInfo: async () => null} as unknown as Connection;
    const program = Keypair.generate().publicKey.toBase58();
    const manifest: DeploymentManifest = {marketSeed: null, name: 'status', cluster: 'localnet', ready: true, startSlot: 10_000,
      programs: {perps_core: program, perps_matcher: program, oracle: program},
      accounts: {registry: null, instrument: null, oracle: null, insurance: null, maker: null}};
    await statusRoutes(app, {connection, store, manifest,
      monitoring: {feePayers: {keeper: null, oracle: null, maker: null}, feeFloorLamports: '1', insuranceFloorLamports: '1'}});
    const indexer = async () => (await app.inject({method: 'GET', url: '/api/status'})).json().checks.indexer;
    try {
      expect(await indexer()).toMatchObject({syncing: true});
      store.setSyncCursor(20_000);
      expect(await indexer()).toMatchObject({syncing: true, lagSlots: 30_000});
      store.setSyncCursor(49_990);
      tip = 50_012;
      expect(await indexer()).toEqual({severity: 'ok', lagSlots: 22, syncing: false});
    } finally {await app.close(); store.close();}
  });
});
