import { friendlyRpcError } from './polling';

const EXPLORER_TX = 'https://explorer.solana.com/tx';
const SIMULATION_PREFIX = 'Simulation failed; no signature requested: ';

export function explorerTxUrl(signature: string): string {
  return `${EXPLORER_TX}/${signature}?cluster=devnet`;
}

/** Wallet, RPC and simulation errors in the words a trader needs; actionable app errors pass through. */
export function describeTxError(raw: string): string {
  if (/insufficient\s*funds|no record of a prior credit/i.test(raw)) {
    return 'Not enough SOL in your wallet to cover this transaction and its fees.';
  }
  if (/user rejected|rejected the request|cancell?ed/i.test(raw)) return 'You cancelled the request in your wallet.';
  if (/blockhash not found|block height exceeded|expired/i.test(raw)) return 'The transaction expired before it confirmed. Try again.';
  if (/unexpected error/i.test(raw)) {
    return 'Your wallet could not send this transaction. Make sure it is set to Devnet, then try again.';
  }
  if (raw.startsWith(SIMULATION_PREFIX)) return `${raw.slice(SIMULATION_PREFIX.length).replace(/\.$/, '')}. Nothing was signed.`;
  if (friendlyRpcError(raw) !== raw) return 'Network busy. Try again in a moment.';
  return raw.split('\n')[0]!.trim();
}
