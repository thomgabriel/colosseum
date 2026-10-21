// `pnpm risk:assets-mid-bars [--since-hours <n>] [--dry-run]` (gate HOURLY-BARS): Solana's hourly token bars
// (`market_bars`, `pool = 'asset'`, `mids-0.1`) from the pool collector's mid prices, read from `risk_pool_snapshots`
// and `risk_pools` of the same database it writes to: no file, no RPC. The rule is `midBars` of `@colosseum/risk`
// (one USDC pool an hour, the deepest; no volume). It rebuilds the complete hours of the last n hours (default 6:
// a late import is caught up by a later run) and upserts them over its own rows of those hours; a bar of another
// method version (the backfill's or the swap history's `bars-0.1`) is another key and is never touched. --dry-run
// builds and counts and writes nothing. The hosted job runs it every hour at minute 19
// (scripts/ops/install-hosted-bars.sh solana); once at the install with --since-hours 96, the four days the hosted
// database keeps of pool snapshots (DB-RETENTION).
import 'dotenv/config';
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
import { and, eq, gte, lt, sql } from 'drizzle-orm';

const HOUR_MS = 3_600_000;

/** The hours a run rebuilds: the `sinceHours` complete hours before `now`'s own hour. */
export function midBarHours(now: Date, sinceHours: number): { from: Date; to: Date } {
  const to = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return { from: new Date(to - sinceHours * HOUR_MS), to: new Date(to) };
}

/** The rows `market_bars` takes for Solana. */
export const midBarRows = (bars: readonly MidBar[], chain = 'solana') =>
  bars.map((b) => ({ chain, ...b })) satisfies Array<typeof marketBars.$inferInsert>;

type Db = ReturnType<typeof createDb>['db'];

/** The snapshots of the registry's USDC pools in the hours, and those pools: only the columns the bars read. */
export async function readMidSnapshots(
  db: Db,
  hours: { from: Date; to: Date },
): Promise<{ snapshots: MidSnapshot[]; pools: MidPool[] }> {
  const pools = await db
    .select({
      address: riskPools.address,
      assetMint: riskPools.assetMint,
      quoteMint: riskPools.quoteMint,
      venue: riskPools.venue,
    })
    .from(riskPools)
    .where(eq(riskPools.quoteMint, USDC_MINT));
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
  const dry = args.includes('--dry-run');
  const i = args.indexOf('--since-hours');
  const sinceHours = Number(i >= 0 ? args[i + 1] : 6);
  const known = new Set(['--dry-run', '--since-hours']);
  if (
    !Number.isInteger(sinceHours) ||
    sinceHours < 1 ||
    sinceHours > 24 * 31 ||
    args.some((a, k) => a.startsWith('--') && !known.has(a) && args[k - 1] !== '--since-hours')
  ) {
    console.error('usage: pnpm risk:assets-mid-bars [--since-hours <n, 1 to 744>] [--dry-run]');
    process.exit(1);
  }
  const t0 = Date.now();
  const hours = midBarHours(new Date(t0), sinceHours);
  const { db, client } = createDb();
  try {
    const { snapshots, pools } = await readMidSnapshots(db, hours);
    const bars = midBars(snapshots, pools, hours);
    const written = dry ? 0 : await upsertMidBars(db, bars);
    const tokens = new Set(bars.map((b) => b.address));
    console.log(
      JSON.stringify({
        chain: 'solana',
        dryRun: dry,
        methodVersion: MIDS_METHOD_VERSION,
        hours: { from: hours.from.toISOString(), toExclusive: hours.to.toISOString() },
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
