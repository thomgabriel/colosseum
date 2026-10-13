import { getBase58Encoder } from '@solana/kit';
import { RAYDIUM_AMM_V4_PROGRAM } from '../pools/raydium-amm-v4';
import { framesWithInvocations } from './invoke';
import type { PoolEvent } from './logs';
import type { RpcTx } from './tx';

// Raydium AMM v4 is not an Anchor program: it writes one `ray_log: <base64>` line per pool instruction, a bincode
// struct whose first byte is its type (github.com/raydium-io/raydium-amm, program/src/log.rs):
//   0 Init (75)        time@1 pc_decimals@9 coin_decimals@10 pc_lot_size@11 coin_lot_size@19 pc_amount@27
//                      coin_amount@35 market@43
//   1 Deposit (105)    max_coin@1 max_pc@9 base@17 pool_coin@25 pool_pc@33 pool_lp@41 calc_pnl_x(u128)@49
//                      calc_pnl_y(u128)@65 deduct_coin@81 deduct_pc@89 mint_lp@97
//   2 Withdraw (89)    withdraw_lp@1 user_lp@9 pool_coin@17 pool_pc@25 pool_lp@33 calc_pnl_x@41 calc_pnl_y@57
//                      out_coin@73 out_pc@81
//   3 SwapBaseIn (57)  amount_in@1 minimum_out@9 direction@17 user_source@25 pool_coin@33 pool_pc@41 out_amount@49
//   4 SwapBaseOut (57) max_in@1 amount_out@9 direction@17 user_source@25 pool_coin@33 pool_pc@41 deduct_in@49
// direction 1 is pc to coin, 2 coin to pc (math.rs SwapDirection). The log names no pool, so each frame is paired
// with the instruction that opened it (invoke.ts) and the pool is that instruction's account 1 (every swap,
// deposit and withdraw variant; Initialize2 has it at 4). Coin is token 0. pool_coin / pool_pc are the reserves
// the program priced at, net of the pnl it owes. Checked against live transactions: the amounts equal the vaults'
// token balance changes (tests/risk-layer/events.test.ts, fixtures/risk/txs/raydium_amm_v4-*.json).
export const AMM_V4_IX: Record<number, string> = {
  0: 'Initialize',
  1: 'Initialize2',
  3: 'Deposit',
  4: 'Withdraw',
  7: 'WithdrawPnl',
  9: 'SwapBaseIn',
  11: 'SwapBaseOut',
  16: 'SwapBaseInV2',
  17: 'SwapBaseOutV2',
};
const b58 = getBase58Encoder();
const tagOf = (data: string) => (data ? (b58.encode(data)[0] ?? -1) : -1);

/** The ray_log payloads of one transaction's frames on `pool`, with the instructions those frames ran. */
export function ammV4Frames(tx: RpcTx, pool: string, program = RAYDIUM_AMM_V4_PROGRAM) {
  const { pairs, aligned, truncated } = framesWithInvocations(tx, program);
  const mine = pairs.filter(({ frame, inv }) => {
    if (!frame.ok) return false;
    const tag = tagOf(inv.data);
    return (tag === 1 ? inv.accounts[4] : inv.accounts[1]) === pool;
  });
  return {
    aligned,
    truncated,
    frames: mine.map(({ frame, inv }) => ({
      outer: inv.outer,
      ix: AMM_V4_IX[tagOf(inv.data)] ?? `tag${tagOf(inv.data)}`,
      logs: frame.log
        .filter((l) => l.startsWith('ray_log: '))
        .map((l) => new Uint8Array(Buffer.from(l.slice(9), 'base64'))),
    })),
  };
}

export function decodeAmmV4Logs(
  frames: ReadonlyArray<{ outer: number; logs: Uint8Array[] }>,
  pool: string,
): PoolEvent[] {
  const out: PoolEvent[] = [];
  for (const { outer: ixIndex, logs } of frames)
    for (const d of logs) {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const u64 = (o: number) => v.getBigUint64(o, true);
      const t = d[0];
      if ((t === 3 || t === 4) && d.length >= 57) {
        // coin to pc sells token 0
        const zeroForOne = u64(17) === 2n;
        const amountIn = t === 3 ? u64(1) : u64(49);
        const amountOut = t === 3 ? u64(49) : u64(9);
        out.push({
          kind: 'swap',
          pool,
          ixIndex,
          amount0: (zeroForOne ? amountIn : amountOut).toString(),
          amount1: (zeroForOne ? amountOut : amountIn).toString(),
          zeroForOne,
        });
      } else if (t === 1 && d.length >= 105)
        out.push({
          kind: 'liquidity',
          pool,
          ixIndex,
          action: 'increase',
          amount0: u64(81).toString(),
          amount1: u64(89).toString(),
          lpDelta: u64(97).toString(),
        });
      else if (t === 2 && d.length >= 89)
        out.push({
          kind: 'liquidity',
          pool,
          ixIndex,
          action: 'decrease',
          amount0: u64(73).toString(),
          amount1: u64(81).toString(),
          lpDelta: (-u64(1)).toString(),
        });
      else if (t === 0 && d.length >= 75)
        out.push({
          kind: 'liquidity',
          pool,
          ixIndex,
          action: 'open',
          amount0: u64(35).toString(),
          amount1: u64(27).toString(),
        });
    }
  return out;
}
