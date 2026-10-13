import { Reader } from './bytes';

/** Anchor's discriminator of an account named `Pool`, sha256("account:Pool")[0..8]: the DAMM v1, DAMM v2 and
 *  PumpSwap pools all carry it (each program names its pool account `Pool`). */
export const ANCHOR_POOL_DISC = 'f19a6d0411b16dbc';

/**
 * Meteora DAMM v1 (dynamic AMM, DexScreener `meteora:DYN`). The pool does not hold the tokens itself: each side sits in
 * a Meteora dynamic vault (a lending vault shared by every pool of that token), and the pool holds that vault's LP
 * token in its own accounts a_vault_lp / b_vault_lp. Layout of `Pool` (IDL: github.com/MeteoraAg/damm-v1-sdk,
 * ts-client/src/amm/idl.ts): disc @0, lp_mint @8, token_a_mint @40, token_b_mint @72, a_vault @104, b_vault @136,
 * a_vault_lp @168, b_vault_lp @200, a_vault_lp_bump u8 @232, enabled bool @233, protocol_token_a_fee @234,
 * protocol_token_b_fee @266, … The account is 944 bytes for a constant-product pool and larger for a stable or
 * depeg curve (952, 1387 seen); every field read here sits before the curve, so the size is not checked. Token A is
 * token 0. Checked against live pools (fixtures/risk/assets/venues/pools-20261013.json.gz).
 */
export const METEORA_DAMM_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

export type DammV1Pool = {
  lpMint: string;
  mint0: string;
  mint1: string;
  /** The dynamic vaults (accounts of the vault program) that hold each token. */
  aVault: string;
  bVault: string;
  /** The pool's own token accounts: its share of each dynamic vault, in that vault's LP token. */
  aVaultLp: string;
  bVaultLp: string;
  enabled: boolean;
  protocolFee0: string;
  protocolFee1: string;
};

export function decodeDammV1Pool(data: Uint8Array): DammV1Pool {
  const r = new Reader(data);
  if (data.length < 944 || r.disc() !== ANCHOR_POOL_DISC)
    throw new Error(`meteora damm v1 pool: ${data.length} bytes, discriminator ${r.disc()}`);
  return {
    lpMint: r.pubkey(8),
    mint0: r.pubkey(40),
    mint1: r.pubkey(72),
    aVault: r.pubkey(104),
    bVault: r.pubkey(136),
    aVaultLp: r.pubkey(168),
    bVaultLp: r.pubkey(200),
    enabled: r.u8(233) === 1,
    protocolFee0: r.pubkey(234),
    protocolFee1: r.pubkey(266),
  };
}

/**
 * Meteora DAMM v2 (`cp-amm`, DexScreener `meteora:DYN2`): a constant-product pool with an optional price range,
 * holding its tokens in its own two vaults. Layout of `Pool` (zero-copy, 8 + 1,104 bytes; source:
 * github.com/MeteoraAg/damm-v2, programs/cp-amm/src/state/pool.rs, and the IDL in damm-v2-sdk, src/idl/cp_amm.json):
 * disc @0, pool_fees (PoolFeesStruct, 160 bytes) @8, token_a_mint @168, token_b_mint @200, token_a_vault @232,
 * token_b_vault @264, whitelisted_vault @296, padding @328, liquidity u128 @360, padding u128 @376, protocol_a_fee
 * u64 @392, protocol_b_fee u64 @400, … sqrt_price u128 @456, activation_point u64 @472, activation_type u8 @480,
 * pool_status u8 @481, token_a_flag u8 @482, token_b_flag u8 @483, collect_fee_mode u8 @484. Token A is token 0.
 * Checked against live pools (fixtures/risk/assets/venues/pools-20261013.json.gz).
 */
export const METEORA_DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const METEORA_DAMM_V2_SIZE = 1112;

export type DammV2Pool = {
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  liquidity: bigint;
  /** Protocol fees owed, held in each vault, raw units. */
  owed0: bigint;
  owed1: bigint;
  sqrtPriceX64: bigint;
  poolStatus: number;
  collectFeeMode: number;
};

export function decodeDammV2Pool(data: Uint8Array): DammV2Pool {
  const r = new Reader(data);
  if (data.length !== METEORA_DAMM_V2_SIZE || r.disc() !== ANCHOR_POOL_DISC)
    throw new Error(`meteora damm v2 pool: ${data.length} bytes, discriminator ${r.disc()}`);
  return {
    mint0: r.pubkey(168),
    mint1: r.pubkey(200),
    vault0: r.pubkey(232),
    vault1: r.pubkey(264),
    liquidity: r.u128(360),
    owed0: r.u64(392),
    owed1: r.u64(400),
    sqrtPriceX64: r.u128(456),
    poolStatus: r.u8(481),
    collectFeeMode: r.u8(484),
  };
}
