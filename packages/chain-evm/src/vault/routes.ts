import { ChainError } from '@colosseum/schemas';
import {
  type Address,
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type StateOverride,
} from 'viem';
import { CL_QUOTER_ADDRESS, CL_QUOTER_CODE } from './cl-quoter';
import { ask, type EvmRpc, isRevert } from './rpc';

// The route an EVM vault trades through here: an exact-input swap in the one pool recorded for the
// asset traded, through Universal Router 2.1.x (pull 2, through Permit2). Most assets have a hookless
// Uniswap v4 pool, priced by Uniswap's v4 Quoter; the call data is the shape
// `contracts/test/fork/UniV4Calldata.sol` builds, which the fork test of the vault ran against the
// real router on Robinhood Chain: `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`, so the output goes
// to the caller, the vault, and nowhere else. An asset whose money is in Uniswap v3 (gate V3-ROUTE)
// has a v3 pool instead: one `V3_SWAP_EXACT_IN` through the same router, paid by the caller through
// Permit2 and sent to the caller, the shape `UniV4Calldata.exactInV3` builds; priced by Bearing's
// read-only quoter in that pool, put in place for the call by a state override (cl-quoter.ts).

/** One Uniswap v4 pool's shape: its fee in hundredths of a basis point, and its tick spacing. */
export type V4Pool = { fee: number; tickSpacing: number };
/** One Uniswap v3 pool against the cash: its address and its fee in hundredths of a basis point. */
export type V3Pool = { v3Pool: Address; fee: number };
/** The pool an asset trades in: a v4 pool's shape, or a v3 pool. */
export type AssetPool = V4Pool | V3Pool;
/** Whether an asset's pool is a Uniswap v3 pool. */
export const isV3Pool = (pool: AssetPool): pool is V3Pool => 'v3Pool' in pool;

/**
 * Which pools a chain trades in, and who prices them. Every asset has one pool, against the cash
 * token, and its shape is the asset's own: on mainnet the money of one stock sits at one fee and that
 * of the next at another, and a few sit in Uniswap v3. A trade goes through the pool recorded for its
 * asset and no other.
 */
export type V4Pools = {
  /** Uniswap's v4 Quoter. */
  quoter: Address;
  /** The zero address: the vault trades in hookless pools only. */
  hooks: Address;
  /** The cash token every pool here is against. */
  cash: Address;
  /** Each asset's pool against the cash token, by the asset's token address in lower case. */
  byToken: Readonly<Record<string, AssetPool>>;
  /**
   * The Uniswap v3 factory Universal Router computes a v3 pool's address from, with the v3 pool's
   * creation code hash: a v3 pool recorded for an asset is held to be that factory's pool of the two
   * tokens and the fee, so the pool quoted is the pool the router swaps in.
   */
  v3: { factory: Address; poolInitCodeHash: Hex };
};

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Uniswap's v4 Quoter on Robinhood Chain: the same address, with the same code, on mainnet (4663)
 * and on the test network (46630) (docs/vault/research/test-networks.md).
 */
export const ROBINHOOD_V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address;

/**
 * Uniswap's v3 factory on Robinhood Chain mainnet and the v3 pool's creation code hash, both in the
 * code of Universal Router 2.1.2 there (`0x204f…0498`, read 2026-10-23): the router computes the pool
 * of a `V3_SWAP_EXACT_IN` from these and no other. Every v3 pool of the mainnet record is this
 * factory's (`factory()` of each, read the same day).
 */
export const ROBINHOOD_V3 = {
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address,
  poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54' as Hex,
} as const;

/** The pools of a network from its assets: the cash token, and each other token with its pool. */
export function v4Pools(
  cash: string,
  assets: readonly {
    address: string;
    pool: V4Pool | null;
    v3Pool?: { pool: string; fee: number } | undefined;
  }[],
  quoter: Address = ROBINHOOD_V4_QUOTER,
  v3: { factory: Address; poolInitCodeHash: Hex } = ROBINHOOD_V3,
): V4Pools {
  return {
    quoter,
    hooks: ZERO,
    cash: cash.toLowerCase() as Address,
    v3,
    byToken: Object.fromEntries(
      assets.flatMap((a): [string, AssetPool][] => {
        const route: AssetPool | null = a.pool
          ? { fee: a.pool.fee, tickSpacing: a.pool.tickSpacing }
          : a.v3Pool
            ? { v3Pool: a.v3Pool.pool.toLowerCase() as Address, fee: a.v3Pool.fee }
            : null;
        // An asset with no pool at all has no route: a trade of it is refused by `poolOf`.
        return route ? [[a.address.toLowerCase(), route]] : [];
      }),
    ),
  };
}

/**
 * The pool two tokens trade in: the pool recorded for the one that is not cash. Two assets have no
 * pool of their own, and an asset with none recorded is not traded: `BadTrade`, before anything is
 * asked of the chain.
 */
export function poolOf(pools: V4Pools, a: Address, b: Address): AssetPool {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  const cash = pools.cash.toLowerCase();
  if ((x === cash) === (y === cash))
    throw new ChainError(
      'BadTrade',
      `no pool is recorded for ${a} and ${b}: a trade is between the cash token and one asset`,
    );
  const asset = x === cash ? y : x;
  const pool = Object.hasOwn(pools.byToken, asset) ? pools.byToken[asset] : undefined;
  if (!pool) throw new ChainError('BadTrade', `no pool is recorded for ${asset}`);
  return pool;
}

/** How a pool is named in a message: its version and its fee, and a v4 pool's tick spacing. */
export function describePool(pool: AssetPool): string {
  return isV3Pool(pool)
    ? `the Uniswap v3 pool ${pool.v3Pool} of fee ${pool.fee}`
    : `the Uniswap v4 pool of fee ${pool.fee} and tick spacing ${pool.tickSpacing}, no hooks`;
}

/**
 * The address of the v3 factory's pool of two tokens at a fee, as Universal Router computes it
 * (`CREATE2` of the factory, the salt `keccak256(abi.encode(token0, token1, fee))`).
 */
export function v3PoolAddress(
  v3: { factory: Address; poolInitCodeHash: Hex },
  a: Address,
  b: Address,
  fee: number,
): Address {
  const [token0, token1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return getContractAddress({
    opcode: 'CREATE2',
    from: v3.factory,
    salt: keccak256(
      encodeAbiParameters(parseAbiParameters('address, address, uint24'), [token0, token1, fee]),
    ),
    bytecodeHash: v3.poolInitCodeHash,
  }).toLowerCase() as Address;
}

const QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const CL_QUOTER_ABI = parseAbi([
  'function quote(address pool, bool zeroForOne, uint256[] amountsIn, uint256 gasPerSwap) returns (uint256[] ins, uint256[] outs)',
]);
const ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);

const CMD_V3_SWAP_EXACT_IN = '0x00';
const CMD_V4_SWAP = '0x10';
const SWAP_EXACT_IN_SINGLE = '0x06';
const SETTLE_ALL = '0x0c';
const TAKE_ALL = '0x0f';
const MAX_UINT128 = (1n << 128n) - 1n;
/** Universal Router's stand-in for the caller as a recipient (`ActionConstants.MSG_SENDER`). */
export const UNIVERSAL_ROUTER_MSG_SENDER = '0x0000000000000000000000000000000000000001' as Address;
/** The gas the quoter lets one v3 swap use, and the call's whole allowance. */
const V3_SWAP_GAS = 3_000_000n;
const V3_QUOTE_GAS = 10_000_000n;

/** The key of the v4 pool two tokens trade in: the lower address is `currency0`, the shape the asset's. */
export function poolKeyOf(pools: V4Pools, a: Address, b: Address) {
  const pool = poolOf(pools, a, b);
  if (isV3Pool(pool)) throw new ChainError('BadTrade', `${describePool(pool)} has no v4 pool key`);
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return {
    currency0,
    currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pools.hooks,
  };
}

/**
 * What the asset's pool pays for `amountIn` of `tokenIn`, now (or at `block`). A pool that does not
 * exist, or cannot fill the amount, is `BadTrade`.
 */
export async function quoteExactIn(
  rpc: EvmRpc,
  pools: V4Pools,
  t: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
  at: { blockNumber?: bigint; stateOverride?: StateOverride } = {},
): Promise<bigint> {
  if (t.amountIn <= 0n || t.amountIn > MAX_UINT128)
    throw new ChainError('BadInput', 'amountInRaw: above zero and at most 2^128 - 1');
  const pool = poolOf(pools, t.tokenIn, t.tokenOut);
  if (isV3Pool(pool)) return quoteV3(rpc, pools, pool, t, at);
  const poolKey = poolKeyOf(pools, t.tokenIn, t.tokenOut);
  try {
    const { result } = await ask('quoteExactInputSingle of the Quoter', () =>
      rpc.simulateContract({
        address: pools.quoter,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            poolKey,
            zeroForOne: t.tokenIn === poolKey.currency0,
            exactAmount: t.amountIn,
            hookData: '0x',
          },
        ],
        ...(at.blockNumber !== undefined ? { blockNumber: at.blockNumber } : {}),
        ...(at.stateOverride ? { stateOverride: at.stateOverride } : {}),
      }),
    );
    const [amountOut] = result as readonly [bigint, bigint];
    if (amountOut === 0n) throw new ChainError('BadTrade', 'the pool pays nothing for that amount');
    return amountOut;
  } catch (e) {
    if (isRevert(e))
      throw new ChainError(
        'BadTrade',
        `no pool of ${t.tokenIn} and ${t.tokenOut} at fee ${poolKey.fee} and tick spacing ${poolKey.tickSpacing} can fill that amount`,
      );
    throw e;
  }
}

/**
 * A v3 pool's quote: the pool recorded is first held to be the router's own (the v3 factory's pool of
 * the two tokens at the fee), then swapped in by the quoter, which reverts with what moved. Filled
 * only where the pool took the whole amount.
 */
async function quoteV3(
  rpc: EvmRpc,
  pools: V4Pools,
  pool: V3Pool,
  t: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
  at: { blockNumber?: bigint; stateOverride?: StateOverride },
): Promise<bigint> {
  const routed = v3PoolAddress(pools.v3, t.tokenIn, t.tokenOut, pool.fee);
  if (routed !== pool.v3Pool.toLowerCase())
    throw new ChainError(
      'BadTrade',
      `${describePool(pool)} is not the v3 factory's pool of ${t.tokenIn} and ${t.tokenOut} at that fee (${routed}): the router would swap in another`,
    );
  const zeroForOne = BigInt(t.tokenIn) < BigInt(t.tokenOut);
  const filled = `${describePool(pool)} cannot fill that amount`;
  try {
    const { data } = await ask('quote of the v3 quoter', () =>
      rpc.call({
        to: CL_QUOTER_ADDRESS,
        data: encodeFunctionData({
          abi: CL_QUOTER_ABI,
          functionName: 'quote',
          args: [pool.v3Pool, zeroForOne, [t.amountIn], V3_SWAP_GAS],
        }),
        gas: V3_QUOTE_GAS,
        ...(at.blockNumber !== undefined ? { blockNumber: at.blockNumber } : {}),
        stateOverride: [
          ...(at.stateOverride ?? []).filter((o) => o.address.toLowerCase() !== CL_QUOTER_ADDRESS),
          { address: CL_QUOTER_ADDRESS, code: CL_QUOTER_CODE as Hex },
        ],
      }),
    );
    if (!data) throw new ChainError('BadTrade', filled);
    const [ins, outs] = decodeFunctionResult({
      abi: CL_QUOTER_ABI,
      functionName: 'quote',
      data,
    }) as readonly [readonly bigint[], readonly bigint[]];
    const [took, out] = [ins[0] ?? 0n, outs[0] ?? 0n];
    if (took !== t.amountIn) throw new ChainError('BadTrade', filled);
    if (out === 0n) throw new ChainError('BadTrade', 'the pool pays nothing for that amount');
    return out;
  } catch (e) {
    if (isRevert(e)) throw new ChainError('BadTrade', filled);
    throw e;
  }
}

/**
 * Universal Router call data for one exact-input swap in the asset's pool, the output to the caller
 * (v4: `TAKE_ALL`; v3: the recipient `MSG_SENDER`). The router's own minimum is left at zero: the
 * vault holds the swap to `minOut` by its own balances, so a price that moved is refused by the vault's
 * rule (`ReceivedTooLittle`), not wrapped in the router's (`RouterFailed`). The router's deadline is
 * the one given.
 */
export function swapCalldata(
  pools: V4Pools,
  t: { tokenIn: Address; tokenOut: Address; amountIn: bigint; deadline: bigint },
): Hex {
  const pool = poolOf(pools, t.tokenIn, t.tokenOut);
  if (isV3Pool(pool)) {
    // `V3_SWAP_EXACT_IN`: recipient, amount in, least out, path, paid by the caller (through Permit2),
    // and Universal Router 2.1's per-hop price floors, empty for none.
    const path = encodePacked(['address', 'uint24', 'address'], [t.tokenIn, pool.fee, t.tokenOut]);
    const input = encodeAbiParameters(
      parseAbiParameters('address, uint256, uint256, bytes, bool, uint256[]'),
      [UNIVERSAL_ROUTER_MSG_SENDER, t.amountIn, 0n, path, true, []],
    );
    return encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'execute',
      args: [CMD_V3_SWAP_EXACT_IN, [input], t.deadline],
    });
  }
  const key = poolKeyOf(pools, t.tokenIn, t.tokenOut);
  const zeroForOne = t.tokenIn === key.currency0;
  const swap = encodeAbiParameters(
    parseAbiParameters(
      '((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)',
    ),
    [
      [
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
        zeroForOne,
        t.amountIn,
        0n,
        0n,
        '0x',
      ],
    ],
  );
  const settle = encodeAbiParameters(parseAbiParameters('address, uint256'), [
    t.tokenIn,
    t.amountIn,
  ]);
  const take = encodeAbiParameters(parseAbiParameters('address, uint256'), [t.tokenOut, 0n]);
  const actions = concatHex([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    actions,
    [swap, settle, take],
  ]);
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'execute',
    args: [CMD_V4_SWAP, [input], t.deadline],
  });
}
