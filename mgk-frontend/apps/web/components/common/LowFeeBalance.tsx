/** Shown when the wallet can't cover network fees. The app only runs against devnet (genesis is checked before signing), so the faucet link always applies. */
export const LOW_FEE_BALANCE = 'Not enough SOL for network fees';
export const DEVNET_FAUCET_URL = 'https://faucet.solana.com/';

export function LowFeeBalance() {
  return (
    <>
      {LOW_FEE_BALANCE}{' '}
      <a href={DEVNET_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="underline">
        devnet faucet
      </a>
    </>
  );
}
