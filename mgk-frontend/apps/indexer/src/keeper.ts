// The indexer is read-only. Run the manifest-bound tools worker separately.
import { Connection, PublicKey } from '@solana/web3.js';
import { state,deriveCommitmentPda,type MarketContext } from '@mgk/sdk';
import type { Store } from './store.js';
const { COMMITMENT_SIZE } = state;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }

  const digits: number[] = [];
  for (let i = leadingZeros; i < bytes.length; i += 1) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = '1'.repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    encoded += BASE58_ALPHABET[digits[i] ?? 0] ?? '';
  }
  return encoded;
}

interface CommitmentAccount {
  pubkey: PublicKey;
  batchId: bigint;
  user: PublicKey;
  status: number; // 0=Pending, 1=Revealed, 2=Slashed, 3=Settled
}

/** Find commitments using the frozen account layout and validated public decoder. */
export async function findCommitmentsForBatch(
  connection: Connection,
  programId: PublicKey,
  batchId: bigint,
  context?:MarketContext,
): Promise<CommitmentAccount[]> {
  const batchIdBuf = Buffer.alloc(8);
  batchIdBuf.writeBigUInt64LE(batchId, 0);

  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: state.layouts.Commitment.fields.batchId![0], bytes: encodeBase58(batchIdBuf) } },
      { dataSize: COMMITMENT_SIZE },
    ],
    encoding: 'base64',
  });

  const commitments: CommitmentAccount[] = [];
  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);
    const { batchId: bid, user, status, nonce } = state.decodeCommitment(data);
    if (bid !== batchId || !pubkey.equals(deriveCommitmentPda(bid,user,nonce,programId,context)[0])) continue;
    commitments.push({ pubkey, batchId: bid, user, status });
  }
  return commitments;
}

export interface StartKeeperParams {
  connection: Connection;
  corePid: PublicKey;
  matcherPid: PublicKey;
  oraclePid: PublicKey;
  registryAddress?: string;
  vaultAddress?: string;
  batchAddress?: string;
  instrumentAddress?: string;
  bookAddress?: string;
  resultsAddress?: string;
  store: Store;
  pollIntervalMs?: number;
  oraclePollMs?: number;
  onCurrentBatchAddress?: (address: string) => void;
}

export function startKeeper(_params: StartKeeperParams): never {
  throw new Error('Embedded keeper disabled: use the manifest-bound tools/ops-keeper.js worker');
}
