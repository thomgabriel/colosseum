// The backfill of PLAN-ASSETS AS.8, the parts with no I/O and no clock: which block windows to sample, how a
// series' total is estimated from samples, the rate of an address's transactions from anchored pages, the
// live loop's quiet minutes, the disk budget, and a pool's or token's manifest. The walkers in scripts/ read
// and write; these functions decide.

/** A series of the backfill, in the order of the prompt's section 6.4. */
export const BACKFILL_SERIES = [
  'robinhood-logs',
  'chainlink-rounds',
  'solana-swaps',
  'solana-mints',
  'external-daily',
] as const;
export type BackfillSeries = (typeof BACKFILL_SERIES)[number];
export const BACKFILL_METHOD_VERSION = 'backfill-0.1';

// ---------------------------------------------------------------------------------------------------------------
// The live loop's minutes

/**
 * Robinhood Chain's live loop reads the public endpoint in the first quarter of every hour: the backfill reads
 * nothing from minute 1 to minute 14 (both included). The wait, in milliseconds, before a read at `now` may go
 * out: 0 outside those minutes, else until minute 15 of the same hour.
 */
export function quietWaitMs(now: Date, first = 1, last = 14): number {
  const m = now.getUTCMinutes();
  if (m < first || m > last) return 0;
  const resume = new Date(now);
  resume.setUTCMinutes(last + 1, 0, 0);
  return resume.getTime() - now.getTime();
}

// ---------------------------------------------------------------------------------------------------------------
// Sampled windows and the estimate of a total

/** A stratum of a span and the window sampled in it, both inclusive. */
export type Stratum = { from: number; to: number; sample: [number, number] };

/**
 * `k` strata of equal length over [from, to], each with one window of `size` at its middle (the whole stratum
 * when it is shorter than a window). Deterministic: the same span gives the same samples.
 */
export function strata(from: number, to: number, k: number, size: number): Stratum[] {
  if (to < from || k < 1 || size < 1) return [];
  const len = to - from + 1;
  const out: Stratum[] = [];
  for (let i = 0; i < k; i++) {
    const a = from + Math.floor((len * i) / k);
    const b = from + Math.floor((len * (i + 1)) / k) - 1;
    if (b < a) continue;
    const n = b - a + 1;
    const s = n <= size ? a : a + Math.floor((n - size) / 2);
    out.push({ from: a, to: b, sample: [s, Math.min(b, s + size - 1)] });
  }
  return out;
}

/** What one sampled window held, by the class of what was counted. */
export type StratumCount = { stratum: Stratum; counts: Record<string, number>; bytes: number };

/**
 * The total of each class over the span: each window's count scaled by its stratum's length over the window's
 * (a stratified estimate), with the spread of the per-stratum rates, so a reader sees how uneven the span is.
 * `bytes` scales the same way.
 */
export function extrapolate(samples: StratumCount[]): {
  totals: Record<string, number>;
  bytes: number;
  sampledShare: number;
  perStratum: Array<{ from: number; to: number; counts: Record<string, number> }>;
} {
  const totals: Record<string, number> = {};
  let bytes = 0;
  let sampled = 0;
  let span = 0;
  for (const s of samples) {
    const w = s.stratum.sample[1] - s.stratum.sample[0] + 1;
    const n = s.stratum.to - s.stratum.from + 1;
    const f = n / w;
    sampled += w;
    span += n;
    for (const [k, v] of Object.entries(s.counts)) totals[k] = (totals[k] ?? 0) + v * f;
    bytes += s.bytes * f;
  }
  return {
    totals,
    bytes,
    sampledShare: span ? sampled / span : 0,
    perStratum: samples.map((s) => ({ from: s.stratum.from, to: s.stratum.to, counts: s.counts })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// An address's transactions over time, from anchored pages (Solana)

/**
 * One page of `getSignaturesForAddress(address, { before: <a signature at time t>, limit })`: the newest
 * signature at or before `t` back. `n` signatures over `[oldest, newest]`; `exhausted` when the page holds fewer
 * than the limit, so nothing older exists and `oldest` is the address's first transaction. `failed` of them
 * carried an error (they are walked, never fetched).
 */
export type AnchoredPage = {
  t: number;
  n: number;
  newest: number | null;
  oldest: number | null;
  failed: number;
  exhausted: boolean;
};

/**
 * The page's rate, in signatures a second: its `n` over the time from its oldest signature to its anchor, which
 * includes the quiet time between its newest signature and the anchor (none happened there). It is the mean
 * rate of that segment, placed at the segment's middle.
 */
export const pageRate = (p: AnchoredPage) =>
  p.n === 0 || p.oldest === null ? 0 : p.n / Math.max(1, p.t - p.oldest);
const pageMid = (p: AnchoredPage) => (p.oldest === null ? p.t : (p.oldest + p.t) / 2);

/**
 * The signatures of an address between `from` and `to` (unix seconds), estimated from its anchored pages: each
 * page's mean rate at the middle of what it covers, linear between neighbouring pages and flat beyond the first
 * and the last (trapezoids), and nothing before the address's first transaction: the oldest signature of an
 * exhausted page, or the anchor of a page that found none. Returns the estimate, the share of failed signatures
 * the pages held, and the first transaction where a page reached it.
 */
export function estimateSignatures(
  pages: AnchoredPage[],
  from: number,
  to: number,
): { signatures: number; failedShare: number; firstSeen: number | null } {
  let firstSeen: number | null = null;
  let noneBefore = Number.NEGATIVE_INFINITY;
  for (const p of pages) {
    if (p.n === 0) noneBefore = Math.max(noneBefore, p.t);
    else if (p.exhausted && p.oldest !== null)
      firstSeen = firstSeen === null ? p.oldest : Math.min(firstSeen, p.oldest);
  }
  const start = Math.max(from, firstSeen ?? Number.NEGATIVE_INFINITY, noneBefore);
  const pts = pages.map((p) => ({ t: pageMid(p), r: pageRate(p) })).sort((a, b) => a.t - b.t);
  const n = pages.reduce((a, p) => a + p.n, 0);
  const failedShare = n ? pages.reduce((a, p) => a + p.failed, 0) / n : 0;
  if (to <= start || pts.length === 0) return { signatures: 0, failedShare, firstSeen };
  const first = pts[0] as { t: number; r: number };
  const last = pts.at(-1) as { t: number; r: number };
  const rateAt = (t: number) => {
    if (t <= first.t) return first.r;
    if (t >= last.t) return last.r;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as { t: number; r: number };
      const b = pts[i] as { t: number; r: number };
      if (t <= b.t) return b.t === a.t ? b.r : a.r + ((b.r - a.r) * (t - a.t)) / (b.t - a.t);
    }
    return last.r;
  };
  const cuts = [start, ...pts.map((p) => p.t).filter((t) => t > start && t < to), to];
  let sum = 0;
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1] as number;
    const b = cuts[i] as number;
    sum += ((rateAt(a) + rateAt(b)) / 2) * (b - a);
  }
  return { signatures: sum, failedShare, firstSeen };
}

/**
 * The transactions a sampled walk fetches between `from` and `to`: in each hour at most `perHour` successful
 * ones, from the rate of the anchored pages (history-backfill.ts keeps the oldest `perHour` of each hour).
 */
export function estimateSampled(
  pages: AnchoredPage[],
  from: number,
  to: number,
  perHour: number,
): { fetched: number; hours: number } {
  const step = 3600;
  let fetched = 0;
  let hours = 0;
  for (let h = from; h < to; h += step) {
    const got = estimateSignatures(pages, h, Math.min(to, h + step));
    const ok = got.signatures * (1 - got.failedShare);
    if (ok <= 0) continue;
    hours++;
    fetched += Math.min(perHour, ok);
  }
  return { fetched, hours };
}

// ---------------------------------------------------------------------------------------------------------------
// The disk budget (DA14, amended): at most 35 GB of new data, and never below 25 GB free

export const GB = 1024 ** 3;
export type Budget = { maxNewBytes: number; minFreeBytes: number };
export const DEFAULT_BUDGET: Budget = { maxNewBytes: 35 * GB, minFreeBytes: 25 * GB };

/**
 * Whether a series of `estimateBytes` fits: the new data already written (`usedBytes`) plus the estimate stays
 * within the budget, and the disk keeps its floor of free space after it. A series that does not fit is
 * stopped and reported, never cut short to fit.
 */
export function fitsBudget(
  inp: { estimateBytes: number; usedBytes: number; freeBytes: number },
  b: Budget = DEFAULT_BUDGET,
): { fits: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (inp.usedBytes + inp.estimateBytes > b.maxNewBytes)
    reasons.push(
      `new data ${((inp.usedBytes + inp.estimateBytes) / GB).toFixed(2)} GB would pass the ${(b.maxNewBytes / GB).toFixed(0)} GB budget`,
    );
  if (inp.freeBytes - inp.estimateBytes < b.minFreeBytes)
    reasons.push(
      `free disk would fall to ${((inp.freeBytes - inp.estimateBytes) / GB).toFixed(2)} GB, under the ${(b.minFreeBytes / GB).toFixed(0)} GB floor`,
    );
  return { fits: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------------------------
// Manifests

/** One completeness check of a pool's or token's raw files, passed or failed, with what it saw. */
export type ManifestCheck = { name: string; passed: boolean; detail: string };
/** What a pool's or token's folder holds: the windows covered, counts per day, and the checks. */
export type Manifest = {
  series: BackfillSeries;
  chain: 'solana' | 'robinhood';
  /** The pool, the token or the feed. */
  subject: string;
  methodVersion: string;
  source: string;
  provenance: 'live';
  /** The windows fetched, merged: blocks on Robinhood Chain, unix seconds on Solana, round ids for a feed. */
  covered: Array<{ from: number; to: number; unit: 'block' | 'second' | 'round' }>;
  days: Record<string, { rows: number; bytes: number }>;
  rows: number;
  bytes: number;
  checks: ManifestCheck[];
  updatedAt: string;
};

/** The windows of a manifest with one more, merged where they touch or overlap. */
export function mergeCovered(
  covered: Manifest['covered'],
  add: Manifest['covered'][number],
): Manifest['covered'] {
  const all = [...covered, add].sort((a, b) => a.unit.localeCompare(b.unit) || a.from - b.from);
  const out: Manifest['covered'] = [];
  for (const w of all) {
    const last = out.at(-1);
    if (last && last.unit === w.unit && w.from <= last.to + 1) last.to = Math.max(last.to, w.to);
    else out.push({ ...w });
  }
  return out;
}

/** A manifest with one more window and its days' counts added. */
export function addToManifest(
  m: Manifest,
  window: Manifest['covered'][number],
  days: Record<string, { rows: number; bytes: number }>,
  checks: ManifestCheck[],
  at: string,
): Manifest {
  const d = { ...m.days };
  for (const [k, v] of Object.entries(days)) d[k] = v;
  const rows = Object.values(d).reduce((a, x) => a + x.rows, 0);
  const bytes = Object.values(d).reduce((a, x) => a + x.bytes, 0);
  const names = new Set(checks.map((c) => c.name));
  return {
    ...m,
    covered: mergeCovered(m.covered, window),
    days: d,
    rows,
    bytes,
    checks: [...m.checks.filter((c) => !names.has(c.name)), ...checks],
    updatedAt: at,
  };
}
