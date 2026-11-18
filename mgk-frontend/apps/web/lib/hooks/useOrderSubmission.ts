'use client';

import { useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  type Connection,
  type PublicKey,
} from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { useSafeTransaction } from '@/lib/hooks/useSafeTransaction';
import { config } from '@/lib/config';
import { resolveRegistryAddress } from '@/lib/onchainAccounts';
import { awaitOpenWindow, BATCH_CLOSED_MESSAGE, isBatchClosedError } from '@/lib/batchWindow';
import {
  useOrderFormStore,
  type OrderFormStatus,
  type OrderSide,
} from '@/lib/stores/useOrderFormStore';

export interface PostOrderParams {
  instrumentId: number;
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
}

export interface PostOrderOptions {
  /** Called when the current batch window is too short and the post waits for the next. */
  onWaiting?: () => void;
  /** Called once the order is bound to an open window, just before the wallet prompt. */
  onReady?: () => void;
  /** Called once the wallet has signed and the transaction is sent. */
  onSigned?: () => void;
}

const CU_LIMIT_POST = 300_000;

export function activeBatchIdFromCounter(batchIdCounter: bigint): bigint {
  if (batchIdCounter === 0n) {
    throw new Error('No active batch. Wait for the keeper to open collecting.');
  }
  return batchIdCounter - 1n;
}

export function postOrderAccountCount(): number {
  return 9;
}

/** Match the wallet-adapter / web3.js error format for a custom program
 *  error, which surfaces in the message string as either:
 *    "custom program error: 0x258"
 *  or the older non-prefixed variant:
 *    "failed to send transaction: ... 0x1f7"
 */
function extractErrorCode(err: unknown): number | null {
  if (err == null) return null;
  if (typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0) return c;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return '';
            }
          })();
  const hex = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex?.[1]) return parseInt(hex[1], 16);
  const plain = message.match(/custom program error:\s*(\d+)/);
  if (plain?.[1]) return Number(plain[1]);
  return null;
}

export interface DecodedProgramError {
  code: number | null;
  severity: sdk.ErrorSeverity;
  message: string;
}

/** Program errors whose SDK copy predates the glossary. Keyed by error code. */
const GLOSSARY_MESSAGES: Readonly<Record<number, string>> = {
  107: 'Your withdrawable collateral is not enough for this order.',
  502: BATCH_CLOSED_MESSAGE,
};

export function decodeProgramError(err: unknown): DecodedProgramError {
  const code = extractErrorCode(err);
  if (code === null) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
    return { code: null, severity: 'unknown', message };
  }
  const severity = sdk.classifyError(code);
  const human = GLOSSARY_MESSAGES[code] ?? sdk.humanizeError(code);
  return { code, severity, message: human };
}

/**
 * Wallets re-simulate before sending and report a closed batch as a generic
 * failure without a code. Before the signature exists, re-read the pinned
 * batch so that case gets an honest message.
 */
async function batchClosedErrorFor(
  connection: Connection,
  e: unknown,
  pinnedBatch: PublicKey | null,
): Promise<DecodedProgramError | null> {
  const raw = e instanceof Error ? e.message : String(e);
  const closed: DecodedProgramError = { code: 502, severity: sdk.classifyError(502), message: BATCH_CLOSED_MESSAGE };
  if (isBatchClosedError(raw)) return closed;
  if (!pinnedBatch || extractErrorCode(e) !== null || /user rejected|rejected the request|cancell?ed/i.test(raw)) return null;
  const account = await connection.getAccountInfo(pinnedBatch, 'confirmed').catch(() => null);
  if (!account || account.data.length < sdk.state.BATCH_SIZE) return null;
  const { status } = sdk.state.decodeBatch(new Uint8Array(account.data));
  return status === sdk.state.BatchStatus.Collecting ? null : closed;
}

function applySeverity(
  severity: sdk.ErrorSeverity,
  setters: { setStatus: (s: OrderFormStatus) => void; clear: () => void },
): void {
  // DFBA PostOrder has no slash-on-reveal UI path. Keep params for retry.
  void severity;
  void setters.clear;
  setters.setStatus('failed');
}

/**
 * DFBA PostOrder: single-tx open limit post onto the book.
 * Replaces the commit-reveal two-tx flow.
 */
export function usePostOrder() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const safeSend = useSafeTransaction();
  const setOrder = useOrderFormStore((s) => s.setOrder);
  const setStatus = useOrderFormStore((s) => s.setStatus);
  const clear = useOrderFormStore((s) => s.clear);

  const batchClosedError = useCallback(
    (e: unknown, pinnedBatch: PublicKey | null) => batchClosedErrorFor(connection, e, pinnedBatch),
    [connection],
  );

  const post = useCallback(
    async (params: PostOrderParams, options: PostOrderOptions = {}) => {
      if (!publicKey || !sendTransaction) {
        throw new Error('Wallet not connected');
      }

      let pinnedBatch: PublicKey | null = null;
      try {
        const registryPda = resolveRegistryAddress(config.coreProgramId);
        const [portfolioPda] = sdk.derivePortfolioPda(
          publicKey,
          config.coreProgramId, config.marketContext);
        // M9: book is a matcher-owned keypair account (config.bookAddress).
        // PDA fallback only if no configured book (future multi-instrument).
        const bookPda =
          config.bookAddress ??
          sdk.deriveBookPda(params.instrumentId, config.matcherProgramId, config.marketContext)[0];

        const instrumentPda = config.instrumentAddress ?? sdk.deriveInstrumentPda(
          params.instrumentId,
          config.coreProgramId, config.marketContext)[0];
        const vaultPda =
          config.vaultAddress ?? sdk.deriveVaultPda(config.coreProgramId, config.marketContext)[0];

        const [registryAcc, portfolioAcc, bookAcc, instrumentAcc] =
          await connection.getMultipleAccountsInfo([
            registryPda,
            portfolioPda,
            bookPda,
            instrumentPda,
          ]);
        if (!registryAcc) {
          throw new Error('Registry not found on-chain. Is the program deployed?');
        }
        if (!portfolioAcc) {
          throw new Error(
            'Portfolio not found. Click Set Up Account first and wait for the keeper to create it.',
          );
        }
        if (!bookAcc) {
          throw new Error(
            'Book account not found. Set NEXT_PUBLIC_BOOK_ADDRESS to the matcher-owned book.',
          );
        }

        if (!instrumentAcc) {
          throw new Error('Instrument not found on-chain.');
        }
        const oraclePda = sdk.state.readInstrumentOracle(
          new Uint8Array(instrumentAcc.data),
        );
        const sideByte = params.side === 'buy' ? sdk.Side.Buy : sdk.Side.Sell;
        const ixData = sdk.programs.encodePostOrder({
          side: sideByte,
          // The trade screen only posts taker limit orders.
          isMaker: false,
          price: params.price,
          qty: params.qty,
          instrumentId: params.instrumentId,
          reduceOnly: params.reduceOnly,
        });

        // Bind the batch only after the deployment checks, so the wallet prompt
        // opens with most of the collecting window still ahead of it.
        let batchId = 0n;
        const build = async (): Promise<Transaction> => {
          const open = await awaitOpenWindow({
            connection,
            programId: config.coreProgramId,
            onWait: options.onWaiting,
          });
          const batchPda = open.batchPda;
          batchId = open.batchId;
          pinnedBatch = batchPda;
          options.onReady?.();
          // Accounts per process_post_order:
          // 0. portfolio  1. user  2. batch  3. registry  4. book  5. matcher
          // 6. instrument  7. conversion oracle  8. vault (insurance fund for the
          //    risk-off gate)
          const ix = new TransactionInstruction({
            keys: [
              { pubkey: portfolioPda, isSigner: false, isWritable: true },
              { pubkey: publicKey, isSigner: true, isWritable: false },
              { pubkey: batchPda, isSigner: false, isWritable: true },
              { pubkey: registryPda, isSigner: false, isWritable: false },
              { pubkey: bookPda, isSigner: false, isWritable: true },
              { pubkey: config.matcherProgramId, isSigner: false, isWritable: false },
              { pubkey: instrumentPda, isSigner: false, isWritable: false },
              { pubkey: oraclePda, isSigner: false, isWritable: false },
              { pubkey: vaultPda, isSigner: false, isWritable: false },
            ],
            programId: config.coreProgramId,
            data: Buffer.from(config.marketSeed ? sdk.wrapInstruction('core',ixData,config.marketSeed) : ixData),
          });

          setOrder({
            instrumentId: params.instrumentId,
            side: params.side,
            price: params.price,
            qty: params.qty,
            reduceOnly: params.reduceOnly,
            batchId,
            salt: 0n,
            hash: '',
            isMaker: false,
          });
          setStatus('submitting');

          return new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT_POST }),
            ix,
          );
        };

        const sig = await safeSend(build);
        // Past this point failures carry their own program error code.
        pinnedBatch = null;
        options.onSigned?.();
        // Throws on a failed, expired or unconfirmed transaction: resolving
        // here means the program accepted the order.
        await sdk.confirmSignature(connection, sig);

        setStatus('done');
        clear();

        return { sig, batchId };
      } catch (e) {
        const decoded = await batchClosedError(e, pinnedBatch) ?? decodeProgramError(e);
        applySeverity(decoded.severity, { setStatus, clear });
        const enriched = new Error(decoded.message) as Error & {
          decoded: DecodedProgramError;
        };
        enriched.decoded = decoded;
        throw enriched;
      }
    },
    [publicKey, sendTransaction, safeSend, connection, setOrder, setStatus, clear, batchClosedError],
  );

  return { post };
}
