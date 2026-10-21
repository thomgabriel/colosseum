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

/**
 * Deletes a chain's pool bars older than `before` that the held history wrote: the hosted job keeps a pool's bars
 * for POOL_BAR_HOURS. A row of the backfill import is never deleted here, so a database that keeps every bar (the
 * local one) loses none of what cannot be built again from files on hand.
 */
export async function dropOldPoolBars(db: Db, chain: string, before: Date): Promise<number> {
  const gone = await db
    .delete(marketBars)
    .where(
      and(
        eq(marketBars.chain, chain),
        ne(marketBars.pool, 'asset'),
        lt(marketBars.hour, before),
        sql`not (${marketBars.source} like '<ASSETS_DATA_DIR>/%' or ${marketBars.source} like '%in the asset backfill''s day files%')`,
      ),
    )
    .returning({ hour: marketBars.hour });
  return gone.length;
}
