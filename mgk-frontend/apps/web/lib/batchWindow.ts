'use client';

import type { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { resolveOpenBatch, resolveRegistryAddress } from '@/lib/onchainAccounts';

/**
 * Slots a batch must still collect for before the wallet is asked to sign.
 * Simulation, wallet approval and landing take several seconds, and PostOrder
 * fails with BatchNotOpen once the keeper closes the window.
 */
export const MIN_RUNWAY_SLOTS = 15n;
const POLL_MS = 400;
const TIMEOUT_MS = 60_000;

export const BATCH_CLOSED_MESSAGE =
  'The batch closed before your wallet approved. Try again and approve within a few seconds.';

export interface OpenWindow {
  batchPda: PublicKey;
  batchId: bigint;
  batch: sdk.state.BatchState;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Slots left in a collecting window; zero once the deadline has passed. */
export function runwaySlots(commitDeadlineSlot: bigint, slot: bigint): bigint {
  return commitDeadlineSlot > slot ? commitDeadlineSlot - slot : 0n;
}

/**
 * Resolve the collecting batch once it has at least `minRunwaySlots` left,
 * waiting through clearing and settlement for the next window when needed.
 * `onWait` fires once, the first time the current window is too short.
 */
export async function awaitOpenWindow(params: {
  connection: Connection;
  programId: PublicKey;
  minRunwaySlots?: bigint;
  timeoutMs?: number;
  onWait?: () => void;
}): Promise<OpenWindow> {
  const { connection, programId, onWait } = params;
  const minRunway = params.minRunwaySlots ?? MIN_RUNWAY_SLOTS;
  const deadline = Date.now() + (params.timeoutMs ?? TIMEOUT_MS);
  const registryAddress = resolveRegistryAddress(programId);
  let waiting = false;
  for (;;) {
    const [[registryAccount], slot] = await Promise.all([
      connection.getMultipleAccountsInfo([registryAddress], 'confirmed'),
      connection.getSlot('confirmed'),
    ]);
    if (!registryAccount) throw new Error('Registry not found on-chain. Is the program deployed?');
    const registry = sdk.state.decodeRegistry(new Uint8Array(registryAccount.data));
    const open = await resolveOpenBatch({ connection, programId, batchIdCounter: registry.batchIdCounter })
      .catch((e: unknown) => {
        if (e instanceof Error && e.message.startsWith('No open collecting batch found')) return null;
        throw e;
      });
    if (open && runwaySlots(open.batch.commitDeadlineSlot, BigInt(slot)) >= minRunway) return open;
    if (Date.now() > deadline) {
      throw new Error('No batch window opened in time. The keeper may be paused; check system status and retry.');
    }
    if (!waiting) {
      waiting = true;
      onWait?.();
    }
    await sleep(POLL_MS);
  }
}

/** True when the wallet or RPC reports a post that missed its batch window. */
export function isBatchClosedError(raw: string): boolean {
  return /0x1f6\b|custom program error: 502\b|batch not open/i.test(raw);
}
