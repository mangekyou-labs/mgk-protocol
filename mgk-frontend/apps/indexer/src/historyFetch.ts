import type {FetchFn} from '@solana/web3.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(key => typeof key === 'string');
}

/** Only discard transactions whose resolved keys prove they cannot invoke core.
 * Reject incomplete v0 lookups: downstream key filtering cannot detect core
 * when the RPC has omitted one of its loaded addresses.
 */
function mayInvokeCore(value: unknown, coreProgramId: string): boolean {
  const tx = record(value);
  if (!tx || ![undefined, 'legacy', 0, 1].includes(tx.version as number | 'legacy' | undefined)) return true;
  const message = record(record(tx.transaction)?.message);
  const meta = record(tx.meta);
  if (!message || !meta || !('err' in meta) || !stringArray(message.accountKeys)) return true;
  const loaded = record(meta.loadedAddresses);
  if (tx.version === 0) {
    if (!Array.isArray(message.addressTableLookups)) throw new Error('Incomplete transaction lookup addresses');
    let writable = 0, readonly = 0;
    for (const value of message.addressTableLookups) {
      const lookup = record(value);
      if (!Array.isArray(lookup?.writableIndexes) || !Array.isArray(lookup?.readonlyIndexes)) throw new Error('Incomplete transaction lookup addresses');
      writable += lookup.writableIndexes.length;
      readonly += lookup.readonlyIndexes.length;
    }
    if (message.addressTableLookups.length > 0 || loaded) {
      if (!loaded || !stringArray(loaded.writable) || !stringArray(loaded.readonly) || loaded.writable.length !== writable || loaded.readonly.length !== readonly) throw new Error('Incomplete transaction lookup addresses');
    }
  }
  if (message.accountKeys.includes(coreProgramId)) return true;
  if (meta.loadedAddresses !== undefined && (!loaded || !stringArray(loaded.writable) || !stringArray(loaded.readonly))) return true;
  if (loaded && ((loaded.writable as string[]).includes(coreProgramId) || (loaded.readonly as string[]).includes(coreProgramId))) return true;
  return false;
}

/** Filter getBlock JSON before web3 allocates PublicKeys and validates every
 * unrelated devnet transaction. Blocks, slot order and relevant txs stay intact.
 */
export function createHistoryFetch(coreProgramId: string, fetcher: FetchFn): FetchFn {
  return async (url, options) => {
    const request = typeof options?.body === 'string' ? record(JSON.parse(options.body)) : null;
    const response = await fetcher(url, options);
    if (request?.method !== 'getBlock' || !response.ok) return response;

    const payload: unknown = await response.json();
    const result = record(record(payload)?.result);
    if (Array.isArray(result?.transactions)) {
      result.transactions = result.transactions.filter(tx => mayInvokeCore(tx, coreProgramId));
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(payload), {status: response.status, statusText: response.statusText, headers});
  };
}
