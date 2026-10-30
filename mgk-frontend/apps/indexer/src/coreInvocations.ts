import type {ConfirmedTransactionMeta, Message, MessageV0, PublicKey} from '@solana/web3.js';
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
export function coreInvocations(message: Message | MessageV0, meta: Pick<ConfirmedTransactionMeta, 'loadedAddresses' | 'innerInstructions' | 'logMessages'>, core: PublicKey) {
  const keys = message.getAccountKeys({accountKeysFromLookups: meta.loadedAddresses});
  const instructions = message.compiledInstructions.flatMap((ix, index) => [
    {...ix, depth: 1},
    ...(meta.innerInstructions?.find(group => group.index === index)?.instructions ?? []).map(inner => ({
      programIdIndex: inner.programIdIndex, accountKeyIndexes: inner.accounts,
      data: bs58.decode(inner.data), depth: (inner as typeof inner & {stackHeight?: number | null}).stackHeight ?? undefined,
    })),
  ]).filter(ix => keys.get(ix.programIdIndex)?.equals(core));
  if (!instructions.length) return [];

  const stack: Invocation[] = [], frames: Invocation[] = [];
  for (const log of meta.logMessages ?? []) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(log);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1) throw new Error('Malformed invocation depth');
      const frame: Invocation = {program: invoke[1]!, depth, parent: stack.at(-1), success: false, logs: [log]};
      stack.push(frame);
      if (frame.program === core.toBase58()) frames.push(frame);
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
    return {...ix, keys, success: committed(frame), logs: frame.logs};
  });
}
