import { METEORA_DAMM_V2_PROGRAM } from '../pools/meteora-damm';
import { METEORA_DLMM_PROGRAM } from '../pools/meteora-dlmm';
import { ORCA_WHIRLPOOL_PROGRAM } from '../pools/orca-whirlpool';
import { PUMPSWAP_PROGRAM } from '../pools/pumpswap';
import { RAYDIUM_CLMM_PROGRAM } from '../pools/raydium-clmm';
import { RAYDIUM_CPMM_PROGRAM } from '../pools/raydium-cpmm';
import { discOf, eventDisc, type LogFrame, type PoolEvent, parseLogs } from './logs';
import { decodeDammV1, decodeDammV2 } from './meteora-damm';
import { DLMM_KNOWN, decodeDlmmEvents, dlmmEventPayloads } from './meteora-dlmm';
import { decodeWhirlpoolFrames } from './orca-whirlpool';
import { decodePumpSwap } from './pumpswap';
import { ammV4Frames, decodeAmmV4Logs } from './raydium-amm-v4';
import { decodeRaydiumClmmFrames } from './raydium-clmm';
import { decodeCpmmFrames } from './raydium-cpmm';

/** The subset of a `getTransaction` (encoding json, maxSupportedTransactionVersion 1) response used here. */
export type RpcTx = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    };
  };
  meta: {
    err: unknown;
    logMessages: string[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: Array<{
      index: number;
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    }>;
    postTokenBalances?: Array<{
      accountIndex: number;
      mint?: string;
      uiTokenAmount: { amount: string };
    }>;
    preTokenBalances?: Array<{
      accountIndex: number;
      mint?: string;
      uiTokenAmount: { amount: string };
    }>;
  } | null;
};

/** Static keys followed by address-table keys (writable, then readonly), as account indexes use them. */
export function txAccountKeys(tx: RpcTx): string[] {
  return [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
}

/** Pre and post raw balances of the given token accounts (null when the tx does not list them). */
export function tokenBalances(tx: RpcTx, accounts: readonly string[]) {
  const keys = txAccountKeys(tx);
  const pick = (rows?: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }>) =>
    accounts.map((a) => {
      const i = keys.indexOf(a);
      return rows?.find((r) => r.accountIndex === i)?.uiTokenAmount.amount ?? null;
    });
  return { pre: pick(tx.meta?.preTokenBalances), post: pick(tx.meta?.postTokenBalances) };
}

export type PoolTxDecode = {
  events: PoolEvent[];
  /** Pool-program payloads no decoder recognised: `disc/len:base64`. Kept so history can be re-decoded. */
  unknown: string[];
  ix: string[];
  truncated: boolean;
};

/** `mint0` is the pool's token 0 (CPMM events name mints, not sides). */
export type PoolDecoder = (tx: RpcTx, pool: string, ctx?: { mint0?: string }) => PoolTxDecode;

/** Payloads emitted by `program` that the venue decoder consumed are identified by discriminator. */
function unknownPayloads(
  frames: ReturnType<typeof parseLogs>['frames'],
  program: string,
  known: ReadonlySet<string>,
) {
  const out: string[] = [];
  for (const f of frames)
    if (f.program === program)
      for (const d of f.data)
        if (!known.has(discOf(d)))
          out.push(`${discOf(d)}/${d.length}:${Buffer.from(d).toString('base64')}`);
  return out;
}

const logDecoder =
  (
    program: string,
    known: ReadonlySet<string>,
    decode: (frames: LogFrame[], pool: string, ctx?: { mint0?: string }) => PoolEvent[],
  ): PoolDecoder =>
  (tx, pool, ctx) => {
    const { frames, truncated } = parseLogs(tx.meta?.logMessages ?? []);
    return {
      events: decode(frames, pool, ctx),
      unknown: unknownPayloads(frames, program, known),
      ix: frames.filter((f) => f.program === program).flatMap((f) => f.ix),
      truncated,
    };
  };

// Orca: PositionOpened and LiquidityRepositioned are read; the others carry no layout change (fees, rewards, pool
// setup).
const ORCA_KNOWN = new Set(
  [
    'Traded',
    'LiquidityIncreased',
    'LiquidityDecreased',
    'PositionOpened',
    'LiquidityRepositioned',
    'PositionHarvestUpdated',
    'PoolInitialized',
  ].map(eventDisc),
);
const CPMM_KNOWN = new Set(['SwapEvent', 'LpChangeEvent'].map(eventDisc));
// Events the CLMM decoder reads, plus ones it ignores on purpose (no effect on price or liquidity layout):
// LiquidityCalculateEvent (amount calculation trace), CollectPersonalFeeEvent, CollectProtocolFeeEvent.
const RAYDIUM_CLMM_KNOWN = new Set(
  [
    'SwapEvent',
    'LiquidityChangeEvent',
    'CreatePersonalPositionEvent',
    'IncreaseLiquidityEvent',
    'DecreaseLiquidityEvent',
    'LiquidityCalculateEvent',
    'CollectPersonalFeeEvent',
    'CollectProtocolFeeEvent',
  ].map(eventDisc),
);

export const decoders: Record<string, PoolDecoder> = {
  raydium_clmm: logDecoder(RAYDIUM_CLMM_PROGRAM, RAYDIUM_CLMM_KNOWN, (f, pool) =>
    decodeRaydiumClmmFrames(f, pool),
  ),
  orca_whirlpool: logDecoder(ORCA_WHIRLPOOL_PROGRAM, ORCA_KNOWN, (f, pool) =>
    decodeWhirlpoolFrames(f, pool),
  ),
  meteora_dlmm: (tx, pool) => {
    const payloads = dlmmEventPayloads(tx, txAccountKeys(tx));
    const { truncated } = parseLogs(tx.meta?.logMessages ?? []);
    return {
      events: decodeDlmmEvents(payloads, pool),
      unknown: payloads
        .filter(([, d]) => !DLMM_KNOWN.has(discOf(d.subarray(8))))
        .map(
          ([, d]) => `${discOf(d.subarray(8))}/${d.length}:${Buffer.from(d).toString('base64')}`,
        ),
      ix: parseLogs(tx.meta?.logMessages ?? [])
        .frames.filter((f) => f.program === METEORA_DLMM_PROGRAM)
        .flatMap((f) => f.ix),
      truncated,
    };
  },
  raydium_cpmm: logDecoder(RAYDIUM_CPMM_PROGRAM, CPMM_KNOWN, (f, pool, ctx) => {
    if (!ctx?.mint0) throw new Error('raydium_cpmm decoder needs mint0');
    return decodeCpmmFrames(f, pool, ctx.mint0);
  }),
  // ASSET-3: the three venues of the shelf's unread liquidity (Raydium AMM v4, Meteora DAMM v1 and v2, PumpSwap).
  // AMM v4 and DAMM v1 events name no pool: their frames are paired with the instructions that opened them
  // (invoke.ts), and a transaction whose frames and instructions do not pair is flagged as truncated.
  raydium_amm_v4: (tx, pool) => {
    const f = ammV4Frames(tx, pool);
    return {
      events: decodeAmmV4Logs(f.frames, pool),
      // a ray_log of a type the decoder does not read (the five types are all read, so a new one)
      unknown: f.frames.flatMap((x) =>
        x.logs
          .filter((d) => (d[0] ?? 9) > 4)
          .map((d) => `raylog${d[0]}/${d.length}:${Buffer.from(d).toString('base64')}`),
      ),
      ix: f.frames.map((x) => x.ix),
      truncated: f.truncated || !f.aligned,
    };
  },
  meteora_damm_v1: (tx, pool, ctx) => {
    if (!ctx?.mint0) throw new Error('meteora_damm_v1 decoder needs mint0');
    return decodeDammV1(tx, pool, ctx.mint0);
  },
  meteora_damm_v2: (tx, pool, ctx) => {
    const { events, unknown } = decodeDammV2(tx, pool, ctx?.mint0, txAccountKeys(tx));
    const { frames, truncated } = parseLogs(tx.meta?.logMessages ?? []);
    return {
      events,
      unknown,
      ix: frames.filter((f) => f.program === METEORA_DAMM_V2_PROGRAM).flatMap((f) => f.ix),
      truncated,
    };
  },
  pumpswap: (tx, pool) => {
    const { events, unknown } = decodePumpSwap(tx, pool, txAccountKeys(tx));
    const { frames, truncated } = parseLogs(tx.meta?.logMessages ?? []);
    return {
      events,
      unknown,
      ix: frames.filter((f) => f.program === PUMPSWAP_PROGRAM).flatMap((f) => f.ix),
      truncated,
    };
  },
};
