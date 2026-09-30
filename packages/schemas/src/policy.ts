import { z } from 'zod';
import { PolicyMechanism } from './enums.js';

export const WeightBand = z.object({
  assetId: z.string(),
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
});

/** The stored policy: allowed assets, bands, trigger, withdrawals only to the owner. */
export const Policy = z.object({
  id: z.string(),
  planId: z.string(),
  wallet: z.string(),
  allowedAssets: z.array(z.string()).min(1),
  bands: z.array(WeightBand),
  trigger: z.object({ driftPct: z.number().positive(), minIntervalHours: z.number().positive() }),
  withdrawalDestination: z.string(),
  mechanism: PolicyMechanism,
  createdAt: z.string().datetime(),
});
export type Policy = z.infer<typeof Policy>;
