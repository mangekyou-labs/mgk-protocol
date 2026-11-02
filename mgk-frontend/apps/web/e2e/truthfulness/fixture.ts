import { test as base, expect, type Page } from '@playwright/test';
import { PublicKey } from '@solana/web3.js';
import type { state } from '@mgk/sdk';
import { layouts } from '../../../../packages/layout/index.js';
import instructions from '../../../../packages/layout/instruction-fixtures.json';

// Keep the CommonJS Playwright fixture loadable; typecheck wire values against the ESM SDK.
const BatchStatus = {
  Collecting: 0,
  Settled: 3,
  Cleared: 4,
} as const satisfies Pick<typeof state.BatchStatus, 'Collecting' | 'Settled' | 'Cleared'>;

const walletBytes = Array.from({ length: 32 }, (_, i) => i + 1);
const walletKey = new PublicKey(walletBytes);
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const signature = '1'.repeat(64);
type Manifest = { ready: boolean; name: string; programs: Record<string, string>; accounts: Record<string, string> };
type LayoutName = keyof typeof layouts;

/** Only the checked-in Rust-exported wire contract supplies offsets and versions. */
function bytes(name: LayoutName, values: Record<string, bigint | number | Uint8Array> = {}, extra = 0) {
  const layout = layouts[name];
  const data = Buffer.alloc(layout.size + extra);
  if (layout.discriminator !== null) { data[0] = layout.discriminator; data[1] = layout.version!; }
  for (const [field, value] of Object.entries(values)) {
    const [offset, type] = (layout.fields as Record<string, [number, string]>)[field] ?? [];
    if (offset === undefined) throw new Error(`Unknown fixture field ${name}.${field}`);
    if (value instanceof Uint8Array) { data.set(value, offset); continue; }
    const n = BigInt(value);
    if (type === 'bool' || type === 'u8') data.writeUInt8(Number(n), offset);
    else if (type === 'u16') data.writeUInt16LE(Number(n), offset);
    else if (type === 'u32') data.writeUInt32LE(Number(n), offset);
    else if (type === 'i64') data.writeBigInt64LE(n, offset);
    else if (type === 'u64') data.writeBigUInt64LE(n, offset);
    else if (type === 'i128' || type === 'u128') {
      const unsigned = BigInt.asUintN(128, n);
      data.writeBigUInt64LE(unsigned & ((1n << 64n) - 1n), offset);
      data.writeBigUInt64LE(unsigned >> 64n, offset + 8);
    } else throw new Error(`Unsupported fixture field ${type}`);
  }
  return data;
}
export class ControlledMarket {
  collateral: bigint | null = null;
  position = false;
  order: 'buy' | 'sell' | null = null;
  batchId = 0;
  phases = new Map<number, state.BatchStatus>([[0, BatchStatus.Collecting]]);
  settledBatches: number[] = [];
  get phase() { return this.phases.get(this.batchId)!; }
  set phase(value: state.BatchStatus) { this.phases.set(this.batchId, value); }
  paused = false;
  staleOracle = false;
  missingOracle = false;
  rpcDown = false;
  indexer: 'live' | 'down' | 'syncing' = 'live';
  wrongCluster = false;
  manifestMismatch = false;
  holdWallet = false;
  holdConfirmation = false;
  releaseWallet: (() => void) | null = null;
  walletRequests: number[] = [];
  unexpectedRpc: string[] = [];
  constructor(readonly manifest: Manifest) {}
  pda(seed: string, suffix?: Uint8Array, program = this.manifest.programs.perps_core) {
    return PublicKey.findProgramAddressSync([Buffer.from(seed), ...(suffix ? [suffix] : [])], new PublicKey(program))[0].toBase58();
  }
  get portfolio() { return this.pda('portfolio', walletKey.toBytes()); }
  get book() { return this.pda('book', Buffer.from([0, 0]), this.manifest.programs.perps_matcher); }
  batchAddress(id: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(id)); return this.pda('batch', b); }
  account(address: string) {
    const m = this.manifest;
    const pk = (key: string) => new PublicKey(key).toBytes();
    let data: Buffer; let owner = m.programs.perps_core;
    if (Object.values(m.programs).includes(address)) return { data: ['', 'base64'], executable: true, lamports: 1, owner: '11111111111111111111111111111111', rentEpoch: 0 };
    if (address === m.accounts.registry) data = bytes('Registry', { batchIdCounter: BigInt(this.batchId + 1), instrumentCount: 1, pauseFlags: this.paused ? 1 : 0 });
    else if (address === m.accounts.instrument) data = bytes('Instrument', { instrumentId: 0, oracleAddr: pk(m.accounts.oracle), isActive: 1, imrBps: 2000, mmrBps: 1000, maxLeverage: 5 });
    else if (address === m.accounts.oracle) {
      if (this.missingOracle) return null;
      owner = m.programs.oracle;
      data = bytes('PriceOracle', { instrument: pk(m.accounts.instrument), isActive: 1, price: 100_000_000n, confidence: 1000n, timestamp: BigInt(Math.floor(Date.now() / 1000) - (this.staleOracle ? 120 : 0)) });
    } else if (address === m.accounts.insurance) data = bytes('Vault', { insuranceFund: 100_000_000_000n });
    else if (address === this.portfolio) {
      if (this.collateral === null) return null;
      data = bytes('Portfolio', { user: walletKey.toBytes(), equity: this.collateral, principal: this.collateral, freeCollateral: this.collateral, health: this.collateral, positionsLen: this.position ? 1 : 0 });
      if (this.position) data.set(bytes('Position', { instrumentId: 0, qty: 100n, entryVwap: 100_000_000n, entryDenominator: 1_000_000_000_000n }), layouts.Portfolio.fields.positions[0]);
    } else if ([...this.phases.keys()].some(id => address === this.batchAddress(id))) {
      const id = [...this.phases.keys()].find(id => address === this.batchAddress(id))!;
      const phase = this.phases.get(id)!;
      data = bytes('Batch', { batchId: BigInt(id), status: phase, closeSlot: 10000n, markValid: phase === BatchStatus.Settled || phase === BatchStatus.Cleared ? 1 : 0, clearingPrice: 100_000_000n });
    }
    else if (address === this.book) {
      owner = m.programs.perps_matcher;
      data = bytes('OrderBook', { instrumentId: 0, nextOrderId: 2n }, 256 * layouts.RestingOrder.size);
      if (this.order) data.set(bytes('RestingOrder', { orderId: 1n, user: walletKey.toBytes(), price: 100_000_000n, qty: 100n, side: this.order === 'buy' ? 0 : 1, batchPlaced: BigInt(this.batchId) }), layouts.OrderBook.size);
    } else return null;
    return { data: [data.toString('base64'), 'base64'], executable: false, lamports: 1_000_000, owner, rentEpoch: 0, space: data.length };
  }
  accept(discriminators: number[]) {
    const code = (name: string) => instructions.find(i => i.name === name && i.program === 'core')?.bytes[0] ?? instructions.find(i => i.name === name)?.bytes[0];
    for (const d of discriminators) {
      this.walletRequests.push(d);
      if (d === code('Deposit')) this.collateral = 1_000_000_000n;
      else if (d === code('Withdraw')) this.collateral = 500_000_000n;
      else if (d === code('PostOrder')) this.order = this.position ? 'sell' : 'buy';
      else if (d === code('CancelRestingOrder')) this.order = null;
      else if (d !== code('InitPortfolioForUser')) throw new Error(`Unscripted synthetic wallet instruction ${d}`);
    }
  }
  clear() { this.order = null; this.phase = BatchStatus.Cleared; }
  settle(close = false) {
    this.phase = BatchStatus.Settled; this.position = !close; this.settledBatches.push(this.batchId);
    this.batchId++; this.phase = BatchStatus.Collecting;
  }
  rpc(method: string, params: unknown[] = []): unknown {
    const context = { slot: 42 };
    if (method === 'getGenesisHash') return this.wrongCluster ? 'wrong-cluster' : genesis;
    if (method === 'getAccountInfo') return { context, value: this.account(String(params[0])) };
    if (method === 'getMultipleAccounts') return { context, value: (params[0] as string[]).map(a => this.account(a)) };
    if (method === 'getBalance') return { context, value: 5_000_000_000 };
    if (method === 'getLatestBlockhash') return { context, value: { blockhash: '1'.repeat(32), lastValidBlockHeight: 10000 } };
    if (method === 'getSignatureStatuses') return { context, value: [this.holdConfirmation ? null : { slot: 42, confirmations: null, err: null, confirmationStatus: 'confirmed' }] };
    if (method === 'simulateTransaction') return { context, value: { err: null, logs: [], unitsConsumed: 10000 } };
    if (method === 'getSlot' || method === 'getBlockHeight') return 42;
    if (method === 'getFeeForMessage') return { context, value: 5000 };
    this.unexpectedRpc.push(method);
    throw new Error(`RPC method forbidden in controlled UI fixtures: ${method}`);
  }
}

async function injectWallet(page: Page, market: ControlledMarket) {
  await page.exposeBinding('__controlledWalletRequest', async (_, ds: number[]) => {
    if (market.holdWallet) await new Promise<void>(resolve => { market.releaseWallet = resolve; });
    market.accept(ds); return signature;
  });
  await page.addInitScript(({ walletBytes, core }) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const publicKey = { toBytes: () => new Uint8Array(walletBytes) };
    const wallet = {
      isPhantom: true, isConnected: false, publicKey,
      on(e: string, f: (...args: unknown[]) => void) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e)!.add(f); },
      off(e: string, f: (...args: unknown[]) => void) { listeners.get(e)?.delete(f); },
      async connect() { wallet.isConnected = true; listeners.get('connect')?.forEach(f => f(publicKey)); return { publicKey }; },
      async disconnect() { wallet.isConnected = false; listeners.get('disconnect')?.forEach(f => f()); },
      // No keys or signatures exist. A request updates controlled RPC observations only.
      async signAndSendTransaction(tx: { instructions: { programId: { toBase58(): string }; data: Uint8Array }[] }) {
        const ds = tx.instructions.filter(i => i.programId.toBase58() === core).map(i => i.data[0]);
        const sig = await (window as unknown as { __controlledWalletRequest(ds: number[]): Promise<string> }).__controlledWalletRequest(ds);
        return { signature: sig };
      },
      async signTransaction() { throw new Error('Real signing is forbidden'); },
      async signAllTransactions() { throw new Error('Real signing is forbidden'); },
      async signMessage() { throw new Error('Real signing is forbidden'); },
    };
    Object.defineProperty(window, 'isPhantomInstalled', { value: true, configurable: true });
    Object.defineProperty(window, 'phantom', { value: { solana: wallet }, configurable: true });
    Object.defineProperty(window, 'solana', { value: wallet, configurable: true });
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
  }, { walletBytes, core: market.manifest.programs.perps_core });
}

export const test = base.extend<{ market: ControlledMarket; evidence: (state: string) => Promise<void> }>({
  market: async ({ page, request, baseURL }, provide, info) => {
    const response = await request.get(`${baseURL}/api/deployment-manifest`);
    expect(response.ok(), 'Candidate must expose its reviewed deployment manifest').toBe(true);
    const manifest = await response.json() as Manifest;
    expect(manifest.ready, 'Candidate manifest is pending; cannot prove trading UI. Use local controlled harness or a ready reviewed preview.').toBe(true);
    const market = new ControlledMarket(manifest);
    await info.attach('evidence-scope', { body: JSON.stringify({ scope: 'controlled UI fixtures only; no chain execution or accounting proof', baseURL, manifest }), contentType: 'application/json' });
    await injectWallet(page, market);
    await page.route('**/*', async route => {
      const req = route.request(); const url = new URL(req.url());
      const body = req.postData();
      if (req.method() === 'POST') {
        let parsed;
        try { parsed = JSON.parse(body ?? ''); } catch { await route.abort(); return; }
        const requests = Array.isArray(parsed) ? parsed : [parsed];
        if (market.rpcDown) { await route.fulfill({ status: 503, body: 'Controlled RPC outage' }); return; }
        const results = requests.map(r => {
          try { return { jsonrpc: '2.0', id: r.id, result: market.rpc(r.method, r.params) }; }
          catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: String(e) } }; }
        });
        await route.fulfill({ json: Array.isArray(parsed) ? results : results[0] }); return;
      }
      if (url.pathname === '/api/deployment-manifest') {
        await route.fulfill({ json: market.manifestMismatch ? { ...manifest, name: 'controlled-stale-build' } : manifest }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (market.indexer === 'down') { await route.fulfill({ status: 503, json: {} }); return; }
        if (url.pathname === '/api/status') {
          const ok = { severity: 'ok', available: true };
          await route.fulfill({ json: { severity: 'ok', checks: { rpc: { ...ok, reachable: !market.rpcDown }, indexer: { ...ok, syncing: market.indexer === 'syncing' }, pause: { ...ok, flags: market.paused ? 1 : 0 }, oracle: ok, batch: ok, makerDepth: ok, fees: ok, insurance: ok } } }); return;
        }
        if (url.pathname.includes('/fills')) {
          await route.fulfill({ json: { fills: market.settledBatches.map(batch_id => ({ slot: 42, batch_id, instrument_id: 0, taker_side: 0, price: 100_000_000, qty: 100, role: 'taker', tx_signature: signature, ts_estimate: 42 })) } }); return;
        }
        await route.fulfill({ json: [] }); return;
      }
      // Keep the deployed app's assets; external chart/telemetry never reach the network.
      if (url.origin !== new URL(baseURL!).origin) { await route.abort(); return; }
      await route.continue();
    });
    await provide(market);
    expect(market.unexpectedRpc, 'No signing, sending or unmodelled RPC may escape fixtures').toEqual([]);
  },
  evidence: async ({ context, page }, provide, info) => {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.tracing.startChunk();
    let chunkOpen = true;
    const save = async (state: string) => {
      const shot = info.outputPath(`${state}.png`); const trace = info.outputPath(`${state}.zip`);
      await page.screenshot({ path: shot, fullPage: true });
      await info.attach(state, { path: shot, contentType: 'image/png' });
      await context.tracing.stopChunk({ path: trace }); chunkOpen = false;
      await info.attach(`${state}-trace`, { path: trace, contentType: 'application/zip' });
      await context.tracing.startChunk(); chunkOpen = true;
    };
    try { await provide(save); } finally {
      if (chunkOpen) await context.tracing.stopChunk({ path: info.outputPath('final-or-failure.zip') });
      await context.tracing.stop();
    }
  },
});
export { expect };
