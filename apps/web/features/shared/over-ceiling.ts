import type { CreatorLimitsResponse } from '@colosseum/schemas';

/** The rules a chain's registry holds a shared portfolio to, with each listed asset's ceiling. */
export type ChainRules = Pick<CreatorLimitsResponse, 'limits' | 'ceilings' | 'ceilingsFrom'>;

/** The rows over their asset's ceiling on the chain's list, with the ceiling: the figure a warning cites. */
export function overCeiling(
  rows: { asset: string; bps: number | null }[],
  rules: Pick<ChainRules, 'ceilings'>,
): { asset: string; bps: number; ceilingBps: number }[] {
  const ceilings = new Map(rules.ceilings.map((c) => [c.asset, c.maxWeightBps]));
  return rows.flatMap((r) => {
    const ceiling = ceilings.get(r.asset);
    return r.bps !== null && ceiling !== undefined && r.bps > ceiling
      ? [{ asset: r.asset, bps: r.bps, ceilingBps: ceiling }]
      : [];
  });
}
