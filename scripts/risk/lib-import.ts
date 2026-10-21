import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { packSide } from '@colosseum/risk';

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

// DB-STORAGE (Oct 18): a pool snapshot's side is stored as its pairs (`packSide`), and as the JSON `null` when a
// ten-minute run measured the pool and found that side as the pool's last stored curve. The heatmap reads a
// `null` side as the pool's previous curve on that side (`heatmapCells`), so it answers what it answered on
// every curve stored: the run still says which pools it measured, which the heatmap's best pool per run needs.
// The hourly run's row keeps its curves, so a pool's previous curve is at most an hour back.

/** The two sides of a pool row as the import stores them, each pair-packed or `null` for "as before". */
export type StoredSides = { sell: unknown; buy: unknown };

/**
 * Whether a pool row is from a run that read every pool: the collector reads all pools when it starts in the
 * first five minutes of a UTC hour (scripts/risk/collector/pools.ts, `hourly`); a pool of tier B is read only
 * then, and a row with no tier is kept whole.
 */
export function fromFullRun(row: { fetchedAt: unknown; tier?: unknown }): boolean {
  if (row.tier !== 'A') return true;
  const t = new Date(row.fetchedAt as string);
  return Number.isNaN(t.getTime()) || t.getUTCMinutes() < 5;
}

/**
 * The sides to store for a pool row, given each pool's last stored curve per side (`last`, updated): a side is
 * `null` when the row is not from a full run and the side, packed, is the pool's last stored one; else packed.
 */
export function poolSidesToStore(
  row: { pool: unknown; fetchedAt: unknown; tier?: unknown; sell: unknown; buy: unknown },
  last: Map<string, string>,
): StoredSides {
  const full = fromFullRun(row);
  const out: StoredSides = { sell: null, buy: null };
  for (const s of ['sell', 'buy'] as const) {
    const packed = packSide(row[s]);
    const key = `${String(row.pool)} ${s}`;
    const seen = JSON.stringify(packed);
    if (!full && last.get(key) === seen) continue;
    last.set(key, seen);
    out[s] = packed;
  }
  return out;
}

/**
 * The keys of a lending collector row that `risk_lending_snapshots.detail` keeps (DB-STORAGE, Oct 18): those
 * a reader takes from it, all in scripts/risk/lending-report.ts on the newest row per account and kind
 * (`debtSymbol` of a Jupiter Lend vault, `symbol`, `supplyApr` and `borrowApr` of its liquidity layer). The
 * whole row stays in the collector's day file; detail held it all, about 1.5 KB of each row.
 */
export const LENDING_DETAIL_KEYS = ['symbol', 'debtSymbol', 'supplyApr', 'borrowApr'] as const;

/** A lending row cut to `LENDING_DETAIL_KEYS`, each kept as written where the row has it. */
export function lendingDetail(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of LENDING_DETAIL_KEYS) if (Object.hasOwn(row, k)) out[k] = row[k];
  return out;
}
