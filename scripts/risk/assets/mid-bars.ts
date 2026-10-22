// `pnpm risk:assets-mid-bars [--since-hours <n>] [--dry-run]` (gate HOURLY-BARS): Solana's hourly token bars
// (`market_bars`, `pool = 'asset'`, `mids-0.1`) from the pool collector's mid prices, read from `risk_pool_snapshots`
// and `risk_pools` of the same database it writes to: no file, no RPC. The rule is `midBars` of `@colosseum/risk`
// (one USDC pool an hour, the deepest; no volume). It rebuilds the complete hours of the last n hours (default 6:
// a late import is caught up by a later run) and upserts them over its own rows of those hours; a bar of another
// method version (the backfill's or the swap history's `bars-0.1`) is another key and is never touched. --dry-run
// builds and counts and writes nothing. The hosted job runs it every hour at minute 19
// (scripts/ops/install-hosted-bars.sh solana); once at the install with --since-hours 96, the four days the hosted
// database keeps of pool snapshots (DB-RETENTION). Only the pools the collector reads: tier A (every five minutes)
// and B (hourly) of the registry; tier X is excluded from its registry file, and its old rows are not read.
//
// --fill-from-files [dir] (once, at the install, after --since-hours 96; gate HOURLY-BARS): the same bars from the
// collector's own day files (default ~/.colosseum/hosted-risk/pools/<day>.jsonl, the rows the hourly import turns
// into risk_pool_snapshots: midQuotePerAsset is mid_price, depth2pct.sellQuoteOut is in_band_liquidity, and as the
// import a row without its curves is skipped), for the hours after the newest swap-built Solana token bar of the
// database (the copied backfill, Oct 15 23:00) up to the first whole hour of its snapshots; --from and --to (ISO
// hours) set them by hand. The pools are the database's, as above. Streamed line by line; a dry run counts. It must
// run after the --since-hours 96 fill (the installer runs them in that order): the hour the database's first snapshot
// cuts short is the files' to write, and a database run after it would rewrite that hour from the partial snapshots.
//
// --write-window <from>-<to> (the scheduled hourly run, 10-25; write-window.ts): outside those minutes of the UTC hour
// the run started in, it touches the database not at all (before reading) and writes nothing (before writing); the
// next run rebuilds the same hours. Not with --fill-from-files: a fill is a person's run. A scheduled run (with
// --write-window, not a dry run) waits up to two minutes for the network after a wake, and one with none ends with
// one line and exit code 0, not a crash (network-wait.ts).
import 'dotenv/config';
import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createDb, marketBars, riskPoolSnapshots, riskPools } from '@colosseum/db';
import {
  MIDS_METHOD_VERSION,
  type MidBar,
  type MidPool,
  type MidSnapshot,
  midBars,
  USDC_MINT,
} from '@colosseum/risk';
import type { Provenance } from '@colosseum/schemas';
import { and, eq, gte, inArray, lt, max, min, notLike, sql } from 'drizzle-orm';
import { exitCleanlyWhenOffline, exitOffline, hostOf, waitForNetwork } from './network-wait';
import { outsideWriteWindow, parseWriteWindow, windowEnd } from './write-window';

const HOUR_MS = 3_600_000;
/** The registry tiers the collector reads (scripts/risk/collector/pools.ts: A every run, B on the hour). */
export const READ_TIERS = ['A', 'B'];

/** One row of the collector's day files, the fields the bars read (scripts/risk/collector/pools.ts writes it). */
type DayFileRow = {
  pool?: unknown;
  fetchedAt?: unknown;
  midQuotePerAsset?: unknown;
  depth2pct?: { sellQuoteOut?: unknown } | null;
  sell?: unknown;
  buy?: unknown;
  methodVersion?: unknown;
  provenance?: unknown;
};

/**
 * A day-file row as the snapshot the hourly import would store (scripts/risk/import.ts): mid_price from
 * midQuotePerAsset, in_band_liquidity from depth2pct.sellQuoteOut; null for a row the import skips (no curves) or
 * one that is not a reading. Pure.
 */
export function snapshotOfDayFileRow(r: DayFileRow): MidSnapshot | null {
  if (typeof r.pool !== 'string' || typeof r.fetchedAt !== 'string' || !r.sell || !r.buy)
    return null;
  const fetchedAt = new Date(r.fetchedAt);
  const midPrice = Number(r.midQuotePerAsset);
  if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(midPrice)) return null;
  const depth = r.depth2pct?.sellQuoteOut;
  const provenance: Provenance =
    r.provenance === 'live' || r.provenance === 'sandbox' || r.provenance === 'prior_dataset'
      ? (r.provenance as Provenance)
      : 'mock';
  return {
    pool: r.pool,
    fetchedAt,
    midPrice,
    inBandLiquidity: typeof depth === 'number' && Number.isFinite(depth) ? depth : null,
    methodVersion: typeof r.methodVersion === 'string' ? r.methodVersion : 'unknown',
    provenance,
  };
}

/** The UTC days whose files hold the hours [from, to). */
export function daysOf(hours: { from: Date; to: Date }): string[] {
  const out: string[] = [];
  for (
    let d = Math.floor(hours.from.getTime() / 86_400_000) * 86_400_000;
    d < hours.to.getTime();
    d += 86_400_000
  )
    out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

/**
 * The snapshots of `pools` in the hours, from the collector's day files: streamed, a line of another pool skipped
 * before it is parsed, a line that does not parse (a file cut short) skipped and counted.
 */
export async function readDayFileSnapshots(
  dir: string,
  hours: { from: Date; to: Date },
  pools: ReadonlySet<string>,
): Promise<{ snapshots: MidSnapshot[]; files: number; lines: number; unreadable: number }> {
  const out: MidSnapshot[] = [];
  let files = 0;
  let lines = 0;
  let unreadable = 0;
  for (const day of daysOf(hours)) {
    const file = join(dir, `${day}.jsonl`);
    if (!existsSync(file)) continue;
    files++;
    const rl = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      lines++;
      const m = /^\{"pool":"([^"]+)"/u.exec(line);
      if (!m || !pools.has(m[1] as string)) continue;
      let row: DayFileRow;
      try {
        row = JSON.parse(line) as DayFileRow;
      } catch {
        unreadable++;
        continue;
      }
      const s = snapshotOfDayFileRow(row);
      if (!s) continue;
      const t = s.fetchedAt.getTime();
      if (t >= hours.from.getTime() && t < hours.to.getTime()) out.push(s);
    }
  }
  return { snapshots: out, files, lines, unreadable };
}

/**
 * The hours a fill from the day files writes: after the newest swap-built token bar (the copied backfill) up to
 * the first whole hour of the database's snapshots (the hourly job's from there on), never past `now`'s complete
 * hours. With no swap-built bar, the 31 days the table keeps; with no snapshot, up to now. Pure.
 */
export function fillHours(
  newestSwapBar: Date | null,
  firstSnapshot: Date | null,
  now: Date,
): { from: Date; to: Date } {
  const floor = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
  const nowHour = floor(now.getTime());
  const to = Math.min(
    nowHour,
    firstSnapshot ? Math.ceil(firstSnapshot.getTime() / HOUR_MS) * HOUR_MS : nowHour,
  );
  const from = newestSwapBar
    ? floor(newestSwapBar.getTime()) + HOUR_MS
    : nowHour - 31 * 24 * HOUR_MS;
  return { from: new Date(from), to: new Date(Math.max(from, to)) };
}

/** The newest swap-built Solana token bar and the first snapshot of a pool the bars read, from the database. */
export async function fillBounds(
  db: Db,
  chain = 'solana',
): Promise<{ newestSwapBar: Date | null; firstSnapshot: Date | null }> {
  const [bar] = await db
    .select({ t: max(marketBars.hour) })
    .from(marketBars)
    .where(
      and(
        eq(marketBars.chain, chain),
        eq(marketBars.pool, 'asset'),
        notLike(marketBars.methodVersion, 'mids-%'),
      ),
    );
  const [snap] = await db
    .select({ t: min(riskPoolSnapshots.fetchedAt) })
    .from(riskPoolSnapshots)
    .innerJoin(riskPools, eq(riskPools.address, riskPoolSnapshots.pool))
    .where(and(eq(riskPools.quoteMint, USDC_MINT), inArray(riskPools.tier, READ_TIERS)));
  return { newestSwapBar: bar?.t ?? null, firstSnapshot: snap?.t ?? null };
}

/** The hours a run rebuilds: the `sinceHours` complete hours before `now`'s own hour. */
export function midBarHours(now: Date, sinceHours: number): { from: Date; to: Date } {
  const to = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return { from: new Date(to - sinceHours * HOUR_MS), to: new Date(to) };
}

/** The rows `market_bars` takes for Solana. */
export const midBarRows = (bars: readonly MidBar[], chain = 'solana') =>
  bars.map((b) => ({ chain, ...b })) satisfies Array<typeof marketBars.$inferInsert>;

type Db = ReturnType<typeof createDb>['db'];

/** The registry's USDC pools the collector reads (tiers A and B). */
export async function readMidPools(db: Db): Promise<MidPool[]> {
  return db
    .select({
      address: riskPools.address,
      assetMint: riskPools.assetMint,
      quoteMint: riskPools.quoteMint,
      venue: riskPools.venue,
    })
    .from(riskPools)
    .where(and(eq(riskPools.quoteMint, USDC_MINT), inArray(riskPools.tier, READ_TIERS)));
}

/** The snapshots of the registry's USDC pools in the hours, and those pools: only the columns the bars read. */
export async function readMidSnapshots(
  db: Db,
  hours: { from: Date; to: Date },
): Promise<{ snapshots: MidSnapshot[]; pools: MidPool[] }> {
  const pools = await readMidPools(db);
  const rows = await db
    .select({
      pool: riskPoolSnapshots.pool,
      fetchedAt: riskPoolSnapshots.fetchedAt,
      midPrice: riskPoolSnapshots.midPrice,
      inBandLiquidity: riskPoolSnapshots.inBandLiquidity,
      methodVersion: riskPoolSnapshots.methodVersion,
      provenance: riskPoolSnapshots.provenance,
    })
    .from(riskPoolSnapshots)
    .innerJoin(riskPools, eq(riskPools.address, riskPoolSnapshots.pool))
    .where(
      and(
        eq(riskPools.quoteMint, USDC_MINT),
        inArray(riskPools.tier, READ_TIERS),
        gte(riskPoolSnapshots.fetchedAt, hours.from),
        lt(riskPoolSnapshots.fetchedAt, hours.to),
      ),
    );
  return {
    pools,
    snapshots: rows.map((r) => ({ ...r, provenance: r.provenance as Provenance })),
  };
}

/** Upserts the bars over the same keys (its own method version only); returns the rows written. */
export async function upsertMidBars(
  db: Db,
  bars: readonly MidBar[],
  chain = 'solana',
): Promise<number> {
  const rows = midBarRows(bars, chain);
  if (!rows.length) return 0;
  const key = ['chain', 'address', 'pool', 'hour', 'methodVersion'];
  const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const set = Object.fromEntries(
    Object.keys(rows[0] as object)
      .filter((k) => !key.includes(k))
      .map((k) => [k, sql.raw(`excluded.${snake(k)}`)]),
  );
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(marketBars)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [
          marketBars.chain,
          marketBars.address,
          marketBars.pool,
          marketBars.hour,
          marketBars.methodVersion,
        ],
        set,
      })
      .returning({ h: marketBars.hour });
    written += res.length;
  }
  return written;
}

if (process.argv[1]?.endsWith('mid-bars.ts') || process.argv[1]?.endsWith('mid-bars.mjs')) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const at = args.indexOf(k);
    const v = at >= 0 ? args[at + 1] : undefined;
    return v === undefined || v.startsWith('--') ? undefined : v;
  };
  const dry = args.includes('--dry-run');
  const files = args.includes('--fill-from-files');
  const sinceHours = Number(opt('--since-hours') ?? 6);
  const at = (k: string) => (opt(k) === undefined ? null : new Date(opt(k) as string));
  const known = new Set([
    '--dry-run',
    '--since-hours',
    '--fill-from-files',
    '--from',
    '--to',
    '--write-window',
  ]);
  const takesValue = new Set([
    '--since-hours',
    '--fill-from-files',
    '--from',
    '--to',
    '--write-window',
  ]);
  const window = args.includes('--write-window') ? parseWriteWindow(opt('--write-window')) : null;
  const [fromArg, toArg] = [at('--from'), at('--to')];
  if (
    !Number.isInteger(sinceHours) ||
    sinceHours < 1 ||
    sinceHours > 24 * 31 ||
    (files && args.includes('--since-hours')) ||
    (args.includes('--write-window') && (window === null || files)) ||
    (!files && (args.includes('--from') || args.includes('--to'))) ||
    [fromArg, toArg].some(
      (d) => d !== null && (!Number.isFinite(d.getTime()) || d.getTime() % HOUR_MS !== 0),
    ) ||
    args.some((a, k) =>
      a.startsWith('--') ? !known.has(a) : !takesValue.has(args[k - 1] as string),
    )
  ) {
    console.error(
      'usage: pnpm risk:assets-mid-bars [--since-hours <n, 1 to 744>] [--dry-run] [--write-window <from>-<to>] | --fill-from-files [dir] [--from <hour>] [--to <hour>] [--dry-run]',
    );
    process.exit(1);
  }
  const t0 = Date.now();
  const outside = () => window !== null && outsideWriteWindow(t0, Date.now(), window);
  const skip = (when: string) =>
    console.log(
      JSON.stringify({
        chain: 'solana',
        skipped: `outside minutes ${window?.from} to ${window?.to} UTC of the hour the run started in (${when}): nothing written; the next run rebuilds these hours`,
      }),
    );
  if (outside()) {
    skip('before reading');
    process.exit(0);
  }
  if (window !== null && !dry) {
    exitCleanlyWhenOffline('hosted-bars-solana');
    const dbHost = hostOf(process.env.DATABASE_URL);
    const offline = await waitForNetwork(dbHost ? [{ host: dbHost }] : [], {
      until: Math.min(t0 + 120_000, windowEnd(t0, window)),
      log: (l) => console.log(l),
    });
    if (offline) exitOffline('hosted-bars-solana', offline);
    if (outside()) {
      skip('before reading');
      process.exit(0);
    }
  }
  const { db, client } = createDb();
  try {
    let hours: { from: Date; to: Date };
    let snapshots: MidSnapshot[];
    let pools: MidPool[];
    let fromFiles: Record<string, unknown> | null = null;
    if (files) {
      const dir = opt('--fill-from-files') ?? join(homedir(), '.colosseum', 'hosted-risk', 'pools');
      const bounds = await fillBounds(db);
      const auto = fillHours(bounds.newestSwapBar, bounds.firstSnapshot, new Date(t0));
      hours = { from: fromArg ?? auto.from, to: toArg ?? auto.to };
      pools = await readMidPools(db);
      const read = await readDayFileSnapshots(dir, hours, new Set(pools.map((p) => p.address)));
      snapshots = read.snapshots;
      fromFiles = {
        dir: dir.replace(homedir(), '~'),
        newestSwapBar: bounds.newestSwapBar?.toISOString() ?? null,
        firstSnapshot: bounds.firstSnapshot?.toISOString() ?? null,
        files: read.files,
        lines: read.lines,
        unreadable: read.unreadable,
      };
    } else {
      hours = midBarHours(new Date(t0), sinceHours);
      ({ snapshots, pools } = await readMidSnapshots(db, hours));
    }
    const bars = midBars(snapshots, pools, hours, files ? 'day_files' : 'snapshots');
    const late = !dry && outside();
    if (late) skip('before writing');
    const written = dry || late ? 0 : await upsertMidBars(db, bars);
    const tokens = new Set(bars.map((b) => b.address));
    console.log(
      JSON.stringify({
        chain: 'solana',
        dryRun: dry,
        methodVersion: MIDS_METHOD_VERSION,
        hours: { from: hours.from.toISOString(), toExclusive: hours.to.toISOString() },
        ...(fromFiles ? { fromFiles } : {}),
        usdcPools: pools.length,
        snapshots: snapshots.length,
        poolsWithSnapshots: new Set(snapshots.map((s) => s.pool)).size,
        tokens: tokens.size,
        bars: bars.length,
        newestHour: bars.at(-1)?.hour.toISOString() ?? null,
        written,
        seconds: Math.round((Date.now() - t0) / 1000),
      }),
    );
  } finally {
    await client.end();
  }
}
