import type { Base64EncodedWireTransaction } from '@solana/kit';
import type { SolanaRpc } from './rpc.js';

export type SimulationResult = {
  ok: boolean;
  err: unknown;
  unitsConsumed: number | null;
  logs: string[];
};

/**
 * Simulates a base64 wire transaction. `sigVerify: false` + `replaceRecentBlockhash: true` lets us dry-run an
 * unsigned transaction (e.g. one built for a wallet whose key we do not hold). Used for pre-flight checks only;
 * every real send goes through sign/ (D3-AM) and is logged in `executions`.
 */
export async function simulateBase64(rpc: SolanaRpc, txBase64: string): Promise<SimulationResult> {
  const res = await rpc
    .simulateTransaction(txBase64 as Base64EncodedWireTransaction, {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    })
    .send();
  const v = res.value;
  return {
    ok: v.err === null,
    err: v.err,
    unitsConsumed: v.unitsConsumed === undefined ? null : Number(v.unitsConsumed),
    logs: v.logs ?? [],
  };
}
