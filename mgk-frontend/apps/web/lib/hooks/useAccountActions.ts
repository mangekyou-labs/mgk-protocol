'use client';

import { useCallback, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, type PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { config } from '@/lib/config';
import { usePortfolioStore } from '@/lib/stores/usePortfolioStore';
import { useSafeTransaction } from './useSafeTransaction';

const SOL = 1_000_000_000n;
export interface AccountActionResult { sig: string }

export function useAccountActions() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const safeSend = useSafeTransaction();
  const busy = useRef(false);

  const execute = useCallback(async (kind: 'init' | 'deposit' | 'withdraw', amount = 0n): Promise<AccountActionResult> => {
    if (!publicKey) throw new Error('Wallet not connected');
    if (busy.current) throw new Error('An account action is already in progress.');
    if (kind !== 'init' && (amount <= 0n || amount > 18446744073709551615n)) throw new Error('Enter a positive SOL amount with at most 9 decimals, within the u64 lamport limit.');
    busy.current = true;
    try {
      const [portfolioPda] = sdk.derivePortfolioPda(publicKey, config.coreProgramId);
      const [account] = await connection.getMultipleAccountsInfo([portfolioPda], 'confirmed');
      if (account && !account.owner.equals(config.coreProgramId)) throw new Error('Portfolio does not match the deployment manifest.');
      const portfolio = account ? sdk.state.decodePortfolio(new Uint8Array(account.data)) : null;
      if (portfolio && !portfolio.user.equals(publicKey)) throw new Error('Portfolio does not match the connected wallet.');
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
      const key = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isSigner: signer, isWritable: writable });
      const instruction = (keys: ReturnType<typeof key>[], data: Uint8Array) => new TransactionInstruction({ keys, programId: config.coreProgramId, data: Buffer.from(data) });
      if (!portfolio) {
        if (kind === 'withdraw') throw new Error('No portfolio to withdraw from.');
        tx.add(instruction([key(publicKey, true, true), key(portfolioPda, true), key(SystemProgram.programId)], sdk.programs.encodeInitPortfolioForUser(publicKey.toBuffer())));
      } else if (kind === 'init') throw new Error('Portfolio already exists. Deposit SOL to add collateral.');
      if (kind === 'deposit') {
        const vault = config.vaultAddress ?? sdk.deriveVaultPda(config.coreProgramId)[0];
        tx.add(instruction([key(portfolioPda, true), key(publicKey, true, true), key(SystemProgram.programId), key(vault, true)], sdk.programs.encodeDeposit(amount)));
      }
      if (kind === 'withdraw' && portfolio) {
        if (amount > portfolio.freeCollateral) throw new Error('Amount exceeds withdrawable collateral, net of initial margin and order reservations.');
        const registryAddress = config.registryAddress ?? sdk.deriveRegistryPda(config.coreProgramId)[0];
        const registryAccount = await connection.getAccountInfo(registryAddress, 'confirmed');
        if (!registryAccount || !registryAccount.owner.equals(config.coreProgramId)) throw new Error('Registry unavailable. Retry when RPC has recovered.');
        const registry = sdk.state.decodeRegistry(new Uint8Array(registryAccount.data));
        if ((registry.pauseFlags & 2) !== 0) throw new Error('Withdrawals are paused. Wait for the operator to restore withdrawals.');
        if (registry.batchIdCounter > 0n) {
          const batchAddress = sdk.deriveBatchPda(registry.batchIdCounter - 1n, config.coreProgramId)[0];
          const batchAccount = await connection.getAccountInfo(batchAddress, 'confirmed');
          if (!batchAccount || !batchAccount.owner.equals(config.coreProgramId)) throw new Error('Current batch unavailable. Retry when RPC has recovered.');
          if (sdk.state.decodeBatch(new Uint8Array(batchAccount.data)).status === sdk.state.BatchStatus.Cleared) throw new Error('Withdrawals are blocked while the current batch is Cleared, awaiting settlement.');
        }
        const vault = config.vaultAddress ?? sdk.deriveVaultPda(config.coreProgramId)[0];
        const keys = [key(portfolioPda, true), key(publicKey, true, true), key(vault, true), key(registryAddress)];
        // Flat portfolios without reservations need no oracle, including during outages.
        if (portfolio.positions.length || portfolio.reservedCollateral > 0n) {
          if (!config.instrumentAddress || !config.oracleAddress) throw new Error('Risk accounts missing from the deployment manifest.');
          keys.push(key(config.instrumentAddress), key(config.oracleAddress));
        }
        tx.add(instruction(keys, sdk.programs.encodeWithdraw(amount)));
      }
      const sig = await safeSend(tx);
      await sdk.confirmSignature(connection, sig);
      await usePortfolioStore.getState().refresh();
      return { sig };
    } finally { busy.current = false; }
  }, [publicKey, connection, safeSend]);
  const initPortfolio = useCallback(() => execute('init'), [execute]);
  const deposit = useCallback((amount: bigint) => execute('deposit', amount), [execute]);
  const withdraw = useCallback((amount: bigint) => execute('withdraw', amount), [execute]);
  return { initPortfolio, deposit, withdraw, SOL };
}
