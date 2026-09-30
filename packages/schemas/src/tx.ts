import { z } from 'zod';
import { Chain, ExecutionKind, Provenance } from './enums.js';

/** What POST /plans/{id}/transactions returns: chain-specific unsigned payloads a partner wallet signs. */
export const UnsignedTx = z.object({
  legAssetId: z.string(),
  kind: ExecutionKind,
  chain: Chain,
  /** Solana: base64 VersionedTransaction. EVM: 0x calldata with `to` and `value` in `evm`. */
  payload: z.string(),
  evm: z.object({ to: z.string(), value: z.string(), chainId: z.number() }).optional(),
  description: z.string(),
  provenance: Provenance,
  /** Row in `executions` created when the set was built; the signer reports the outcome against it. */
  executionId: z.string().optional(),
  /** Solana: the block height after which the payload's blockhash is stale and must be rebuilt. */
  lastValidBlockHeight: z.number().optional(),
});

export const ExecutionReport = z.object({
  signature: z.string().min(64).optional(),
  status: z.enum(['sent', 'confirmed', 'failed']),
  error: z.string().max(2000).optional(),
});
export type ExecutionReport = z.infer<typeof ExecutionReport>;
export type UnsignedTx = z.infer<typeof UnsignedTx>;
