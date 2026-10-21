// The minutes of each UTC hour in which a scheduled hosted bars job may touch the hosted database (gate HOURLY-BARS):
// Neon's free compute sleeps after five minutes idle, and the hourly import has it awake from about :10 to :25
// (SNAPSHOT-IN-API, amended), so a job that reads or writes outside those minutes would wake it once more. The
// minutes are counted in the hour the run started: a run started late (a Mac waking at :40), or one that ran into the
// next hour, touches nothing, and the next hour's run does its work. Only the scheduled runs pass it; the runs a
// person starts (a fill, a dry run) do not.

/** The window the hosted jobs are given: minute 10 (inclusive) to 25 (exclusive). */
export const HOSTED_WRITE_WINDOW = { from: 10, to: 25 } as const;
export type WriteWindow = { from: number; to: number };

/** `--write-window <from>-<to>` (minutes, 0 ≤ from < to ≤ 60); null when it does not read as one. */
export function parseWriteWindow(text: string | undefined): WriteWindow | null {
  const m = /^(\d{1,2})-(\d{1,2})$/u.exec(text ?? '');
  if (!m) return null;
  const [from, to] = [Number(m[1]), Number(m[2])];
  return from < to && to <= 60 ? { from, to } : null;
}

/** Whether `nowMs` is outside the window of the UTC hour `startedMs` fell in. */
export function outsideWriteWindow(startedMs: number, nowMs: number, w: WriteWindow): boolean {
  const hour = Math.floor(startedMs / 3_600_000) * 3_600_000;
  return nowMs < hour + w.from * 60_000 || nowMs >= hour + w.to * 60_000;
}
