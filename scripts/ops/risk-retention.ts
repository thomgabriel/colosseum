import { ident, qualified, tsLiteral } from './lib-pg';

// How long the hosted database keeps each table that grows by the hour (Thom, Oct 16: about the last four
// days of raw liquidity readings; older rows are archived to files and pruned daily). The reasons are the
// readers in the code; docs/risk/STATE-RISK.md ("Retention of the hosted tables") lists them in full. The
// prune (prune-risk.ts), the archive (archive-risk.ts) and the move (move-db.ts) all read this one list.
//
// The cut is taken from the newer of nothing and the table's own newest row: a row is old when it is more
// than `keepHours` older than min(now, newest). A table whose collector stopped therefore keeps its last
// window instead of being emptied, and an empty table would make the hourly import read every collected
// day again (scripts/risk/import.ts reads the day files from the table's newest row on).

export type Retention = {
  schema: string;
  table: string;
  /** The time a row is aged by. */
  column: string;
  keepHours: number;
  /** Rows that never age out, as SQL on the table (reconstructed history that no job writes again). */
  exempt?: string;
  why: string;
};

const DAY = 24;

export const RETENTION: readonly Retention[] = [
  {
    schema: 'public',
    table: 'risk_pool_snapshots',
    column: 'fetched_at',
    keepHours: 4 * DAY,
    why: 'raw pool depth readings (about 38,000 rows and 77 MB a day); the import reads only its newest day and the heatmap shows what is kept',
  },
  {
    schema: 'public',
    table: 'risk_asset_snapshots',
    column: 'fetched_at',
    keepHours: 7 * DAY,
    why: "routed asset curves; the fact sheets' exit capacity reads 7 days (capacityWindowDays), the history charts show what is kept",
  },
  {
    schema: 'public',
    table: 'risk_lending_snapshots',
    column: 'observed_at',
    keepHours: 4 * DAY,
    exempt: "kind like '%\\_hourly'",
    why: "the lending collector's five-minute reads; the reconstructed hourly history is never cut",
  },
  {
    schema: 'public',
    table: 'risk_quotes',
    column: 'fetched_at',
    keepHours: 4 * DAY,
    why: 'Jupiter cross-check quotes; nothing reads them but the import, which reads its newest day',
  },
  {
    schema: 'public',
    table: 'risk_events',
    column: 'fetched_at',
    keepHours: 7 * DAY,
    why: 'LP-withdrawal and stale-map events; the fact sheets and /risk/events read 7 days',
  },
  {
    schema: 'public',
    table: 'risk_lp_concentration',
    column: 'fetched_at',
    keepHours: 4 * DAY,
    why: 'hourly LP concentration; every reader takes the newest row per pool',
  },
  {
    schema: 'public',
    table: 'risk_lending_facts',
    column: 'report_at',
    keepHours: 4 * DAY,
    why: 'a full set of lending sheets every hour; readers take the newest report',
  },
  {
    schema: 'public',
    table: 'risk_lending_coverage',
    column: 'report_at',
    keepHours: 4 * DAY,
    why: 'liquidation coverage every hour; /risk/lending/coverage reads the newest report',
  },
  {
    schema: 'public',
    table: 'risk_pool_flow',
    column: 'fetched_at',
    keepHours: 7 * DAY,
    why: 'one import a day, each row summing its 24h, 7d and 28d window; readers take the newest data_to, and a week of imports covers days the rewalk returned fewer pools',
  },
];

/**
 * The tables that grow but are kept whole, and why. Every risk table of packages/db is in one list or the
 * other (tests/ops-risk-retention.test.ts), so a new table needs a decision.
 */
export const KEPT_WHOLE: Readonly<Record<string, string>> = {
  risk_pools: 'the registry: one row per pool, rewritten in place',
  risk_depth_curves: 'one fitted curve per asset, side, regime and method version',
  risk_market_params: 'written by hand; readers take the newest row per account',
  risk_lending_pools: 'the lending registry',
  risk_lending_events: 'decoded history, imported by hand',
  risk_lending_positions:
    'small (about 1 MB a day); the hourly lending import re-inserts any hour it does not find',
  risk_price_observations:
    'small (about 0.5 MB a day); oracle facts read 28 days and the metrics job lists every mint ever seen',
  risk_reference_prices: 'the fact sheets read 365 days of market series',
  risk_network_fees: 'one row per swap the product sent',
  risk_depth_recovery: 'one row per asset, regime and history report',
  risk_sheets: 'plans point at it',
  asset_observations: 'the metrics jobs read 40 days of exchange rates',
  market_bars: 'the facts read 30 days of hourly bars, built by hand',
};

/** A table's retention, or undefined when the table is kept whole. */
export function retentionOf(schema: string, table: string): Retention | undefined {
  return RETENTION.find((r) => r.schema === schema && r.table === table);
}

/**
 * The time before which a row is old: `keepHours` before the earlier of `at` and the table's newest row.
 * Null when the table has no row, so nothing is cut.
 */
export function cutoffOf(keepHours: number, at: Date, newest: Date | null): Date | null {
  if (!Number.isFinite(keepHours) || keepHours <= 0)
    throw new Error('keepHours must be above zero');
  if (Number.isNaN(at.getTime())) throw new Error('not a time');
  if (newest === null) return null;
  const base = Math.min(at.getTime(), newest.getTime());
  return new Date(base - keepHours * 3_600_000);
}

/** SQL that is true of a row older than the cut and not exempt. */
export function agedSql(r: Retention, cut: Date): string {
  const old = `${ident(r.column)} < ${tsLiteral(cut)}`;
  return r.exempt ? `(${old} and not (${r.exempt}))` : `(${old})`;
}

/** SQL that is true of a row the database keeps. */
export function keptSql(r: Retention, cut: Date): string {
  return `(not ${agedSql(r, cut)})`;
}

/** The table's newest time, as SQL. */
export function newestSql(r: Retention): string {
  return `select max(${ident(r.column)}) as t from ${qualified(r.schema, r.table)}`;
}

/**
 * The oldest time an importer may write into a table: `keepHours` before `now`. An importer that re-reads its
 * collector's files (the lending import, the Robinhood Chain import) skips what is older, or the prune's
 * deletions would be inserted again at the next hourly run. Null for a table that is kept whole.
 */
export function importFloor(table: string, now = new Date()): Date | null {
  const r = RETENTION.find((x) => x.table === table);
  return r ? new Date(now.getTime() - r.keepHours * 3_600_000) : null;
}

/** The time `--at` names, or now. */
export function parseAt(raw: string | undefined, now = new Date()): Date {
  if (raw === undefined) return now;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
    throw new Error('--at takes an ISO time with its zone, such as 2026-10-17T09:00:00Z');
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error('--at is not a time');
  if (d.getTime() > now.getTime() + 60_000) throw new Error('--at is in the future');
  return d;
}
