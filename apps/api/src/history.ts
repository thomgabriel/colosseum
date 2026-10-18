import {
  type Db,
  riskAssetSnapshots,
  riskLendingFacts,
  riskLendingSnapshots,
  riskReferencePrices,
} from '@colosseum/db';
import {
  dailyCloses,
  fitCurve,
  maxNotionalAt,
  type PricePoint,
  type Regime,
  type RegimeParams,
  regimeAt,
} from '@colosseum/risk';
import { type AnyColumn, and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';

/**
 * Time series for line charts (`/risk/assets/:id/history`, `/risk/assets/:id/prices`,
 * `/risk/facts/lending/:account/history`). Stored measurements only: every point is one stored row (the last of its
 * UTC hour or day), nothing interpolated or extrapolated; a value that cannot be computed is `null`, never 0.
 */
export const HISTORY_METHOD_VERSION = 'history-0.1';

type Provenance = 'live' | 'mock' | 'sandbox' | 'fixture' | 'prior_dataset';
/** One label for a series: the rows' own when they agree, else the first that is not `live` (never shown as live). */
export const seriesProvenance = (xs: Provenance[]): Provenance =>
  xs.find((p) => p !== 'live') ?? 'live';

type CurvePt = { notionalUsd: number; outUsd: number };

/**
 * A stored side cut, in the database, to what `capacityAtTau` reads: `[notionalUsd, outUsd]` of each point
 * whose outUsd is a number, in the stored order. The numbers are the stored JSON's, not floats the
 * database printed. A snapshot's side holds the collector's route detail beside the two numbers (pool,
 * mid, cost, fill), about three quarters of what a row ships; the series read only the two.
 */
export const curvePairs = (side: AnyColumn): SQL<Array<[number, number]>> =>
  sql<
    Array<[number, number]>
  >`(select coalesce(jsonb_agg(jsonb_build_array(p.pt->'notionalUsd', p.pt->'outUsd') order by p.ord), '[]'::jsonb) from jsonb_array_elements(case when jsonb_typeof(${side}) = 'array' then ${side} else '[]'::jsonb end) with ordinality p(pt, ord) where jsonb_typeof(p.pt->'outUsd') = 'number')`;

/**
 * A stored side cut, in the database, to each point's `notionalUsd` and `outUsd`, in the stored order: every
 * point kept, each key there or absent as stored, the numbers the stored JSON's. For a read that does its own
 * arithmetic on the two and nothing else, without the collector's route detail.
 */
export const curveNotionalOut = (side: AnyColumn): SQL<Array<Record<string, unknown>>> =>
  sql<
    Array<Record<string, unknown>>
  >`(select coalesce(jsonb_agg(case when jsonb_typeof(p.pt) = 'object' then p.pt - array(select k from jsonb_object_keys(p.pt) k where k not in ('notionalUsd', 'outUsd')) else p.pt end order by p.ord), '[]'::jsonb) from jsonb_array_elements(case when jsonb_typeof(${side}) = 'array' then ${side} else '[]'::jsonb end) with ordinality p(pt, ord))`;

/**
 * The first point of a stored side whose `notionalUsd` is the number `notionalUsd` (compared as a double, as
 * JavaScript compares the parsed point), cut to its `outUsd` as stored; null when no point is at that size.
 * The heatmap reads one point of each snapshot, not the side.
 */
export const curvePointAt = (
  side: AnyColumn,
  notionalUsd: number,
): SQL<{ outUsd?: unknown } | null> =>
  sql<{
    outUsd?: unknown;
  } | null>`(select p.pt - array(select k from jsonb_object_keys(p.pt) k where k <> 'outUsd') from jsonb_array_elements(case when jsonb_typeof(${side}) = 'array' then ${side} else '[]'::jsonb end) with ordinality p(pt, ord) where jsonb_typeof(p.pt) = 'object' and case when jsonb_typeof(p.pt->'notionalUsd') = 'number' then (p.pt->>'notionalUsd')::float8 = ${notionalUsd}::float8 else false end order by p.ord limit 1)`;

/** `curvePairs` back as the points `capacityAtTau` reads. */
export const fromPairs = (xs: Array<[number, number]>): CurvePt[] =>
  xs.map(([notionalUsd, outUsd]) => ({ notionalUsd, outUsd }));

/**
 * Capacity at cost tolerance `tau` of one routed snapshot side: the computation `loadAssetFacts` runs for its
 * capacity series (fitCurve over cost = 1 − outUsd ÷ notionalUsd, quantile 0.5, minSamples 1, then
 * maxNotionalAt). Buy points are USD spent → asset received valued at the reference mid (collector
 * `routed_greedy`), so the same cost formula holds. `null` when the side has no finite point.
 */
export function capacityAtTau(
  side: unknown,
  tau: number,
): { capacityUsd: number | null; lowerBound: boolean } {
  const pts = ((side as CurvePt[] | null) ?? []).filter((p) => Number.isFinite(p.outUsd));
  if (!pts.length) return { capacityUsd: null, lowerBound: false };
  const c = fitCurve(
    pts.map((p) => ({ notionalUsd: p.notionalUsd, cost: 1 - p.outUsd / p.notionalUsd })),
    { quantile: 0.5, minSamples: 1 },
  );
  const m = maxNotionalAt(c, tau);
  return { capacityUsd: m.notionalUsd, lowerBound: m.lowerBound };
}

/** The last row of each UTC hour or UTC day, oldest first. */
export function lastPerBucket<T>(rows: T[], at: (r: T) => Date, bucket: 'hour' | 'day'): T[] {
  const len = bucket === 'hour' ? 13 : 10; // ISO prefix: YYYY-MM-DDTHH or YYYY-MM-DD
  const out = new Map<string, T>();
  for (const r of rows) {
    const k = at(r).toISOString().slice(0, len);
    const prev = out.get(k);
    if (!prev || at(r).getTime() >= at(prev).getTime()) out.set(k, r);
  }
  return [...out.values()].sort((a, b) => at(a).getTime() - at(b).getTime());
}

const span = (ts: string[]) => ({ from: ts[0] ?? null, to: ts.at(-1) ?? null });

// ---------------------------------------------------------------- asset capacity history

export type AssetSnapshotRow = {
  fetchedAt: Date;
  sell: unknown;
  buy: unknown;
  refMidUsd: number | null;
  pools: number;
};
export type AssetHistoryPoint = {
  t: string;
  regime: Regime;
  sellCapacityUsd: number | null;
  sellLowerBound: boolean;
  buyCapacityUsd: number | null;
  buyLowerBound: boolean;
  refMidUsd: number | null;
  pools: number;
};

export function assetHistoryPoints(
  snaps: AssetSnapshotRow[],
  tau: number,
  regimeParams: RegimeParams,
): AssetHistoryPoint[] {
  return lastPerBucket(snaps, (s) => s.fetchedAt, 'hour').map((s) => {
    const sell = capacityAtTau(s.sell, tau);
    const buy = capacityAtTau(s.buy, tau);
    return {
      t: s.fetchedAt.toISOString(),
      regime: regimeAt(s.fetchedAt, regimeParams),
      sellCapacityUsd: sell.capacityUsd,
      sellLowerBound: sell.lowerBound,
      buyCapacityUsd: buy.capacityUsd,
      buyLowerBound: buy.lowerBound,
      refMidUsd: Number.isFinite(s.refMidUsd) ? s.refMidUsd : null,
      pools: s.pools,
    };
  });
}

export async function loadAssetHistory(
  db: Db,
  mint: string,
  opts: { days: number; tau: number; now?: Date; regimeParams: RegimeParams },
) {
  const now = opts.now ?? new Date();
  const inWindow = and(
    eq(riskAssetSnapshots.assetMint, mint),
    gte(riskAssetSnapshots.fetchedAt, new Date(now.getTime() - opts.days * 86_400_000)),
    lte(riskAssetSnapshots.fetchedAt, now),
  );
  // The chart keeps the last row of each UTC hour: only those rows are read, with only what a point
  // needs. What the series says of every row in the window (the newest row's source and method, the
  // method versions, the provenance) is worked out in the database and read as one row.
  const hour = sql`date_trunc('hour', ${riskAssetSnapshots.fetchedAt} at time zone 'UTC')`;
  const [rows, [all]] = await Promise.all([
    db
      .selectDistinctOn([hour], {
        fetchedAt: riskAssetSnapshots.fetchedAt,
        sell: curvePairs(riskAssetSnapshots.sell),
        buy: curvePairs(riskAssetSnapshots.buy),
        refMidUsd: riskAssetSnapshots.refMidUsd,
        pools: riskAssetSnapshots.pools,
      })
      .from(riskAssetSnapshots)
      .where(inWindow)
      .orderBy(hour, desc(riskAssetSnapshots.fetchedAt)),
    db
      .select({
        head: sql<
          string | null
        >`(array_agg(${riskAssetSnapshots.source} || '; ' || ${riskAssetSnapshots.method} order by ${riskAssetSnapshots.fetchedAt} desc))[1]`,
        versions: sql<string[] | null>`array_agg(distinct ${riskAssetSnapshots.methodVersion})`,
        notLive: sql<Provenance | null>`(array_agg(${riskAssetSnapshots.provenance} order by ${riskAssetSnapshots.fetchedAt}) filter (where ${riskAssetSnapshots.provenance} <> 'live'))[1]`,
      })
      .from(riskAssetSnapshots)
      .where(inWindow),
  ]);
  const points = assetHistoryPoints(
    rows.map((r) => ({ ...r, sell: fromPairs(r.sell), buy: fromPairs(r.buy) })),
    opts.tau,
    opts.regimeParams,
  );
  const versions = [...(all?.versions ?? [])].sort();
  return {
    tau: opts.tau,
    days: opts.days,
    resolution: 'hour' as const,
    points,
    ...span(points.map((p) => p.t)),
    source: `risk_asset_snapshots (${all?.head ?? 'no rows in window'}${versions.length ? `; snapshot method ${versions.join(', ')}` : ''})`,
    method: `last snapshot of each UTC hour; per snapshot and side, fitCurve over cost = 1 − outUsd ÷ notionalUsd (quantile 0.5, minSamples 1), then maxNotionalAt(tau); buy side: notionalUsd is USD spent and outUsd the asset received at the reference mid, same cost formula; lowerBound when the cost stays within tau up to the largest simulated size; null when the side has no finite point`,
    methodVersion: HISTORY_METHOD_VERSION,
    provenance: all?.notLive ?? ('live' as const),
  };
}

// ---------------------------------------------------------------- reference prices

export type PriceRow = {
  observedAt: Date;
  priceUsd: number | null;
  regime: string;
  quality: string | null;
  nullReason: string | null;
};
export type PriceSeriesPoint = {
  t: string;
  priceUsd: number | null;
  regime: Regime;
  quality: string | null;
  nullReason: string | null;
};

/**
 * Hourly: every stored hour, nulls kept with their reason. Daily: `dailyCloses` (packages/risk facts/market.ts),
 * the last market-hours price of each US trading day (ET date); a day without one has no point.
 */
export function pricePoints(rows: PriceRow[], resolution: 'hour' | 'day'): PriceSeriesPoint[] {
  const sorted = [...rows].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  if (resolution === 'hour')
    return sorted.map((r) => ({
      t: r.observedAt.toISOString(),
      priceUsd: r.priceUsd,
      regime: r.regime as Regime,
      quality: r.quality,
      nullReason: r.priceUsd === null ? (r.nullReason ?? 'not_collected') : null,
    }));
  const byAt = new Map(sorted.map((r) => [r.observedAt.toISOString(), r]));
  const series: PricePoint[] = sorted
    .filter((r) => r.priceUsd !== null)
    .map((r) => ({
      at: r.observedAt.toISOString(),
      priceUsd: r.priceUsd as number,
      regime: r.regime as Regime,
      quality: r.quality,
    }));
  return dailyCloses(series).map((c) => ({
    t: c.at,
    priceUsd: c.priceUsd,
    regime: (byAt.get(c.at)?.regime ?? 'us_market_hours') as Regime,
    quality: byAt.get(c.at)?.quality ?? null,
    nullReason: null,
  }));
}

export async function loadPriceHistory(db: Db, mint: string, opts: { days: number; now?: Date }) {
  const now = opts.now ?? new Date();
  const [latest] = await db
    .select({ v: riskReferencePrices.methodVersion })
    .from(riskReferencePrices)
    .where(eq(riskReferencePrices.mint, mint))
    .orderBy(desc(riskReferencePrices.methodVersion))
    .limit(1);
  const resolution = opts.days <= 31 ? ('hour' as const) : ('day' as const);
  const rows = latest
    ? await db
        .select({
          observedAt: riskReferencePrices.observedAt,
          priceUsd: riskReferencePrices.priceUsd,
          regime: riskReferencePrices.regime,
          quality: riskReferencePrices.quality,
          nullReason: riskReferencePrices.nullReason,
          source: riskReferencePrices.source,
          method: riskReferencePrices.method,
          provenance: riskReferencePrices.provenance,
        })
        .from(riskReferencePrices)
        .where(
          and(
            eq(riskReferencePrices.mint, mint),
            eq(riskReferencePrices.methodVersion, latest.v),
            gte(riskReferencePrices.observedAt, new Date(now.getTime() - opts.days * 86_400_000)),
            lte(riskReferencePrices.observedAt, now),
          ),
        )
        .orderBy(asc(riskReferencePrices.observedAt))
    : [];
  const points = pricePoints(rows, resolution);
  const head = rows.at(-1);
  return {
    days: opts.days,
    resolution,
    points,
    ...span(points.map((p) => p.t)),
    source: `risk_reference_prices (${head ? `${head.source}; ${head.method}` : 'no rows in window'})`,
    method:
      resolution === 'hour'
        ? 'every stored hourly reference price of the newest method version; an hour without a price is null with its null reason'
        : 'daily close: the last market-hours reference price of each US trading day (ET date), dailyCloses in packages/risk/src/facts/market.ts; a day without a market-hours price has no point; t is the hour of that price',
    methodVersion: latest?.v ?? HISTORY_METHOD_VERSION,
    provenance: seriesProvenance(rows.map((r) => r.provenance)),
  };
}

// ---------------------------------------------------------------- lending pool history

/** The snapshot kinds the lending sheets read: live 5-minute rows and the reconstructed hourly history. */
export const LENDING_HISTORY_KINDS = [
  'kamino_reserve',
  'kamino_reserve_hourly',
  'jl_vault',
  'jl_vault_hourly',
  'jl_liquidity',
];

export type LendingRow = {
  observedAt: Date;
  kind: string;
  available: number | null;
  priceUsd: number | null;
  suppliedUsd: number | null;
  borrowedUsd: number | null;
  shareLentOut: number | null;
  supplyApy: number | null;
  borrowApy: number | null;
  usdNullReason: string | null;
};
export type LendingHistoryPoint = {
  t: string;
  suppliedUsd: number | null;
  borrowedUsd: number | null;
  availableUsd: number | null;
  availableBasis: 'available_x_price' | 'supplied_minus_borrowed_usd' | null;
  availableNullReason: string | null;
  shareLentOut: number | null;
  supplyApy: number | null;
  borrowApy: number | null;
  usdNullReason: string | null;
};

const fin = (x: number | null) => (x !== null && Number.isFinite(x) ? x : null);

/**
 * Available in USD: the stored `available` (whole tokens of idle cash) × the row's price; where `available` is not
 * stored, suppliedUsd − borrowedUsd. A Jupiter Lend vault row (collateral supplied, debt borrowed: two different
 * tokens) has no available cash, so it stays null with `availableNullReason: not_applicable_vault`.
 */
export function lendingPoint(r: LendingRow): LendingHistoryPoint {
  const vault = r.kind.startsWith('jl_vault');
  const avail = fin(r.available);
  const price = fin(r.priceUsd);
  const sUsd = fin(r.suppliedUsd);
  const bUsd = fin(r.borrowedUsd);
  let availableUsd: number | null = null;
  let availableBasis: LendingHistoryPoint['availableBasis'] = null;
  if (!vault && avail !== null && price !== null) {
    availableUsd = avail * price;
    availableBasis = 'available_x_price';
  } else if (!vault && avail === null && sUsd !== null && bUsd !== null) {
    availableUsd = sUsd - bUsd;
    availableBasis = 'supplied_minus_borrowed_usd';
  }
  return {
    t: r.observedAt.toISOString(),
    suppliedUsd: sUsd,
    borrowedUsd: bUsd,
    availableUsd,
    availableBasis,
    availableNullReason:
      availableUsd === null
        ? vault
          ? 'not_applicable_vault'
          : (r.usdNullReason ?? 'not_collected')
        : null,
    shareLentOut: fin(r.shareLentOut),
    supplyApy: fin(r.supplyApy),
    borrowApy: fin(r.borrowApy),
    usdNullReason: sUsd === null || bUsd === null ? (r.usdNullReason ?? 'not_collected') : null,
  };
}

export function lendingHistoryPoints(rows: LendingRow[], resolution: 'hour' | 'day') {
  return lastPerBucket(rows, (r) => r.observedAt, resolution).map(lendingPoint);
}

/** Null when the account has no snapshot row of the kinds the sheets read. */
export async function loadLendingHistory(
  db: Db,
  account: string,
  opts: { days: number; now?: Date },
) {
  const now = opts.now ?? new Date();
  const [any] = await db
    .select({
      venue: riskLendingSnapshots.venue,
      market: riskLendingSnapshots.market,
      symbol: riskLendingSnapshots.symbol,
    })
    .from(riskLendingSnapshots)
    .where(
      and(
        eq(riskLendingSnapshots.account, account),
        inArray(riskLendingSnapshots.kind, LENDING_HISTORY_KINDS),
      ),
    )
    .orderBy(desc(riskLendingSnapshots.observedAt))
    .limit(1);
  if (!any) return null;
  const [sheet] = await db
    .select({
      venue: riskLendingFacts.venue,
      market: riskLendingFacts.market,
      symbol: riskLendingFacts.symbol,
    })
    .from(riskLendingFacts)
    .where(eq(riskLendingFacts.account, account))
    .orderBy(desc(riskLendingFacts.reportAt))
    .limit(1);
  const resolution = opts.days <= 14 ? ('hour' as const) : ('day' as const);
  const inWindow = and(
    eq(riskLendingSnapshots.account, account),
    inArray(riskLendingSnapshots.kind, LENDING_HISTORY_KINDS),
    gte(riskLendingSnapshots.observedAt, new Date(now.getTime() - opts.days * 86_400_000)),
    lte(riskLendingSnapshots.observedAt, now),
  );
  // Only the last row of each UTC hour or day is read (the live rows come every five minutes), with what
  // a point needs; the kinds, sources and provenance of every row in the window come grouped.
  // the unit as text of the statement, not a parameter: DISTINCT ON must match the ORDER BY's expression
  const bucket = sql`date_trunc(${sql.raw(`'${resolution}'`)}, ${riskLendingSnapshots.observedAt} at time zone 'UTC')`;
  const [rows, groups] = await Promise.all([
    db
      .selectDistinctOn([bucket], {
        observedAt: riskLendingSnapshots.observedAt,
        kind: riskLendingSnapshots.kind,
        available: riskLendingSnapshots.available,
        priceUsd: riskLendingSnapshots.priceUsd,
        suppliedUsd: riskLendingSnapshots.suppliedUsd,
        borrowedUsd: riskLendingSnapshots.borrowedUsd,
        shareLentOut: riskLendingSnapshots.shareLentOut,
        supplyApy: riskLendingSnapshots.supplyApy,
        borrowApy: riskLendingSnapshots.borrowApy,
        usdNullReason: riskLendingSnapshots.usdNullReason,
      })
      .from(riskLendingSnapshots)
      .where(inWindow)
      .orderBy(bucket, desc(riskLendingSnapshots.observedAt)),
    db
      .select({
        kind: riskLendingSnapshots.kind,
        source: riskLendingSnapshots.source,
        method: riskLendingSnapshots.method,
        provenance: riskLendingSnapshots.provenance,
        first: sql`min(${riskLendingSnapshots.observedAt})`.as('first'),
      })
      .from(riskLendingSnapshots)
      .where(inWindow)
      .groupBy(
        riskLendingSnapshots.kind,
        riskLendingSnapshots.source,
        riskLendingSnapshots.method,
        riskLendingSnapshots.provenance,
      )
      .orderBy(sql`min(${riskLendingSnapshots.observedAt})`),
  ]);
  const points = lendingHistoryPoints(rows, resolution);
  const kinds = [...new Set(groups.map((r) => r.kind))].sort();
  // in the order each first appears, as the rows oldest first would give them
  const sources = [...new Set(groups.map((r) => `${r.source}; ${r.method}`))];
  return {
    account,
    venue: sheet?.venue ?? any.venue,
    market: sheet?.market ?? any.market,
    symbol: sheet?.symbol ?? any.symbol ?? null,
    days: opts.days,
    resolution,
    points,
    ...span(points.map((p) => p.t)),
    source: `risk_lending_snapshots (${kinds.length ? kinds.join(', ') : 'no rows in window'}${sources.length ? `: ${sources.join(' | ')}` : ''})`,
    method: `last observation of each UTC ${resolution} across the live 5-minute rows and the reconstructed hourly history (kinds ${LENDING_HISTORY_KINDS.join(', ')}); USD figures as stored; availableUsd = stored available (whole tokens) × the row's priceUsd, or suppliedUsd − borrowedUsd where available is not stored (availableBasis says which); null with availableNullReason not_applicable_vault for a Jupiter Lend vault (collateral and debt are different tokens); a missing supplied or borrowed USD figure is null with usdNullReason`,
    methodVersion: HISTORY_METHOD_VERSION,
    provenance: seriesProvenance(groups.map((r) => r.provenance)),
  };
}
