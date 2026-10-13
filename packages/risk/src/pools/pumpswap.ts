import { Reader } from './bytes';
import { ANCHOR_POOL_DISC } from './meteora-damm';

/**
 * PumpSwap (pump.fun's constant-product AMM, DexScreener `pumpswap`). Layout of `Pool` (IDL:
 * github.com/pump-fun/pump-public-docs, idl/pump_amm.json): disc @0, pool_bump u8 @8, index u16 @9, creator @11,
 * base_mint @43, quote_mint @75, lp_mint @107, pool_base_token_account @139, pool_quote_token_account @171,
 * lp_supply u64 @203, coin_creator @211, is_mayhem_mode @243, is_cashback_coin @244, virtual_quote_reserves i128
 * @245, creator_fee_bps u64 @261, … protocol_fees u64 @271, creator_fees u64 @279. The program has grown the
 * account over time (300 and 301 bytes seen on 2026-10-13), so only the fields to coin_creator are required. Base is
 * token 0, quote token 1. Checked against live pools (fixtures/risk/assets/venues/pools-20261013.json.gz).
 */
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export type PumpSwapPool = {
  index: number;
  creator: string;
  mint0: string;
  mint1: string;
  lpMint: string;
  vault0: string;
  vault1: string;
  lpSupply: bigint;
  coinCreator: string;
};

export function decodePumpSwapPool(data: Uint8Array): PumpSwapPool {
  const r = new Reader(data);
  if (data.length < 243 || r.disc() !== ANCHOR_POOL_DISC)
    throw new Error(`pumpswap pool: ${data.length} bytes, discriminator ${r.disc()}`);
  return {
    index: r.u16(9),
    creator: r.pubkey(11),
    mint0: r.pubkey(43),
    mint1: r.pubkey(75),
    lpMint: r.pubkey(107),
    vault0: r.pubkey(139),
    vault1: r.pubkey(171),
    lpSupply: r.u64(203),
    coinCreator: r.pubkey(211),
  };
}
