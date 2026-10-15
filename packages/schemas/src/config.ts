import { z } from 'zod';
import { ChainConfig } from './chain-config';
import { Provenance } from './enums';
import { ChainMode, Flags } from './flags';

/**
 * One chain as GET /v1/config reports it: where it is, how it is run, and the label its figures carry
 * (chainProvenance). The label is null for a chain that is off.
 */
export const ChainStatus = ChainConfig.extend({
  mode: ChainMode,
  provenance: Provenance.nullable(),
  /**
   * Tokens the chain's deploy record shows that the server's asset table has no row for, so the server
   * lists them nowhere: empty when every one is listed. Only for a chain run from a record (live or
   * readonly); checked after each deploy.
   */
  missingAssets: z
    .array(z.object({ id: z.string(), address: z.string() }))
    .optional()
    .describe(
      "Tokens the chain's deploy record shows that the server's asset table has no row for, so they are listed nowhere. Empty when every one is listed; absent for a chain not run from a record.",
    ),
});
export type ChainStatus = z.infer<typeof ChainStatus>;

/** GET /v1/config. No secret and no RPC URL is part of it. */
export const ConfigResponse = z.object({ flags: Flags, chains: z.array(ChainStatus) });
export type ConfigResponse = z.infer<typeof ConfigResponse>;
