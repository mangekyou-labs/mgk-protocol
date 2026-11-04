import {unwrapInstruction,type MarketSeed} from '../../../packages/layout/market.js';
import type {ConfirmedTransactionMeta, PublicKey, VersionedMessage} from '@solana/web3.js';
import bs58 from 'bs58';

interface Invocation {
  program: string;
  depth: number;
  parent?: Invocation;
  success: boolean;
  logs: string[];
}

/** Match core instructions in execution preorder to authenticated runtime log frames.
 * A successful child is committed only if every enclosing invocation succeeds.
 */
export function coreInvocations(message: VersionedMessage, meta: Pick<ConfirmedTransactionMeta, 'loadedAddresses' | 'innerInstructions' | 'logMessages'>, core: PublicKey, marketSeed?: MarketSeed) {
  // V1 messages carry resolved keys directly; legacy/V0 resolve lookups from meta.
  const keys = message.version === 0
    ? message.getAccountKeys({accountKeysFromLookups: meta.loadedAddresses})
    : message.getAccountKeys();
  const instructions = message.compiledInstructions.flatMap((ix, index) => [
    {...ix, depth: 1},
    ...(meta.innerInstructions?.find(group => group.index === index)?.instructions ?? []).map(inner => ({
      programIdIndex: inner.programIdIndex, accountKeyIndexes: inner.accounts,
      data: bs58.decode(inner.data), depth: (inner as typeof inner & {stackHeight?: number | null}).stackHeight ?? undefined,
    })),
  ]).filter(ix => keys.get(ix.programIdIndex)?.equals(core));
  // Missing inner metadata must not hide core calls visible in runtime logs.
  // Transactions unrelated to core need no complete invocation history.
  const coreProgram = core.toBase58();
  const hasCoreInvocation = meta.logMessages?.some(log => log.startsWith(`Program ${coreProgram} invoke [`));
  if (!instructions.length && !hasCoreInvocation) return [];

  const stack: Invocation[] = [], frames: Invocation[] = [];
  for (const log of meta.logMessages ?? []) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(log);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1) throw new Error('Malformed invocation depth');
      const frame: Invocation = {program: invoke[1]!, depth, parent: stack.at(-1), success: false, logs: [log]};
      stack.push(frame);
      if (frame.program === coreProgram) frames.push(frame);
      continue;
    }
    const exit = /^Program (\S+) (success|failed:.*)$/.exec(log);
    if (exit) {
      const frame = stack.pop();
      if (!frame || frame.program !== exit[1]) throw new Error('Malformed invocation logs');
      frame.success = exit[2] === 'success'; frame.logs.push(log);
      continue;
    }
    stack.at(-1)?.logs.push(log);
  }
  if (stack.length || frames.length !== instructions.length) throw new Error('Incomplete core invocation history');
  const committed = (frame: Invocation): boolean => frame.success && (!frame.parent || committed(frame.parent));
  return instructions.map((ix, index) => {
    const frame = frames[index]!;
    if (ix.depth !== undefined && ix.depth !== frame.depth) throw new Error('Core instruction/log depth mismatch');
    if (!committed(frame)) return null;
    const data=unwrapInstruction('core',ix.data,marketSeed);
    return data ? {...ix, data, keys, success: committed(frame), logs: frame.logs} : null;
  }).filter((ix): ix is NonNullable<typeof ix> => ix!==null);
}
