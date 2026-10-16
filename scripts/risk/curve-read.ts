import type { Db } from '@colosseum/db';
import { type Regime, type RegimeParams, regimeSpans } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import type { CurveSamples, MintMeta } from './curve-rows';

// What `pnpm risk:compute` reads of risk_asset_snapshots, reduced in the database: per mint, side, regime
// and grid notional, the quantile of the cost and the count, instead of every snapshot's curves (the whole
// table, about 77 MB an hour when this was written). The reduction is `curveRows`'s, step for step:
//   - a point counts when its `outUsd` is a number; within one snapshot and side the last point of a
//     notional wins, as a Map keyed by notional keeps it;
//   - cost = 1 − outUsd ÷ notionalUsd; a cost that is not finite (no notional, or a notional of zero) is
//     a sample of its bucket, in its count and its times, and no grid point's;
//   - each snapshot's regime is `regimeAt`'s, handed to the database as spans (`regimeSpans`);
//   - the quantile is `percentile_cont`, which interpolates between the two nearest costs as `quantileOf`,
//     and leaves the database at full precision: the hosted one rounds a float to 15 digits on the way out
//     (`extra_float_digits` = 0), so the read sets it back to the shortest exact form for its transaction.
// tests/risk-layer/compute-read.test.ts holds the rows it gives to the rows `curveRows` gives.

type GroupRow = {
  asset_mint: string;
  side: 'sell' | 'buy';
  regime: Regime;
  samples: number;
  data_from: Date;
  data_to: Date;
  grid: Array<[number, number, number]>;
};

export async function readCurveSamples(
  db: Db,
  opts: { quantile: number; regimeParams: RegimeParams },
): Promise<{ groups: CurveSamples[]; meta: Map<string, MintMeta>; snapshots: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local extra_float_digits = 1`);
    return readIn(tx as unknown as Db, opts);
  });
}

async function readIn(
  db: Db,
  opts: { quantile: number; regimeParams: RegimeParams },
): Promise<{ groups: CurveSamples[]; meta: Map<string, MintMeta>; snapshots: number }> {
  const metaRows = (await db.execute(sql`
    select distinct on (asset_mint) asset_mint, asset, method_version
    from risk_asset_snapshots
    order by asset_mint, fetched_at desc`)) as unknown as Array<{
    asset_mint: string;
    asset: string;
    method_version: string;
  }>;
  const meta = new Map(
    metaRows.map((r) => [r.asset_mint, { asset: r.asset, version: r.method_version }]),
  );
  const [range] = (await db.execute(sql`
    select min(fetched_at) as lo, max(fetched_at) as hi, count(*)::int as n
    from risk_asset_snapshots`)) as unknown as Array<{
    lo: Date | null;
    hi: Date | null;
    n: number;
  }>;
  if (!range?.lo || !range.hi) return { groups: [], meta, snapshots: 0 };
  const spans = regimeSpans(new Date(range.lo), new Date(range.hi), opts.regimeParams).map((s) => [
    s.from.toISOString(),
    s.to.toISOString(),
    s.regime,
  ]);
  const rows = (await db.execute(sql`
    with spans as (
      select (s->>0)::timestamptz as lo, (s->>1)::timestamptz as hi, s->>2 as regime
      from jsonb_array_elements(${JSON.stringify(spans)}::jsonb) s
    ),
    snaps as (
      select a.asset_mint, a.fetched_at, sp.regime, a.sell, a.buy
      from risk_asset_snapshots a
      join spans sp on a.fetched_at >= sp.lo and a.fetched_at < sp.hi
    ),
    pts as (
      select distinct on (s.asset_mint, s.fetched_at, v.side, n)
        s.asset_mint, s.fetched_at, s.regime, v.side,
        case when jsonb_typeof(p.pt->'notionalUsd') = 'number'
          then (p.pt->>'notionalUsd')::float8 end as n,
        (p.pt->>'outUsd')::float8 as out_usd
      from snaps s
      cross join lateral (values ('sell', s.sell), ('buy', s.buy)) v(side, arr)
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(v.arr) = 'array' then v.arr else '[]'::jsonb end
      ) with ordinality p(pt, ord)
      where jsonb_typeof(p.pt->'outUsd') = 'number'
      order by s.asset_mint, s.fetched_at, v.side, n, p.ord desc
    ),
    costs as (
      select asset_mint, side, regime, n, fetched_at,
        case when n <> 0 then 1 - out_usd / n end as cost
      from pts
    ),
    grid as (
      select asset_mint, side, regime, n,
        percentile_cont(${opts.quantile}::float8) within group (order by cost) as q,
        count(*)::int as k
      from costs where cost is not null
      group by asset_mint, side, regime, n
    ),
    grids as (
      select asset_mint, side, regime, jsonb_agg(jsonb_build_array(n, q, k) order by n) as grid
      from grid group by asset_mint, side, regime
    ),
    buckets as (
      select asset_mint, side, regime, count(*)::int as samples,
        min(fetched_at) as data_from, max(fetched_at) as data_to
      from costs group by asset_mint, side, regime
    )
    select b.asset_mint, b.side, b.regime, b.samples, b.data_from, b.data_to,
      coalesce(g.grid, '[]'::jsonb) as grid
    from buckets b
    left join grids g using (asset_mint, side, regime)
    order by b.asset_mint, b.side, b.regime`)) as unknown as GroupRow[];
  const groups = rows.map((r) => ({
    assetMint: r.asset_mint,
    side: r.side,
    regime: r.regime,
    grid: r.grid.map(([notionalUsd, cost, samples]) => ({ notionalUsd, cost, samples })),
    from: new Date(r.data_from).toISOString(),
    to: new Date(r.data_to).toISOString(),
    samples: r.samples,
  }));
  return { groups, meta, snapshots: range.n };
}
