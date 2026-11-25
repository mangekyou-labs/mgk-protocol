import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Connection } from '@solana/web3.js';
import { WebSocketServer } from 'ws';
import { createStore } from './store.js';
import { healthRoutes } from './rest/health.js';
import { marketsRoutes, candlesRoutes, tradesRoutes, bookRoutes, batchRoutes, userFillsRoutes } from './rest/routes.js';
import { portfolioRoutes } from './rest/portfolio.js';
import { createSyncer } from './syncer.js';
import { loadDeployment, loadMonitoring } from './config.js';
import { statusRoutes } from './rest/status.js';
import { createWsServer, broadcastFill, broadcastBatch } from './ws.js';
import { createFallbackFetch, resolveFallbackUrl } from './rpcFallback.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
// Public devnet by default; RPC_PUBLIC_FALLBACK=off disables it.
const RPC_FALLBACK_URL = resolveFallbackUrl(process.env.RPC_PUBLIC_FALLBACK);
const DB_PATH = process.env.DB_PATH ?? 'mgk-indexer.db';
// Status response cache; runtime tests set 0 to read the chain on every request.
const STATUS_CACHE_MS = process.env.STATUS_CACHE_MS === undefined ? undefined : Number(process.env.STATUS_CACHE_MS);
if (STATUS_CACHE_MS !== undefined && !(Number.isInteger(STATUS_CACHE_MS) && STATUS_CACHE_MS >= 0)) throw new Error('STATUS_CACHE_MS must be a non-negative integer');

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: LOG_LEVEL },
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: true });

  const manifest = loadDeployment();
  const store = createStore(DB_PATH, JSON.stringify(manifest));
  const monitoring = loadMonitoring();
  const CORE_PROGRAM_ID = manifest.programs.perps_core;
  const MATCHER_PROGRAM_ID = manifest.programs.perps_matcher;
  let lastFallbackLog = 0;
  const rpcFetch = createFallbackFetch({
    primaryUrl: RPC_URL,
    fallbackUrl: RPC_FALLBACK_URL,
    timeoutMs: 10_000,
    onFallback: (reason) => {
      const now = Date.now();
      if (now - lastFallbackLog < 60_000) return;
      lastFallbackLog = now;
      app.log.warn({ reason }, 'dedicated RPC failed; using public devnet fallback');
    },
  });
  const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (url, options) => rpcFetch(String(url), options as RequestInit),
  });

  let wss: WebSocketServer | undefined;

  const syncer = createSyncer({
    connection,
    store,
    coreProgramId: CORE_PROGRAM_ID,
    marketSeed: manifest.marketSeed,
    matcherProgramId: MATCHER_PROGRAM_ID,
    startSlot: manifest.startSlot!,
    // Log subscriptions trigger syncs; polling is only a fallback (each tick costs 2 RPC credits).
    pollIntervalMs: 30_000,
    onFill: (fill) => {
      if (!wss) return;
      const f = fill as Record<string, unknown>;
      const instrumentId = typeof f.instrument_id === 'number' ? f.instrument_id : 0;
      broadcastFill(wss, instrumentId, fill);
    },
    onBatchEvent: (event: unknown) => {
      if (!wss) return;
      broadcastBatch(wss, event);
    },
  });

  await healthRoutes(app, {
    store,
    getRuntimeHealth: () => syncer.getRuntimeHealth(),
    tracker: syncer.getHealthTracker(),
  });
  await statusRoutes(app, {connection, store, manifest, monitoring, cacheMs: STATUS_CACHE_MS});
  await marketsRoutes(app, store);
  await candlesRoutes(app, store);
  await tradesRoutes(app, store);
  await bookRoutes(app, store, {
    connection,
    matcherProgramId: MATCHER_PROGRAM_ID,
    coreProgramId: CORE_PROGRAM_ID,
    marketSeed:manifest.marketSeed,
  });
  await batchRoutes(app, store, {
    connection,
    coreProgramId: CORE_PROGRAM_ID,
    marketSeed: manifest.marketSeed,
    registryAddress: manifest.accounts.registry!,
  });
  await userFillsRoutes(app, store);
  await portfolioRoutes(app, store);

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    app.log.info({ address }, 'indexer listening (read-only sync/API)');

    const httpServer = app.server;
    wss = createWsServer(httpServer, async (instrumentId: number) => {
      const trades = store.db
        .prepare('SELECT slot, price, qty, taker_side, is_maker FROM fills WHERE instrument_id = ? ORDER BY slot DESC LIMIT 50')
        .all(instrumentId);
      return { bids: [], asks: [], lastTrades: trades };
    });

    app.log.info('starting syncer...');
    await syncer.start();
    app.log.info('syncer started — indexer is read-only (no keeper/oracle)');

  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.log.info({ sig }, 'shutting down');
      void syncer.stop().then(() => {
        store.close();
        app.close().then(() => process.exit(0));
      });
    });
  }
}

main();
