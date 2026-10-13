// The backfill's own endpoints, chosen before any module reads the RPC from the env (imported second in
// backfill.ts, right after dotenv). SOLANA_BACKFILL_RPC_URL and ROBINHOOD_BACKFILL_RPC_URL, when set, carry the
// backfill's Solana and Robinhood Chain calls, and nothing else: the collectors and every other script keep
// SOLANA_RPC_URL and RISK_EVM_RH_RPC_URL as they are. Neither URL is printed or written anywhere; the logs
// name the variable only.

/** Which endpoint each chain's calls use, by variable name. */
export const BACKFILL_ENDPOINTS = {
  solana: process.env.SOLANA_BACKFILL_RPC_URL ? 'SOLANA_BACKFILL_RPC_URL' : null,
  robinhood: process.env.ROBINHOOD_BACKFILL_RPC_URL ? 'ROBINHOOD_BACKFILL_RPC_URL' : null,
} as const;

if (process.env.SOLANA_BACKFILL_RPC_URL)
  process.env.SOLANA_RPC_URL = process.env.SOLANA_BACKFILL_RPC_URL;
if (process.env.ROBINHOOD_BACKFILL_RPC_URL)
  process.env.RISK_EVM_RH_RPC_URL = process.env.ROBINHOOD_BACKFILL_RPC_URL;

/**
 * The live loop's quiet minutes (1 to 14 of each hour) guard the public endpoint the loop shares. A dedicated
 * endpoint shares nothing with it, so its requests are not held back.
 */
export const KEEP_QUIET_MINUTES = BACKFILL_ENDPOINTS.robinhood === null;
