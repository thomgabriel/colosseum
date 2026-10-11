// The gates of `pnpm risk:assets-backfill` (PLAN-ASSETS AS.8, DA14): a whole series, or a window wider than a
// sample, runs only when the newest count of the same scope says it fits the budget; and a fetch stops between
// pieces when the next one could pass it. File reads only; the clock and the disk are passed in.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Budget, DEFAULT_BUDGET, fitsBudget } from '@colosseum/risk';

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

/** True when a fetch window is wider than a sample of its series may be. */
export function windowNeedsGate(series: keyof typeof MAX_SAMPLE_WINDOW, from: number, to: number) {
  return to - from + 1 > MAX_SAMPLE_WINDOW[series].size;
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
