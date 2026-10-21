import { z } from 'zod';
import { ChainId } from './chain';
import { Provenance } from './enums';

// GET /v1/stats: the platform's numbers under the landing's hero, from the vault product's own
// tables. One block per label the active chains' figures carry, so a mainnet's counts are never added
// to a test network's.

/** One count or sum, with where it came from, when it was read and how it was worked out. */
export const PlatformFigure = z.object({
  value: z.number().nonnegative(),
  source: z.string(),
  fetchedAt: z.string().datetime(),
  method: z.string(),
});
export type PlatformFigure = z.infer<typeof PlatformFigure>;

export const PlatformNetwork = z.object({
  /** The label every row counted here carries, and that the chains' figures carry now. */
  provenance: Provenance,
  chains: z.array(ChainId),
  /** Vaults the server knows on these chains: named by its cache, or read by the snapshot worker in the last 7 days. */
  vaults: PlatformFigure,
  /** The wallets that own them. */
  wallets: PlatformFigure,
  /**
   * What the vaults held at the snapshot worker's last pass, in dollars. Null when no pass in the last
   * two hours stands behind it on every one of the chains, or a vault counted has no snapshot in those
   * two hours: unknown, never 0 and never a partial sum.
   */
  valueUsd: PlatformFigure.nullable(),
});
export type PlatformNetwork = z.infer<typeof PlatformNetwork>;

export const PlatformStatsResponse = z.object({
  networks: z.array(PlatformNetwork),
  disclaimer: z.string(),
});
export type PlatformStatsResponse = z.infer<typeof PlatformStatsResponse>;
