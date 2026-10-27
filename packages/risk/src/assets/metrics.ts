import type { UniverseAsset } from '@colosseum/schemas';
import { decodeKaminoReserve, kaminoReserveState, sfToNumber } from '../lending/kamino';
import { Reader } from '../pools/bytes';
import { wordUint } from './evm';
import { decodeMint } from './spl-mint';

// PLAN-ASSETS AS.5 (gate ASSET-METRICS): a token's facts over time, one `asset_observations` row per chain, token,
// metric, source and time. Pure: the reads come in as they were answered, rows come out. No I/O, no clock, no SDK;
// the time of every row is the time its read says (a slot's block time, the source's own stamp, or when the answer
// was fetched). A fact a free source does not give is a row with `value: null` and the reason; a missing fact is
// never zero. Prices are not here (`metric-prices.ts`): a price is a `PriceObservation` under its own source.

export const METRICS_METHOD_VERSION = 'asset-metrics-0.1';

export const ASSET_METRICS = [
  'supply_total',
  'supply_issuer',
  'holders_top20_share',
  'pool_tvl_usd',
  'dex_volume_24h_usd',
  'protocol_tvl_usd',
  'exchange_rate',
  'yield_realised_30d',
  'yield_quoted',
] as const;
export type AssetMetric = (typeof ASSET_METRICS)[number];
export type MetricUnit = 'usd' | 'tokens' | 'fraction' | 'count' | 'ratio';

/** The unit of each metric's value: a yield is a fraction a year, a rate the underlying's whole tokens per share. */
export const METRIC_UNIT: Record<AssetMetric, MetricUnit> = {
  supply_total: 'tokens',
  supply_issuer: 'tokens',
  holders_top20_share: 'fraction',
  pool_tvl_usd: 'usd',
  dex_volume_24h_usd: 'usd',
  protocol_tvl_usd: 'usd',
  exchange_rate: 'ratio',
  yield_realised_30d: 'fraction',
  yield_quoted: 'fraction',
};

/** How often each metric is read by the jobs (PROMPT-BUILD-ASSETS 6.2). The import reads what it is asked. */
export const METRIC_CADENCE: Record<AssetMetric, 'hourly' | 'daily'> = {
  supply_total: 'hourly',
  supply_issuer: 'daily',
  holders_top20_share: 'daily',
  pool_tvl_usd: 'hourly',
  dex_volume_24h_usd: 'daily',
  protocol_tvl_usd: 'hourly',
  exchange_rate: 'hourly',
  yield_realised_30d: 'hourly',
  yield_quoted: 'hourly',
};

/** The fields of a list row the metrics read. */
export type MetricAsset = Pick<
  UniverseAsset,
  | 'chain'
  | 'address'
  | 'symbol'
  | 'decimals'
  | 'standard'
  | 'category'
  | 'cls'
  | 'yieldMechanism'
  | 'status'
  | 'listedIn'
>;

/** One `asset_observations` row, times as ISO strings. */
export type AssetObservation = {
  chain: string;
  address: string;
  metric: AssetMetric;
  value: number | null;
  unit: MetricUnit;
  nullReason: string | null;
  observedAt: string;
  height: number | null;
  detail: Record<string, unknown>;
  methodVersion: string;
  source: string;
  method: string;
  fetchedAt: string;
  provenance: 'live';
};

/** Where a row's figure came from: the time the state refers to, when it was fetched, the slot or block. */
export type ReadStamp = {
  observedAt: string;
  fetchedAt: string;
  height: number | null;
  source: string;
  method: string;
};

/** A row with a value. A value that is not a finite number is a missing fact, said so, never stored as a figure. */
export function assetFact(
  a: MetricAsset,
  metric: AssetMetric,
  value: number,
  s: ReadStamp,
  detail: Record<string, unknown> = {},
): AssetObservation {
  if (!Number.isFinite(value)) return assetMissing(a, metric, 'not_a_finite_number', s, detail);
  return {
    chain: a.chain,
    address: a.address,
    metric,
    value,
    unit: METRIC_UNIT[metric],
    nullReason: null,
    observedAt: s.observedAt,
    height: s.height,
    detail,
    methodVersion: METRICS_METHOD_VERSION,
    source: s.source,
    method: s.method,
    fetchedAt: s.fetchedAt,
    provenance: 'live',
  };
}

/** A row that says why the fact is missing. */
export function assetMissing(
  a: MetricAsset,
  metric: AssetMetric,
  reason: string,
  s: ReadStamp,
  detail: Record<string, unknown> = {},
): AssetObservation {
  return {
    chain: a.chain,
    address: a.address,
    metric,
    value: null,
    unit: METRIC_UNIT[metric],
    nullReason: reason,
    observedAt: s.observedAt,
    height: s.height,
    detail,
    methodVersion: METRICS_METHOD_VERSION,
    source: s.source,
    method: s.method,
    fetchedAt: s.fetchedAt,
    provenance: 'live',
  };
}

// --------------------------------------------------------------------------------------------- the reviewed map

/**
 * The reviewed map of which free source answers which row (`scripts/risk/assets/metrics.sources.json`), each entry
 * with its source. A row no entry names takes the reason of its metric's plan below.
 */
export type MetricSources = {
  reviewedOn: string;
  /** Readings the structurer already stores in `yield_observations` (feeds:refresh, feeds:refresh-models). */
  inYieldObservations: Array<{
    chain: string;
    address: string;
    assetId: string;
    metrics: Array<'yield_realised_30d' | 'yield_quoted'>;
    source: string;
  }>;
  /** Issuers that publish what is outstanding on a chain. */
  issuerSupply: Array<{
    chain: string;
    address: string;
    kind: 'circle_stablecoins' | 'tether_transparency';
    url: string;
    /** Circle: the coin's symbol and the chain's name in the answer; Tether: the field suffix of the chain. */
    key: { symbol?: string; chain: string };
    source: string;
  }>;
  /** Kamino reserves whose collateral token is a row: the reserve account and its market. */
  kaminoReserves: Array<{
    chain: string;
    address: string;
    reserve: string;
    market: string;
    source: string;
  }>;
  /** DefiLlama yield pools tied to a row, and which metrics each gives. */
  defillamaYieldPools: Array<{
    chain: string;
    address: string;
    symbol: string;
    pool: string;
    project: string;
    metrics: Array<'yield_quoted' | 'protocol_tvl_usd'>;
    source: string;
  }>;
  /** Robinhood Chain stock tokens whose issuer multiplier is read as the exchange rate (SGOV). */
  issuerMultiplier: Array<{ chain: string; address: string; url: string; source: string }>;
  /** Tokens whose realised rate the research notes say to read from the price path, whatever the list's mechanism. */
  realisedPricePath: Array<{ chain: string; address: string; symbol: string; source: string }>;
  /** The Jupiter Lend earn API and the deposit tokens it listed when the map was reviewed. */
  jupiterLend: {
    url: string;
    source: string;
    tokens: Array<{ chain: string; address: string; symbol: string }>;
  };
};

export const sameAddress = (chain: string, a: string, b: string) =>
  chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase();
const named = <T extends { chain: string; address: string }>(xs: readonly T[], a: MetricAsset) =>
  xs.filter((x) => x.chain === a.chain && sameAddress(a.chain, x.address, a.address));

/** What answers one metric for one row: a read by its kind, or the reason no read applies. */
export type MetricPlan = { read: string; ref?: string } | { reason: string };

export type PlanContext = { sources: MetricSources };

const NATIVE_SOLANA = 'So11111111111111111111111111111111111111112';
const isDollarYield = (a: MetricAsset) => a.cls === 'dollar_yield';

/**
 * Which read answers each metric of a row, or why none does. A reason here is a fact about the row and the
 * reviewed map, not about one read: its row is stamped with the list's time (`structural`).
 */
export function metricPlan(a: MetricAsset, ctx: PlanContext): Record<AssetMetric, MetricPlan> {
  const S = ctx.sources;
  const yo = named(S.inYieldObservations, a);
  const inYo = (m: 'yield_realised_30d' | 'yield_quoted') => yo.some((y) => y.metrics.includes(m));
  const issuer = named(S.issuerSupply, a)[0];
  const kamino = named(S.kaminoReserves, a)[0];
  const llama = named(S.defillamaYieldPools, a);
  const llamaFor = (m: 'yield_quoted' | 'protocol_tvl_usd') =>
    llama.find((p) => p.metrics.includes(m));
  const jl = named(S.jupiterLend.tokens, a).length > 0 && isDollarYield(a);
  const multiplier = named(S.issuerMultiplier, a)[0];
  const native = a.standard === 'native' || (a.chain === 'solana' && a.address === NATIVE_SOLANA);

  const exchangeRate: MetricPlan = jl
    ? { read: 'jupiter_lend' }
    : kamino
      ? { read: 'kamino_reserve', ref: kamino.reserve }
      : a.standard === 'erc4626'
        ? { read: 'erc4626' }
        : multiplier
          ? { read: 'issuer_multiplier' }
          : {
              reason:
                a.yieldMechanism === 'exchange_rate'
                  ? 'no_free_exchange_rate_read'
                  : 'not_an_exchange_rate_token',
            };
  const hasRate = 'read' in exchangeRate;

  return {
    supply_total:
      a.chain === 'solana'
        ? { read: native ? 'native_supply' : 'spl_mint' }
        : native
          ? { reason: 'native_token_no_supply_call' }
          : { read: 'erc20_total_supply' },
    supply_issuer: issuer
      ? { read: issuer.kind, ref: issuer.url }
      : { reason: 'no_issuer_source_in_map' },
    holders_top20_share:
      a.chain !== 'solana'
        ? { reason: 'no_free_indexer' }
        : native
          ? { reason: 'native_balances_not_read' }
          : { read: 'largest_accounts' },
    pool_tvl_usd: { read: a.chain === 'solana' ? 'risk_pools' : 'discovery_file' },
    dex_volume_24h_usd:
      native && a.chain !== 'solana'
        ? { reason: 'native_token_not_listed' }
        : { read: 'dexscreener' },
    protocol_tvl_usd: !isDollarYield(a)
      ? { reason: 'not_a_dollar_yield_token' }
      : jl
        ? { read: 'jupiter_lend' }
        : kamino
          ? { read: 'kamino_reserve', ref: kamino.reserve }
          : llamaFor('protocol_tvl_usd')
            ? { read: 'defillama_yield_pool', ref: llamaFor('protocol_tvl_usd')?.pool as string }
            : { reason: 'no_reviewed_protocol_source' },
    exchange_rate: exchangeRate,
    yield_realised_30d: !isDollarYield(a)
      ? { reason: 'not_a_dollar_yield_token' }
      : inYo('yield_realised_30d')
        ? { reason: 'in_yield_observations' }
        : hasRate
          ? { read: 'exchange_rate_series' }
          : a.yieldMechanism === 'accruing_price' ||
              a.yieldMechanism === 'exchange_rate' ||
              named(S.realisedPricePath, a).length > 0
            ? { read: 'price_path_defillama' }
            : // a token that pays by distribution or rebasing, or whose way is not read, earns nothing its price shows
              { reason: 'no_realised_method_for_its_mechanism' },
    yield_quoted: !isDollarYield(a)
      ? { reason: 'not_a_dollar_yield_token' }
      : inYo('yield_quoted')
        ? { reason: 'in_yield_observations' }
        : jl
          ? { read: 'jupiter_lend' }
          : llamaFor('yield_quoted')
            ? { read: 'defillama_yield_pool', ref: llamaFor('yield_quoted')?.pool as string }
            : { reason: 'no_reviewed_quoted_source' },
  };
}

/** The structural rows of a row: one per metric whose plan is a reason, stamped with the list and the map. */
export function structuralRows(
  a: MetricAsset,
  plan: Record<AssetMetric, MetricPlan>,
  s: ReadStamp,
  only?: ReadonlySet<AssetMetric>,
  ctx?: PlanContext,
): AssetObservation[] {
  const out: AssetObservation[] = [];
  for (const m of ASSET_METRICS) {
    const p = plan[m];
    if (only && !only.has(m)) continue;
    if ('reason' in p) {
      const yo = ctx ? named(ctx.sources.inYieldObservations, a)[0] : undefined;
      out.push(
        assetMissing(
          a,
          m,
          p.reason,
          s,
          p.reason === 'in_yield_observations' && yo
            ? { assetId: yo.assetId, readBy: yo.source }
            : {},
        ),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ supply_total

/** One account as answered by getMultipleAccounts: the owner and the bytes, or null where none exists. */
export type AccountRead = { owner: string; data: Uint8Array } | null;

const MINT_SUPPLY_OFFSET = 36;
const SCALED_UI_AMOUNT = 25;
const TOKEN_2022_TLV_START = 166;

/** Token-2022's scaledUiAmountConfig of a mint, where it has one: the multiplier the UI shows amounts by. */
export function scaledUiAmount(data: Uint8Array):
  | {
      authority: string;
      multiplier: number;
      newMultiplierEffectiveTimestamp: number;
      newMultiplier: number;
    }
  | undefined {
  if (data.length <= TOKEN_2022_TLV_START) return undefined;
  const r = new Reader(data);
  let o = TOKEN_2022_TLV_START;
  while (o + 4 <= data.length) {
    const type = r.u16(o);
    const len = r.u16(o + 2);
    if (type === 0) return undefined;
    if (type === SCALED_UI_AMOUNT && len >= 56 && o + 4 + len <= data.length) {
      const v = new DataView(data.buffer, data.byteOffset + o + 4, len);
      return {
        authority: r.pubkey(o + 4),
        multiplier: v.getFloat64(32, true),
        newMultiplierEffectiveTimestamp: Number(v.getBigInt64(40, true)),
        newMultiplier: v.getFloat64(48, true),
      };
    }
    o += 4 + len;
  }
  return undefined;
}

/** A mint's supply field: raw units over 10^decimals, the raw amount and the UI multiplier kept in the detail. */
export function supplyFromMint(a: MetricAsset, acct: AccountRead, s: ReadStamp): AssetObservation {
  if (!acct) return assetMissing(a, 'supply_total', 'account_not_found', s);
  let decoded: ReturnType<typeof decodeMint>;
  try {
    decoded = decodeMint(acct.owner, acct.data);
  } catch (e) {
    return assetMissing(a, 'supply_total', 'not_a_mint', s, { error: String(e).slice(0, 200) });
  }
  const raw = new Reader(acct.data).u64(MINT_SUPPLY_OFFSET);
  const scaled = decoded.program === 'token2022' ? scaledUiAmount(acct.data) : undefined;
  return assetFact(a, 'supply_total', Number(raw) / 10 ** decoded.decimals, s, {
    raw: raw.toString(),
    decimals: decoded.decimals,
    program: decoded.program,
    ...(decoded.decimals !== a.decimals ? { listDecimals: a.decimals } : {}),
    ...(scaled ? { scaledUiAmount: scaled } : {}),
  });
}

/** SOL: getSupply's total, in lamports, over 10^9. */
export function supplyNative(
  a: MetricAsset,
  supply: { total: number; circulating: number; nonCirculating: number },
  s: ReadStamp,
): AssetObservation {
  const LAMPORTS_PER_SOL = 1e9;
  return assetFact(a, 'supply_total', supply.total / LAMPORTS_PER_SOL, s, {
    lamports: { ...supply },
  });
}

/** An ERC-20's totalSupply() at the pinned block. */
export function supplyFromTotalSupply(
  a: MetricAsset,
  reply: { success: boolean; data: string } | undefined,
  s: ReadStamp,
): AssetObservation {
  if (!reply?.success) return assetMissing(a, 'supply_total', 'call_reverted', s);
  const raw = wordUint(reply.data);
  if (raw === null) return assetMissing(a, 'supply_total', 'not_a_uint', s, { data: reply.data });
  return assetFact(a, 'supply_total', Number(raw) / 10 ** a.decimals, s, {
    raw: raw.toString(),
    decimals: a.decimals,
  });
}

// --------------------------------------------------------------------------------------------- supply_issuer

/** Circle's answer of `GET /v1/stablecoins`: a coin's amount on one chain, with the time Circle gives it. */
export function supplyFromCircle(
  a: MetricAsset,
  answer: unknown,
  key: { symbol?: string; chain: string },
  s: ReadStamp,
): AssetObservation {
  const coins = (answer as { data?: Array<Record<string, unknown>> })?.data ?? [];
  const coin = coins.find((c) => c.symbol === key.symbol);
  const ch = (coin?.chains as Array<Record<string, unknown>> | undefined)?.find(
    (c) => c.chain === key.chain,
  );
  if (!ch) return assetMissing(a, 'supply_issuer', 'not_in_issuer_answer', s, { key });
  const at =
    typeof ch.updateDate === 'string' && !Number.isNaN(Date.parse(ch.updateDate))
      ? new Date(ch.updateDate).toISOString()
      : s.observedAt;
  return assetFact(
    a,
    'supply_issuer',
    Number(ch.amount),
    { ...s, observedAt: at },
    {
      issuer: 'Circle',
      key,
      amount: ch.amount,
      secondaryMarketBurnedAmount: ch.secondaryMarketBurnedAmount ?? null,
    },
  );
}

/**
 * Tether's transparency answer: on a chain, the tokens authorised (`totaltokens_<chain>`) less those authorised and
 * not issued (`reserve_balance_<chain>`). The quarantined amount is kept beside it, not taken off.
 */
export function supplyFromTether(
  a: MetricAsset,
  answer: unknown,
  key: { chain: string },
  s: ReadStamp,
): AssetObservation {
  const usdt = (answer as { data?: { usdt?: Record<string, unknown> } })?.data?.usdt;
  const total = usdt?.[`totaltokens_${key.chain}`];
  const reserve = usdt?.[`reserve_balance_${key.chain}`];
  if (total === undefined || reserve === undefined)
    return assetMissing(a, 'supply_issuer', 'not_in_issuer_answer', s, { key });
  return assetFact(a, 'supply_issuer', Number(total) - Number(reserve), s, {
    issuer: 'Tether',
    key,
    authorised: total,
    authorisedNotIssued: reserve,
    quarantined: usdt?.[`quarantined_${key.chain}`] ?? null,
    formula: 'authorised less authorised and not issued',
  });
}

// ------------------------------------------------------------------------------------------ holders_top20_share

export type LargestAccounts =
  | { slot: number; value: Array<{ address: string; amount: string }> }
  /** `unavailable`: the RPC does not serve the method at all (a plan without it), so no mint was asked again. */
  | { error: string; unavailable?: boolean };

/** The share of the supply in the (at most) twenty largest token accounts, both read in raw units. */
export function top20Share(
  a: MetricAsset,
  largest: LargestAccounts,
  supply: { raw: string; slot: number } | null,
  s: ReadStamp,
): AssetObservation {
  if ('error' in largest)
    return assetMissing(
      a,
      'holders_top20_share',
      largest.unavailable ? 'rpc_method_unavailable' : 'largest_accounts_refused',
      s,
      { error: largest.error.slice(0, 300) },
    );
  if (!supply) return assetMissing(a, 'holders_top20_share', 'no_supply_read', s);
  const total = BigInt(supply.raw);
  if (total === 0n) return assetMissing(a, 'holders_top20_share', 'zero_supply', s);
  const accounts = largest.value.slice(0, 20);
  const top = accounts.reduce((m, x) => m + BigInt(x.amount), 0n);
  // the ratio of two big integers, kept to 1e-12
  const share = Number((top * 10n ** 12n) / total) / 1e12;
  return assetFact(a, 'holders_top20_share', share, s, {
    accounts: accounts.map((x) => ({ address: x.address, amount: x.amount })),
    topRaw: top.toString(),
    supplyRaw: supply.raw,
    supplySlot: supply.slot,
    largestSlot: largest.slot,
    note: 'token accounts, not owners: a pool vault, an exchange or a program is one account',
  });
}

// -------------------------------------------------------------------------------------------------- pool_tvl_usd

export type RegisteredPool = {
  address: string;
  venue: string;
  assetMint: string;
  quoteMint: string;
  tvlUsd: number | null;
  tier: string;
  status: string;
};

/** Solana: the measured TVL of every registered pool that holds the token on either side, summed. */
export function poolTvlFromRegistry(
  a: MetricAsset,
  pools: readonly RegisteredPool[],
  s: ReadStamp,
): AssetObservation {
  const mine = pools.filter((p) => p.assetMint === a.address || p.quoteMint === a.address);
  if (!mine.length) return assetMissing(a, 'pool_tvl_usd', 'no_registered_pool', s);
  const measured = mine.filter((p) => p.tvlUsd !== null && Number.isFinite(p.tvlUsd));
  if (!measured.length)
    return assetMissing(a, 'pool_tvl_usd', 'no_measured_pool', s, { pools: mine.length });
  const sum = measured.reduce((m, p) => m + (p.tvlUsd as number), 0);
  return assetFact(a, 'pool_tvl_usd', sum, s, {
    measured: measured.length,
    unmeasured: mine.length - measured.length,
    pools: measured
      .sort(
        (x, y) => (y.tvlUsd as number) - (x.tvlUsd as number) || x.address.localeCompare(y.address),
      )
      .map((p) => ({
        address: p.address,
        venue: p.venue,
        tier: p.tier,
        side: p.assetMint === a.address ? 'asset' : 'quote',
        tvlUsd: p.tvlUsd,
      })),
  });
}

export type DiscoveryPool = {
  id: string;
  venue: string;
  token: string;
  other: string;
  tvlUsd: number | null;
  tvlReason: string | null;
  reachable: boolean;
};

/** Robinhood Chain: the discovery file's measured pools holding the token on either side, summed. */
export function poolTvlFromDiscovery(
  a: MetricAsset,
  pools: readonly DiscoveryPool[],
  s: ReadStamp,
): AssetObservation {
  const k = a.address.toLowerCase();
  const mine = pools.filter((p) => p.token.toLowerCase() === k || p.other.toLowerCase() === k);
  if (!mine.length) return assetMissing(a, 'pool_tvl_usd', 'no_registered_pool', s);
  const measured = mine.filter((p) => p.tvlUsd !== null && Number.isFinite(p.tvlUsd));
  const unmeasuredBy: Record<string, number> = {};
  for (const p of mine)
    if (p.tvlUsd === null)
      unmeasuredBy[p.tvlReason ?? 'none'] = (unmeasuredBy[p.tvlReason ?? 'none'] ?? 0) + 1;
  if (!measured.length)
    return assetMissing(a, 'pool_tvl_usd', 'no_measured_pool', s, {
      pools: mine.length,
      unmeasuredBy,
    });
  const sum = measured.reduce((m, p) => m + (p.tvlUsd as number), 0);
  return assetFact(a, 'pool_tvl_usd', sum, s, {
    measured: measured.length,
    unmeasured: mine.length - measured.length,
    unmeasuredBy,
    lowerBound: mine.length > measured.length,
    scope: 'pools with a stock token of the issuer registry on one side (the discovery file)',
    pools: measured
      .sort((x, y) => (y.tvlUsd as number) - (x.tvlUsd as number) || x.id.localeCompare(y.id))
      .map((p) => ({
        id: p.id,
        venue: p.venue,
        side: p.token.toLowerCase() === k ? 'token' : 'other',
        reachable: p.reachable,
        tvlUsd: p.tvlUsd,
      })),
  });
}

// ------------------------------------------------------------------------------------------- dex_volume_24h_usd

/** DexScreener's pair as its API answers (the fields read). */
export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
};

/** The most pairs DexScreener's token-pairs endpoint answers: a full answer is a lower bound. */
export const DEXSCREENER_PAIR_CAP = 30;

/**
 * DexScreener's own 24 h volume (gate VOLUME-DEXSCREENER), summed over the distinct pairs on this chain that hold the
 * token on either side. `pairs` null: its batch endpoint named no pair for the token.
 */
export function dexVolume24h(
  a: MetricAsset,
  pairs: readonly DexPair[] | null,
  chainId: string,
  s: ReadStamp,
): AssetObservation {
  if (pairs === null) return assetMissing(a, 'dex_volume_24h_usd', 'no_dexscreener_pair', s);
  const seen = new Set<string>();
  const mine = pairs.filter((p) => {
    if (p.chainId !== chainId) return false;
    const hit =
      sameAddress(a.chain, p.baseToken.address, a.address) ||
      sameAddress(a.chain, p.quoteToken.address, a.address);
    if (!hit || seen.has(p.pairAddress)) return false;
    seen.add(p.pairAddress);
    return true;
  });
  if (!mine.length) return assetMissing(a, 'dex_volume_24h_usd', 'no_dexscreener_pair', s);
  const withVolume = mine.filter((p) => typeof p.volume?.h24 === 'number');
  if (!withVolume.length)
    return assetMissing(a, 'dex_volume_24h_usd', 'no_volume_in_answer', s, { pairs: mine.length });
  const atCap = pairs.length >= DEXSCREENER_PAIR_CAP;
  return assetFact(
    a,
    'dex_volume_24h_usd',
    withVolume.reduce((m, p) => m + (p.volume?.h24 as number), 0),
    s,
    {
      what: "DexScreener's 24 h volume of the pairs, not our own measure",
      pairs: withVolume.map((p) => ({
        pair: p.pairAddress,
        dex: p.dexId,
        base: p.baseToken.symbol ?? p.baseToken.address,
        quote: p.quoteToken.symbol ?? p.quoteToken.address,
        volumeH24Usd: p.volume?.h24,
        liquidityUsd: p.liquidity?.usd ?? null,
      })),
      pairsWithoutVolume: mine.length - withVolume.length,
      atCap,
      lowerBound: atCap,
    },
  );
}

// -------------------------------------------------------------------------------- Jupiter Lend (exchange, TVL, rate)

/** One token of Jupiter Lend's earn API (`/lend/v1/earn/tokens`), the fields read. */
export type JupiterLendToken = {
  address: string;
  symbol: string;
  decimals: number;
  asset: { address: string; symbol: string; decimals: number; price?: string; updatedAt?: string };
  totalAssets: string;
  totalSupply: string;
  convertToAssets: string;
  supplyRate: string;
  rewardsRate: string;
  totalRate: string;
  liquiditySupplyData?: { lastUpdateTimestamp?: string };
};

const BPS = 10_000;
const jlAt = (t: JupiterLendToken, s: ReadStamp): ReadStamp => {
  const ts = Number(t.liquiditySupplyData?.lastUpdateTimestamp);
  return Number.isFinite(ts) && ts > 0
    ? { ...s, observedAt: new Date(ts * 1000).toISOString() }
    : s;
};

/** Assets per whole share: `convertToAssets` (assets in raw units for one whole share) over 10^asset decimals. */
export function jupiterLendExchangeRate(a: MetricAsset, t: JupiterLendToken, s: ReadStamp) {
  return assetFact(
    a,
    'exchange_rate',
    Number(t.convertToAssets) / 10 ** t.asset.decimals,
    jlAt(t, s),
    {
      convertToAssets: t.convertToAssets,
      shareDecimals: t.decimals,
      asset: t.asset.address,
      assetDecimals: t.asset.decimals,
      totalAssets: t.totalAssets,
      totalSupply: t.totalSupply,
    },
  );
}

/** The supply rate the API states, in basis points a year; the rewards rate apart, in the detail. */
export function jupiterLendQuoted(a: MetricAsset, t: JupiterLendToken, s: ReadStamp) {
  return assetFact(a, 'yield_quoted', Number(t.supplyRate) / BPS, jlAt(t, s), {
    supplyRateBps: t.supplyRate,
    rewardsRateBps: t.rewardsRate,
    totalRateBps: t.totalRate,
    basis:
      'basis points as the API writes them; supplyRate + rewardsRate = totalRate; rewards apart',
    haircut: 'none: not a registry row',
  });
}

/** The vault's assets, at the asset price the same answer gives. */
export function jupiterLendTvl(a: MetricAsset, t: JupiterLendToken, s: ReadStamp) {
  const price = Number(t.asset.price);
  if (!Number.isFinite(price) || t.asset.price === undefined)
    return assetMissing(a, 'protocol_tvl_usd', 'no_price_in_answer', jlAt(t, s));
  return assetFact(
    a,
    'protocol_tvl_usd',
    (Number(t.totalAssets) / 10 ** t.asset.decimals) * price,
    jlAt(t, s),
    {
      totalAssets: t.totalAssets,
      assetDecimals: t.asset.decimals,
      assetSymbol: t.asset.symbol,
      assetPriceUsd: t.asset.price,
      assetPriceAt: t.asset.updatedAt ?? null,
      what: "the vault's assets at the API's own price of the asset",
    },
  );
}

// ------------------------------------------------------------------------------------------- Kamino reserve

/** The cToken's exchange rate and the reserve's supply in dollars at its own price, from the reserve account. */
export function kaminoReserveRows(
  a: MetricAsset,
  acct: AccountRead,
  reserve: string,
  s: ReadStamp,
  metrics: ReadonlySet<AssetMetric>,
): AssetObservation[] {
  const want = (['exchange_rate', 'protocol_tvl_usd'] as const).filter((m) => metrics.has(m));
  if (!acct) return want.map((m) => assetMissing(a, m, 'account_not_found', s, { reserve }));
  let r: ReturnType<typeof decodeKaminoReserve>;
  try {
    r = decodeKaminoReserve(acct.data);
  } catch (e) {
    return want.map((m) =>
      assetMissing(a, m, 'not_a_reserve', s, { reserve, error: String(e).slice(0, 200) }),
    );
  }
  if (r.collateralMint !== a.address)
    return want.map((m) =>
      assetMissing(a, m, 'reserve_collateral_mint_differs', s, {
        reserve,
        collateralMint: r.collateralMint,
      }),
    );
  const st = kaminoReserveState(r);
  const price = sfToNumber(r.marketPriceSf);
  const detail = {
    reserve,
    liquidityMint: r.liquidityMint,
    collateralMintSupply: r.collateralMintTotalSupply.toString(),
    supplied: st.supplied.toString(),
    mintDecimals: r.mintDecimals,
    marketPriceUsd: price,
    marketPriceAt: new Date(Number(r.marketPriceLastUpdatedTs) * 1000).toISOString(),
  };
  return want.map((m) =>
    m === 'exchange_rate'
      ? assetFact(a, m, st.exchangeRate, s, {
          ...detail,
          what: 'liquidity per cToken, at the last refresh',
        })
      : assetFact(a, m, (Number(st.supplied) / 10 ** r.mintDecimals) * price, s, {
          ...detail,
          what: "the reserve's supply at the reserve's own price (Scope, at its last refresh)",
        }),
  );
}

// ------------------------------------------------------------------------------------------- ERC-4626 and SGOV

/** convertToAssets(10^decimals) over 10^(asset decimals): the underlying's whole tokens per whole share. */
export function erc4626Rate(
  a: MetricAsset,
  r: {
    asset?: { success: boolean; data: string };
    convertToAssets?: { success: boolean; data: string };
    totalAssets?: { success: boolean; data: string };
    totalSupply?: { success: boolean; data: string };
    assetDecimals?: { success: boolean; data: string };
  },
  s: ReadStamp,
): AssetObservation {
  const assets = r.convertToAssets?.success ? wordUint(r.convertToAssets.data) : null;
  const dec = r.assetDecimals?.success ? wordUint(r.assetDecimals.data) : null;
  if (assets === null)
    return assetMissing(a, 'exchange_rate', 'call_reverted', s, { call: 'convertToAssets' });
  if (dec === null || dec > 36n)
    return assetMissing(a, 'exchange_rate', 'call_reverted', s, { call: 'decimals() of asset()' });
  const asset = r.asset?.success ? `0x${r.asset.data.slice(-40)}` : null;
  return assetFact(a, 'exchange_rate', Number(assets) / 10 ** Number(dec), s, {
    asset,
    assetDecimals: Number(dec),
    shareDecimals: a.decimals,
    convertToAssets: assets.toString(),
    totalAssets: r.totalAssets?.success ? (wordUint(r.totalAssets.data)?.toString() ?? null) : null,
    totalSupply: r.totalSupply?.success ? (wordUint(r.totalSupply.data)?.toString() ?? null) : null,
  });
}

/** A Robinhood Chain stock token's multiplier as the issuer's registry states it (SGOV pays through it). */
export function issuerMultiplier(
  a: MetricAsset,
  row: { currentMultiplier?: string; pendingMultiplier?: string } | undefined,
  s: ReadStamp,
): AssetObservation {
  if (!row?.currentMultiplier) return assetMissing(a, 'exchange_rate', 'not_in_issuer_answer', s);
  return assetFact(a, 'exchange_rate', Number(row.currentMultiplier), s, {
    currentMultiplier: row.currentMultiplier,
    pendingMultiplier: row.pendingMultiplier || null,
    what: "the issuer's multiplier: shares of the underlying per token",
  });
}

// ----------------------------------------------------------------------------------------- DefiLlama yield pools

export type LlamaPoolPoint = {
  timestamp: string;
  tvlUsd: number | null;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
};

const PERCENT = 100;

/** The newest point of a DefiLlama yield pool's chart: its total rate (base and reward apart) or its TVL. */
export function llamaPoolRow(
  a: MetricAsset,
  metric: 'yield_quoted' | 'protocol_tvl_usd',
  pool: { pool: string; project: string },
  points: readonly LlamaPoolPoint[] | null,
  s: ReadStamp,
): AssetObservation {
  const last = points?.at(-1);
  if (!last) return assetMissing(a, metric, 'no_point_in_answer', s, { pool: pool.pool });
  if (Number.isNaN(Date.parse(last.timestamp)))
    return assetMissing(a, metric, 'bad_point_in_answer', s, {
      pool: pool.pool,
      timestamp: last.timestamp,
    });
  const at = { ...s, observedAt: new Date(last.timestamp).toISOString() };
  const detail = { pool: pool.pool, project: pool.project, points: points?.length ?? 0 };
  if (metric === 'protocol_tvl_usd')
    return last.tvlUsd === null
      ? assetMissing(a, metric, 'no_tvl_in_answer', at, detail)
      : assetFact(a, metric, last.tvlUsd, at, { ...detail, what: "DefiLlama's TVL of the pool" });
  return last.apy === null
    ? assetMissing(a, metric, 'no_rate_in_answer', at, detail)
    : assetFact(a, metric, last.apy / PERCENT, at, {
        ...detail,
        apyBasePct: last.apyBase,
        apyRewardPct: last.apyReward,
        what: "DefiLlama's total rate of the pool (base and reward), an aggregator's figure",
        haircut: 'none: not a registry row',
      });
}

// ------------------------------------------------------------------------------------------ yield_realised_30d

/** As `fetchRealised30d` (packages/engine/src/feeds/yields.ts): at least 20 daily points over at least 20 days. */
export const REALISED_MIN_POINTS = 20;
export const REALISED_MIN_DAYS = 20;
export const REALISED_WINDOW_DAYS = 30;
const DAY_S = 86_400;
const DAYS_A_YEAR = 365;

/** The realised rate of a year from a token's dollar price path (DefiLlama's daily chart), annualised. */
export function realisedFromPrices(
  a: MetricAsset,
  prices: ReadonlyArray<{ timestamp: number; price: number }> | null,
  s: ReadStamp,
): AssetObservation {
  if (!prices?.length) return assetMissing(a, 'yield_realised_30d', 'not_priced_by_source', s);
  const first = prices[0] as { timestamp: number; price: number };
  const last = prices.at(-1) as { timestamp: number; price: number };
  if (!Number.isFinite(last.timestamp) || !Number.isFinite(first.timestamp))
    return assetMissing(a, 'yield_realised_30d', 'bad_price_points', s);
  const at = { ...s, observedAt: new Date(last.timestamp * 1000).toISOString() };
  if (prices.length < REALISED_MIN_POINTS)
    return assetMissing(a, 'yield_realised_30d', 'insufficient_price_history', at, {
      points: prices.length,
    });
  const days = (last.timestamp - first.timestamp) / DAY_S;
  if (days < REALISED_MIN_DAYS)
    return assetMissing(a, 'yield_realised_30d', 'window_too_short', at, { days });
  if (!(first.price > 0)) return assetMissing(a, 'yield_realised_30d', 'bad_price_points', at);
  return assetFact(
    a,
    'yield_realised_30d',
    (last.price / first.price) ** (DAYS_A_YEAR / days) - 1,
    at,
    {
      first: { t: first.timestamp, price: first.price },
      last: { t: last.timestamp, price: last.price },
      days,
      points: prices.length,
      formula: '(last / first)^(365 / days) - 1',
      haircut: 'none: not a registry row',
    },
  );
}

/**
 * The realised rate of a year from this table's own exchange-rate series of the token: the newest reading against
 * the newest reading at or before 30 days earlier. Until the series reaches back that far it is missing.
 */
export function realisedFromSeries(
  a: MetricAsset,
  series: ReadonlyArray<{ observedAt: string; value: number }>,
  s: ReadStamp,
): AssetObservation {
  const xs = [...series].sort((x, y) => x.observedAt.localeCompare(y.observedAt));
  const last = xs.at(-1);
  if (!last) return assetMissing(a, 'yield_realised_30d', 'insufficient_history', s, { points: 0 });
  const end = Date.parse(last.observedAt) / 1000;
  const start = [...xs]
    .reverse()
    .find((x) => Date.parse(x.observedAt) / 1000 <= end - REALISED_WINDOW_DAYS * DAY_S);
  const at = { ...s, observedAt: last.observedAt };
  if (!start)
    return assetMissing(a, 'yield_realised_30d', 'insufficient_history', at, {
      points: xs.length,
      firstAt: xs[0]?.observedAt,
      needsFrom: new Date((end - REALISED_WINDOW_DAYS * DAY_S) * 1000).toISOString(),
    });
  const days = (end - Date.parse(start.observedAt) / 1000) / DAY_S;
  if (!(start.value > 0)) return assetMissing(a, 'yield_realised_30d', 'bad_series_points', at);
  return assetFact(
    a,
    'yield_realised_30d',
    (last.value / start.value) ** (DAYS_A_YEAR / days) - 1,
    at,
    {
      first: start,
      last,
      days,
      formula: '(last / first)^(365 / days) - 1 over this table’s exchange_rate rows',
      haircut: 'none: not a registry row',
    },
  );
}

// ------------------------------------------------------------------------------------------------- counting

/** Rows with a value and rows null by reason, per metric. */
export function metricCounts(rows: readonly AssetObservation[]) {
  const out: Record<string, { value: number; null: Record<string, number> }> = {};
  for (const r of rows) {
    const c = out[r.metric] ?? { value: 0, null: {} };
    out[r.metric] = c;
    if (r.value !== null) c.value++;
    else c.null[r.nullReason as string] = (c.null[r.nullReason as string] ?? 0) + 1;
  }
  return out;
}

/** The key the table is unique on. */
export const assetObservationKey = (r: AssetObservation) =>
  `${r.chain}|${r.address}|${r.metric}|${r.source}|${r.observedAt}`;
