"use strict";
// Shared wire/seed contract; no SDK dependency so browser and tools use the same bytes.
function marketSeedBytes(seed) {
  if (seed == null) return null;
  if (typeof seed === 'string') {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(seed)) throw Error('Invalid market seed');
    let n = 0n;
    for (const c of seed) n = n * 58n + BigInt(alphabet.indexOf(c));
    const bytes = [];
    while (n > 0n) {
      bytes.unshift(Number(n & 255n));
      n >>= 8n;
    }
    const leadingZeros = /^1*/.exec(seed)[0].length;
    seed = Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes]);
  }
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw Error('Market seed must be 32 bytes');
  return Uint8Array.from(seed);
}

function marketSeeds(seeds, marketSeed, registry) {
  const seed = marketSeedBytes(marketSeed);
  if (!seed) return seeds;
  const name = new TextDecoder().decode(seeds[0]);
  if (name === 'registry') return [seeds[0], seed, ...seeds.slice(1)];
  if (!['vault', 'instrument', 'portfolio', 'batch', 'commitment', 'book', 'results'].includes(name)) {
    throw Error('Unknown market PDA seed');
  }
  if (!(registry instanceof Uint8Array) || registry.length !== 32) throw Error('Scoped child requires canonical registry');
  return [seeds[0], registry, ...seeds.slice(1)];
}

function wrapInstruction(program, data, marketSeed) {
  const seed = marketSeedBytes(marketSeed);
  if (!seed || program === 'oracle') return data;
  const outer = {core: 29, matcher: 10}[program];
  if (outer == null || !data.length || data[0] === outer) throw Error('Invalid or nested scoped instruction');
  return Uint8Array.from([outer, ...seed, ...data]);
}

function unwrapInstruction(program, data, marketSeed) {
  const seed = marketSeedBytes(marketSeed);
  const outer = {core: 29, matcher: 10}[program];
  if (data[0] !== outer) return seed ? null : data;
  if (data.length < 34 || data[33] === outer) throw Error('Malformed scoped instruction');
  if (!seed || !seed.every((b, i) => b === data[i + 1])) return null;
  return data.slice(33);
}
module.exports = {marketSeedBytes, marketSeeds, wrapInstruction, unwrapInstruction};
