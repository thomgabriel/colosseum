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
});
export type UnsignedTx = z.infer<typeof UnsignedTx>;
