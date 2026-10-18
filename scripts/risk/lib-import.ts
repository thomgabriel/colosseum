import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// PLAN-ANALYTICS item 2 — what the hourly import reads. The collectors write one JSONL file per UTC day; a table's
// newest imported row says which day it had reached, so a run opens only that day's file and the later ones (inserts
// skip rows already present) and reads each as a stream of bounded chunks. Memory no longer grows with history.

/** The `YYYY-MM-DD.jsonl` files of `dir` whose day is on or after `newest`'s UTC day (all of them when null). */
export function dayFilesFrom(dir: string, newest: Date | null): string[] {
  if (!existsSync(dir)) return [];
  const from = newest ? newest.toISOString().slice(0, 10) : '';
  return readdirSync(dir)
    .filter((n) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n) && n.slice(0, 10) >= from)
    .sort()
    .map((n) => join(dir, n));
}

/** The rows of a JSONL file in order, at most `n` parsed rows at a time; blank lines are skipped. */
export async function* jsonlChunks<T = Record<string, unknown>>(
  file: string,
  n = 500,
): AsyncGenerator<T[]> {
  let buf: T[] = [];
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    if (!line) continue;
    buf.push(JSON.parse(line) as T);
    if (buf.length >= n) {
      yield buf;
      buf = [];
    }
  }
  if (buf.length) yield buf;
}

/**
 * The rows a run still has to send: those at or after the table's newest imported time (all of them when
 * there is none). A collector stamps every row of a run with the run's start and its runs never overlap, so
 * a row older than the newest imported one was sent by an earlier run; rows at the newest time are sent
 * again, since the run that wrote them may have been under way when the last import read its file (inserts
 * skip what is there). Before this, every hourly run sent the whole newest day file again.
 */
export function rowsSince<T>(rows: T[], newest: Date | null, at: (row: T) => unknown): T[] {
  if (!newest) return rows;
  const from = newest.getTime();
  return rows.filter((row) => {
    const t = new Date(at(row) as string).getTime();
    // a row whose time does not read is left to the insert, as before
    return !(t < from);
  });
}
