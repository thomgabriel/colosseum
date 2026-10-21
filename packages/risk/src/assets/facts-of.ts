import type { Fact, FactNullReason, LendingPoolFacts, Provenance } from '@colosseum/schemas';
import { ASSET_METRICS, type AssetMetric, METRIC_CADENCE } from './metrics';

// The facts of one asset, as the conversations look them up (gate FIGURES-BY-REFERENCE as amended
// 2026-10-14, ledger API-AGENT-LOOKUPS-1): the rows the API reads, turned into figures. Pure: no I/O and no
// clock; the caller hands in the rows and `now`. Every figure carries its source, method (with its version),
// time and provenance, or is null with a reason; a missing figure is never zero, and a figure past its age is
// served with that age, never silently as fresh. Prices here are the DEX bars' dollar columns only; an oracle's
// price is never read here and never blended in (ORACLE-VS-DEX).

/** The units a looked-up figure is in: those of `asset_observations`, and hours for a gap in the bars. */
export type FigureUnit = 'usd' | 'tokens' | 'fraction' | 'count' | 'ratio' | 'hours';

/** One figure: a value with its pin, or null with why. `key` names it within its part. */
export type AssetFigure =
  | {
      key: string;
      value: number;
      unit: FigureUnit;
      source: string;
      method: string;
      fetchedAt: string;
      provenance: Provenance;
      /** The true value is at least this. */
      lowerBound?: true;
      /** The reading is older than its job's limit by its cadence: this is its age, in seconds. */
      staleAgeSec?: number;
    }
  | { key: string; value: null; reason: FactNullReason; missingHours?: number };

const HOUR_MS = 3_600_000;
const UNITS: readonly FigureUnit[] = ['usd', 'tokens', 'fraction', 'count', 'ratio', 'hours'];
const KNOWN_REASONS: readonly FactNullReason[] = [
  'no_samples_in_regime',
  'insufficient_samples',
  'not_a_number',
  'beyond_measured_size',
  'no_reference_price',
  'no_external_source',
  'chain_not_covered',
  'not_collected',
  'not_imported',
  'not_followed',
  'gate_open',
  'not_applicable',
  'no_oracle',
];

/**
 * The reason a stored null reading gives, in the words a fact uses. The metrics job writes its own reasons
 * (metrics.ts, metric-rows.ts, evm.ts); those not listed are `not_collected`: the fact exists and we do not
 * hold it.
 */
const NULL_REASON_OF: Record<string, FactNullReason> = {
  not_a_finite_number: 'not_a_number',
  // the metric does not exist for this token
  not_an_exchange_rate_token: 'not_applicable',
  not_a_dollar_yield_token: 'not_applicable',
  // a realised yield over too short a history
  insufficient_history: 'insufficient_samples',
  insufficient_price_history: 'insufficient_samples',
  // a realised yield that needs a price its source does not give
  not_priced_by_source: 'no_reference_price',
  no_price_in_answer: 'no_reference_price',
  // the structurer's registry yields are kept in `yield_observations`, which the lookups do not read
  in_yield_observations: 'not_imported',
};

/** A stored `null_reason` as a fact's reason; one the job does not name here is `not_collected`. */
export function factNullReason(reason: string | null | undefined): FactNullReason {
  if (!reason) return 'not_collected';
  if ((KNOWN_REASONS as readonly string[]).includes(reason)) return reason as FactNullReason;
  return NULL_REASON_OF[reason] ?? 'not_collected';
}

/** A figure's label is worst of its parts: anything that is not live stays what it is. */
export const worstProvenance = (a: Provenance, b: Provenance): Provenance =>
  a === b || b === 'live' ? a : a === 'live' ? b : 'mock';

const missing = (key: string, reason: FactNullReason, missingHours?: number): AssetFigure =>
  missingHours === undefined
    ? { key, value: null, reason }
    : { key, value: null, reason, missingHours };

// ------------------------------------------------------------------------------------------------- profile

/** One `asset_observations` row, times as ISO strings. */
export type ObservationRow = {
  metric: string;
  value: number | null;
  unit: string;
  nullReason: string | null;
  observedAt: string;
  fetchedAt: string;
  source: string;
  method: string;
  methodVersion: string;
  provenance: Provenance;
  detail?: Record<string, unknown>;
};

/** How long a metric's reading is served as current: three of its job's intervals. */
export function staleAfterSec(metric: string): number {
  const cadence =
    METRIC_CADENCE[metric as AssetMetric] ?? (metric.startsWith('yield_') ? 'hourly' : 'daily');
  return 3 * (cadence === 'hourly' ? 3_600 : 86_400);
}

/** Seconds since `at`, when past `limit`; undefined while it is within. */
function ageOver(at: string, now: Date, limit: number): number | undefined {
  const age = Math.floor((now.getTime() - Date.parse(at)) / 1_000);
  return Number.isFinite(age) && age > limit ? age : undefined;
}

/** The newest row of each metric: by the time the state refers to, then by when it was read. */
export function newestByMetric(rows: readonly ObservationRow[]): ObservationRow[] {
  const newest = new Map<string, ObservationRow>();
  for (const row of rows) {
    const kept = newest.get(row.metric);
    const later =
      !kept ||
      Date.parse(row.observedAt) > Date.parse(kept.observedAt) ||
      (row.observedAt === kept.observedAt &&
        Date.parse(row.fetchedAt) > Date.parse(kept.fetchedAt));
    if (later) newest.set(row.metric, row);
  }
  const order = (metric: string) => {
    const at = (ASSET_METRICS as readonly string[]).indexOf(metric);
    return at < 0 ? ASSET_METRICS.length : at;
  };
  return [...newest.values()].sort(
    (a, b) => order(a.metric) - order(b.metric) || a.metric.localeCompare(b.metric),
  );
}

/** One reading as a figure under `key`, with its age when it is past its metric's limit. */
function observationFigure(key: string, row: ObservationRow, now: Date): AssetFigure {
  if (row.value === null) return missing(key, factNullReason(row.nullReason));
  if (!Number.isFinite(row.value)) return missing(key, 'not_a_number');
  const unit = (UNITS as readonly string[]).includes(row.unit) ? (row.unit as FigureUnit) : null;
  if (!unit) return missing(key, 'not_a_number');
  const stale = ageOver(row.observedAt, now, staleAfterSec(row.metric));
  return {
    key,
    value: row.value,
    unit,
    source: row.source,
    method: `${row.method} (${row.methodVersion})`,
    fetchedAt: row.fetchedAt,
    provenance: row.provenance,
    // the sum of a token's pools where some pool could not be measured (metrics.ts, the discovery file)
    ...(row.detail?.lowerBound === true ? { lowerBound: true as const } : {}),
    ...(stale === undefined ? {} : { staleAgeSec: stale }),
  };
}

/**
 * The newest reading of each of the asset's metrics, each under its metric's name (each `yield_<method>`
 * its own). A null reading says why; one older than three of its job's intervals carries its age.
 */
export function profileFigures(rows: readonly ObservationRow[], now: Date): AssetFigure[] {
  return newestByMetric(rows).map((row) => observationFigure(row.metric, row, now));
}

// ------------------------------------------------------------------------------------------- price history

export type LookupWindow = '24h' | '7d' | '30d';
export const WINDOW_HOURS: Record<LookupWindow, number> = { '24h': 24, '7d': 168, '30d': 720 };
/** The bars reach the present when their last hour ended no more than this long before `now`. */
export const BARS_FRESH_MS = 2 * HOUR_MS;

/** One `market_bars` row, its dollar columns only: the quote-token columns are never read here. */
export type BarRow = {
  hour: string;
  closeUsd: number | null;
  highUsd: number | null;
  lowUsd: number | null;
  swaps: number;
  volumeUsd: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  quoteUsdMethod: string | null;
  methodVersion: string;
  source: string;
  method: string;
  fetchedAt: string;
  provenance: Provenance;
};
export type PoolBarRow = BarRow & { pool: string };

/** The keys of a window's figures, in the order they are served. */
export const BAR_KEYS = [
  'close',
  'high',
  'low',
  'change',
  'volume',
  'buyvol',
  'sellvol',
  'swaps',
  'gaps',
] as const;
export type BarKey = (typeof BAR_KEYS)[number];

const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/**
 * Two method versions in order, by their numbers part by part ('bars-0.10' after 'bars-0.9'); a version with
 * no number, or the same numbers, by its text.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.match(/\d+/gu) ?? []).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let at = 0; at < Math.max(x.length, y.length); at += 1) {
    const d = (x[at] ?? -1) - (y[at] ?? -1);
    if (d) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One row an hour: where a bar was built by two method versions, the later version's. */
function oneAnHour<T extends BarRow>(rows: readonly T[]): T[] {
  const byHour = new Map<number, T>();
  for (const row of rows) {
    const at = Date.parse(row.hour);
    const kept = byHour.get(at);
    if (!kept || compareVersions(row.methodVersion, kept.methodVersion) > 0) byHour.set(at, row);
  }
  return [...byHour.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** The hours of a window: the current hour and the ones before it. */
export function windowStart(window: LookupWindow, now: Date): Date {
  return new Date(floorHour(now.getTime()) - (WINDOW_HOURS[window] - 1) * HOUR_MS);
}

/**
 * Whether the bars cover the window. `chainHours` are the hours in which any asset of the chain has a bar: an
 * hour of the window in which none has is an hour the collector did not run (an outage), never a quiet hour,
 * and a window with one is not covered. A quiet hour is one the chain has bars for and this asset has none: a
 * gap. The asset's own history must reach back to the window's start (a bar at or before it, or `before`, the
 * latest bar older than the window), and the chain's latest collected hour must have ended at most
 * `BARS_FRESH_MS` before `now`: the hours after it, within that tolerance, are neither covered nor missing.
 * Covered: `collectedHours`, the window's hours up to the chain's latest collected one. Otherwise, how many
 * of the window's hours were not collected.
 */
export function barCoverage(
  bars: readonly { hour: string }[],
  before: string | null,
  window: LookupWindow,
  now: Date,
  chainHours: readonly string[],
): { covered: true; collectedHours: number } | { covered: false; missingHours: number } {
  const total = WINDOW_HOURS[window];
  const start = windowStart(window, now).getTime();
  const end = start + total * HOUR_MS;
  const inside = (at: number) => Number.isFinite(at) && at >= start && at < end;
  const own = bars.map((bar) => Date.parse(bar.hour)).filter(inside);
  if (!own.length) return { covered: false, missingHours: total };
  // an asset's bar is a bar of its chain: the chain was collected that hour
  const collected = new Set([
    ...chainHours.map((hour) => floorHour(Date.parse(hour))).filter(inside),
    ...own.map(floorHour),
  ]);
  const latest = Math.max(...collected);
  const uncollected = new Set<number>();
  // the asset's history does not reach back to the window's start
  if (before === null)
    for (let at = start; at < Math.min(...own); at += HOUR_MS) uncollected.add(at);
  // an hour in which no asset of the chain has a bar
  for (let at = start; at <= latest; at += HOUR_MS) if (!collected.has(at)) uncollected.add(at);
  // the chain's bars stop short of now by more than the tolerance
  if (now.getTime() - (latest + HOUR_MS) > BARS_FRESH_MS)
    for (let at = latest + HOUR_MS; at < now.getTime() && at < end; at += HOUR_MS)
      uncollected.add(at);
  return uncollected.size
    ? { covered: false, missingHours: Math.min(total, uncollected.size) }
    : { covered: true, collectedHours: Math.round((latest - start) / HOUR_MS) + 1 };
}

/** How the bars put their quotes in dollars, without the pools' addresses: `implied_from_<pool>`. */
function quoteMethods(rows: readonly BarRow[]): string {
  const said = new Set<string>();
  for (const row of rows)
    for (const part of (row.quoteUsdMethod ?? 'none').split(/;\s*/u))
      if (part) said.add(part.replace(/^implied_from_\S+$/u, 'implied_from_<pool>'));
  return [...said].sort().join(', ');
}

/** The pin of a figure made of `rows`: the newest row's source, the oldest read behind it. */
function barPin(rows: readonly BarRow[]) {
  const last = rows.at(-1) as BarRow;
  const versions = [...new Set(rows.map((row) => row.methodVersion))]
    .sort(compareVersions)
    .join(', ');
  return {
    source: `market_bars (DEX swaps; ${last.source})`,
    method: `${last.method}; quote in dollars by ${quoteMethods(rows)} (${versions})`,
    fetchedAt: rows.reduce(
      (oldest, row) => (Date.parse(row.fetchedAt) < Date.parse(oldest) ? row.fetchedAt : oldest),
      last.fetchedAt,
    ),
    provenance: rows.reduce<Provenance>(
      (label, row) => worstProvenance(label, row.provenance),
      'live',
    ),
  };
}

/**
 * The asset's price history over one window, from its `pool = 'asset'` bars in dollars: the latest close,
 * the window's high and low, the change from its first priced close to its last (a past figure, as a
 * fraction), the volume and the volume of purchases and of sales in dollars, the swaps, and the hours with
 * no priced swap among the hours the chain was collected (up to its latest collected hour). A window the bars
 * do not cover (`barCoverage`: an outage of the chain's collector, a history that starts inside the window,
 * bars that stop short of now) answers every figure `not_collected` with the hours missing: never a part of
 * the window shown as the whole of it.
 */
export function priceHistoryFigures(
  rows: readonly BarRow[],
  before: string | null,
  window: LookupWindow,
  now: Date,
  chainHours: readonly string[],
): AssetFigure[] {
  const start = windowStart(window, now).getTime();
  const bars = oneAnHour(rows.filter((row) => Date.parse(row.hour) >= start));
  const coverage = barCoverage(bars, before, window, now, chainHours);
  if (!coverage.covered)
    return BAR_KEYS.map((key) => missing(key, 'not_collected', coverage.missingHours));
  const priced = bars.filter((bar) => bar.closeUsd !== null && Number.isFinite(bar.closeUsd));
  const valued = bars.filter((bar) => bar.volumeUsd !== null && Number.isFinite(bar.volumeUsd));
  const figure = (
    key: BarKey,
    used: readonly BarRow[],
    value: number,
    unit: FigureUnit,
  ): AssetFigure =>
    Number.isFinite(value) ? { key, value, unit, ...barPin(used) } : missing(key, 'not_a_number');
  const out: AssetFigure[] = [];
  const last = priced.at(-1);
  const first = priced[0];
  if (!last || !first) {
    for (const key of ['close', 'high', 'low', 'change'] as const)
      out.push(missing(key, 'no_reference_price'));
  } else {
    out.push(figure('close', [last], last.closeUsd as number, 'usd'));
    const highs = priced.filter((bar) => bar.highUsd !== null);
    const lows = priced.filter((bar) => bar.lowUsd !== null);
    out.push(
      highs.length
        ? figure('high', highs, Math.max(...highs.map((bar) => bar.highUsd as number)), 'usd')
        : missing('high', 'no_reference_price'),
    );
    out.push(
      lows.length
        ? figure('low', lows, Math.min(...lows.map((bar) => bar.lowUsd as number)), 'usd')
        : missing('low', 'no_reference_price'),
    );
    const from = first.closeUsd as number;
    out.push(
      priced.length < 2
        ? missing('change', 'insufficient_samples')
        : from > 0
          ? figure('change', priced, ((last.closeUsd as number) - from) / from, 'fraction')
          : missing('change', 'not_a_number'),
    );
  }
  const sum = (pick: (bar: BarRow) => number | null) =>
    valued.reduce((total, bar) => total + (pick(bar) ?? 0), 0);
  for (const [key, pick] of [
    ['volume', (bar: BarRow) => bar.volumeUsd],
    ['buyvol', (bar: BarRow) => bar.buyVolumeUsd],
    ['sellvol', (bar: BarRow) => bar.sellVolumeUsd],
  ] as const)
    out.push(
      valued.length ? figure(key, valued, sum(pick), 'usd') : missing(key, 'no_reference_price'),
    );
  out.push(
    figure(
      'swaps',
      bars,
      bars.reduce((total, bar) => total + bar.swaps, 0),
      'count',
    ),
  );
  // the hours the chain was collected with no priced swap of the asset; the tolerated tail is not counted
  out.push(figure('gaps', bars, coverage.collectedHours - valued.length, 'hours'));
  return out;
}

// --------------------------------------------------------------------------------------------------- pools

/** At most this many pools are served, the largest by dollars held. */
export const MAX_POOLS = 5;

export type PoolFigures = { rank: number; pool: string; venue: string; figures: AssetFigure[] };

/**
 * The pools a `pool_tvl_usd` reading's `detail.pools` lists, by dollars held, at most five: the pools the asset
 * lookups show, and so the only pools whose bars they use. The jobs that write bars for the lookups alone keep
 * these pools' bars and no other (scripts/risk/assets/lookup-rows.ts).
 */
export function topPools(
  detail: Record<string, unknown> | null | undefined,
): Array<{ address: string; venue: string; tvl: number }> {
  const listed = Array.isArray(detail?.pools) ? (detail.pools as unknown[]) : [];
  return listed
    .flatMap((entry) => {
      const p = entry as Record<string, unknown>;
      const address =
        typeof p.address === 'string' ? p.address : typeof p.id === 'string' ? p.id : null;
      const tvl = typeof p.tvlUsd === 'number' && Number.isFinite(p.tvlUsd) ? p.tvlUsd : null;
      if (!address || tvl === null) return [];
      return [{ address, venue: typeof p.venue === 'string' ? p.venue : 'unknown', tvl }];
    })
    .sort((a, b) => b.tvl - a.tvl || a.address.localeCompare(b.address))
    .slice(0, MAX_POOLS);
}

/**
 * The asset's pools by dollars held, at most five, each with its TVL in dollars, its share of the asset's pool
 * TVL and its volume over the last day in dollars.
 *
 * Where the per-pool TVL comes from: the newest `pool_tvl_usd` reading of `asset_observations`, whose
 * `detail.pools` lists every measured pool the sum was made of with its own TVL. It is the one place that holds
 * a pool's TVL on both chains: `risk_pools.tvl_usd` is Solana's registry alone (and is what the Solana reading
 * sums), the Robinhood Chain reading sums the discovery file's pools, and the per-pool `market_bars` hold
 * swaps, not balances. So the pools, their TVL and the shares all come from one reading, with its age.
 * The volume is each pool's own bars (`market_bars`, `pool` = its address) over the last day, served only
 * when the asset's bars cover that day (`dayCovered`); a pool with no bar in it is not collected, never zero.
 * Where the reading's sum is a lower bound (a pool it could not measure), no pool's share is served.
 */
export function poolFigures(
  reading: ObservationRow | null,
  poolBars: readonly PoolBarRow[],
  dayCovered: ReturnType<typeof barCoverage>,
  now: Date,
): { pools: PoolFigures[]; missing: AssetFigure | null } {
  if (!reading) return { pools: [], missing: missing('tvl', 'not_collected') };
  const whole = observationFigure('tvl', reading, now);
  if (whole.value === null) return { pools: [], missing: whole };
  const pools = topPools(reading.detail);
  if (!pools.length) return { pools: [], missing: missing('tvl', 'not_collected') };
  const start = now.getTime() - 24 * HOUR_MS;
  const pin = {
    source: whole.source,
    fetchedAt: whole.fetchedAt,
    provenance: whole.provenance,
    ...(whole.staleAgeSec === undefined ? {} : { staleAgeSec: whole.staleAgeSec }),
  };
  return {
    missing: null,
    pools: pools.map((pool, index) => {
      const own = oneAnHour(
        poolBars.filter((bar) => bar.pool === pool.address && Date.parse(bar.hour) >= start),
      );
      const valued = own.filter((bar) => bar.volumeUsd !== null && Number.isFinite(bar.volumeUsd));
      const volume: AssetFigure = !dayCovered.covered
        ? missing('volume', 'not_collected', dayCovered.missingHours)
        : !own.length
          ? missing('volume', 'not_collected')
          : !valued.length
            ? missing('volume', 'no_reference_price')
            : {
                key: 'volume',
                value: valued.reduce((total, bar) => total + (bar.volumeUsd as number), 0),
                unit: 'usd',
                ...barPin(valued),
              };
      // A sum that left a pool out (`detail.lowerBound`) is less than the whole: a share of it would be
      // overstated, so it is not measured. The pool's own TVL stands.
      const share: AssetFigure = whole.lowerBound
        ? missing('share', 'not_collected')
        : whole.value > 0
          ? {
              key: 'share',
              value: pool.tvl / whole.value,
              unit: 'fraction',
              ...pin,
              method: `this pool's TVL over the sum of the asset's measured pools, from one reading (${whole.method})`,
            }
          : missing('share', 'not_applicable');
      return {
        rank: index + 1,
        pool: pool.address,
        venue: pool.venue,
        figures: [
          {
            key: 'tvl',
            value: pool.tvl,
            unit: 'usd',
            ...pin,
            method: `this pool's measured TVL in the reading's list of pools (${whole.method})`,
          },
          volume,
          share,
        ],
      };
    }),
  };
}

// ------------------------------------------------------------------------------------------------- lending

/** The lending report runs every hour: a figure older than three reports is served with its age. */
export const LENDING_STALE_SEC = 3 * 3_600;

export type LendingMarketRow = {
  account: string;
  venue: string;
  /** The market's name as the report writes it. */
  market: string;
  /** The pool's role in its market: `debt` lends the token, `vault` and `collateral` take it as collateral. */
  role: string | null;
  /**
   * The symbol of the token whose supply and borrow rates the sheet holds: a Jupiter Lend vault's debt token,
   * or the reserve's own token. When the row does not say, it is read from the sheet's symbol (`lentOf`).
   */
  lent?: string | null;
  /**
   * Whether the token the market was read for is the one it lends (supplied and borrowed there), so the
   * sheet's rates are that token's own; false where the market only takes it as collateral. When the row does
   * not say, a `vault` or `collateral` role takes it as collateral and any other role lends it (`lendsIt`).
   */
  lends?: boolean;
  sheet: LendingPoolFacts;
};
export type LendingFigures = Omit<LendingMarketRow, 'sheet' | 'lent' | 'lends'> & {
  /** The token whose rates these are, or null when it cannot be named. */
  lent: string | null;
  /** The token a vault takes as collateral (`vault` role), or null. */
  collateral: string | null;
  /** The token read is the one this market lends: its figures are that token's (`lendsIt`). */
  lends: boolean;
  figures: AssetFigure[];
};

/** At most this many markets that lend a token are served, the largest by what a lender can withdraw now. */
export const MAX_LENDING_MARKETS = 5;

/**
 * Whether a market lends the token it was read for: what the row says, or by its role (a `vault` or
 * `collateral` pool takes the token as collateral; a reserve, a curated vault or a `debt` pool lends it).
 */
export const lendsIt = (row: Pick<LendingMarketRow, 'lends' | 'role'>): boolean =>
  row.lends ?? !(row.role === 'vault' || row.role === 'collateral');

/** A symbol that may stand in a label: letters first, no digit, short. */
const SYMBOL = /^\p{L}[\p{L}.-]{0,15}$/u;
const symbolOrNull = (symbol: string | null | undefined) =>
  symbol && SYMBOL.test(symbol.trim()) ? symbol.trim() : null;

/**
 * The token a market lends and the one it takes as collateral, by its sheet's symbol: a Jupiter Lend vault's
 * is `<collateral>/<debt>`, a reserve's is its own token. A symbol with a digit or out of shape is not named.
 */
export function lentOf(row: Pick<LendingMarketRow, 'lent' | 'sheet' | 'role'>): {
  lent: string | null;
  collateral: string | null;
} {
  const [first, second] = row.sheet.symbol.split('/');
  const pair = second !== undefined;
  return {
    lent: symbolOrNull(row.lent ?? (pair ? second : first)),
    collateral: row.role === 'vault' && pair ? symbolOrNull(first) : null,
  };
}

/** A fact of a stored sheet as a figure: its pin, its quality, and its age past the report's limit. */
export function factFigure(key: string, fact: Fact, now: Date, staleAfter: number): AssetFigure {
  if (fact.value === null) return missing(key, fact.reason);
  if (!Number.isFinite(fact.value)) return missing(key, 'not_a_number');
  const unit = (UNITS as readonly string[]).includes(fact.unit) ? (fact.unit as FigureUnit) : null;
  if (!unit) return missing(key, 'not_a_number');
  const stale = ageOver(fact.fetchedAt, now, staleAfter);
  return {
    key,
    value: fact.value,
    unit,
    source: fact.source,
    method: `${fact.method} (${fact.methodVersion})`,
    fetchedAt: fact.fetchedAt,
    provenance: fact.provenance,
    ...(fact.quality === 'lower_bound' ? { lowerBound: true as const } : {}),
    ...(stale === undefined ? {} : { staleAgeSec: stale }),
  };
}

/**
 * Per lending market of the asset, from the sheets the lending report stored (`risk_lending_facts`, the sheets
 * `/risk/facts/lending/{account}` serves): the supply rate, the borrow rate, the share lent out and the dollars
 * a lender can withdraw now. The rates are the sheet's: a past reading of a rate that moves, never a promise.
 */
export function lendingFigures(markets: readonly LendingMarketRow[], now: Date): LendingFigures[] {
  return [...markets]
    .sort((a, b) => a.venue.localeCompare(b.venue) || a.account.localeCompare(b.account))
    .map(({ sheet, lent: _lent, lends, ...market }) => ({
      ...market,
      ...lentOf({ lent: _lent, sheet, role: market.role }),
      lends: lendsIt({ lends, role: market.role }),
      figures: [
        factFigure('supply', sheet.rates.supplyApy, now, LENDING_STALE_SEC),
        factFigure('borrow', sheet.rates.borrowApy, now, LENDING_STALE_SEC),
        factFigure('util', sheet.withdrawal.shareLentOut, now, LENDING_STALE_SEC),
        factFigure('withdrawable', sheet.withdrawal.availableUsd, now, LENDING_STALE_SEC),
      ],
    }));
}

/** A figure's value, or its reason when it has none: what two markets are compared on. */
const said = (figure: AssetFigure | undefined) =>
  figure === undefined ? '' : figure.value === null ? figure.reason : String(figure.value);

/**
 * The markets that lend the token (`lends`), as many as are served: markets of one venue lending one token
 * whose four figures are the same draw on one pool (Jupiter Lend's vaults all lend from its liquidity layer)
 * and are served once, the first by account; then the largest by what a lender can withdraw now, at most
 * `MAX_LENDING_MARKETS`, a market whose withdrawable dollars are not measured after those that are.
 */
export function largestLendingMarkets(markets: readonly LendingFigures[]): LendingFigures[] {
  const seen = new Set<string>();
  const withdrawable = (market: LendingFigures) => {
    const figure = market.figures.find((f) => f.key === 'withdrawable');
    return figure?.value ?? Number.NEGATIVE_INFINITY;
  };
  return [...markets]
    .filter((market) => market.lends)
    .sort((a, b) => a.account.localeCompare(b.account))
    .filter((market) => {
      const key = [
        market.venue,
        market.lent ?? '',
        ...['supply', 'borrow', 'util', 'withdrawable'].map((k) =>
          said(market.figures.find((f) => f.key === k)),
        ),
      ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => withdrawable(b) - withdrawable(a) || a.account.localeCompare(b.account))
    .slice(0, MAX_LENDING_MARKETS);
}
