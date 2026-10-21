import type { LimitContext, Target } from '@colosseum/schemas';
import type { RecipeHeader } from './creator-limits';

// A second, slow statement of the author limits, used only by the tests. It is written from the rule
// tables in fixtures/creator-limits/README.md, the first rules and the second, and shares nothing with
// creator-limits.ts: its own numbers, sorted lists in place of maps, and every rule tried, not only the
// first that fails. It reads which rules apply from `ctx.limits.rules` and nothing else of
// `ctx.limits`. The tests hold the real check to it.

const ORDER = [
  'FeeNotZero',
  'FlagsNotZero',
  'TooFewAssets',
  'TooManyAssets',
  'AssetNotListed',
  'DuplicateAsset',
  'WeightBelowMin',
  'WeightOffStep',
  'WeightAboveCeiling',
  'WeightSum',
  'VersionPending',
  'VersionTooSoon',
  'TurnoverTooHigh',
  'CashNotAllowed',
];

/**
 * Twice the turnover: the sum of the absolute changes, by walking two sorted lists side by side. Under
 * the second rules cash moves too, by the difference between what the two versions leave of 10,000.
 */
export function referenceMovedBps(
  prev: readonly Target[],
  next: readonly Target[],
  rules: 1 | 2 = 1,
): number {
  const total = (list: readonly Target[]) => {
    const names = [...new Set(list.map((t) => t.asset))].sort();
    return names.map((name) => ({
      name,
      weight: list.filter((t) => t.asset === name).reduce((n, t) => n + t.weightBps, 0),
    }));
  };
  const a = total(prev);
  const b = total(next);
  let i = 0;
  let j = 0;
  let moved = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x && y && x.name === y.name) {
      moved += x.weight > y.weight ? x.weight - y.weight : y.weight - x.weight;
      i += 1;
      j += 1;
    } else if (x && (!y || x.name < y.name)) {
      moved += x.weight;
      i += 1;
    } else if (y) {
      moved += y.weight;
      j += 1;
    }
  }
  if (rules === 2) {
    const left = (list: readonly Target[]) => 10_000 - list.reduce((n, t) => n + t.weightBps, 0);
    moved += Math.abs(left(next) - left(prev));
  }
  return moved;
}

/** Every rule `next` breaks, lowest-numbered first. Empty means it may be published. */
export function referenceBreaks(
  prev: readonly Target[] | null,
  next: readonly Target[],
  ctx: LimitContext,
  header: RecipeHeader,
): string[] {
  const second = ctx.limits.rules === 2;
  const broken = new Set<string>();
  if (header.maxFeeBps > 0 || header.maxFeeBps < 0) broken.add('FeeNotZero');
  if (header.flags > 0 || header.flags < 0) broken.add('FlagsNotZero');

  if (next.length <= (second ? 0 : 2)) broken.add('TooFewAssets');
  if (next.length >= (second ? 17 : 13)) broken.add('TooManyAssets');

  let sum = 0;
  const names = next.map((t) => t.asset).sort();
  for (let k = 1; k < names.length; k += 1)
    if (names[k] === names[k - 1]) broken.add('DuplicateAsset');
  for (const t of next) {
    sum += t.weightBps;
    const onList = ctx.assets.filter((a) => a.id === t.asset);
    if (onList.length === 0) broken.add('AssetNotListed');
    if (t.weightBps < (second ? 50 : 200)) broken.add('WeightBelowMin');
    if (t.weightBps % 50 !== 0) broken.add('WeightOffStep');
    // Under the second rules the asset's own ceiling is not a limit.
    if (second && t.weightBps > 10_000) broken.add('WeightAboveCeiling');
    for (const a of onList) {
      if (!second && (t.weightBps > 5000 || t.weightBps > a.maxWeightBps))
        broken.add('WeightAboveCeiling');
      if (a.cls === 'cash') broken.add('CashNotAllowed');
    }
  }
  if (second ? sum > 10_000 : sum !== 10_000) broken.add('WeightSum');

  // A first version has nothing before it: nothing can be waiting, too recent or moved.
  const later = prev !== null;
  if (later && ctx.hasPending) broken.add('VersionPending');
  if (later && ctx.lastPublishAt !== null && ctx.now - ctx.lastPublishAt < ctx.publishDelay)
    broken.add('VersionTooSoon');
  // Over 20% moved is over 40% of absolute change.
  if (later && referenceMovedBps(prev, next, second ? 2 : 1) > 4000) broken.add('TurnoverTooHigh');

  return ORDER.filter((rule) => broken.has(rule));
}
