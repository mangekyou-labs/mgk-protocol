"use strict";
/**
 * Credit-aware RPC helpers for the bots. Every RPC call costs provider
 * credits, so a tick reads all its accounts in one batched call (which also
 * carries the slot), a blockhash is reused for a short while, and
 * confirmation polls are spaced out.
 */
const BLOCKHASH_MAX_AGE_MS = 20_000;
const CONFIRM_OPTIONS = Object.freeze({
  pollIntervalMs: 1000,
  heightCheckIntervalMs: 10_000,
});

/** One getMultipleAccounts call: the accounts in key order plus the read slot. */
async function readAccounts(connection, keys, commitment = "confirmed") {
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(
    keys,
    commitment,
  );
  if (!Array.isArray(value) || value.length !== keys.length)
    throw Error("Unexpected RPC account batch");
  return { slot: context.slot, accounts: value };
}

/** A missing system account holds zero lamports. */
function lamportsOf(info) {
  const lamports = info?.lamports ?? 0;
  if (!Number.isSafeInteger(lamports) || lamports < 0)
    throw Error("Unsafe RPC balance");
  return lamports;
}

/**
 * Reuses a confirmed blockhash for up to `maxAgeMs`; it stays valid for about
 * 60 s. Call `invalidate` after a failed send so a retry never resends an
 * identical, already-processed transaction.
 */
function createBlockhashCache(connection, now = Date.now, maxAgeMs = BLOCKHASH_MAX_AGE_MS) {
  let cached = null,
    fetchedAt = 0;
  return {
    async get() {
      if (!cached || now() - fetchedAt >= maxAgeMs) {
        cached = await connection.getLatestBlockhash("confirmed");
        fetchedAt = now();
      }
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}

module.exports = {
  BLOCKHASH_MAX_AGE_MS,
  CONFIRM_OPTIONS,
  createBlockhashCache,
  lamportsOf,
  readAccounts,
};
