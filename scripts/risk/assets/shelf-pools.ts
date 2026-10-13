import { VENUES, type Venue } from '../lib-venues';

// The pure part of `pnpm risk:shelf-pools-solana` (PLAN-ASSETS AS.12, ledger ASSET-3): which of a shelf token's
// DexScreener pairs the shelf's registry keeps. No I/O: the pairs are passed in, as DexScreener's
// `token-pairs/v1/solana/<mint>` answers them (at most 30 a token).

/** One pair of DexScreener's token-pairs answer, the fields read here. */
export type DsPair = {
  pairAddress: string;
  dexId: string;
  labels?: string[];
  baseToken: { address: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  /** The base token's USD price and its price in the quote, as DexScreener answers them (strings). */
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};

/** The rule: pools of at least `minLiquidityUsd`, largest first, until `share` of the token's supported liquidity is
 *  covered, at most `maxPools` a token. A pair whose price of the token is off the token's reference price by more
 *  than `priceBand` (either way) has its liquidity re-valued at the reference price (`pairLiquidity`). */
export const SHELF_POOL_RULE = {
  minLiquidityUsd: 10_000,
  share: 0.9,
  maxPools: 5,
  priceBand: 1.5,
} as const;
export type ShelfPoolRule = {
  minLiquidityUsd: number;
  share: number;
  maxPools: number;
  priceBand: number;
};

const byDsVenue = new Map(Object.entries(VENUES).map(([v, c]) => [c.dexscreener, v as Venue]));

/** DexScreener's name of a pair's venue: `dexId` and its labels (`raydium:CLMM`, `orca:wp`, `meteora:DYN2`). */
export const dsVenue = (p: Pick<DsPair, 'dexId' | 'labels'>): string =>
  `${p.dexId}${p.labels?.length ? `:${p.labels.join('/')}` : ''}`;
/** The venue our swap decoders read for a pair, or null (DexScreener's names as build-registry.ts maps them). */
export const supportedVenue = (p: Pick<DsPair, 'dexId' | 'labels'>): Venue | null =>
  byDsVenue.get(dsVenue(p)) ?? null;

export type PickedPool = {
  address: string;
  venue: Venue;
  dsVenue: string;
  /** The liquidity the rule used (`pairLiquidity`), and DexScreener's own figure. */
  liquidityUsd: number;
  dexscreenerLiquidityUsd: number;
  repriced: boolean;
  volume24hUsd: number;
  quoteMint: string;
  quoteSymbol: string | null;
};
export type TokenPick = {
  /** Pairs DexScreener answered that hold the token (deduplicated by address). */
  pairs: number;
  supported: { pools: number; liquidityUsd: number };
  /** Pairs on venues the decoders do not read, by DexScreener's venue name. */
  unsupported: { pools: number; liquidityUsd: number; byVenue: Record<string, number> };
  /** Supported pairs under the rule's minimum liquidity. */
  belowMin: { pools: number; liquidityUsd: number };
  picked: PickedPool[];
  coveredUsd: number;
  /** Supported liquidity not picked (below the minimum, past the share or the pool cap, or rejected). */
  leftOutUsd: number;
  /** coveredUsd over the supported liquidity; null when the token has none. */
  coveredShare: number | null;
  /** The token's reference price and the pairs whose liquidity was re-valued at it. */
  referencePriceUsd: number | null;
  repriced: Array<{ address: string; dexscreenerUsd: number; usd: number }>;
};

const dsLiq = (p: DsPair) => (Number.isFinite(p.liquidity?.usd) ? (p.liquidity?.usd as number) : 0);

/** The token's USD price a pair implies: `priceUsd` when the token is the base, `priceUsd / priceNative` when it is
 *  the quote; null when DexScreener gives no price. */
export function impliedPrice(token: string, p: DsPair): number | null {
  const usd = Number(p.priceUsd);
  const native = Number(p.priceNative);
  if (!(usd > 0)) return null;
  if (p.baseToken.address === token) return usd;
  return native > 0 ? usd / native : null;
}

/** The token's reference price: the median of the prices its pairs imply, over the pairs that traded at least $1,000
 *  in 24 h (every priced pair when none did). A median, so one mispriced pair does not move it. */
export function referencePrice(token: string, pairs: DsPair[]): number | null {
  const priced = pairs
    .map((p) => ({ price: impliedPrice(token, p), vol: p.volume?.h24 ?? 0 }))
    .filter((x): x is { price: number; vol: number } => x.price !== null);
  const traded = priced.filter((x) => x.vol >= 1_000);
  const xs = (traded.length ? traded : priced).map((x) => x.price).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? (xs[m] as number) : ((xs[m - 1] as number) + (xs[m] as number)) / 2;
}

/**
 * A pair's liquidity in dollars. DexScreener values a pool's two sides at the pair's own price of the base, which it
 * sometimes takes from a mispriced quote (seen 2026-10-13 on pairs quoted in JupSOL, JLP, MET: a JitoSOL/JupSOL
 * pool at $2.4 billion). Its liquidity is linear in that price, so when the pair's price of the token is off the
 * reference by more than the band, the liquidity is scaled by reference ÷ implied.
 */
export function pairLiquidity(
  token: string,
  p: DsPair,
  ref: number | null,
  band: number,
): { usd: number; repriced: boolean } {
  const usd = dsLiq(p);
  const implied = impliedPrice(token, p);
  if (ref === null || implied === null) return { usd, repriced: false };
  const r = implied / ref;
  if (r <= band && r >= 1 / band) return { usd, repriced: false };
  return { usd: usd / r, repriced: true };
}

/**
 * The pools kept for one token: the supported pairs holding `token` with at least the minimum liquidity, largest
 * first (address breaks ties), taken while the covered liquidity is under `share` of the token's supported
 * liquidity (every supported pair, of any size) and fewer than `maxPools` are kept. `rejected` pools (failed the
 * on-chain confirmation) are skipped and stay in the supported liquidity, as left out.
 */
export function pickPools(
  token: string,
  pairs: DsPair[],
  rule: ShelfPoolRule = SHELF_POOL_RULE,
  rejected: ReadonlySet<string> = new Set(),
): TokenPick {
  const seen = new Map<string, DsPair>();
  for (const p of pairs)
    if (
      (p.baseToken.address === token || p.quoteToken.address === token) &&
      !seen.has(p.pairAddress)
    )
      seen.set(p.pairAddress, p);
  const all = [...seen.values()];
  const ref = referencePrice(token, all);
  const valued = new Map(
    all.map((p) => [p.pairAddress, pairLiquidity(token, p, ref, rule.priceBand)]),
  );
  const liq = (p: DsPair) => valued.get(p.pairAddress)?.usd ?? 0;
  const supported = all.filter((p) => supportedVenue(p));
  const unsupported = all.filter((p) => !supportedVenue(p));
  const supportedUsd = supported.reduce((s, p) => s + liq(p), 0);
  const byVenue: Record<string, number> = {};
  for (const p of unsupported) byVenue[dsVenue(p)] = (byVenue[dsVenue(p)] ?? 0) + liq(p);
  const belowMin = supported.filter((p) => liq(p) < rule.minLiquidityUsd);
  const eligible = supported
    .filter((p) => liq(p) >= rule.minLiquidityUsd && !rejected.has(p.pairAddress))
    .sort((a, b) => liq(b) - liq(a) || (a.pairAddress < b.pairAddress ? -1 : 1));
  const picked: PickedPool[] = [];
  let covered = 0;
  for (const p of eligible) {
    if (picked.length >= rule.maxPools || covered >= rule.share * supportedUsd) break;
    const quote = p.baseToken.address === token ? p.quoteToken : p.baseToken;
    picked.push({
      address: p.pairAddress,
      venue: supportedVenue(p) as Venue,
      dsVenue: dsVenue(p),
      liquidityUsd: liq(p),
      dexscreenerLiquidityUsd: dsLiq(p),
      repriced: valued.get(p.pairAddress)?.repriced ?? false,
      volume24hUsd: p.volume?.h24 ?? 0,
      quoteMint: quote.address,
      quoteSymbol: quote.symbol ?? null,
    });
    covered += liq(p);
  }
  return {
    pairs: all.length,
    supported: { pools: supported.length, liquidityUsd: supportedUsd },
    unsupported: {
      pools: unsupported.length,
      liquidityUsd: unsupported.reduce((s, p) => s + liq(p), 0),
      byVenue,
    },
    belowMin: { pools: belowMin.length, liquidityUsd: belowMin.reduce((s, p) => s + liq(p), 0) },
    picked,
    coveredUsd: covered,
    leftOutUsd: supportedUsd - covered,
    coveredShare: supportedUsd > 0 ? covered / supportedUsd : null,
    referencePriceUsd: ref,
    repriced: all
      .filter((p) => valued.get(p.pairAddress)?.repriced)
      .map((p) => ({ address: p.pairAddress, dexscreenerUsd: dsLiq(p), usd: liq(p) })),
  };
}

/**
 * Each pool once: a pool picked for two shelf tokens (a pair of two subjects) is kept under the first token in
 * `order` and named as shared under the other, so the backfill never walks it twice.
 */
export function assignPools(
  order: string[],
  picks: Map<string, PickedPool[]>,
): {
  owner: Map<string, string>;
  sharedWith: Map<string, Array<{ address: string; owner: string }>>;
} {
  const owner = new Map<string, string>();
  const sharedWith = new Map<string, Array<{ address: string; owner: string }>>();
  for (const token of order)
    for (const p of picks.get(token) ?? []) {
      const o = owner.get(p.address);
      if (o === undefined) owner.set(p.address, token);
      else
        sharedWith.set(token, [...(sharedWith.get(token) ?? []), { address: p.address, owner: o }]);
    }
  return { owner, sharedWith };
}
