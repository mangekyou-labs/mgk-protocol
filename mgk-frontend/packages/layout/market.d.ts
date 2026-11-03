export type MarketSeed = string | Uint8Array | null;
export function marketSeedBytes(seed?: MarketSeed): Uint8Array | null;
export function marketSeeds(seeds: Uint8Array[], seed?: MarketSeed, registry?: Uint8Array): Uint8Array[];
export function wrapInstruction(program: 'core'|'matcher'|'oracle', data: Uint8Array, seed?: MarketSeed): Uint8Array;

export function unwrapInstruction(program:'core'|'matcher',data:Uint8Array,seed?:MarketSeed):Uint8Array|null;
