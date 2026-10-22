import { ASSET_METRICS, type AssetMetric, METRIC_CADENCE, type MetricAsset } from '@colosseum/risk';

// What one run of an asset metrics job reads (gate ASSET-METRICS, amended 2026-10-22 by Thom): pure, so the tests
// hold it. Two things decide it.
//
// The rows it reads. `all`, every row of the chain's list, is the local job's: the shelf's cut reads the DEX volume
// of every listed and candidate row from it. `served` is the hosted job's: only the rows the asset lookups can
// answer for (`GET /v1/assets/{id}/facts`, read from the chain's listed assets, `basket_assets`, which the deploy
// records hold): the chain's shelf (`shelf-<chain>.json`), its listed rows, and every token a committed deploy record
// names or models (a test-network token reads its model's mainnet rows, as `universeTwin` in apps/api finds them:
// by symbol, a listed row first). On Oct 22 that was about 100 Solana rows of 2,249 and 46 Robinhood Chain rows of
// 272. A row outside it keeps its newest reading in the hosted database (DB-RETENTION never ages it).
//
// The daily parts. The hourly metrics are read every run; each daily part when no run in the last 23 hours read it
// in full and wrote: the issuer's supply, the twenty largest holders' share (one getTokenLargestAccounts a mint),
// the DEX volume (one DexScreener call a token with a pair), and, for the hosted job, SOL's total supply (getSupply,
// which took six minutes on Oct 22: SOL's supply moves by inflation, a fraction a day; given 45 s, a call with no answer
// by then writes no row and counts as tried, `timedOut`, so it is asked once a day). A part a run did not finish
// (its reads stopped at the run's deadline) or did not write (past its window) stays due, and the next run reads
// only what is still due.

/** How long a daily part's reading stands before it is read again. */
export const DAILY_WITHIN_MS = 23 * 3600 * 1000;

export type MetricsScope = 'all' | 'served';
/** A daily part: a daily metric, or `native_supply` (SOL's supply_total, daily in the hosted job only). */
export type DailyPart = AssetMetric | 'native_supply';

/** The reads a daily part needs in full (`MetricAnswers.cutShort` names a read its deadline stopped). */
const PART_READS: Record<string, readonly string[]> = {
  holders_top20_share: ['largest_accounts'],
  dex_volume_24h_usd: ['dexscreener'],
  native_supply: ['native_supply'],
};

/** The daily parts of a chain's job in a scope. */
export function dailyParts(scope: MetricsScope, chain: 'solana' | 'robinhood'): DailyPart[] {
  const metrics = ASSET_METRICS.filter((m) => METRIC_CADENCE[m] === 'daily');
  return scope === 'served' && chain === 'solana' ? [...metrics, 'native_supply'] : metrics;
}

/** One line of the run log, as far as the schedule reads it. */
export type RunLine = {
  kind?: string;
  chain?: string;
  dryRun?: boolean;
  at?: string;
  metrics?: string[];
  /** The daily parts the run was asked (written since 2026-10-22). */
  daily?: string[];
  /** The reads its deadline stopped. */
  cutShort?: string[];
  /** Set when the run wrote nothing (past its window). */
  skipped?: string;
};

/** The daily parts a logged run read in full and wrote. */
export function partsDone(r: RunLine, parts: readonly DailyPart[]): Set<DailyPart> {
  const done = new Set<DailyPart>();
  if (r.skipped) return done;
  const cut = new Set(r.cutShort ?? []);
  // a line written before 2026-10-22 names no parts: its daily metrics were read in full, and SOL's supply every run
  const asked = r.daily ?? [
    ...(r.metrics ?? []).filter((m) => (parts as readonly string[]).includes(m)),
    ...((r.metrics ?? []).includes('supply_total') ? ['native_supply'] : []),
  ];
  for (const p of parts)
    if (asked.includes(p) && !(PART_READS[p] ?? []).some((read) => cut.has(read))) done.add(p);
  return done;
}

/** The daily parts due now: those no run of the chain read in full and wrote in the last 23 hours. */
export function dailyDue(
  runLog: string,
  chain: string,
  nowMs: number,
  parts: readonly DailyPart[],
): Set<DailyPart> {
  const done = new Set<DailyPart>();
  for (const line of runLog.trim().split('\n').reverse()) {
    if (!line) continue;
    let r: RunLine;
    try {
      r = JSON.parse(line) as RunLine;
    } catch {
      continue; // the last line may be being written
    }
    if (r.kind !== 'asset-metrics-job' || r.chain !== chain || r.dryRun) continue;
    if (nowMs - Date.parse(r.at ?? '') > DAILY_WITHIN_MS) break;
    for (const p of partsDone(r, parts)) done.add(p);
  }
  return new Set(parts.filter((p) => !done.has(p)));
}

/** The metrics a run asks for, and the reads it leaves out (a daily read that is not due). */
export function runPlan(due: ReadonlySet<DailyPart>, parts: readonly DailyPart[]) {
  const metrics = ASSET_METRICS.filter((m) => METRIC_CADENCE[m] === 'hourly' || due.has(m));
  const skipReads = new Set<string>();
  if (parts.includes('native_supply') && !due.has('native_supply')) skipReads.add('native_supply');
  return { metrics, skipReads, daily: [...due].sort() };
}

/** A deploy record's tokens, as the scope reads them. */
export type RecordToken = { address?: string; mint?: string; modelOf?: string };
export type DeployRecord = {
  chain?: string;
  network?: string;
  cash?: RecordToken;
  assets?: RecordToken[];
  hidden?: RecordToken[];
};

/** The rows of a chain's list the hosted asset lookups can answer for (see above), in the list's order. */
export function servedAssets<T extends MetricAsset>(
  chain: 'solana' | 'robinhood',
  list: readonly T[],
  shelfAddresses: readonly string[],
  records: readonly DeployRecord[],
): T[] {
  const key = (a: string) => (chain === 'solana' ? a : a.toLowerCase());
  const keep = new Set(shelfAddresses.map(key));
  for (const a of list) if (a.status === 'listed') keep.add(key(a.address));
  for (const r of records) {
    if (r.chain !== chain) continue;
    for (const t of [r.cash, ...(r.assets ?? []), ...(r.hidden ?? [])]) {
      if (!t) continue;
      const address = t.address ?? t.mint;
      if (address && list.some((a) => key(a.address) === key(address))) keep.add(key(address));
      if (t.modelOf) {
        const named = list.filter(
          (a) => a.symbol === t.modelOf && (a.status === 'listed' || a.status === 'candidate'),
        );
        const model = named.find((a) => a.status === 'listed') ?? named[0];
        if (model) keep.add(key(model.address));
      }
    }
  }
  return list.filter((a) => keep.has(key(a.address)));
}
