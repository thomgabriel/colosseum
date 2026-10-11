import { type FlowWindow, flowWindow, hourOf } from '../facts/flow';
import type { Regime } from '../time';

// Hourly bars from the swap history (PLAN-ASSETS AS.7): one bar per pool and hour, then one per token and
// hour across its pools (`pool = 'asset'`), as `market_bars` holds them. Pure: no I/O, no clock. The caller
// reads the swaps and says, for each hour of each pool, what the pool's quote was worth in dollars by the
// method `risk_pool_flow` used on that chain, so the bars and that table reconcile; nothing here sets a
// stablecoin at par or prices a swap on its own.
//
//   A swap's price   the quote-leg amount ÷ the token amount, in whole tokens: the price the trade was done
//                    at, the venue's fee included. Open and close are the first and the last swap of the hour
//                    by their place in the chain, high and low the extremes; VWAP is Σ quote ÷ Σ tokens.
//   In dollars       each quote figure × the hour's `quoteUsd`. A swap of an hour without one, or of a pool
//                    whose quote decimals are unknown, is counted in `swaps` and `unpricedSwaps` and left out
//                    of every dollar figure; the dollar figures are null when no swap of the hour was priced.
//   A swap with no side  (the event logged nothing going in: a v4 hook took the trade) is not a purchase or a
//                    sale: it is left out of `swaps` and counted in `detail.swapsWithoutSide`.
export const BARS_METHOD_VERSION = 'bars-0.1';
export const BARS_METHOD =
  "hourly bars of the pool's swaps: price = quote-leg amount ÷ token amount; open and close by place in the chain; VWAP = Σ quote ÷ Σ tokens; dollars = quote figures × the hour's quoteUsd, by the method risk_pool_flow used on the chain; unpriced swaps counted, never valued";

/** Where a swap sits in the chain: slot or block, then its place in it (larger is later), then its place in the transaction. */
export type ChainPlace = readonly [number, number, number];

/** One swap of one pool, as the bars need it. */
export type BarSwap = {
  /** Unix seconds. */
  t: number;
  at: ChainPlace;
  /** A sale sends the token into the pool. Null: nothing went in on either side. */
  side: 'sell' | 'buy' | null;
  /** The token amount in whole tokens, positive. */
  tokens: number;
  /** The quote-leg amount in whole quote tokens, positive; null when the quote's decimals are unknown. */
  quote: number | null;
};

/** What the caller knows of one hour of one pool: the regime of the hour's row and the quote in dollars. */
export type BarHour = {
  regime: Regime | null;
  quoteUsd: number | null;
  /** How the quote was put in dollars (`usdc_at_par`, `implied_from_<pool>` …), or null. */
  method: string | null;
};

type Mark = { at: ChainPlace; t: number; p: number };
const later = (a: ChainPlace, b: ChainPlace) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

type HourAcc = {
  hour: string;
  regime: Regime;
  regimeFrom: 'hourly_row' | 'first_swap_read';
  quoteUsd: number | null;
  method: string | null;
  swaps: number;
  buySwaps: number;
  sellSwaps: number;
  unpriced: number;
  withoutSide: number;
  /** Priced swaps whose amounts give no price (a zero amount on one side): counted, no price mark. */
  withoutPrice: number;
  tokens: number;
  buyTokens: number;
  sellTokens: number;
  /** Σ quote and Σ tokens of the swaps with a price, for the VWAP. */
  vwapQuote: number;
  vwapTokens: number;
  buyUsd: number;
  sellUsd: number;
  open: Mark | null;
  close: Mark | null;
  high: number | null;
  low: number | null;
};

/** One pool's swaps, hour by hour. */
export type PoolBarAccumulator = Map<string, HourAcc>;
export const newPoolBars = (): PoolBarAccumulator => new Map();

/**
 * Adds one swap to its hour. `hour` is what the caller knows of that hour (undefined: no row); the bar's
 * regime is the row's, or, with no row, `regimeAt` of the first swap added to the hour, which is the rule of
 * the flow import (`addSwap` in facts/flow.ts). `rowRegime` false: this swap, if it opens the hour, takes
 * its regime from its own time even where a row exists (the Robinhood import adds a swap with no side
 * without the hour's row). A swap's dollars are added one by one in the order given, as that import does.
 */
export function addBarSwap(
  acc: PoolBarAccumulator,
  s: BarSwap,
  hour: BarHour | undefined,
  regimeAt: (t: number) => Regime,
  rowRegime = true,
): void {
  const h = hourOf(s.t);
  let b = acc.get(h);
  if (!b) {
    b = {
      hour: h,
      regime: (rowRegime ? hour?.regime : null) ?? regimeAt(s.t),
      regimeFrom: rowRegime && hour?.regime ? 'hourly_row' : 'first_swap_read',
      quoteUsd: hour?.quoteUsd ?? null,
      method: hour?.method ?? null,
      swaps: 0,
      buySwaps: 0,
      sellSwaps: 0,
      unpriced: 0,
      withoutSide: 0,
      withoutPrice: 0,
      tokens: 0,
      buyTokens: 0,
      sellTokens: 0,
      vwapQuote: 0,
      vwapTokens: 0,
      buyUsd: 0,
      sellUsd: 0,
      open: null,
      close: null,
      high: null,
      low: null,
    };
    acc.set(h, b);
  }
  if (s.side === null) {
    b.withoutSide++;
    return;
  }
  b.swaps++;
  b.tokens += s.tokens;
  if (s.side === 'sell') {
    b.sellSwaps++;
    b.sellTokens += s.tokens;
  } else {
    b.buySwaps++;
    b.buyTokens += s.tokens;
  }
  if (s.quote !== null && s.tokens > 0 && s.quote > 0) {
    const p = s.quote / s.tokens;
    b.vwapQuote += s.quote;
    b.vwapTokens += s.tokens;
    if (!b.open || later(b.open.at, s.at)) b.open = { at: s.at, t: s.t, p };
    if (!b.close || later(s.at, b.close.at)) b.close = { at: s.at, t: s.t, p };
    b.high = b.high === null ? p : Math.max(b.high, p);
    b.low = b.low === null ? p : Math.min(b.low, p);
  } else if (s.quote !== null) b.withoutPrice++;
  const q = b.quoteUsd;
  if (s.quote === null || q === null || !Number.isFinite(q)) {
    b.unpriced++;
    return;
  }
  if (s.side === 'sell') b.sellUsd += s.quote * q;
  else b.buyUsd += s.quote * q;
}

/** A bar as `market_bars` takes it, without the row's chain, address, pool and provenance. */
export type Bar = {
  hour: string;
  openQuote: number | null;
  highQuote: number | null;
  lowQuote: number | null;
  closeQuote: number | null;
  vwapQuote: number | null;
  openUsd: number | null;
  highUsd: number | null;
  lowUsd: number | null;
  closeUsd: number | null;
  vwapUsd: number | null;
  swaps: number;
  buySwaps: number;
  sellSwaps: number;
  unpricedSwaps: number;
  volumeTokens: number;
  volumeUsd: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  quoteUsdMethod: string | null;
  detail: Record<string, unknown>;
};

/** A pool's bar, with the places of its first and last priced swap, which the token's bar needs. */
export type PoolBar = Bar & {
  regime: Regime;
  swapsWithoutSide: number;
  openMark: Mark | null;
  closeMark: Mark | null;
};

const orNull = (q: number | null, x: number | null) => (q === null || x === null ? null : x * q);

/**
 * The pool's bars, oldest hour first, one for every hour the pool logged a swap. An hour where every swap had
 * no side keeps its bar, with no swap counted and `detail.swapsWithoutSide` saying how many were logged.
 */
export function poolBars(acc: PoolBarAccumulator, layer: string): PoolBar[] {
  const out: PoolBar[] = [];
  for (const b of [...acc.values()].sort((x, y) => x.hour.localeCompare(y.hour))) {
    const priced = b.swaps - b.unpriced;
    const q = priced > 0 ? b.quoteUsd : null;
    const vwap = b.vwapTokens > 0 ? b.vwapQuote / b.vwapTokens : null;
    out.push({
      hour: b.hour,
      openQuote: b.open?.p ?? null,
      highQuote: b.high,
      lowQuote: b.low,
      closeQuote: b.close?.p ?? null,
      vwapQuote: vwap,
      openUsd: orNull(q, b.open?.p ?? null),
      highUsd: orNull(q, b.high),
      lowUsd: orNull(q, b.low),
      closeUsd: orNull(q, b.close?.p ?? null),
      vwapUsd: orNull(q, vwap),
      swaps: b.swaps,
      buySwaps: b.buySwaps,
      sellSwaps: b.sellSwaps,
      unpricedSwaps: b.unpriced,
      volumeTokens: b.tokens,
      volumeUsd: priced > 0 ? b.buyUsd + b.sellUsd : null,
      buyVolumeUsd: priced > 0 ? b.buyUsd : null,
      sellVolumeUsd: priced > 0 ? b.sellUsd : null,
      quoteUsdMethod: b.method,
      detail: {
        layer,
        regime: b.regime,
        regimeFrom: b.regimeFrom,
        quoteUsd: b.quoteUsd,
        buyTokens: b.buyTokens,
        sellTokens: b.sellTokens,
        openAt: b.open ? { t: b.open.t, at: b.open.at } : null,
        closeAt: b.close ? { t: b.close.t, at: b.close.at } : null,
        ...(b.withoutSide ? { swapsWithoutSide: b.withoutSide } : {}),
        ...(b.withoutPrice ? { swapsWithoutPrice: b.withoutPrice } : {}),
      },
      regime: b.regime,
      swapsWithoutSide: b.withoutSide,
      openMark: b.open,
      closeMark: b.close,
    });
  }
  return out;
}

/**
 * The token's bars across its pools, one per hour any pool traded: counts and token volume summed; dollars
 * summed over the priced pools (null when none was priced); the dollar open and close are those of the first
 * and the last priced swap of the hour across the pools, by place in the chain; high and low the extremes;
 * VWAP the dollars over the tokens of the priced pools. No quote figure: the pools' quotes differ. `detail`
 * names the pools and each one's share of the hour's swaps and dollars.
 */
export function assetBars(pools: Array<{ pool: string; bars: PoolBar[] }>, layer: string): Bar[] {
  const byHour = new Map<string, Array<{ pool: string; b: PoolBar }>>();
  for (const p of pools)
    for (const b of p.bars) {
      const l = byHour.get(b.hour) ?? [];
      l.push({ pool: p.pool, b });
      byHour.set(b.hour, l);
    }
  const out: Bar[] = [];
  for (const hour of [...byHour.keys()].sort()) {
    const l = byHour.get(hour) as Array<{ pool: string; b: PoolBar }>;
    const sum = (f: (b: PoolBar) => number) => l.reduce((a, x) => a + f(x.b), 0);
    const priced = l.filter((x) => x.b.volumeUsd !== null);
    const usd = priced.length ? priced.reduce((a, x) => a + (x.b.volumeUsd as number), 0) : null;
    const usdTokens = priced.reduce((a, x) => a + x.b.volumeTokens, 0);
    let open: { at: ChainPlace; v: number } | null = null;
    let close: { at: ChainPlace; v: number } | null = null;
    let high: number | null = null;
    let low: number | null = null;
    for (const { b } of priced) {
      const q = b.detail.quoteUsd as number;
      if (b.openMark && (!open || later(open.at, b.openMark.at)))
        open = { at: b.openMark.at, v: b.openMark.p * q };
      if (b.closeMark && (!close || later(b.closeMark.at, close.at)))
        close = { at: b.closeMark.at, v: b.closeMark.p * q };
      if (b.highUsd !== null) high = high === null ? b.highUsd : Math.max(high, b.highUsd);
      if (b.lowUsd !== null) low = low === null ? b.lowUsd : Math.min(low, b.lowUsd);
    }
    const swaps = sum((b) => b.swaps);
    const withoutSide = sum((b) => b.swapsWithoutSide);
    out.push({
      hour,
      openQuote: null,
      highQuote: null,
      lowQuote: null,
      closeQuote: null,
      vwapQuote: null,
      openUsd: open?.v ?? null,
      highUsd: high,
      lowUsd: low,
      closeUsd: close?.v ?? null,
      vwapUsd: usd !== null && usdTokens > 0 ? usd / usdTokens : null,
      swaps,
      buySwaps: sum((b) => b.buySwaps),
      sellSwaps: sum((b) => b.sellSwaps),
      unpricedSwaps: sum((b) => b.unpricedSwaps),
      volumeTokens: sum((b) => b.volumeTokens),
      volumeUsd: usd,
      buyVolumeUsd:
        usd === null ? null : priced.reduce((a, x) => a + (x.b.buyVolumeUsd as number), 0),
      sellVolumeUsd:
        usd === null ? null : priced.reduce((a, x) => a + (x.b.sellVolumeUsd as number), 0),
      quoteUsdMethod: null,
      detail: {
        layer,
        pools: l.map(({ pool, b }) => ({
          pool,
          swaps: b.swaps,
          unpricedSwaps: b.unpricedSwaps,
          volumeUsd: b.volumeUsd,
          quoteUsdMethod: b.quoteUsdMethod,
          swapShare: swaps > 0 ? b.swaps / swaps : null,
          usdShare: b.volumeUsd !== null && usd !== null && usd > 0 ? b.volumeUsd / usd : null,
        })),
        ...(withoutSide ? { swapsWithoutSide: withoutSide } : {}),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The check against risk_pool_flow

/** What the check needs of one pool bar. */
export type CheckBar = {
  hour: string;
  regime: Regime;
  swaps: number;
  buySwaps: number;
  sellSwaps: number;
  unpricedSwaps: number;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  swapsWithoutSide: number;
};
/** One row of risk_pool_flow, the fields the check compares. */
export type CheckFlowRow = {
  regime: Regime | 'all';
  window: FlowWindow;
  dataTo: string;
  swaps: number;
  sellSwaps: number;
  buySwaps: number;
  unpricedSwaps: number;
  sellUsd: number;
  buyUsd: number;
};
export type CheckField =
  | 'swaps'
  | 'sellSwaps'
  | 'buySwaps'
  | 'unpricedSwaps'
  | 'sellUsd'
  | 'buyUsd';
export type CheckSums = Record<CheckField, number> & { swapsWithoutSide: number; hours: number };
export type CheckResult = {
  status: 'exact' | 'float_rounding' | 'differs';
  sums: CheckSums;
  /** The fields that differ, flow's figure and the bars'. */
  diffs: Partial<Record<CheckField, { flow: number; bars: number }>>;
  /** True when the bars and flow agree once the swaps with no side are counted as unpriced purchases, as the flow import counts them. */
  explainedBySwapsWithoutSide: boolean;
};

/** The bars of a flow row's window (its last 24, 168 or 672 hours to `dataTo`) and regime, summed in hour order. */
export function barsInWindow(bars: CheckBar[], row: CheckFlowRow): CheckSums {
  const w = flowWindow(row.dataTo, row.window);
  const s: CheckSums = {
    swaps: 0,
    sellSwaps: 0,
    buySwaps: 0,
    unpricedSwaps: 0,
    sellUsd: 0,
    buyUsd: 0,
    swapsWithoutSide: 0,
    hours: 0,
  };
  for (const b of [...bars].sort((x, y) => x.hour.localeCompare(y.hour))) {
    if (b.hour < w.from || b.hour > w.to) continue;
    if (row.regime !== 'all' && b.regime !== row.regime) continue;
    s.hours++;
    s.swaps += b.swaps;
    s.sellSwaps += b.sellSwaps;
    s.buySwaps += b.buySwaps;
    s.unpricedSwaps += b.unpricedSwaps;
    s.sellUsd += b.sellVolumeUsd ?? 0;
    s.buyUsd += b.buyVolumeUsd ?? 0;
    s.swapsWithoutSide += b.swapsWithoutSide;
  }
  return s;
}

/**
 * Within float rounding: the two sums of the same products differ by no more than the summation error
 * bound, 2·n·ε·|sum| for n terms (ε = 2^-52); n is the swaps summed. Counts must be equal.
 */
export const withinRounding = (a: number, b: number, n: number) =>
  Math.abs(a - b) <= 2 * Math.max(n, 1) * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));

/** The fields where `s` and the flow row differ beyond float rounding, and whether any differed within it. */
export function compareSums(row: CheckFlowRow, s: CheckSums) {
  const counts: CheckField[] = ['swaps', 'sellSwaps', 'buySwaps', 'unpricedSwaps'];
  const usd: CheckField[] = ['sellUsd', 'buyUsd'];
  const diffs: CheckResult['diffs'] = {};
  let rounding = false;
  for (const k of counts) if (row[k] !== s[k]) diffs[k] = { flow: row[k], bars: s[k] };
  for (const k of usd) {
    if (row[k] === s[k]) continue;
    if (withinRounding(row[k], s[k], s.swaps)) rounding = true;
    else diffs[k] = { flow: row[k], bars: s[k] };
  }
  return { diffs, rounding };
}

export function checkFlowRow(bars: CheckBar[], row: CheckFlowRow): CheckResult {
  const sums = barsInWindow(bars, row);
  const { diffs, rounding } = compareSums(row, sums);
  const differs = Object.keys(diffs).length > 0;
  let explained = false;
  if (differs && sums.swapsWithoutSide > 0) {
    const adj = {
      ...sums,
      swaps: sums.swaps + sums.swapsWithoutSide,
      buySwaps: sums.buySwaps + sums.swapsWithoutSide,
      unpricedSwaps: sums.unpricedSwaps + sums.swapsWithoutSide,
    };
    explained = Object.keys(compareSums(row, adj).diffs).length === 0;
  }
  return {
    status: differs ? 'differs' : rounding ? 'float_rounding' : 'exact',
    sums,
    diffs,
    explainedBySwapsWithoutSide: explained,
  };
}
