// The hosted bars job's own walk of Robinhood Chain (ASSET-HOURLY, gate `HOURLY-BARS`): every Swap event of the
// cut's pools over the last few hours, kept in a folder of the job's own, so the bars can be built every hour
// without waiting for the hosted loop's daily rewalk (whose `history/` folder this never reads or writes).
// Read-only on chain: `eth_blockNumber`, `eth_getBlockByNumber` and `eth_getLogs`, on the chain's public
// endpoint. The folder has the layout of RU.14's walk (history-run.ts), so `readRobinhood` reads it as it
// reads the loop's:
//
//   cursor.json               the span held: `fromT` (every swap from it on is in the files) to `headT`
//   headers.jsonl             the block headers a swap's time is interpolated from
//   swaps/<pool>/<day>.jsonl  one line per swap, the same rows as the loop's
//
// Each run reads the blocks after the last head it walked, up to the chain's head now, into a pending folder,
// and adds them to the day files only when the whole walk went through: a walk that stops leaves the files and
// the cursor as they were, and the next run walks the same blocks again. A row written twice (a merge cut short)
// is counted once by the reader (`readRobinhood` keeps one swap per block and log index). A folder whose head is
// more than `keepHours` old, or that holds none, is started again from `keepHours` before the head. Day files
// that ended `keepHours` before the head are deleted.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ChainConfig } from './config';
import {
  blockTime,
  DEFAULT_HEADER_STEP,
  DEFAULT_WINDOW,
  dayOf,
  type Header,
  HISTORY_METHOD,
  type HistoryPool,
  type SwapRow,
  swapFilters,
  walkSwaps,
} from './history';
import { type Cursor, type HistoryDeps, readHeaders, spanHeaders } from './history-run';

/** How far back the folder holds swaps: a quote's dollar price may come from a pool's last swap 24 hours before. */
export const RECENT_KEEP_HOURS = 30;
/**
 * The hours at the start of the span whose bars are not written: a pool's quote in dollars is the last price of
 * another pool (carried up to MAX_CARRY_HOURS), and a pool quiet since before the span would read unpriced. Six
 * hours, measured against the full rewalk (docs/risk/STATE-RISK.md, "The hourly bars").
 */
export const RECENT_CONTEXT_HOURS = 6;
/** Seconds between requests, as the loop's walk asks the public endpoint (history-run.ts PAUSE_MS). */
export const RECENT_PAUSE_MS = 1_000;

const HOUR_S = 3_600;
const DAY_S = 86_400;

export type RecentWalkOptions = {
  keepHours?: number;
  window?: number;
  headerStep?: number;
  pauseMs?: number;
};

export type RecentWalkSummary = {
  event: 'recent_walk';
  chain: string;
  /** `fresh`: the folder was started again; `added`: the blocks after its head; `none`: the head has not moved. */
  mode: 'fresh' | 'added' | 'none';
  fromBlock: number | null;
  toBlock: number;
  blocks: number;
  windows: number;
  queries: number;
  halvings: number;
  rows: number;
  backoffs: number;
  headers: number;
  daysDeleted: number;
  /** Day files whose cut-short last line was dropped at the start of the run. */
  repaired: number;
  span: { from: string; to: string };
  httpRequests: number;
  rpcCalls: number;
  durationS: number;
};

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** The blocks whose headers place every block between two headers already read: one every `step`. */
export function headerBlocks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let b = from + step; b < to; b += step) out.push(b);
  return out;
}

/**
 * The day files of a folder that ended `keepHours` or more before `headT`, and the new start of the span once
 * they are gone: the start of the oldest day kept, or the span's own start when no day was deleted.
 */
export function daysToDelete(
  days: readonly string[],
  fromT: number,
  headT: number,
  keepHours: number,
): { deleted: string[]; fromT: number } {
  const cutoff = headT - keepHours * HOUR_S;
  const deleted = [...new Set(days)]
    .filter((d) => Date.parse(`${d}T00:00:00Z`) / 1000 + DAY_S <= cutoff)
    .sort();
  if (!deleted.length) return { deleted, fromT };
  const lastDeleted = deleted.at(-1) as string;
  const nextDay = Date.parse(`${lastDeleted}T00:00:00Z`) / 1000 + DAY_S;
  return { deleted, fromT: Math.max(fromT, nextDay) };
}

/**
 * The hours whose bars the job writes, unix seconds of the first and one past the last: complete hours only
 * (an hour is written once the head is past its end), and none of the first `contextHours` whole hours of the
 * span. Empty (`from >= to`) when the span holds no such hour.
 */
export function writableHours(
  span: { fromT: number; headT: number },
  contextHours = RECENT_CONTEXT_HOURS,
): { from: number; to: number } {
  const firstWhole = Math.ceil(span.fromT / HOUR_S) * HOUR_S;
  return { from: firstWhole + contextHours * HOUR_S, to: Math.floor(span.headT / HOUR_S) * HOUR_S };
}

/**
 * The hours a run writes, in ms, `from` inclusive and `to` exclusive: the complete hours of the span after its
 * first `contextHours` whole hours (`writableHours`), and none at or before `writtenThrough`, the newest hour an
 * earlier run wrote (written.json), so each hour is written once. Empty when `from >= to`.
 */
export function hoursToWrite(
  span: { fromT: number; headT: number },
  writtenThrough: number | null,
  contextHours: number,
): { from: number; to: number } {
  const w = writableHours(span, contextHours);
  return {
    from: Math.max(w.from * 1000, writtenThrough === null ? 0 : writtenThrough + HOUR_S * 1000),
    to: w.to * 1000,
  };
}

/** The newest hour a run wrote, read from the folder's written.json; null when none was. */
export function readWrittenThrough(root: string): number | null {
  const file = join(root, 'written.json');
  if (!existsSync(file)) return null;
  const t = Date.parse(
    (JSON.parse(readFileSync(file, 'utf8')) as { through?: string }).through ?? '',
  );
  return Number.isFinite(t) ? t : null;
}

/** Records the newest hour written, whole or not at all (a temporary file renamed over the old one). */
export function writeWrittenThrough(root: string, through: number): void {
  writeAtomic(
    join(root, 'written.json'),
    JSON.stringify({ through: new Date(through).toISOString() }),
  );
}

/**
 * Whether a scheduled run is past the minute by which it must have written (gate HOURLY-BARS): the hosted
 * database is awake from about :10 to :25 UTC for the hourly import, and a write after that would wake it again.
 * The minute is counted in the hour the run started, so a run started late (a Mac waking) writes nothing and the
 * next hour's run writes its hours.
 */
export function pastWriteDeadline(startedMs: number, nowMs: number, minute: number): boolean {
  return nowMs >= Math.floor(startedMs / (HOUR_S * 1000)) * HOUR_S * 1000 + minute * 60_000;
}

/** Writes a file whole: a temporary file beside it, renamed over it, so a crash never leaves half of it. */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * A day file whose last line was cut short (a merge stopped mid-write) loses that line: the cursor was not moved,
 * so the next run walks those blocks again, and a row written twice is read once. Returns the bytes dropped.
 */
export function dropPartialLastLine(file: string): number {
  const size = statSync(file).size;
  if (size === 0) return 0;
  const fd = openSync(file, 'r');
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(file);
  const keep = text.lastIndexOf(0x0a) + 1;
  truncateSync(file, keep);
  return size - keep;
}

/** One run of the walk: the blocks after the folder's head, or a fresh span. See the file's head. */
export async function runRecentWalk(
  deps: HistoryDeps,
  chain: ChainConfig,
  pools: HistoryPool[],
  root: string,
  opts: RecentWalkOptions = {},
): Promise<RecentWalkSummary> {
  const keepHours = opts.keepHours ?? RECENT_KEEP_HOURS;
  const window = opts.window ?? DEFAULT_WINDOW;
  const step = opts.headerStep ?? DEFAULT_HEADER_STEP;
  const pauseMs = opts.pauseMs ?? RECENT_PAUSE_MS;
  const startedAt = deps.now();
  const cursorFile = join(root, 'cursor.json');
  const headersFile = join(root, 'headers.jsonl');
  const swapsDir = join(root, 'swaps');
  const pendingDir = join(root, 'pending');
  mkdirSync(swapsDir, { recursive: true });
  rmSync(pendingDir, { recursive: true, force: true });
  // a merge a crash cut short: no day file keeps a half line (the cursor did not move past those blocks)
  let repaired = 0;
  for (const pool of readdirSync(swapsDir))
    for (const f of readdirSync(join(swapsDir, pool)))
      if (f.endsWith('.jsonl') && dropPartialLastLine(join(swapsDir, pool, f)) > 0) repaired++;

  const headBlock = Number(BigInt(await deps.rpc.call<string>('eth_blockNumber', [])));
  const [head] = (await readHeaders(deps.rpc, [headBlock], deps.sleep)) as [Header];
  const held: Cursor | null = existsSync(cursorFile)
    ? (JSON.parse(readFileSync(cursorFile, 'utf8')) as Cursor)
    : null;
  const usable =
    held !== null &&
    held.chain === chain.id &&
    held.complete &&
    head.t - held.headT <= keepHours * HOUR_S &&
    existsSync(headersFile);

  let mode: RecentWalkSummary['mode'];
  let headers: Header[];
  let from: number;
  let fromT: number;
  if (usable && head.block <= (held as Cursor).head) {
    // the endpoint's head has not moved past the folder's (or answered behind it): nothing to walk
    const c = held as Cursor;
    const stats = deps.rpc.stats();
    const summary: RecentWalkSummary = {
      event: 'recent_walk',
      chain: chain.id,
      mode: 'none',
      fromBlock: null,
      toBlock: c.head,
      blocks: 0,
      windows: 0,
      queries: 0,
      halvings: 0,
      rows: 0,
      backoffs: 0,
      headers: 1,
      daysDeleted: 0,
      repaired,
      span: {
        from: new Date(c.fromT * 1000).toISOString(),
        to: new Date(c.headT * 1000).toISOString(),
      },
      ...stats,
      durationS: Math.round((deps.now().getTime() - startedAt.getTime()) / 1000),
    };
    deps.log(summary);
    return summary;
  }
  if (usable) {
    const c = held as Cursor;
    mode = 'added';
    const stored = readJsonl<Header>(headersFile).sort((a, b) => a.block - b.block);
    const between = await readHeaders(deps.rpc, headerBlocks(c.head, head.block, step), deps.sleep);
    headers = [...stored.filter((h) => h.block <= c.head), ...between, head].sort(
      (a, b) => a.block - b.block,
    );
    from = c.head + 1;
    fromT = c.fromT;
  } else {
    mode = 'fresh';
    // a folder too old to add to, or none: started again; the day files of the old span are not kept
    rmSync(cursorFile, { force: true });
    rmSync(swapsDir, { recursive: true, force: true });
    mkdirSync(swapsDir, { recursive: true });
    const span = await spanHeaders(deps.rpc, head, keepHours / 24, step, deps.sleep);
    headers = span.headers;
    from = span.from.block;
    fromT = span.from.t;
  }

  const filters = swapFilters(chain, pools);
  const known = new Set(pools.map((p) => p.address));
  const result = await walkSwaps(deps, filters, from, head.block, { window, pauseMs }, (w) => {
    const byFile = new Map<string, SwapRow[]>();
    for (const r of w.rows) {
      if (!known.has(r.pool)) continue;
      r.t = blockTime(headers, r.block);
      const key = `${r.pool}/${dayOf(r.t)}`;
      const list = byFile.get(key);
      if (list) list.push(r);
      else byFile.set(key, [r]);
    }
    for (const [key, rows] of byFile) {
      const [pool] = key.split('/') as [string];
      mkdirSync(join(pendingDir, pool), { recursive: true });
      appendFileSync(
        join(pendingDir, `${key}.jsonl`),
        `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
      );
    }
  });

  // the whole walk went through: its rows join the day files, then the headers and the cursor say so
  if (existsSync(pendingDir))
    for (const pool of readdirSync(pendingDir)) {
      mkdirSync(join(swapsDir, pool), { recursive: true });
      for (const f of readdirSync(join(pendingDir, pool))) {
        const day = join(swapsDir, pool, f);
        if (existsSync(day)) dropPartialLastLine(day);
        appendFileSync(day, readFileSync(join(pendingDir, pool, f)));
      }
    }
  rmSync(pendingDir, { recursive: true, force: true });

  const days = existsSync(swapsDir)
    ? readdirSync(swapsDir).flatMap((pool) =>
        readdirSync(join(swapsDir, pool))
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => f.slice(0, 10)),
      )
    : [];
  const pruned = daysToDelete(days, fromT, head.t, keepHours);
  if (pruned.deleted.length)
    for (const pool of readdirSync(swapsDir))
      for (const d of pruned.deleted) rmSync(join(swapsDir, pool, `${d}.jsonl`), { force: true });
  fromT = pruned.fromT;
  // the headers from the newest one at or before the span's start on
  const firstKept = [...headers].reverse().find((h) => h.t <= fromT) ?? (headers[0] as Header);
  headers = headers.filter((h) => h.block >= firstKept.block);
  writeAtomic(headersFile, `${headers.map((h) => JSON.stringify(h)).join('\n')}\n`);
  const fromBlock = mode === 'fresh' ? from : (held as Cursor).from;
  const cursor: Cursor = {
    chain: chain.id,
    method: HISTORY_METHOD,
    head: head.block,
    headT: head.t,
    from: Math.max(fromBlock, firstKept.block),
    fromT,
    days: keepHours / 24,
    window,
    oldestDone: Math.max(fromBlock, firstKept.block),
    oldestDoneT: fromT,
    complete: true,
    pools: pools.length,
    startedAt: mode === 'fresh' ? startedAt.toISOString() : (held as Cursor).startedAt,
    updatedAt: deps.now().toISOString(),
    maxTimeErrorS: null,
  };
  writeAtomic(cursorFile, JSON.stringify(cursor, null, 2));
  const stats = deps.rpc.stats();
  const summary: RecentWalkSummary = {
    event: 'recent_walk',
    chain: chain.id,
    mode,
    fromBlock: from,
    toBlock: head.block,
    blocks: head.block - from + 1,
    ...result,
    headers: headers.length,
    daysDeleted: pruned.deleted.length,
    repaired,
    span: { from: new Date(fromT * 1000).toISOString(), to: new Date(head.t * 1000).toISOString() },
    ...stats,
    durationS: Math.round((deps.now().getTime() - startedAt.getTime()) / 1000),
  };
  deps.log(summary);
  return summary;
}
