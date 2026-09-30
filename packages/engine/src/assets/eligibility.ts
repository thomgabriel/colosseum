import type { Asset, Profile } from '@colosseum/schemas';

/**
 * Registry-level eligibility. Rule (CLAUDE.md): equity (xStocks) is never eligible for `income`,
 * regardless of what the asset row says. Enforced here, not in the LLM prompt.
 */
export function isEligible(
  asset: Pick<Asset, 'kind' | 'eligibleProfiles' | 'mintPath'>,
  profile: Profile,
): boolean {
  if (asset.kind === 'equity' && profile === 'income') return false;
  return asset.eligibleProfiles.includes(profile);
}

/** Legs with `mintPath: 'unavailable'` may appear in a plan (labelled) but never in an execution set. */
export function isExecutable(asset: Pick<Asset, 'mintPath'>): boolean {
  return asset.mintPath !== 'unavailable';
}

/** Identifier of the abstract BRL leg. The registry entry is seeded in D1-PM; BRS-specific data only after G-Nora. */
export const BRL_LEG_ID = 'brl-leg';
