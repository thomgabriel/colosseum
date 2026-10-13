import type { BarHour } from './bars';

// The backfill's files into the database (PLAN-ASSETS AS.13): the pure parts. No I/O, no clock, no env.
//
//   Whole days   A day file is read only when the fetch's records hold its UTC day whole, so a day still being
//                written is never read. On Solana the covered windows are seconds (`wholeDaysOfSeconds`, the
//                rule of `daysCovered` in scripts/risk/assets/backfill-status.ts). On Robinhood Chain they are
//                blocks, and no record maps a block to its time; but every subject's manifest says which blocks
//                it was fetched over and on which UTC days its rows fell. A manifest whose pieces all lie in one
//                contiguous covered range R shows a block of R on each of its days, so every day strictly between
//                the oldest and the newest such day has all its blocks in R (`wholeDaysOfBlocks`). A day at
//                either end is never proven whole, which is the safe side.
//   Solana's quote in dollars  USDC at par (`usdc_at_par`, DA21, confirmed by Rodrigo on 2026-10-13); another
//                quote implied from the asset's own USDC pool in the same hour, as Step 5b's reconstruction does
//                (`implied_from_<pool>`): the USDC pool's volume-weighted price over the pool's own, both of the
//                hour, the USDC pool's carried at most 24 hours inside the same UTC day; else no dollar figure
//                (`none:…` on the bar). Never a price of the quote invented, never a stablecoin other than USDC
//                at par. A price carried from an earlier hour says so (`…_carried_<h>h`), and a price of the
//                hour itself wins over a carried one. When the asset has no USDC price that hour: a quote that is itself an asset of the
//                registry at its own USDC pools' price (`implied_from_<pool>`), and SOL at the hour's native median
//                (`nativeMedianByHour`, `native_median_of_<n>_pools`), as Robinhood Chain prices ETH.
//   Robinhood Chain's pools  which side is the asset: the side less like a quote (USDG, then the other dollar
//                tokens, then ETH and WETH, then anything else), and it must be a token of the shelf
//                (`fileEvmPool`).
//   Daily series   DefiLlama's daily prices and Chainlink's rounds as price observations, protocol TVL as a fact.
//                A Solana price observation inside the installed price job's six-day window is held back
//                (`priceJobHoldBack`): the job reads every Solana row of the table from the last six days, and
//                an external price there would change the `others` of assets it values (AS.5).

export const HISTORY_IMPORT_METHOD_VERSION = 'history-import-0.1';
const DAY = 86_400;
const HOUR = 3_600;
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** The longest a reference pool's price is carried to a later hour of the same UTC day. */
export const MAX_CARRY_HOURS = 24;

export const dayOfT = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

// ---------------------------------------------------------------------------------------------------------------
// Whole days

type Range = { from: number; to: number };

/** The UTC days that one of the windows (unix seconds, both ends included) holds from 00:00:00 to 23:59:59. */
export function wholeDaysOfSeconds(covered: Range[]): string[] {
  const out = new Set<string>();
  for (const w of covered)
    for (let d = Math.ceil(w.from / DAY) * DAY; d + DAY - 1 <= w.to; d += DAY) out.add(dayOfT(d));
  return [...out].sort();
}

/** The block ranges two lists share, merged. */
export function intersectRanges(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const x of a)
    for (const y of b) {
      const from = Math.max(x.from, y.from);
      const to = Math.min(x.to, y.to);
      if (from <= to) out.push({ from, to });
    }
  return mergeRanges(out);
}

/** Ranges merged where they touch or overlap, in order. */
export function mergeRanges(rs: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...rs].sort((x, y) => x.from - y.from)) {
    const last = out.at(-1);
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** A check a fetch's owner set to reopen a subject's windows (`recheck_…`, `rewalk_…`, `verify_days_…`), failed. */
export const REOPEN_CHECK = /^(recheck|rewalk|verify_days)_/;
export const isReopened = (checks: Array<{ name: string; passed: boolean }> | undefined) =>
  (checks ?? []).some((c) => !c.passed && REOPEN_CHECK.test(c.name));

/**
 * The UTC days whose every block lies in one of `covered` (contiguous block ranges): a day is whole when, inside
 * the same range, a manifest shows a block on an earlier day and one shows a block on a later day. A manifest is
 * used for a range only when every piece it was fetched over lies inside the range shrunk by `marginBlocks` at
 * each end: a row's time is interpolated between headers at most `marginBlocks` apart, so a row filed on the day
 * before (after) D sits within that many blocks of D's true first (last) block, and the margin keeps that block
 * inside the range. Its days are trusted only then. A manifest with no covered piece, or with a failed reopen
 * check (`isReopened`: its owner uncovered windows and left their days listed), is not used.
 */
export function wholeDaysOfBlocks(
  covered: Range[],
  manifests: Array<{
    covered: Range[];
    days: string[];
    checks?: Array<{ name: string; passed: boolean }>;
  }>,
  marginBlocks = 0,
): string[] {
  const out = new Set<string>();
  for (const r of mergeRanges(covered)) {
    const lo = r.from + marginBlocks;
    const hi = r.to - marginBlocks;
    let first: string | null = null;
    let last: string | null = null;
    for (const m of manifests) {
      if (!m.covered.length || isReopened(m.checks)) continue;
      if (!m.covered.every((w) => w.from >= lo && w.to <= hi)) continue;
      for (const d of m.days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        if (first === null || d < first) first = d;
        if (last === null || d > last) last = d;
      }
    }
    if (first === null || last === null) continue;
    for (let t = dayStart(first) + DAY; t < dayStart(last); t += DAY) out.add(dayOfT(t));
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------------------------------
// Solana: the quote of each pool and hour in dollars

/** One pool's volume-weighted price (quote per asset) for each hour it traded. */
export type HourVwaps = Map<string, number>;

/**
 * What each traded hour of a Solana pool knows of its quote in dollars, by Step 5b's rule: USDC at par; else the
 * asset's price in dollars from its USDC pools (the first, by the order given, with a price that hour, its own
 * or carried at most MAX_CARRY_HOURS inside the day) over the pool's own price of the hour. `regimeOf` sets the
 * hour's regime (the bars take the regime of the hour's row).
 */
export function solanaQuoteUsd(inp: {
  quoteMint: string;
  /** The pool's own volume-weighted price, by hour. */
  own: HourVwaps;
  /** The asset's USDC pools, in the order of preference (the registry's TVL, largest first), each with its prices. */
  usdcPools: Array<{ pool: string; vwap: HourVwaps }>;
  /**
   * The quote token's own dollar price, if any (the quote's USDC pools when it is an asset of the registry,
   * `implied_from_<pool>`; SOL's median, `native_median_of_<n>_pools`), with the hours it was carried.
   */
  quoteUsdOf?: (hour: string) => { usd: number; method: string; carriedHours: number } | null;
  regimeOf: (hour: string) => BarHour['regime'];
}): Map<string, BarHour> {
  const out = new Map<string, BarHour>();
  for (const [hour, ownPrice] of inp.own) {
    const regime = inp.regimeOf(hour);
    if (inp.quoteMint === USDC_MINT) {
      out.set(hour, { regime, quoteUsd: 1, method: 'usdc_at_par' });
      continue;
    }
    // the candidates: the asset's USDC pools over the pool's own price (Step 5b), and the quote's own price; a
    // price of the hour itself wins over a carried one, then the asset's USDC pools, then the shorter carry
    const cands: Array<{ usd: number; method: string; carriedHours: number; rank: number }> = [];
    const ref = carriedPrice(inp.usdcPools, hour);
    if (ref && ownPrice > 0 && Number.isFinite(ownPrice))
      cands.push({
        usd: ref.usd / ownPrice,
        method: `implied_from_${ref.pool}${ref.carriedHours ? `_carried_${ref.carriedHours}h` : ''}`,
        carriedHours: ref.carriedHours,
        rank: 0,
      });
    const q = inp.quoteUsdOf?.(hour) ?? null;
    if (q && q.usd > 0 && Number.isFinite(q.usd)) cands.push({ ...q, rank: 1 });
    cands.sort((a, b) => a.carriedHours - b.carriedHours || a.rank - b.rank);
    const best = cands[0];
    out.set(
      hour,
      best
        ? { regime, quoteUsd: best.usd, method: best.method }
        : { regime, quoteUsd: null, method: null },
    );
  }
  return out;
}

/** The value with half the weight at or below it (the lower one when the weight splits exactly), as Robinhood Chain's. */
export function weightedMedianOf(xs: Array<{ v: number; w: number }>): number {
  const sorted = [...xs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((a, x) => a + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc * 2 >= total) return x.v;
  }
  return (sorted.at(-1) as { v: number }).v;
}

/**
 * SOL's dollar price per hour, as Robinhood Chain prices ETH (`hourlyRows`): every pool quoted in SOL that traded in
 * the hour and whose asset has a dollar price that hour (its USDC pools, own or carried in the day) implies one,
 * the asset's dollars over the pool's own price; the hour's price is their median weighted by the pools' swaps of
 * the hour. An hour with none carries the last one at most MAX_CARRY_HOURS inside the same UTC day.
 * `native_median_of_<n>_pools` (`_carried_<h>h` when carried).
 */
export function nativeMedianByHour(
  samples: Map<string, Array<{ v: number; w: number }>>,
): Map<string, { usd: number; method: string; carriedHours: number }> {
  const out = new Map<string, { usd: number; method: string; carriedHours: number }>();
  const byDay = new Map<string, string[]>();
  for (const h of samples.keys())
    byDay.set(h.slice(0, 10), [...(byDay.get(h.slice(0, 10)) ?? []), h]);
  for (const day of [...byDay.keys()].sort()) {
    let last: { v: number; n: number; t: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const t = dayStart(day) + k * HOUR;
      const hour = new Date(t * 1000).toISOString();
      const xs = (samples.get(hour) ?? []).filter(
        (x) => x.v > 0 && Number.isFinite(x.v) && x.w > 0,
      );
      if (xs.length) last = { v: weightedMedianOf(xs), n: xs.length, t };
      if (!last) continue;
      const carried = (t - last.t) / HOUR;
      if (carried > MAX_CARRY_HOURS) continue;
      out.set(hour, {
        usd: last.v,
        method: `native_median_of_${last.n}_pools${carried ? `_carried_${carried}h` : ''}`,
        carriedHours: carried,
      });
    }
  }
  return out;
}

/**
 * The freshest price at `hour` among the pools: the hour's own first, then each earlier hour of the same UTC day
 * within the carry; among pools of equal freshness, the first in the order given.
 */
export function carriedPrice(
  pools: Array<{ pool: string; vwap: HourVwaps }>,
  hour: string,
): { pool: string; usd: number; carriedHours: number } | null {
  const t = Date.parse(hour) / 1000;
  const from = Math.max(dayStart(hour.slice(0, 10)), t - MAX_CARRY_HOURS * HOUR);
  for (let h = t; h >= from; h -= HOUR) {
    const key = new Date(h * 1000).toISOString();
    for (const p of pools) {
      const v = p.vwap.get(key);
      if (v !== undefined && v > 0 && Number.isFinite(v))
        return { pool: p.pool, usd: v, carriedHours: (t - h) / HOUR };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Robinhood Chain: which side of a pool is the asset

/** How much a token looks like a quote: 0 the chain's dollar, 1 another dollar token, 2 ETH or WETH, 3 anything else. */
export type QuoteRank = 0 | 1 | 2 | 3;

/**
 * The side a pool's bars are filed under: the side less like a quote; on a tie, the side on the shelf; both on
 * the shelf, token 0 (the lower address). A pool whose asset side is not a shelf token gets no bars (`reason`).
 */
export function fileEvmPool(
  token0: string,
  token1: string,
  rank: (address: string) => QuoteRank,
  onShelf: (address: string) => boolean,
): { asset: string; quote: string; assetIsToken0: boolean } | { reason: string } {
  const [a, b] = [token0.toLowerCase(), token1.toLowerCase()];
  const [ra, rb] = [rank(a), rank(b)];
  let asset: string;
  if (ra !== rb) asset = ra > rb ? a : b;
  else if (onShelf(a) !== onShelf(b)) asset = onShelf(a) ? a : b;
  else asset = a;
  if (!onShelf(asset)) return { reason: 'asset_not_on_the_shelf' };
  return { asset, quote: asset === a ? b : a, assetIsToken0: asset === a };
}

// ---------------------------------------------------------------------------------------------------------------
// The daily series as rows

/** The price job's window (scripts/risk/prices/job.ts `windowSec`) and a margin for a job already running. */
export const PRICE_JOB_WINDOW_SEC = 6 * DAY;
export const PRICE_JOB_MARGIN_SEC = 2 * HOUR;

/**
 * True when a Solana price observation at `t` could enter the installed price job's window, now or on a run that
 * started before this import: such a point is held back and written by a later run, once older. Robinhood Chain's
 * are never held back (the job reads Solana rows only).
 */
export const priceJobHoldBack = (chain: string, t: number, nowT: number) =>
  chain === 'solana' && t >= nowT - PRICE_JOB_WINDOW_SEC - PRICE_JOB_MARGIN_SEC;

/** An integer answer with `decimals` places as a number (the decimal string first, so no float scaling). */
export function scaled(answer: string, decimals: number): number {
  const neg = answer.startsWith('-');
  const digits = (neg ? answer.slice(1) : answer).padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  return Number(
    `${neg ? '-' : ''}${digits.slice(0, cut)}${decimals > 0 ? `.${digits.slice(cut)}` : ''}`,
  );
}

/** One Chainlink round as the backfill wrote it (scripts/risk-evm/backfill-rounds.ts). */
export type RoundRow = {
  feed: string;
  phase: number;
  round: number;
  roundId: string;
  answer: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  answeredInRound: string | null;
};

/** A round's price per whole token, or why the round gives none. */
export function roundPrice(
  r: RoundRow,
  decimals: number,
): { t: number; price: number } | { reason: string } {
  if (r.answer === null || r.updatedAt === null || r.updatedAt <= 0)
    return { reason: 'unanswered' };
  const price = scaled(r.answer, decimals);
  if (!(price > 0) || !Number.isFinite(price)) return { reason: 'answer_not_positive' };
  return { t: r.updatedAt, price };
}

/** A DefiLlama daily point, or why it is not one. */
export function dailyPoint(p: unknown): { t: number; v: number } | { reason: string } {
  const o = p as {
    timestamp?: unknown;
    price?: unknown;
    date?: unknown;
    totalLiquidityUSD?: unknown;
  };
  const t = typeof o.timestamp === 'number' ? o.timestamp : o.date;
  const v = typeof o.price === 'number' ? o.price : o.totalLiquidityUSD;
  if (typeof t !== 'number' || !Number.isInteger(t) || t <= 0) return { reason: 'no_time' };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { reason: 'no_value' };
  return { t, v };
}
