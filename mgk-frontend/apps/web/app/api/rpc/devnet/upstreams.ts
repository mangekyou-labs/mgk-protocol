export const PUBLIC_DEVNET_RPC = 'https://api.devnet.solana.com';

/**
 * Endpoints in the order they are tried: the dedicated provider (first entry
 * of RPC_UPSTREAMS), then the public devnet fallback. A drained or revoked
 * key must not take the public site offline, so a failed request is retried
 * once on public devnet. RPC_PUBLIC_FALLBACK overrides the fallback URL;
 * "off" disables it (fail closed).
 */
export function rpcTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = (env.RPC_UPSTREAMS ?? '')
    .split(',')
    .map((u) => u.trim())
    .find(Boolean);
  const raw = env.RPC_PUBLIC_FALLBACK?.trim();
  const fallback = !raw ? PUBLIC_DEVNET_RPC : raw.toLowerCase() === 'off' ? null : raw;
  return [...new Set([primary, fallback].filter((u): u is string => Boolean(u)))];
}
