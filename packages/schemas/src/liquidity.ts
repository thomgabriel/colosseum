import { z } from 'zod';

/**
 * The seam between the structurer (packages/engine) and the liquidity & risk layer (packages/risk).
 * The engine depends only on these types; packages/risk implements LiquidityProvider; the API wires them.
 * Every field is optional on the structurer's side: with no provider, the engine behaves as before.
 */

/** Structured liquidity block for one leg of a plan's risk sheet. */
export const LiquidityEntry = z.object({
  assetId: z.string(),
  /** Share of the leg's amount exitable within the plan's window at ≤ tau, worst regime; [0,1]. */
  score: z.number().min(0).max(1),
  /** Exit capacity in USD at ≤ tau in the worst regime of the window. */
  capacityUsd: z.number().nonnegative(),
  capacityLowerBound: z.boolean(),
  worstRegime: z.string(),
  tau: z.number(),
  windowDays: z.number(),
  legAmountUsd: z.number().nonnegative(),
  weekendRatio: z.number().nullable(),
  /** LP-exit stress: cost of selling the leg if the largest positions withdraw, when measured. */
  lpExitCostPct: z.number().nullable(),
  primaryPath: z.string().nullable(),
  samples: z.number().int().nonnegative(),
  dataFrom: z.string().nullable(),
  dataTo: z.string().nullable(),
  methodVersion: z.string(),
  provenance: z.enum(['live', 'fixture', 'mock']),
});
export type LiquidityEntry = z.infer<typeof LiquidityEntry>;

export const LiquidityOrder = z.object({
  fromAssetId: z.string(),
  toAssetId: z.string(),
  amountUsd: z.number().positive(),
  reason: z.literal('liquidity_breach'),
});
export type LiquidityOrder = z.infer<typeof LiquidityOrder>;

/** Result of a breach assessment for a policy's positions and upcoming withdrawals. */
export const LiquidityAssessment = z.object({
  breach: z.boolean(),
  likelyBreach: z.boolean(),
  shortfallUsd: z.number(),
  monthsAtRisk: z.array(z.string()),
  orders: z.array(LiquidityOrder),
  params: z.record(z.string(), z.number()),
  methodVersion: z.string(),
});
export type LiquidityAssessment = z.infer<typeof LiquidityAssessment>;

export type ExitCapacity = {
  capacityUsd: number;
  lowerBound: boolean;
  regime: string;
  samples: number;
  dataFrom: string | null;
  dataTo: string | null;
};

export type LiquidityAssessInput = {
  cashUsd: number;
  brlUsd: number;
  liquid: Array<{ assetId: string; valueUsd: number }>;
  illiquid: Array<{ assetId: string; valueUsd: number }>;
  withdrawals: Array<{ at: string; usd: number }>;
  windowDays: number;
  tau: number;
  shareOfDepth: number;
  dryFactorFloor: number;
};

/** Implemented by packages/risk (measured curves) and by a fixture provider in tests. */
export interface LiquidityProvider {
  readonly methodVersion: string;
  readonly provenance: 'live' | 'fixture' | 'mock';
  /** Whether the provider has measured curves for this asset (registry id). */
  covers(assetId: string): boolean;
  /** Exit capacity at cost ≤ tau in the worst regime a window of `windowDays` can contain. */
  exitCapacity(assetId: string, tau: number, windowDays: number): ExitCapacity | null;
  /** Cost (fraction) of selling `notionalUsd` in the worst regime of the window; null beyond measured sizes. */
  exitCost(assetId: string, notionalUsd: number, windowDays: number): number | null;
  /** Measured weekend ÷ market-hours capacity at tau; null when not measurable. */
  weekendRatio(assetId: string, tau: number): number | null;
  entry(
    assetId: string,
    ctx: { tau: number; windowDays: number; legAmountUsd: number },
  ): LiquidityEntry | null;
  assess(input: LiquidityAssessInput): LiquidityAssessment;
}

/** Policy trigger for liquidity (optional): when a likely breach is found, propose illiquid → USDC orders. */
export const LiquidityTrigger = z.object({
  impactTolerancePct: z.number().positive().max(50),
  horizonMonths: z.number().int().min(1).max(60),
  shareOfDepth: z.number().positive().max(1).default(0.25),
  dryFactorFloor: z.number().positive().max(1).default(0.25),
});
export type LiquidityTrigger = z.infer<typeof LiquidityTrigger>;
