// The bars the asset lookups read, and no other (apps/api/src/asset-lookups.ts): what a database with no room for
// every bar keeps (the hosted one: Neon's 1 GB, gate DB-RETENTION). The lookups read
//   - the token rows (`pool = 'asset'`) over at most 30 days (asset_price_history), and
//   - the rows of the pools a token's newest `pool_tvl_usd` reading lists, at most five by dollars held
//     (`topPools`), over the last day (asset_pools' volume).
// They never read `detail`, so these rows carry an empty one: it is most of a bar's size (a third to a half).
// Used by `pnpm risk:assets-bars <chain> --lookups-only` (the hosted bars job) and `pnpm ops:copy-token-bars`.
import { assetObservations, type Db, marketBars } from '@colosseum/db';
import { topPools } from '@colosseum/risk';
import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { BarRow } from './bars-rows';

/** How long the hosted database keeps a pool's bars: the lookups read the last day of them. */
export const POOL_BAR_HOURS = 48;

/** Each token's top pools by dollars held, keyed by the token's address. */
export type TopPools = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The rows the lookups read, with `detail` emptied: every token row from `since` on, and the rows of each token's
 * top pools from `poolSince` on. Pure.
 */
export function lookupRows(
  rows: readonly BarRow[],
  top: TopPools,
  opts: { since: Date; poolSince: Date },
): BarRow[] {
  const out: BarRow[] = [];
  for (const r of rows) {
    const t = (r.hour as Date).getTime();
    const keep =
      r.pool === 'asset'
        ? t >= opts.since.getTime()
        : t >= opts.poolSince.getTime() && (top.get(r.address)?.has(r.pool) ?? false);
    if (keep) out.push({ ...r, detail: {} });
  }
  return out;
}

/** The rows whose hour is in [from, to) (ms): the hours a run writes (recent-walk.ts hoursToWrite). Pure. */
export function rowsInHours(
  rows: readonly BarRow[],
  hours: { from: number; to: number },
): BarRow[] {
  return rows.filter((r) => {
    const t = (r.hour as Date).getTime();
    return t >= hours.from && t < hours.to;
  });
}

/** The newest hour of the token rows (`pool = 'asset'`) of a write, in ms; null when it holds none. Pure. */
export function newestTokenHour(rows: readonly BarRow[]): number | null {
  let newest: number | null = null;
  for (const r of rows)
    if (r.pool === 'asset')
      newest = Math.max(newest ?? Number.NEGATIVE_INFINITY, (r.hour as Date).getTime());
  return newest;
}

/** Each token's top pools of a chain, from its newest `pool_tvl_usd` reading (as the lookups choose them). */
export async function readTopPools(db: Db, chain: string): Promise<Map<string, Set<string>>> {
  const rows = await db
    .selectDistinctOn([assetObservations.address], {
      address: assetObservations.address,
      detail: assetObservations.detail,
    })
    .from(assetObservations)
    .where(and(eq(assetObservations.chain, chain), eq(assetObservations.metric, 'pool_tvl_usd')))
    .orderBy(
      assetObservations.address,
      desc(assetObservations.observedAt),
      desc(assetObservations.fetchedAt),
    );
  const top = new Map<string, Set<string>>();
  for (const r of rows) {
    const pools = topPools(r.detail as Record<string, unknown> | null);
    if (pools.length) top.set(r.address, new Set(pools.map((p) => p.address)));
  }
  return top;
}

/** Whether a connection address names a database on this machine (or none: createDb's default is local). */
export function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return true;
  }
}

/** The held pool bars older than `before` that dropOldPoolBars would delete. */
const oldHeldPoolBars = (chain: string, before: Date) =>
  and(
    eq(marketBars.chain, chain),
    ne(marketBars.pool, 'asset'),
    lt(marketBars.hour, before),
    sql`not (${marketBars.source} like '<ASSETS_DATA_DIR>/%' or ${marketBars.source} like '%in the asset backfill''s day files%')`,
  );

/** How many rows dropOldPoolBars would delete: what a dry run says. */
export async function countOldPoolBars(db: Db, chain: string, before: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marketBars)
    .where(oldHeldPoolBars(chain, before));
  return Number(r?.n ?? 0);
}

/**
 * Deletes a chain's pool bars older than `before` that the held history wrote: the hosted job keeps a pool's bars
 * for POOL_BAR_HOURS. A row of the backfill import is never deleted here, so a database that keeps every bar (the
 * local one) loses none of what cannot be built again from files on hand.
 */
export async function dropOldPoolBars(db: Db, chain: string, before: Date): Promise<number> {
  const gone = await db
    .delete(marketBars)
    .where(oldHeldPoolBars(chain, before))
    .returning({ hour: marketBars.hour });
  return gone.length;
}
