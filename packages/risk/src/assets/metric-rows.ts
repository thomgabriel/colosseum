import {
  defillamaPrice,
  type ExternalPrice,
  isPrice,
  jupiterPrice,
  type PriceRefusal,
} from './metric-prices';
import {
  ASSET_METRICS,
  type AssetMetric,
  type AssetObservation,
  assetFact,
  assetMissing,
  type DexPair,
  dexVolume24h,
  erc4626Rate,
  issuerMultiplier,
  type JupiterLendToken,
  jupiterLendExchangeRate,
  jupiterLendQuoted,
  jupiterLendTvl,
  kaminoReserveRows,
  type LargestAccounts,
  type LlamaPoolPoint,
  llamaPoolRow,
  type MetricAsset,
  type MetricSources,
  metricPlan,
  poolTvlFromRegistry,
  type ReadStamp,
  type RegisteredPool,
  realisedFromPrices,
  realisedFromSeries,
  sameAddress,
  structuralRows,
  supplyFromCircle,
  supplyFromMint,
  supplyFromTether,
  supplyFromTotalSupply,
  supplyNative,
  top20Share,
} from './metrics';

// PLAN-ASSETS AS.5: one run's answers, as they were saved (`<stamp>.jsonl.gz`), into rows. Pure: the import and the
// job hand in the answers and get the rows; a second pass over the same answers gives the same rows, so it inserts
// nothing new. Nothing here reads a clock: every time comes from an answer.

type Failed = { error: string; fetchedAt: string };
const failed = (x: unknown): x is Failed =>
  typeof x === 'object' && x !== null && 'error' in x && typeof (x as Failed).error === 'string';

export type EncodedAccount = { owner: string; data: string } | null;
type Call = { success: boolean; data: string };

/** The extract of the discovery file for one token: the pools that hold it, measured ones in full. */
export type DiscoveryExtract = {
  measured: Array<{
    id: string;
    venue: string;
    side: 'token' | 'other';
    reachable: boolean;
    tvlUsd: number;
  }>;
  unmeasured: number;
  unmeasuredBy: Record<string, number>;
};

export type MetricAnswers = {
  kind: 'asset-metrics-answers';
  chain: 'solana' | 'robinhood';
  stamp: string;
  startedAt: string;
  list: { file: string; fetchedAt: string; method: string };
  sources: { file: string; reviewedOn: string };
  metrics: AssetMetric[];
  rpcLabel: string;
  /** Solana: the RPC asked for getTokenLargestAccounts, when it is not the one of `rpcLabel`. */
  largestRpcLabel?: string;
  /**
   * The reads a run's deadline stopped before they were done (the hosted jobs, gate ASSET-METRICS amended
   * 2026-10-22): a token they did not reach has no row, not a null, and the next run reads it.
   */
  cutShort?: string[];
  /**
   * The reads that gave no answer in the time they were given (SOL's getSupply in the hosted job): no row, and
   * the part counts as tried, so it is asked again the next day, not every hour.
   */
  timedOut?: string[];
  // Solana
  mints?: Array<{
    slot: number;
    blockTime: number | null;
    fetchedAt: string;
    accounts: Record<string, EncodedAccount>;
  }>;
  nativeSupply?:
    | {
        slot: number;
        blockTime: number | null;
        fetchedAt: string;
        value: { total: number; circulating: number; nonCirculating: number };
      }
    | Failed;
  largest?: Record<
    string,
    (
      | { slot: number; value: Array<{ address: string; amount: string }> }
      | { error: string; unavailable?: boolean }
    ) & {
      fetchedAt: string;
    }
  >;
  riskPools?:
    | { fetchedAt: string; observedAt: string; rows: RegisteredPool[] }
    /** The registry has not been built again since its rows were stored: not read again. */
    | { unchanged: true; observedAt: string; fetchedAt: string }
    | Failed;
  kamino?:
    | {
        slot: number;
        blockTime: number | null;
        fetchedAt: string;
        accounts: Record<string, EncodedAccount>;
      }
    | Failed;
  jupiterLend?: { fetchedAt: string; url: string; tokens: JupiterLendToken[] } | Failed;
  // Robinhood Chain
  block?: { number: number; timestamp: number; fetchedAt: string };
  /** The chain part failed every attempt: its rows are missing with this error. */
  chainError?: Failed;
  totalSupply?: Record<string, Call>;
  erc4626?: Record<
    string,
    {
      asset?: Call;
      convertToAssets?: Call;
      totalAssets?: Call;
      totalSupply?: Call;
      assetDecimals?: Call;
    }
  >;
  discovery?:
    | {
        file: string;
        fetchedAt: string;
        stateLast: number | null;
        byToken: Record<string, DiscoveryExtract>;
      }
    | { unchanged: true; file: string; fetchedAt: string }
    | Failed;
  registry?:
    | {
        fetchedAt: string;
        url: string;
        byAddress: Record<string, { currentMultiplier?: string; pendingMultiplier?: string }>;
      }
    | Failed;
  // both
  dex?:
    | {
        chainId: string;
        /** When the batch endpoint was first asked: the time of a token it named no pair for. */
        batchAt: string;
        withPair: string[];
        byToken: Record<string, ({ pairs: DexPair[] } | { error: string }) & { fetchedAt: string }>;
      }
    | Failed;
  llamaPools?: Record<
    string,
    ({ url: string; points: LlamaPoolPoint[] } | { error: string }) & { fetchedAt: string }
  >;
  llamaCharts?: Record<
    string,
    ({ url: string; prices: Array<{ timestamp: number; price: number }> } | { error: string }) & {
      fetchedAt: string;
    }
  >;
  series?:
    | { fetchedAt: string; byAddress: Record<string, Array<{ observedAt: string; value: number }>> }
    | Failed;
  issuer?: Record<
    string,
    ({ url: string; answer: unknown } | { error: string }) & { fetchedAt: string }
  >;
  prices?: {
    defillama?:
      | {
          fetchedAt: string;
          url: string;
          coins: Record<
            string,
            { price?: number; timestamp?: number; decimals?: number; confidence?: number }
          >;
        }
      | Failed;
    jupiter?:
      | {
          fetchedAt: string;
          url: string;
          answers: Record<string, { usdPrice?: number; blockId?: number; decimals?: number }>;
        }
      | Failed;
    /** What the installed price job holds when the answers were read: the assets it values, its newest observation. */
    job?: { resolved: string[]; newestT: number | null; fetchedAt: string };
  };
};

const iso = (t: number) => new Date(t * 1000).toISOString();
const bytes = (a: EncodedAccount) =>
  a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data, 'base64')) } : null;

/** The DefiLlama coins key of a token: `solana:<mint>`, `robinhood:<address>`. */
export const llamaKey = (chain: string, address: string) =>
  `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

export type RunRows = {
  rows: AssetObservation[];
  prices: ExternalPrice[];
  refusals: PriceRefusal[];
  /** Reads that failed, by token: the reason a row of that token is missing. */
  errorsByToken: Record<string, string[]>;
};

/** Every row of a run, from its answers, for every list row and every metric asked. */
export function rowsFromAnswers(
  list: readonly MetricAsset[],
  sources: MetricSources,
  A: MetricAnswers,
): RunRows {
  const asked = new Set(A.metrics);
  const rows: AssetObservation[] = [];
  const errorsByToken: Record<string, string[]> = {};
  const err = (address: string, e: string) => {
    const xs = errorsByToken[address] ?? [];
    xs.push(e.slice(0, 200));
    errorsByToken[address] = xs;
  };
  const structural: ReadStamp = {
    observedAt: A.list.fetchedAt,
    fetchedAt: A.list.fetchedAt,
    height: null,
    source: `${A.list.file} (${A.list.method}) with ${A.sources.file} reviewed ${A.sources.reviewedOn}`,
    method: 'asset-metrics-plan',
  };
  const stampOf = (
    fetchedAt: string,
    source: string,
    method: string,
    at?: string | null,
    height?: number | null,
  ): ReadStamp => ({
    observedAt: at ?? fetchedAt,
    fetchedAt,
    height: height ?? null,
    source,
    method,
  });
  const readFailed = (a: MetricAsset, m: AssetMetric, s: ReadStamp, e: string) => {
    err(a.address, `${m}: ${e}`);
    return assetMissing(a, m, 'read_failed', s, { error: e.slice(0, 300) });
  };
  const rpcSource =
    A.chain === 'solana' ? `Solana RPC (${A.rpcLabel})` : `Robinhood Chain RPC (${A.rpcLabel})`;

  // the mint reads by address, with their slot's time
  const mintOf = new Map<
    string,
    { acct: EncodedAccount; slot: number; blockTime: number | null; fetchedAt: string }
  >();
  for (const c of A.mints ?? [])
    for (const [addr, acct] of Object.entries(c.accounts))
      mintOf.set(addr, { acct, slot: c.slot, blockTime: c.blockTime, fetchedAt: c.fetchedAt });
  const rawSupplyOf = (addr: string) => {
    const m = mintOf.get(addr);
    if (!m?.acct) return null;
    const data = Buffer.from(m.acct.data, 'base64');
    if (data.length < 44) return null;
    return { raw: data.readBigUInt64LE(36).toString(), slot: m.slot };
  };
  const block = A.block;
  const blockStamp = (method: string) =>
    block
      ? stampOf(
          block.fetchedAt,
          `${rpcSource} eth_call by Multicall3 at block ${block.number}`,
          method,
          iso(block.timestamp),
          block.number,
        )
      : null;

  const chainFailed = (a: MetricAsset, m: AssetMetric, method: string) => {
    const e = A.chainError as Failed;
    return readFailed(
      a,
      m,
      stampOf(e.fetchedAt, `${rpcSource} eth_call by Multicall3`, method),
      e.error,
    );
  };

  for (const a of list) {
    const plan = metricPlan(a, { sources });
    rows.push(...structuralRows(a, plan, structural, asked, { sources }));
    for (const m of ASSET_METRICS) {
      if (!asked.has(m)) continue;
      const p = plan[m];
      if (!('read' in p)) continue;
      const out = rowFor(a, m, p);
      if (out) rows.push(...(Array.isArray(out) ? out : [out]));
    }
  }

  function rowFor(
    a: MetricAsset,
    m: AssetMetric,
    p: { read: string; ref?: string },
  ): AssetObservation | AssetObservation[] | null {
    switch (p.read) {
      case 'spl_mint': {
        const r = mintOf.get(a.address);
        if (!r) return null;
        const s = stampOf(
          r.fetchedAt,
          `${rpcSource} getMultipleAccounts`,
          'spl_mint_supply',
          r.blockTime ? iso(r.blockTime) : null,
          r.slot,
        );
        return supplyFromMint(a, bytes(r.acct), s);
      }
      case 'native_supply': {
        const n = A.nativeSupply;
        if (!n) return null;
        if (failed(n))
          return readFailed(
            a,
            m,
            stampOf(n.fetchedAt, `${rpcSource} getSupply`, 'getSupply_total'),
            n.error,
          );
        return supplyNative(
          a,
          n.value,
          stampOf(
            n.fetchedAt,
            `${rpcSource} getSupply`,
            'getSupply_total',
            n.blockTime ? iso(n.blockTime) : null,
            n.slot,
          ),
        );
      }
      case 'erc20_total_supply': {
        if (A.chainError) return chainFailed(a, m, 'erc20_totalSupply');
        const s = blockStamp('erc20_totalSupply');
        if (!s || !A.totalSupply) return null;
        return supplyFromTotalSupply(a, A.totalSupply[a.address], s);
      }
      case 'circle_stablecoins':
      case 'tether_transparency': {
        const e = sources.issuerSupply.find(
          (x) => x.chain === a.chain && sameAddress(a.chain, x.address, a.address),
        );
        const ans = A.issuer?.[p.read];
        if (!e || !ans) return null;
        const s = stampOf(ans.fetchedAt, `${e.url} (the issuer)`, p.read);
        if ('error' in ans) return readFailed(a, m, s, ans.error);
        return p.read === 'circle_stablecoins'
          ? supplyFromCircle(a, ans.answer, e.key, s)
          : supplyFromTether(a, ans.answer, e.key, s);
      }
      case 'largest_accounts': {
        const l = A.largest?.[a.address];
        if (!l) return null;
        const s = stampOf(
          l.fetchedAt,
          `${A.largestRpcLabel ? `Solana RPC (${A.largestRpcLabel})` : rpcSource} getTokenLargestAccounts and getMultipleAccounts`,
          'largest_accounts_top20_share',
          null,
          'slot' in l ? l.slot : null,
        );
        return top20Share(a, l as LargestAccounts, rawSupplyOf(a.address), s);
      }
      case 'risk_pools': {
        const rp = A.riskPools;
        if (!rp || 'unchanged' in rp) return null;
        if (failed(rp))
          return readFailed(
            a,
            m,
            stampOf(rp.fetchedAt, 'risk_pools (local Postgres)', 'risk_pools_tvl_sum'),
            rp.error,
          );
        return poolTvlFromRegistry(
          a,
          rp.rows,
          stampOf(
            rp.fetchedAt,
            'risk_pools.tvl_usd (the Solana pool registry, measured on chain at its build)',
            'risk_pools_tvl_sum',
            rp.observedAt,
          ),
        );
      }
      case 'discovery_file': {
        const d = A.discovery;
        if (!d || 'unchanged' in d) return null;
        if (failed(d))
          return readFailed(
            a,
            m,
            stampOf(d.fetchedAt, 'the discovery file', 'discovery_tvl_sum'),
            d.error,
          );
        const s = stampOf(
          d.fetchedAt,
          `${d.file} (pnpm risk-evm:discover)`,
          'discovery_tvl_sum',
          d.fetchedAt,
          d.stateLast,
        );
        const x = d.byToken[a.address.toLowerCase()];
        if (!x) return assetMissing(a, m, 'no_registered_pool', s);
        if (!x.measured.length)
          return assetMissing(a, m, 'no_measured_pool', s, {
            pools: x.unmeasured,
            unmeasuredBy: x.unmeasuredBy,
          });
        return assetFact(
          a,
          m,
          x.measured.reduce((t, q) => t + q.tvlUsd, 0),
          s,
          {
            measured: x.measured.length,
            unmeasured: x.unmeasured,
            unmeasuredBy: x.unmeasuredBy,
            lowerBound: x.unmeasured > 0,
            scope:
              'pools with a stock token of the issuer registry on one side (the discovery file)',
            pools: x.measured,
          },
        );
      }
      case 'dexscreener': {
        const d = A.dex;
        if (!d) return null;
        if (failed(d))
          return readFailed(
            a,
            m,
            stampOf(d.fetchedAt, 'DexScreener', 'dexscreener_token_pairs_h24'),
            d.error,
          );
        const t = d.byToken[a.chain === 'solana' ? a.address : a.address.toLowerCase()];
        const s = (at: string) =>
          stampOf(
            at,
            `DexScreener api.dexscreener.com/token-pairs/v1/${d.chainId} (VOLUME-DEXSCREENER: DexScreener's figure)`,
            'dexscreener_token_pairs_h24',
          );
        if (!t) {
          // a token the batch named whose pairs the run's deadline left unread: no row, the next run reads it
          if (d.withPair.includes(a.chain === 'solana' ? a.address : a.address.toLowerCase()))
            return null;
          // the batch endpoint named no pair for the token: no pairs call was made
          return dexVolume24h(a, null, d.chainId, s(d.batchAt));
        }
        if ('error' in t) return readFailed(a, m, s(t.fetchedAt), t.error);
        return dexVolume24h(a, t.pairs, d.chainId, s(t.fetchedAt));
      }
      case 'jupiter_lend': {
        const j = A.jupiterLend;
        if (!j) return null;
        const s = stampOf(
          failed(j) ? j.fetchedAt : j.fetchedAt,
          `Jupiter Lend earn API ${sources.jupiterLend.url}`,
          'jupiter_lend_earn_api',
        );
        if (failed(j)) return readFailed(a, m, s, j.error);
        const t = j.tokens.find((x) => x.address === a.address);
        if (!t) return assetMissing(a, m, 'not_in_answer', s);
        return m === 'exchange_rate'
          ? jupiterLendExchangeRate(a, t, s)
          : m === 'yield_quoted'
            ? jupiterLendQuoted(a, t, s)
            : jupiterLendTvl(a, t, s);
      }
      case 'kamino_reserve': {
        const k = A.kamino;
        if (!k || !p.ref) return null;
        if (failed(k))
          return readFailed(
            a,
            m,
            stampOf(k.fetchedAt, `${rpcSource} getMultipleAccounts`, 'kamino_reserve_decode'),
            k.error,
          );
        const s = stampOf(
          k.fetchedAt,
          `${rpcSource} getMultipleAccounts of Kamino reserve ${p.ref}`,
          'kamino_reserve_decode',
          k.blockTime ? iso(k.blockTime) : null,
          k.slot,
        );
        return kaminoReserveRows(a, bytes(k.accounts[p.ref] ?? null), p.ref, s, new Set([m]));
      }
      case 'erc4626': {
        if (A.chainError) return chainFailed(a, m, 'erc4626_convertToAssets');
        const s = blockStamp('erc4626_convertToAssets');
        if (!s || !A.erc4626) return null;
        return erc4626Rate(a, A.erc4626[a.address] ?? {}, s);
      }
      case 'issuer_multiplier': {
        const r = A.registry;
        if (!r) return null;
        const s = stampOf(
          r.fetchedAt,
          `${'url' in r ? r.url : 'the issuer registry'} (the issuer)`,
          'issuer_registry_multiplier',
        );
        if (failed(r)) return readFailed(a, m, s, r.error);
        return issuerMultiplier(a, r.byAddress[a.address.toLowerCase()], s);
      }
      case 'defillama_yield_pool': {
        const e = sources.defillamaYieldPools.find((x) => x.pool === p.ref);
        const ans = p.ref ? A.llamaPools?.[p.ref] : undefined;
        if (!e || !ans) return null;
        const s = stampOf(
          ans.fetchedAt,
          `DefiLlama yields https://yields.llama.fi/chart/${e.pool}`,
          'aggregator_defillama',
        );
        if ('error' in ans) return readFailed(a, m, s, ans.error);
        return llamaPoolRow(a, m as 'yield_quoted' | 'protocol_tvl_usd', e, ans.points, s);
      }
      case 'price_path_defillama': {
        const c = A.llamaCharts?.[llamaKey(a.chain, a.address)];
        if (!c) return null;
        const s = stampOf(
          c.fetchedAt,
          `DefiLlama coins ${'url' in c ? c.url : 'chart'}`,
          'realised_30d_price_path_defillama',
        );
        if ('error' in c) return readFailed(a, m, s, c.error);
        return realisedFromPrices(a, c.prices.length ? c.prices : null, s);
      }
      case 'exchange_rate_series': {
        const sr = A.series;
        if (!sr) return null;
        const s = stampOf(
          sr.fetchedAt,
          'asset_observations exchange_rate rows of this token',
          'realised_30d_exchange_rate_series',
        );
        if (failed(sr)) return readFailed(a, m, s, sr.error);
        return realisedFromSeries(a, sr.byAddress[a.address] ?? [], s);
      }
      default:
        throw new Error(`no builder for read ${p.read}`);
    }
  }

  // ---------------------------------------------------------------------------------------------- prices
  const prices: ExternalPrice[] = [];
  const refusals: PriceRefusal[] = [];
  const P = A.prices;
  if (P) {
    const dl = P.defillama;
    const jp = P.jupiter;
    for (const a of list) {
      if (dl && !failed(dl)) {
        const x = defillamaPrice(a, dl.coins[llamaKey(a.chain, a.address)], dl);
        if (isPrice(x)) prices.push(x);
        else refusals.push(x);
      }
      if (jp && !failed(jp) && a.chain === 'solana') {
        const x = jupiterPrice(a, jp.answers[a.address], jp);
        if (isPrice(x)) prices.push(x);
        else refusals.push(x);
      }
    }
  }
  return { rows, prices, refusals, errorsByToken };
}

/**
 * The discovery file's pools by the token they hold (either side), lower-cased, for the tokens asked: the measured
 * ones in full, the others counted by the reason their TVL was not measured.
 */
export function discoveryExtract(
  pools: ReadonlyArray<{
    id: string;
    venue: string;
    token: string;
    other: string;
    tvlUsd: number | null;
    tvlReason: string | null;
    reachable: boolean;
  }>,
  tokens: readonly string[],
): Record<string, DiscoveryExtract> {
  const want = new Set(tokens.map((t) => t.toLowerCase()));
  const out: Record<string, DiscoveryExtract> = {};
  for (const p of pools)
    for (const [addr, side] of [
      [p.token.toLowerCase(), 'token'],
      [p.other.toLowerCase(), 'other'],
    ] as const) {
      if (!want.has(addr)) continue;
      const x = out[addr] ?? { measured: [], unmeasured: 0, unmeasuredBy: {} };
      out[addr] = x;
      if (p.tvlUsd !== null && Number.isFinite(p.tvlUsd))
        x.measured.push({
          id: p.id,
          venue: p.venue,
          side,
          reachable: p.reachable,
          tvlUsd: p.tvlUsd,
        });
      else {
        x.unmeasured++;
        const why = p.tvlReason ?? 'none';
        x.unmeasuredBy[why] = (x.unmeasuredBy[why] ?? 0) + 1;
      }
    }
  for (const x of Object.values(out))
    x.measured.sort((p, q) => q.tvlUsd - p.tvlUsd || p.id.localeCompare(q.id));
  return out;
}
