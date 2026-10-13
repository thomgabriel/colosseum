import { Reader } from '../pools/bytes';
import { METEORA_DAMM_V1_PROGRAM, METEORA_DAMM_V2_PROGRAM } from '../pools/meteora-damm';
import { alignFrames, childFrames } from './invoke';
import { discOf, eventDisc, type PoolEvent } from './logs';
import { dlmmEventPayloads } from './meteora-dlmm';
import { type RpcTx, txAccountKeys } from './tx';

// ---------------------------------------------------------------------------------------------------- DAMM v1
// The pool keeps no token itself: it deposits into and withdraws from Meteora's dynamic vaults (program 24Uqj…,
// one vault per token, shared by every pool of that token) and holds their LP tokens. Its own Anchor `emit!` events
// (`Program data:` in its frame; IDL: MeteoraAg/damm-v1-sdk, ts-client/src/amm/idl.ts), offsets with the 8-byte
// discriminator:
//   Swap (48)               in_amount@8 out_amount@16 trade_fee@24 protocol_fee@32 host_fee@40
//   AddLiquidity (32)       lp_mint_amount@8 token_a_amount@16 token_b_amount@24
//   RemoveLiquidity (32)    lp_unmint_amount@8 token_a_out_amount@16 token_b_out_amount@24
//   BootstrapLiquidity (64) lp_mint_amount@8 token_a_amount@16 token_b_amount@24 pool@32
// name no pool (but Bootstrap) and no side, and their amounts are not what the vaults move: a swap's protocol fee
// goes from the user straight to the protocol's fee account, and the vault rounds its LP conversion. Live
// (fixtures/risk/txs/meteora_damm_v1-*.json): a user paid 255,857,529 of DBR, the protocol's fee account took
// 153,514 and the vault 255,704,015, while Swap said in_amount 255,857,515; the vault paid 4,971,488 of USDC,
// Swap said out_amount 4,971,489. So the token amounts are read from the dynamic vault's
// own events, emitted in the frames the pool's instruction opens:
//   vault AddLiquidity (24)    lp_mint_amount@8 token_amount@16   (a deposit: tokens into the vault)
//   vault RemoveLiquidity (24) lp_unmint_amount@8 token_amount@16 (a withdrawal: tokens out of it)
// Each frame is paired with the instruction that opened it (invoke.ts): the pool's instruction names the pool as
// account 0, and the vault's deposit or withdraw names the vault's token account as account 1, whose mint (from
// the transaction's token balances) says the side. The pool's event says the kind: Swap a swap, AddLiquidity or
// BootstrapLiquidity an increase, RemoveLiquidity a decrease. Token A is token 0, and `mint0` is required.
export const METEORA_VAULT_PROGRAM = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';
export const DAMM_V1_EVENTS = {
  swap: eventDisc('Swap'),
  add: eventDisc('AddLiquidity'),
  remove: eventDisc('RemoveLiquidity'),
  bootstrap: eventDisc('BootstrapLiquidity'),
};
/** The dynamic vault's events (same names as the pool's, other layouts). */
const VAULT_EVENTS = { deposit: eventDisc('AddLiquidity'), withdraw: eventDisc('RemoveLiquidity') };
/** Events read, plus ones that move no token in or out of the pool's vaults (PoolInfo reports the pool's amounts;
 *  fees on the pool's LP token are claimed from a lock escrow, not from the vaults). */
export const DAMM_V1_KNOWN = new Set([
  ...Object.values(DAMM_V1_EVENTS),
  ...[
    'PoolInfo',
    'SetPoolFees',
    'TransferAdmin',
    'OverrideCurveParam',
    'PoolCreated',
    'PoolEnabled',
    'CreateLockEscrow',
    'Lock',
    'ClaimFee',
    'MoveLockedLp',
  ].map(eventDisc),
]);

type Bal = { accountIndex: number; mint?: string; uiTokenAmount: { amount: string } };

export function decodeDammV1(
  tx: RpcTx,
  pool: string,
  mint0: string,
  program = METEORA_DAMM_V1_PROGRAM,
  vaultProgram = METEORA_VAULT_PROGRAM,
) {
  const a = alignFrames(tx);
  const keys = txAccountKeys(tx);
  const mintOf = new Map<string, string>();
  for (const b of [
    ...(tx.meta?.preTokenBalances ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ] as Bal[])
    if (b.mint) mintOf.set(keys[b.accountIndex] as string, b.mint);
  const events: PoolEvent[] = [];
  const unknown: string[] = [];
  const ix: string[] = [];
  const paired = !a.misaligned.has(program) && !a.misaligned.has(vaultProgram);
  for (const f of paired ? a.frames : []) {
    if (f.frame.program !== program || !f.frame.ok || f.inv?.accounts[0] !== pool) continue;
    ix.push(...f.frame.ix);
    for (const d of f.frame.data)
      if (!DAMM_V1_KNOWN.has(discOf(d)))
        unknown.push(`${discOf(d)}/${d.length}:${Buffer.from(d).toString('base64')}`);
    const kinds = f.frame.data.map(discOf);
    // the vaults' token flows under this instruction: + into a vault, − out of it, by side
    const flow: [bigint, bigint] = [0n, 0n];
    let seen = 0;
    for (const c of childFrames(a.frames, f.index)) {
      if (c.frame.program !== vaultProgram || !c.inv) continue;
      const side = mintOf.get(c.inv.accounts[1] as string) === mint0 ? 0 : 1;
      for (const d of c.frame.data) {
        if (d.length < 24) continue;
        const r = new Reader(d);
        if (discOf(d) === VAULT_EVENTS.deposit) flow[side] += r.u64(16);
        else if (discOf(d) === VAULT_EVENTS.withdraw) flow[side] -= r.u64(16);
        else continue;
        seen++;
      }
    }
    if (!seen) continue;
    const abs = (x: bigint) => (x < 0n ? -x : x).toString();
    if (kinds.includes(DAMM_V1_EVENTS.swap))
      events.push({
        kind: 'swap',
        pool,
        ixIndex: f.inv.outer,
        amount0: abs(flow[0]),
        amount1: abs(flow[1]),
        zeroForOne: flow[0] > 0n,
      });
    else if (kinds.includes(DAMM_V1_EVENTS.add) || kinds.includes(DAMM_V1_EVENTS.bootstrap))
      events.push({
        kind: 'liquidity',
        pool,
        ixIndex: f.inv.outer,
        action: 'increase',
        amount0: abs(flow[0]),
        amount1: abs(flow[1]),
      });
    else if (kinds.includes(DAMM_V1_EVENTS.remove))
      events.push({
        kind: 'liquidity',
        pool,
        ixIndex: f.inv.outer,
        action: 'decrease',
        amount0: abs(flow[0]),
        amount1: abs(flow[1]),
      });
  }
  return { events, unknown, ix, truncated: a.truncated || !paired };
}

// ---------------------------------------------------------------------------------------------------- DAMM v2
// Anchor `emit_cpi!` events (a self-invocation whose data is the event tag e445a52e51cb9a1d, the event's
// discriminator, its fields), read from innerInstructions as DLMM's are (IDL: MeteoraAg/damm-v2-sdk,
// src/idl/cp_amm.json; event.rs in MeteoraAg/damm-v2). Offsets include the 16-byte prefix:
//   EvtSwap2 (196)  pool@16 trade_direction@48 collect_fee_mode@49 has_referral@50 amount_0@51 amount_1@59
//     swap_mode@67 | swap_result: included_fee_input_amount@68 excluded_fee_input_amount@76 amount_left@84
//     output_amount@92 next_sqrt_price(u128)@100 claiming_fee@116 protocol_fee@124 compounding_fee@132
//     referral_fee@140 | included_transfer_fee_amount_in@148 included_transfer_fee_amount_out@156
//     excluded_transfer_fee_amount_out@164 current_timestamp@172 reserve_a_amount@180 reserve_b_amount@188
//   EvtLiquidityChange (193) pool@16 position@48 owner@80 token_a_amount@112 token_b_amount@120
//     transfer_fee_included_token_a_amount@128 transfer_fee_included_token_b_amount@136 reserve_a_amount@144
//     reserve_b_amount@152 liquidity_delta(u128)@160 token_a_amount_threshold@176 token_b_amount_threshold@184
//     change_type@192 (0 add, 1 remove)
//   EvtClaimPositionFee (128) pool@16 position@48 owner@80 fee_a_claimed@112 fee_b_claimed@120
//   EvtClaimProtocolFee2 (120) pool@16 receiver_token_account@48 token_mint@80 amount@112
// trade_direction 0 is A to B. The input vault takes included_fee_input_amount (the input after the token's
// transfer fee); the output vault pays output_amount (the trading fee stays in the pool). A referral fee, when there
// is a referrer, is paid out of the vault of the side the fee is taken on: the input when collect_fee_mode is 1
// (fees in token B only) and B is sold, the output otherwise (cp-amm's FeeMode). A liquidity change moves
// token_a/b_amount into the vaults on an add and transfer_fee_included_token_a/b_amount out of them on a remove.
// reserve_a/b_amount after a swap or a change are kept as reserve0After / reserve1After. Token A is token 0.
export const DAMM_V2_EVENTS = {
  swap: eventDisc('EvtSwap2'),
  liquidity: eventDisc('EvtLiquidityChange'),
  claimFee: eventDisc('EvtClaimPositionFee'),
  claimProtocol: eventDisc('EvtClaimProtocolFee2'),
};
/** Events read, plus ones that move no token of the pool's two vaults (rewards sit in their own vaults). */
export const DAMM_V2_KNOWN = new Set([
  ...Object.values(DAMM_V2_EVENTS),
  ...[
    'EvtCreatePosition',
    'EvtClosePosition',
    'EvtInitializePool',
    'EvtLockPosition',
    'EvtPermanentLockPosition',
    'EvtSplitPosition2',
    'EvtSplitPosition3',
    'EvtSetPoolStatus',
    'EvtUpdatePoolFees',
    'EvtUpdateDelegatePermission',
    'EvtInitializeReward',
    'EvtFundReward',
    'EvtClaimReward',
    'EvtUpdateRewardDuration',
    'EvtUpdateRewardFunder',
    'EvtWithdrawIneligibleReward',
    'EvtWithdrawDeadLiquidityReward',
    'EvtCreateConfig',
    'EvtCreateDynamicConfig',
    'EvtCloseConfig',
    'EvtCreateTokenBadge',
  ].map(eventDisc),
]);

export function decodeDammV2Events(
  payloads: ReadonlyArray<[number, Uint8Array]>,
  pool: string,
  mint0?: string,
): PoolEvent[] {
  const out: PoolEvent[] = [];
  for (const [ixIndex, d] of payloads) {
    const k = discOf(d.subarray(8));
    const r = new Reader(d);
    if (d.length < 48 || r.pubkey(16) !== pool) continue;
    if (k === DAMM_V2_EVENTS.swap && d.length >= 196) {
      const zeroForOne = r.u8(48) === 0;
      const feeOnInput = r.u8(49) === 1 && !zeroForOne;
      const referral = r.u8(50) === 1 ? r.u64(140) : 0n;
      const amountIn = r.u64(68) - (feeOnInput ? referral : 0n);
      const amountOut = r.u64(92) + (feeOnInput ? 0n : referral);
      out.push({
        kind: 'swap',
        pool,
        ixIndex,
        amount0: (zeroForOne ? amountIn : amountOut).toString(),
        amount1: (zeroForOne ? amountOut : amountIn).toString(),
        zeroForOne,
        sqrtPriceX64: r.u128(100).toString(),
        reserve0After: r.u64(180).toString(),
        reserve1After: r.u64(188).toString(),
      });
    } else if (k === DAMM_V2_EVENTS.liquidity && d.length >= 193) {
      const remove = r.u8(192) === 1;
      const delta = r.u128(160);
      out.push({
        kind: 'liquidity',
        pool,
        ixIndex,
        action: remove ? 'decrease' : 'increase',
        amount0: (remove ? r.u64(128) : r.u64(112)).toString(),
        amount1: (remove ? r.u64(136) : r.u64(120)).toString(),
        liquidityDelta: (remove ? -delta : delta).toString(),
        position: r.pubkey(48),
        owner: r.pubkey(80),
      });
    } else if (k === DAMM_V2_EVENTS.claimFee && d.length >= 128)
      out.push({
        kind: 'fees',
        pool,
        ixIndex,
        amount0: r.u64(112).toString(),
        amount1: r.u64(120).toString(),
        position: r.pubkey(48),
      });
    else if (k === DAMM_V2_EVENTS.claimProtocol && d.length >= 120 && mint0) {
      const a = r.u64(112).toString();
      const side0 = r.pubkey(80) === mint0;
      out.push({
        kind: 'fees',
        pool,
        ixIndex,
        amount0: side0 ? a : '0',
        amount1: side0 ? '0' : a,
      });
    }
  }
  return out;
}

export function decodeDammV2(
  tx: RpcTx,
  pool: string,
  mint0: string | undefined,
  keys: readonly string[],
  program = METEORA_DAMM_V2_PROGRAM,
) {
  const payloads = dlmmEventPayloads(tx, keys, program);
  return {
    events: decodeDammV2Events(payloads, pool, mint0),
    unknown: payloads
      .filter(([, d]) => !DAMM_V2_KNOWN.has(discOf(d.subarray(8))))
      .map(([, d]) => `${discOf(d.subarray(8))}/${d.length}:${Buffer.from(d).toString('base64')}`),
  };
}
