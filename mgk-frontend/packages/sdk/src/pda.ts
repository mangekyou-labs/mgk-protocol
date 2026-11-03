import { PublicKey } from '@solana/web3.js';
import {marketSeeds, type MarketSeed} from '../../layout/market.js';
export interface MarketContext {
  marketSeed?: MarketSeed;
  coreProgramId?: PublicKey;
}

function derive(seeds: Uint8Array[], programId: PublicKey, context?: MarketContext): readonly [PublicKey, number] {
  const seed = context?.marketSeed;
  const prefix = new TextDecoder().decode(seeds[0]);
  if (seed && !context?.coreProgramId && ['book', 'results'].includes(prefix)) {
    throw Error('Scoped matcher PDA requires coreProgramId');
  }
  const core = context?.coreProgramId ?? programId;
  const registry = PublicKey.findProgramAddressSync(marketSeeds([seedBytes('registry')], seed), core)[0];
  return PublicKey.findProgramAddressSync(marketSeeds(seeds, seed, registry.toBytes()), programId);
}

export const SEEDS = {
  PORTFOLIO: 'portfolio',
  INSTRUMENT: 'instrument',
  VAULT: 'vault',
  REGISTRY: 'registry',
  BATCH: 'batch',
  COMMITMENT: 'commitment',
  BOOK: 'book',
  RESULTS: 'results',
} as const;

function seedBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf-8'));
}

function u16Le(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

function u64Le(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

export function derivePortfolioPda(
  user: PublicKey,
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive(
    [seedBytes(SEEDS.PORTFOLIO), user.toBytes()],
    programId, context,
  );
}

export function deriveInstrumentPda(
  instrumentId: number,
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive(
    [seedBytes(SEEDS.INSTRUMENT), u16Le(instrumentId)],
    programId, context,
  );
}

export function deriveVaultPda(
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive(
    [seedBytes(SEEDS.VAULT)],
    programId, context,
  );
}

export function deriveRegistryPda(
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive(
    [seedBytes(SEEDS.REGISTRY)],
    programId, context,
  );
}

export function deriveBatchPda(
  batchId: bigint,
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive(
    [seedBytes(SEEDS.BATCH), u64Le(batchId)],
    programId, context,
  );
}

export function deriveCommitmentPda(
  batchId: bigint,
  user: PublicKey,
  salt: bigint,
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive(
    [
      seedBytes(SEEDS.COMMITMENT),
      u64Le(batchId),
      user.toBytes(),
      u64Le(salt),
    ],
    programId, context,
  );
}

export function deriveBookPda(
  instrumentId: number,
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive(
    [seedBytes(SEEDS.BOOK), u16Le(instrumentId)],
    programId, context,
  );
}

export function deriveResultsPda(
  batchId: bigint,
  programId: PublicKey,
  context?: MarketContext,
): readonly [PublicKey, number] {
  return derive([seedBytes(SEEDS.RESULTS), u64Le(batchId)], programId, context);
}
