import { type LogFrame, parseLogs } from './logs';
import type { RpcTx } from './tx';

/** One instruction as it ran: an outer instruction or one of its inner (CPI) instructions, with its accounts
 *  resolved to addresses and the index of the outer instruction it belongs to. */
export type Invocation = { program: string; accounts: string[]; data: string; outer: number };

/** Every instruction of a transaction in the order it ran: each outer instruction followed by its inner ones,
 *  which is the order of the `invoke` lines in the logs. */
export function invocations(tx: RpcTx): Invocation[] {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((g) => [g.index, g.instructions]));
  const out: Invocation[] = [];
  const push = (ix: { programIdIndex: number; accounts: number[]; data: string }, outer: number) =>
    out.push({
      program: keys[ix.programIdIndex] as string,
      accounts: ix.accounts.map((a) => keys[a] as string),
      data: ix.data,
      outer,
    });
  tx.transaction.message.instructions.forEach((ix, i) => {
    push(ix, i);
    for (const c of inner.get(i) ?? []) push(c, i);
  });
  return out;
}

/** A transaction's log frames, each paired with the instruction that opened it when its program's frames and
 *  invocations pair (the k-th frame of a program in the logs is its k-th invocation). */
export type AlignedFrame = { frame: LogFrame; inv: Invocation | undefined; index: number };

export function alignFrames(tx: RpcTx): {
  frames: AlignedFrame[];
  /** Programs whose frames outnumber their invocations (or differ in number on untruncated logs): unpaired. */
  misaligned: Set<string>;
  truncated: boolean;
} {
  const { frames, truncated } = parseLogs(tx.meta?.logMessages ?? []);
  const byProgram = new Map<string, Invocation[]>();
  for (const i of invocations(tx))
    byProgram.set(i.program, [...(byProgram.get(i.program) ?? []), i]);
  const count = new Map<string, number>();
  for (const f of frames) count.set(f.program, (count.get(f.program) ?? 0) + 1);
  const misaligned = new Set<string>();
  for (const [p, n] of count) {
    const m = byProgram.get(p)?.length ?? 0;
    if (truncated ? n > m : n !== m) misaligned.add(p);
  }
  const seen = new Map<string, number>();
  return {
    frames: frames.map((frame, index) => {
      const k = seen.get(frame.program) ?? 0;
      seen.set(frame.program, k + 1);
      return {
        frame,
        inv: misaligned.has(frame.program) ? undefined : byProgram.get(frame.program)?.[k],
        index,
      };
    }),
    misaligned,
    truncated,
  };
}

/** The frames a frame's program invoked, directly or deeper: those after it with a greater depth, up to the next
 *  frame at its depth or above. */
export function childFrames(frames: readonly AlignedFrame[], index: number): AlignedFrame[] {
  const d = frames[index]?.frame.depth ?? 0;
  const out: AlignedFrame[] = [];
  for (let i = index + 1; i < frames.length && (frames[i] as AlignedFrame).frame.depth > d; i++)
    out.push(frames[i] as AlignedFrame);
  return out;
}

/**
 * The log frames of `program` paired with the instructions that opened them. Used for venues whose events do not
 * name their pool (Raydium AMM v4's ray_log, Meteora DAMM v1's Anchor events): the pool is read from the
 * instruction's accounts instead. A transaction whose logs show a different number of frames of the program than
 * it has invocations is not paired at all (`aligned` false); truncated logs pair only the frames before the cut.
 */
export function framesWithInvocations(
  tx: RpcTx,
  program: string,
): { pairs: Array<{ frame: LogFrame; inv: Invocation }>; aligned: boolean; truncated: boolean } {
  const a = alignFrames(tx);
  const aligned = !a.misaligned.has(program);
  return {
    pairs: aligned
      ? a.frames
          .filter((f) => f.frame.program === program && f.inv)
          .map((f) => ({ frame: f.frame, inv: f.inv as Invocation }))
      : [],
    aligned,
    truncated: a.truncated,
  };
}
