import { Reader } from './bytes';

/**
 * Raydium AMM v4 (the legacy constant-product AMM, once paired with an OpenBook market). Its pool account `AmmInfo`
 * is a plain 752-byte struct with no discriminator: 32 u64 fields (status @0, nonce @8, … coin_decimals @32,
 * pc_decimals @40, … need_take_pnl_coin @192, need_take_pnl_pc @200, … orderbook_to_init_time @248), the swap
 * accumulators (u128 @256, u128 @272, u64 @288, u128 @296, u128 @312, u64 @328), then the keys: coin_vault @336,
 * pc_vault @368, coin_mint @400, pc_mint @432, lp_mint @464, open_orders @496, market @528, market_program @560,
 * target_orders @592, withdraw_queue @624, lp_vault @656, amm_owner @688, lp_amount u64 @720, 3 u64 of padding.
 * Source: the program's state.rs (github.com/raydium-io/raydium-amm, program/src/state.rs) and the SDK's
 * `liquidityStateV4Layout` (@raydium-io/raydium-sdk-v2, src/raydium/liquidity/layout.ts), checked against live
 * pools (fixtures/risk/assets/venues/pools-20261013.json.gz). Coin is token 0, pc token 1. Swappable reserves are the
 * vault balances minus the protocol's pnl not yet taken (need_take_pnl), which sits in the same vaults.
 */
export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_AMM_V4_SIZE = 752;

export type AmmV4Pool = {
  status: number;
  decimals0: number;
  decimals1: number;
  /** Protocol pnl owed, held in each vault, raw units. */
  owed0: bigint;
  owed1: bigint;
  vault0: string;
  vault1: string;
  mint0: string;
  mint1: string;
  lpMint: string;
  openOrders: string;
  market: string;
  lpAmount: bigint;
};

export function decodeAmmV4Pool(data: Uint8Array): AmmV4Pool {
  if (data.length !== RAYDIUM_AMM_V4_SIZE)
    throw new Error(`raydium amm v4 pool: ${data.length} bytes, not ${RAYDIUM_AMM_V4_SIZE}`);
  const r = new Reader(data);
  return {
    status: Number(r.u64(0)),
    decimals0: Number(r.u64(32)),
    decimals1: Number(r.u64(40)),
    owed0: r.u64(192),
    owed1: r.u64(200),
    vault0: r.pubkey(336),
    vault1: r.pubkey(368),
    mint0: r.pubkey(400),
    mint1: r.pubkey(432),
    lpMint: r.pubkey(464),
    openOrders: r.pubkey(496),
    market: r.pubkey(528),
    lpAmount: r.u64(720),
  };
}
