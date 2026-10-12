// The gates of `pnpm risk:assets-backfill` (PLAN-ASSETS AS.8, DA14): a whole series, or a window wider than a
// sample, runs only when the newest count of the same scope says it fits the budget; and a fetch stops between
// pieces when the next one could pass it. File reads only; the clock and the disk are passed in.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Budget, DEFAULT_BUDGET, fitsBudget, SHELF_FLOOR_USD } from '@colosseum/risk';

/**
 * The widest window a fetch may take without a count that fits, per series: a day of Robinhood Chain is about
 * 855,000 blocks, so a million blocks is a day and a few hours; two days on Solana. Wider is a series run.
 */
export const MAX_SAMPLE_WINDOW = {
  'robinhood-logs': { size: 1_000_000, unit: 'block' },
  'solana-swaps': { size: 2 * 86_400, unit: 'second' },
  'solana-mints': { size: 2 * 86_400, unit: 'second' },
} as const;

/**
 * What a count measured: `scope` names it (a series counted two ways keeps both: `mint` and `authority` for
 * Solana's mints, `pools` sampled and `pools-exact` walked for its swaps). A count written before scopes is
 * read by its `via` where it has one.
 */
export type CountFile = {
  file: string;
  scope: string | null;
  countedAt: string;
  gzBytes: number | null;
};

export function readCounts(dir: string): CountFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('count-') && f.endsWith('.json'))
    .map((f) => {
      const b = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        scope?: string;
        via?: string;
        countedAt?: string;
        estimate?: { gzBytes?: number | null };
      };
      return {
        file: join(dir, f),
        scope: b.scope ?? b.via ?? null,
        countedAt: b.countedAt ?? '',
        gzBytes: typeof b.estimate?.gzBytes === 'number' ? b.estimate.gzBytes : null,
      };
    });
}

/** The newest count of exactly this scope, or null. */
export function newestCount(dir: string, scope: string): CountFile | null {
  return (
    readCounts(dir)
      .filter((c) => c.scope === scope)
      .sort((a, b) => a.countedAt.localeCompare(b.countedAt))
      .at(-1) ?? null
  );
}

/**
 * Whether a series (or a window wider than a sample) may run: the newest count of its scope exists and its
 * estimate fits the budget beside what is already written and the free disk.
 */
export function gateWholeSeries(inp: {
  dir: string;
  scope: string;
  usedBytes: number;
  freeBytes: number;
  budget?: Budget;
}): { ok: boolean; reasons: string[]; count: string | null } {
  const c = newestCount(inp.dir, inp.scope);
  if (!c)
    return {
      ok: false,
      reasons: [`no count of scope ${inp.scope} in ${inp.dir}: run --count first`],
      count: null,
    };
  if (c.gzBytes === null)
    return { ok: false, reasons: [`the count ${c.file} has no byte estimate`], count: c.file };
  const b = fitsBudget(
    { estimateBytes: c.gzBytes, usedBytes: inp.usedBytes, freeBytes: inp.freeBytes },
    inp.budget ?? DEFAULT_BUDGET,
  );
  return { ok: b.fits, reasons: b.reasons, count: c.file };
}

/**
 * The scope of a trading series (gate ASSET-HISTORY-2): `shelf`, the default, is the pools of the shelf's tokens
 * (ASSET-SHELF) over the last `days` (30); `list` is the scope of 2026-10-10 (ASSET-HISTORY), every pool of the
 * list's rows over each pool's whole life on Robinhood Chain (`days` null) or 90 days and the sampled walk
 * beyond on Solana. `tokensHash` names the shelf's token set (`shelfHash`), so a count of one shelf never gates
 * a fetch of another.
 */
export type TradingSeries = 'robinhood-logs' | 'solana-swaps';
export type BackfillScope =
  | { kind: 'list'; days: number | null }
  | { kind: 'shelf'; days: number; floorUsd: number; tokensHash: string };
export const SHELF_DAYS = 30;
export const LIST_DAYS: Record<TradingSeries, number | null> = {
  'robinhood-logs': null,
  'solana-swaps': 90,
};

/** `--scope`, `--days` and `--floor` read and checked; the shelf's hash is filled in once the shelf is cut. */
export function scopeOptions(
  series: TradingSeries,
  o: { scope?: string | undefined; days?: string | undefined; floor?: string | undefined },
):
  | { kind: 'list'; days: number | null; floorUsd: null }
  | { kind: 'shelf'; days: number; floorUsd: number } {
  const kind = o.scope ?? 'shelf';
  if (kind !== 'shelf' && kind !== 'list') throw new Error(`--scope ${kind}: shelf or list`);
  const days =
    o.days === undefined ? (kind === 'shelf' ? SHELF_DAYS : LIST_DAYS[series]) : Number(o.days);
  if (days !== null && (!Number.isInteger(days) || days < 1))
    throw new Error(`--days ${o.days}: a whole number of days, at least 1`);
  if (kind === 'list') {
    if (o.floor !== undefined)
      throw new Error('--floor cuts the shelf: it has no meaning with --scope list');
    return { kind, days, floorUsd: null };
  }
  const floorUsd = Number(o.floor ?? SHELF_FLOOR_USD);
  if (!(floorUsd >= 0)) throw new Error(`--floor ${o.floor}: dollars, at least 0`);
  return { kind, days: days as number, floorUsd };
}

/**
 * The key a count is written under and a fetch is gated on. The list's scopes of 2026-10-10 keep their keys
 * (`logs`; `pools` sampled and `pools-exact` walked), so the counts already on disk gate what they gated; every
 * other scope names its kind, days and, for the shelf, the floor and the token set.
 */
export function scopeKey(series: TradingSeries, s: BackfillScope, exact = false): string {
  if (exact && series !== 'solana-swaps') throw new Error(`${series}: no exact pass`);
  const base =
    s.kind === 'shelf'
      ? `shelf-d${s.days}-f${s.floorUsd}-${s.tokensHash}`
      : series === 'robinhood-logs'
        ? s.days === null
          ? 'logs'
          : `logs-d${s.days}`
        : s.days === 90
          ? 'pools'
          : `pools-d${s.days ?? 'life'}`;
  return exact ? `${base}-exact` : base;
}

/** True when a fetch window is wider than a sample of its series may be. */
export function windowNeedsGate(series: keyof typeof MAX_SAMPLE_WINDOW, from: number, to: number) {
  return to - from + 1 > MAX_SAMPLE_WINDOW[series].size;
}

/**
 * A wide window (one `windowNeedsGate` sends to a count) must lie inside the scope it is gated by: a count of
 * the scope's last `days` does not stand for a window that starts before them. `scopeStart` is the scope's first
 * block (Robinhood Chain) or second (Solana); null for a whole-life scope, which holds every window.
 */
export function requireWindowInScope(
  from: number,
  scopeStart: number | null,
  what: string,
  key: string,
): void {
  if (scopeStart !== null && from < scopeStart)
    throw new Error(
      `${what} starts at ${from}, before the scope ${key} begins (${scopeStart}): its count does not cover it; count the wider scope (--scope list or --days) first`,
    );
}

/** Thrown between pieces when the budget would be crossed; the command ends cleanly with the reasons. */
export class BudgetStop extends Error {
  constructor(readonly reasons: string[]) {
    super(`stopped by the budget: ${reasons.join('; ')}`);
  }
}

/**
 * A check to run before a fetch and after every piece: `usedAtStart` is the new data under the output folder
 * when the run began, `written` what the run has written since, `free` the disk's free bytes now; `nextBytes`
 * is what the next piece may add (the largest piece so far). Throws BudgetStop when it would not fit.
 */
export function budgetGuard(
  usedAtStart: number,
  free: () => number,
  budget: Budget = DEFAULT_BUDGET,
) {
  return (p: { nextBytes: number; writtenBytes: number }) => {
    const b = fitsBudget(
      { estimateBytes: p.nextBytes, usedBytes: usedAtStart + p.writtenBytes, freeBytes: free() },
      budget,
    );
    if (!b.fits) throw new BudgetStop(b.reasons);
  };
}
