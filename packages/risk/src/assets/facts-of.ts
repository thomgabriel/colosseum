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

/** One row an hour: where a bar was built by two method versions, the later version's. */
function oneAnHour<T extends BarRow>(rows: readonly T[]): T[] {
  const byHour = new Map<number, T>();
  for (const row of rows) {
    const at = Date.parse(row.hour);
    const kept = byHour.get(at);
    if (!kept || row.methodVersion > kept.methodVersion) byHour.set(at, row);
  }
  return [...byHour.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** The hours of a window: the current hour and the ones before it. */
export function windowStart(window: LookupWindow, now: Date): Date {
  return new Date(floorHour(now.getTime()) - (WINDOW_HOURS[window] - 1) * HOUR_MS);
}

/**
 * Whether the bars cover the window: they reach back to its start (a bar at or before it, or `before`, the
 * latest bar older than the window, which says the history goes back further and the hours between were
 * quiet), and forward to `now` (their last hour ended at most `BARS_FRESH_MS` ago). Otherwise, the hours of
 * the window the bars do not reach.
 */
export function barCoverage(
  bars: readonly { hour: string }[],
  before: string | null,
  window: LookupWindow,
  now: Date,
): { covered: true } | { covered: false; missingHours: number } {
  const total = WINDOW_HOURS[window];
  const start = windowStart(window, now).getTime();
  const hours = bars.map((bar) => Date.parse(bar.hour)).filter((at) => at >= start);
  if (!hours.length) return { covered: false, missingHours: total };
  const first = Math.min(...hours);
  const last = Math.max(...hours);
  const head = before !== null || first <= start ? 0 : Math.round((first - start) / HOUR_MS);
  const behind = now.getTime() - (last + HOUR_MS);
  const tail = behind > BARS_FRESH_MS ? Math.ceil(behind / HOUR_MS) : 0;
  const gap = Math.min(total, head + tail);
  return gap ? { covered: false, missingHours: gap } : { covered: true };
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
  const versions = [...new Set(rows.map((row) => row.methodVersion))].sort().join(', ');
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
 * no priced swap. A window the bars do not cover answers every figure `not_collected` with the hours missing:
 * never a part of the window shown as the whole of it.
 */
export function priceHistoryFigures(
  rows: readonly BarRow[],
  before: string | null,
  window: LookupWindow,
  now: Date,
): AssetFigure[] {
  const start = windowStart(window, now).getTime();
  const bars = oneAnHour(rows.filter((row) => Date.parse(row.hour) >= start));
  const coverage = barCoverage(bars, before, window, now);
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
  out.push(figure('gaps', bars, WINDOW_HOURS[window] - valued.length, 'hours'));
  return out;
}

// --------------------------------------------------------------------------------------------------- pools

/** At most this many pools are served, the largest by dollars held. */
export const MAX_POOLS = 5;

export type PoolFigures = { rank: number; pool: string; venue: string; figures: AssetFigure[] };

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
  const listed = Array.isArray(reading.detail?.pools) ? (reading.detail.pools as unknown[]) : [];
  const pools = listed
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
      const share: AssetFigure =
        whole.value > 0
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
  sheet: LendingPoolFacts;
};
export type LendingFigures = Omit<LendingMarketRow, 'sheet'> & { figures: AssetFigure[] };

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
    .map(({ sheet, ...market }) => ({
      ...market,
      figures: [
        factFigure('supply', sheet.rates.supplyApy, now, LENDING_STALE_SEC),
        factFigure('borrow', sheet.rates.borrowApy, now, LENDING_STALE_SEC),
        factFigure('util', sheet.withdrawal.shareLentOut, now, LENDING_STALE_SEC),
        factFigure('withdrawable', sheet.withdrawal.availableUsd, now, LENDING_STALE_SEC),
      ],
    }));
}
