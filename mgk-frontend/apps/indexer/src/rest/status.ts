import type { FastifyInstance } from 'fastify';
import { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { decodeStruct, layouts, decodeAccount } from '../../../../packages/layout/index.js';
import type { DeploymentManifest } from '../../../../packages/layout/manifest.js';
import { coreInvocations } from '../coreInvocations.js';
import { instructions } from '../../../../packages/layout/instructions.js';
import { splitSlotRanges } from '../backfill.js';
import type { Store } from '../store.js';
import type { MonitoringConfig } from '../config.js';

type Severity = 'ok' | 'warn' | 'critical';
type Check = { severity: Severity; [key: string]: unknown };
export async function statusRoutes(app: FastifyInstance, cfg: {
  connection: Connection; store: Store; manifest: DeploymentManifest; monitoring: MonitoringConfig;
}): Promise<void> {
  const {connection, store, manifest, monitoring} = cfg;
  const core = new PublicKey(manifest.programs.perps_core);
  const matcher = new PublicKey(manifest.programs.perps_matcher);
  async function account(name: 'Registry'|'Instrument'|'PriceOracle'|'Vault', address: string | null, owner: PublicKey) {
    if (!address) throw new Error('Manifest address pending');
    const info = await connection.getAccountInfo(new PublicKey(address), 'confirmed');
    if (!info || !info.owner.equals(owner)) throw new Error(`${name}: missing account or wrong owner`);
    return info;
  }
  // Frozen Batch has no clear timestamp. Find the successful ClearBatch instruction
  // in confirmed chain history, including across signature-history pages.
  async function clearedAt(batch: PublicKey): Promise<number> {
    let before: string | undefined;
    while (true) {
      const page = await connection.getSignaturesForAddress(batch, {limit: 1000, before}, 'confirmed');
      for (const entry of page) {
        if (entry.err || entry.slot < manifest.startSlot!) continue;
        const tx = await connection.getTransaction(entry.signature, {
          commitment: 'confirmed', maxSupportedTransactionVersion: 1, ...{encoding: 'json'},
        });
        if (!tx?.meta || tx.meta.err) throw new Error('Clear transaction history unavailable');
        if (coreInvocations(tx.transaction.message, tx.meta, core).some(ix =>
          ix.success && ix.data[0] === instructions.core.ClearBatch.disc &&
          ix.accountKeyIndexes.some(i => ix.keys.get(i)?.equals(batch)))) {
          const time = tx.blockTime ?? await connection.getBlockTime(entry.slot);
          if (time === null) throw new Error('Clear block time unavailable');
          return time;
        }
      }
      if (!page.length || page.at(-1)!.slot < manifest.startSlot!) throw new Error('Clear transaction not available from deployment start slot');
      const next = page.at(-1)!.signature;
      if (next === before) throw new Error('Signature history did not progress');
      before = next;
    }
  }
  app.get('/api/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const checks: Record<string, Check> = Object.fromEntries(['oracle', 'batch', 'makerDepth', 'fees', 'insurance', 'pause', 'indexer', 'rpc'].map(key => [key, {severity: 'critical', available: false}]));
    let chainTip: number | null = null;
    const lastIndexedSlot = store.getSyncState().processedThroughSlot;
    try {
      chainTip = await connection.getSlot('confirmed');
      checks.rpc = {severity: 'ok', reachable: true};
      const now = Math.floor(Date.now()/1000);
      const run = async (key: string, read: () => Promise<Check>) => {
        try { checks[key] = await read(); }
        catch (error) { checks[key] = {severity: 'critical', available: false, error: error instanceof Error ? error.message : 'Chain read failed'}; }
      };
      await Promise.all([
        run('oracle', async () => {
          const oracle = decodeAccount('PriceOracle', (await account('PriceOracle', manifest.accounts.oracle, new PublicKey(manifest.programs.oracle))).data);
          if (new PublicKey(oracle.instrument).toBase58() !== manifest.accounts.instrument) throw new Error('Oracle instrument mismatch');
          const ageSeconds = now - Number(oracle.timestamp);
          return {severity: !oracle.isActive || oracle.price <= 0n || oracle.confidence < 0n || oracle.confidence * 100n > oracle.price || ageSeconds < 0 || ageSeconds > 60 ? 'critical' : ageSeconds > 30 ? 'warn' : 'ok', ageSeconds};
        }),
        run('insurance', async () => {
          const vault = decodeAccount('Vault', (await account('Vault', manifest.accounts.insurance, core)).data);
          return {severity: vault.insuranceFund < BigInt(monitoring.insuranceFloorLamports) ? 'warn' : 'ok', lamports: vault.insuranceFund.toString(), floorLamports: monitoring.insuranceFloorLamports};
        }),
        run('fees', async () => {
          const balances: Record<string, string> = {};
          let severity: Severity = 'ok';
          for (const [role, address] of Object.entries(monitoring.feePayers)) {
            if (!address) throw new Error(`${role} fee payer not configured`);
            const balance = await connection.getBalance(new PublicKey(address), 'confirmed');
            if (!Number.isSafeInteger(balance)) throw new Error('Unsafe fee balance');
            balances[role] = String(balance);
            if (BigInt(balance) < BigInt(monitoring.feeFloorLamports)) severity = 'critical';
          }
          return {severity, balances, floorLamports: monitoring.feeFloorLamports};
        }),
        run('makerDepth', async () => {
          const instrument = decodeAccount('Instrument', (await account('Instrument', manifest.accounts.instrument, core)).data);
          if (new PublicKey(instrument.oracleAddr).toBase58() !== manifest.accounts.oracle) throw new Error('Instrument oracle mismatch');
          const bookPk = sdk.deriveBookPda(instrument.instrumentId, matcher)[0];
          const info = await connection.getAccountInfo(bookPk, 'confirmed');
          if (!info || !info.owner.equals(matcher)) throw new Error('Book missing or wrong owner');
          decodeAccount('OrderBook', info.data);
          const orders = Array.from({length: 256}, (_, i) => decodeStruct('RestingOrder', info.data, layouts.OrderBook.size + i * layouts.RestingOrder.size)).filter(order => order.isMaker && order.qty > order.filledQty && new PublicKey(order.user).toBase58() === manifest.accounts.maker && order.instrumentId === instrument.instrumentId);
          const bid = orders.some(o => o.side === 0), ask = orders.some(o => o.side === 1);
          return {severity: instrument.isActive && bid && ask ? 'ok' : 'critical', bid, ask};
        }),
        (async () => {
          try {
            const registry = decodeAccount('Registry', (await account('Registry', manifest.accounts.registry, core)).data);
            checks.pause = {severity: registry.pauseFlags ? 'critical' : 'ok', flags: registry.pauseFlags};
            await run('batch', async () => {
              if (!registry.batchIdCounter) throw new Error('No current batch');
              const batchId = registry.batchIdCounter - 1n;
              const batchPk = sdk.deriveBatchPda(batchId, core)[0];
              const info = await connection.getAccountInfo(batchPk, 'confirmed');
              if (!info || !info.owner.equals(core)) throw new Error('Current batch missing or wrong owner');
              const batch = decodeAccount('Batch', info.data);
              if (batch.batchId !== batchId) throw new Error('Current batch ID mismatch');
              let severity: Severity = 'ok', ageSeconds: number | null = null;
              if (batch.status === 0 && chainTip! > Number(batch.commitDeadlineSlot)) {
                // Use actual block time at the first produced block at/after deadline.
                let time: number | null = null;
                for (const [start, end] of splitSlotRanges(Number(batch.commitDeadlineSlot), chainTip!, 64)) {
                  const slots = await connection.getBlocks(start, end, 'confirmed');
                  if (slots.length) {time = await connection.getBlockTime(slots[0]!); break;}
                }
                if (time === null) throw new Error('Deadline block time unavailable');
                ageSeconds = now - time;
                if (ageSeconds > 30) severity = 'warn';
              }
              if (batch.status === 4) {ageSeconds = now - await clearedAt(batchPk); if (ageSeconds > 120) severity = 'critical';}
              return {severity, batchId: String(batchId), phase: batch.status, ageSeconds, address: batchPk.toBase58()};
            });
          } catch (error) {
            checks.pause = checks.batch = {severity: 'critical', available: false, error: error instanceof Error ? error.message : 'Registry unavailable'};
          }
        })(),
      ]);
      const lagSlots = chainTip - (lastIndexedSlot ?? manifest.startSlot! - 1);
      checks.indexer = {severity: lastIndexedSlot === null || lagSlots > 150 ? 'warn' : 'ok', lagSlots, syncing: lastIndexedSlot === null || lagSlots > 0};
    } catch {
      checks.rpc = {severity: 'critical', reachable: false};
      checks.indexer = {severity: 'warn', available: false};
    }
    const severity: Severity = Object.values(checks).some(c => c.severity === 'critical') ? 'critical' : Object.values(checks).some(c => c.severity === 'warn') ? 'warn' : 'ok';
    return {severity, chainTip, lastIndexedSlot, checks};
  });
}
