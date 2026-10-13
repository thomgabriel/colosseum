// The pool collector's refresh tiers (policy inputs), as one function so the registry's re-tiering (retier.ts) and the
// merge of the shelf's pools into the collector's registry (collector/registry-merge.ts) apply the same rule:
//   A: the pools that together hold `tierAShare` of the TVL of the pools with TVL ≥ `minPoolTvlUsd` (5-minute refresh)
//   B: the other pools with TVL ≥ `minPoolTvlUsd` (hourly)
//   X: dust, TVL below `minPoolTvlUsd`: kept in the registry, not collected.
// No I/O.
export type Tier = 'A' | 'B' | 'X';
export type TierRule = { tierAShare: number; minPoolTvlUsd: number };
/** retier.ts's defaults (TIER_A_SHARE, MIN_POOL_TVL_USD), the rule the installed registry was tiered by. */
export const DEFAULT_TIER_RULE: TierRule = { tierAShare: 0.99, minPoolTvlUsd: 1000 };

/** Each pool's tier, by address. Pools are ranked by TVL; equal TVLs keep the order given. */
export function tierByShare(
  pools: ReadonlyArray<{ address: string; tvlUsd: number | null }>,
  rule: TierRule = DEFAULT_TIER_RULE,
): Map<string, Tier> {
  const live = pools
    .filter((p) => (p.tvlUsd ?? 0) >= rule.minPoolTvlUsd)
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  const total = live.reduce((s, p) => s + (p.tvlUsd ?? 0), 0);
  let cum = 0;
  const tier = new Map<string, Tier>();
  for (const p of live) {
    tier.set(p.address, cum < rule.tierAShare * total ? 'A' : 'B');
    cum += p.tvlUsd ?? 0;
  }
  for (const p of pools) if (!tier.has(p.address)) tier.set(p.address, 'X');
  return tier;
}
