import { createSolanaRpc, type Rpc, type SolanaRpcApi } from '@solana/kit';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** Primary RPC from env, with an optional fallback used by callers on timeout. Never the public RPC in production paths. */
export function rpcUrls(): { primary: string; fallback?: string } {
  const primary = process.env.SOLANA_RPC_URL;
  if (!primary) throw new Error('SOLANA_RPC_URL is not set (see .env.example)');
  return { primary, fallback: process.env.SOLANA_RPC_URL_FALLBACK || undefined };
}

export function createRpc(url = rpcUrls().primary): SolanaRpc {
  return createSolanaRpc(url);
}
