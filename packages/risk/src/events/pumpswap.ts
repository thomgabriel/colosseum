import { Reader } from '../pools/bytes';
import { PUMPSWAP_PROGRAM } from '../pools/pumpswap';
import { discOf, eventDisc, type PoolEvent } from './logs';
import { dlmmEventPayloads } from './meteora-dlmm';
import type { RpcTx } from './tx';

// PumpSwap emits Anchor `emit_cpi!` events, read from innerInstructions as DLMM's are (IDL:
// github.com/pump-fun/pump-public-docs, idl/pump_amm.json). Offsets include the 16-byte prefix:
//   BuyEvent  timestamp@16 base_amount_out@24 max_quote_amount_in@32 user_base_token_reserves@40
//     user_quote_token_reserves@48 pool_base_token_reserves@56 pool_quote_token_reserves@64 quote_amount_in@72
//     lp_fee_basis_points@80 lp_fee@88 protocol_fee_basis_points@96 protocol_fee@104
//     quote_amount_in_with_lp_fee@112 user_quote_amount_in@120 pool@128 user@160 … protocol_fee_recipient@256
//     protocol_fee_recipient_token_account@288 coin_creator@320 coin_creator_fee_basis_points@352
//     coin_creator_fee@360
//   SellEvent timestamp@16 base_amount_in@24 min_quote_amount_out@32 (reserves as Buy) quote_amount_out@72
//     lp_fee_basis_points@80 lp_fee@88 protocol_fee_basis_points@96 protocol_fee@104
//     quote_amount_out_without_lp_fee@112 user_quote_amount_out@120 pool@128 … (as Buy to) coin_creator_fee@360
//   DepositEvent / WithdrawEvent timestamp@16 lp_token_amount@24 … pool_base_token_reserves@64
//     pool_quote_token_reserves@72 base_amount@80 quote_amount@88 lp_mint_supply@96 pool@104
//   SweepPoolFeeEvent (193) timestamp@16 pool@24 base_mint@56 quote_mint@88 recipient@120 payer@152 amount@184
//     bucket@192
//   CreatePoolEvent (352) timestamp@16 index@24 creator@26 base_mint@58 quote_mint@90 base_mint_decimals@122
//     quote_mint_decimals@123 base_amount_in@124 quote_amount_in@132 … pool@181
//   InitBoostEvent (144) timestamp@16 mint@24 bonding_curve@56 pool@88 virtual_quote_reserves(i128)@120
//     real_quote_reserves_after@136
// The events grow with the program (BuyEvent and SellEvent are past 400 bytes now). A Buy or Sell long enough to name
// its protocol fee recipient (288 bytes) and naming one is a v1 trade and decodes with nothing held; one that names
// the zero key needs the later fee fields, and one too short to say either way is not guessed: its payload goes to
// `unknown` (`ux` in the backfill's rows), to be decoded when its layout is known. Base is token 0. A buy puts quote_amount_in_with_lp_fee into the quote vault and pays
// base_amount_out from the base vault; a sell puts base_amount_in into the base vault and pays
// quote_amount_out_without_lp_fee from the quote vault (the lp fee stays in the pool; the protocol and creator fees
// are paid to their recipients from what leaves or are held in the vault until a sweep). A sweep pays fees held in
// the quote vault to their recipient. pool_*_token_reserves are the reserves before the trade. A pool created by a
// migration from the bonding curve opens with base_amount_in in the base vault; when the same transaction sets up a
// boost (InitBoostEvent), part of the quote goes to the boost and the quote vault holds real_quote_reserves_after
// (live: quote_amount_in 23,722,070, the quote vault 18,813,974, InitBoost's real_quote_reserves_after
// 18,813,974); otherwise it holds quote_amount_in. BoostBuyAndBurnEvent is not read (no live sample): it is kept
// as unknown, for a later decode.
export const PUMPSWAP_EVENTS = {
  buy: eventDisc('BuyEvent'),
  sell: eventDisc('SellEvent'),
  deposit: eventDisc('DepositEvent'),
  withdraw: eventDisc('WithdrawEvent'),
  sweep: eventDisc('SweepPoolFeeEvent'),
  create: eventDisc('CreatePoolEvent'),
  initBoost: eventDisc('InitBoostEvent'),
};
/** Events read, plus ones that move no token of the pool's two vaults. */
export const PUMPSWAP_KNOWN = new Set([
  ...Object.values(PUMPSWAP_EVENTS),
  ...[
    'CollectCoinCreatorFeeEvent',
    'ClaimCashbackEvent',
    'ClaimTokenIncentivesEvent',
    'InitUserVolumeAccumulatorEvent',
    'SyncUserVolumeAccumulatorEvent',
    'CloseUserVolumeAccumulatorEvent',
    'ExtendAccountEvent',
    'SetBondingCurveCoinCreatorEvent',
    'SetMetaplexCoinCreatorEvent',
    'MigratePoolCoinCreatorEvent',
    'UpdateFeeConfigEvent',
    'UpdateAdminEvent',
    'CreateConfigEvent',
    'DisableEvent',
    'ReservedFeeRecipientsEvent',
    'AdminUpdateTokenIncentivesEvent',
    'AdminCtoPoolEvent',
    'UpdateCreatorFeeConfigEvent',
    'SetBoostAuthorityEvent',
  ].map(eventDisc),
]);

/** The fees a trade leaves in the quote vault rather than paying out: none when the event names a protocol fee
 *  recipient (the v1 instructions pay the fees out with the trade); when the recipient is the zero key (the v2
 *  instructions), the coin creator's fee and the protocol fee less its buyback part, which the pool holds (its
 *  creator_fees and protocol_fees) until a sweep. Found on live trades, not stated by the IDL: a v2 buy of
 *  quote_amount_in_with_lp_fee 5,920 with coin_creator_fee 60, protocol_fee 3 and buyback_fee 1 raised the quote
 *  vault by 5,982 = 5,920 + 60 + 3 − 1. null when the event is too short to say. */
export function heldFees(d: Uint8Array, sell: boolean): bigint | null {
  const r = new Reader(d);
  if (d.length >= 288 && d.subarray(256, 288).some((b) => b !== 0)) return 0n;
  if (d.length < 368) return null;
  // SellEvent: … coin_creator_fee@360 cashback_fee_basis_points@368 cashback@376 buyback_fee_basis_points@384
  // buyback_fee@392. BuyEvent: … coin_creator_fee@360 track_volume@368 … min_base_amount_out@401 ix_name (u32
  // length + bytes)@409, then cashback_fee_basis_points, cashback, buyback_fee_basis_points, buyback_fee.
  let o = 392;
  if (!sell) {
    if (d.length < 413) return null;
    o = 413 + r.u32(409) + 24;
  }
  if (d.length < o + 8) return null;
  return r.u64(360) + r.u64(104) - r.u64(o);
}

const payloadText = (d: Uint8Array) =>
  `${discOf(d.subarray(8))}/${d.length}:${Buffer.from(d).toString('base64')}`;

/** The pool's events; a Buy or Sell of a known discriminator that cannot be read (too short to name its pool, or to
 *  say which fees it holds) is pushed to `undecoded` instead of being dropped. */
export function decodePumpSwapEvents(
  payloads: ReadonlyArray<[number, Uint8Array]>,
  pool: string,
  undecoded: string[] = [],
): PoolEvent[] {
  const out: PoolEvent[] = [];
  for (const [ixIndex, d] of payloads) {
    const k = discOf(d.subarray(8));
    const r = new Reader(d);
    if (k === PUMPSWAP_EVENTS.buy || k === PUMPSWAP_EVENTS.sell) {
      if (d.length < 160) {
        undecoded.push(payloadText(d));
        continue;
      }
      if (r.pubkey(128) !== pool) continue;
      const sell = k === PUMPSWAP_EVENTS.sell;
      const held = heldFees(d, sell);
      if (held === null) {
        undecoded.push(payloadText(d));
        continue;
      }
      out.push({
        kind: 'swap',
        pool,
        ixIndex,
        amount0: r.u64(24).toString(),
        amount1: (sell ? r.u64(112) - held : r.u64(112) + held).toString(),
        zeroForOne: sell,
      });
    } else if (
      (k === PUMPSWAP_EVENTS.deposit || k === PUMPSWAP_EVENTS.withdraw) &&
      d.length >= 136
    ) {
      if (r.pubkey(104) !== pool) continue;
      const w = k === PUMPSWAP_EVENTS.withdraw;
      out.push({
        kind: 'liquidity',
        pool,
        ixIndex,
        action: w ? 'decrease' : 'increase',
        amount0: r.u64(80).toString(),
        amount1: r.u64(88).toString(),
        lpDelta: (w ? -r.u64(24) : r.u64(24)).toString(),
      });
    } else if (k === PUMPSWAP_EVENTS.sweep && d.length >= 192 && r.pubkey(24) === pool)
      out.push({ kind: 'fees', pool, ixIndex, amount0: '0', amount1: r.u64(184).toString() });
    else if (k === PUMPSWAP_EVENTS.create && d.length >= 213 && r.pubkey(181) === pool)
      out.push({
        kind: 'liquidity',
        pool,
        ixIndex,
        action: 'open',
        amount0: r.u64(124).toString(),
        amount1: r.u64(132).toString(),
      });
    else if (k === PUMPSWAP_EVENTS.initBoost && d.length >= 144 && r.pubkey(88) === pool) {
      const open = [...out].reverse().find((e) => e.kind === 'liquidity' && e.action === 'open');
      if (open?.kind === 'liquidity') open.amount1 = r.u64(136).toString();
    }
  }
  return out;
}

export function decodePumpSwap(
  tx: RpcTx,
  pool: string,
  keys: readonly string[],
  program = PUMPSWAP_PROGRAM,
) {
  const payloads = dlmmEventPayloads(tx, keys, program);
  const undecoded: string[] = [];
  const events = decodePumpSwapEvents(payloads, pool, undecoded);
  return {
    events,
    unknown: [
      ...payloads
        .filter(([, d]) => !PUMPSWAP_KNOWN.has(discOf(d.subarray(8))))
        .map(([, d]) => payloadText(d)),
      ...undecoded,
    ],
  };
}
