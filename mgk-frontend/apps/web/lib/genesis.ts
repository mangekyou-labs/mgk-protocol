import type { Connection } from '@solana/web3.js';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// A cluster's genesis hash never changes, so read it once per connection.
// Failed reads are evicted so the next caller retries.
const cache = new WeakMap<Connection, Promise<string>>();

export function genesisHash(connection: Connection): Promise<string> {
  let hash = cache.get(connection);
  if (!hash) {
    hash = connection.getGenesisHash();
    cache.set(connection, hash);
    hash.catch(() => { if (cache.get(connection) === hash) cache.delete(connection); });
  }
  return hash;
}
