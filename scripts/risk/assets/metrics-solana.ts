import type { Db } from '@colosseum/db';
import type {
  AssetMetric,
  JupiterLendToken,
  MetricAnswers,
  MetricAsset,
  MetricSources,
} from '@colosseum/risk';
import { RPC_URL } from '../../lib';
import { rpc } from '../lib-pools';
import {
  addressesObservedAt,
  readExchangeRateSeries,
  readPriceJobState,
  readRiskPools,
  riskPoolsBuiltAt,
} from './metrics-db';
import {
  getJson,
  type Reads,
  readDexScreener,
  readIssuers,
  readLlamaCharts,
  readLlamaPools,
  readLlamaPrices,
  readsNeeded,
  sleep,
} from './metrics-io';

// PLAN-ASSETS AS.5, Solana: every read of a run, into its answers (`MetricAnswers`). Read-only: getMultipleAccounts
// on the mints (100 a call, the slot of each call and its block time kept), getTokenLargestAccounts one mint at a
// time with a pause between, getSupply for SOL, the Kamino reserve the map names; the shared rpc() of
// scripts/risk/lib-pools.ts and its backoff on 429. SOLANA_RPC_URL comes through dotenv (DOTENV_CONFIG_PATH): the
// URL is never written; errors are scrubbed of it.

const MINTS_PER_CALL = 100;
/** Between two getTokenLargestAccounts calls: about seven a second at most, beside the collectors. */
const LARGEST_GAP_MS = 120;
const SERIES_DAYS = 40;
/** SOL's getSupply, the one slow read (six minutes on Oct 22), is given this long at most in a run with a deadline. */
const NATIVE_SUPPLY_MS = 45_000;

const scrub = (e: unknown) => {
  let m = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  for (const u of [process.env.SOLANA_RPC_URL, process.env.SOLANA_LARGEST_ACCOUNTS_RPC_URL])
    if (u) m = m.split(u).join('<rpc>');
  return m;
};
export const solanaRpcLabel = () =>
  process.env.SOLANA_RPC_URL ? 'the RPC in SOLANA_RPC_URL' : RPC_URL;

type Ctx = {
  value: Array<{ owner: string; data: [string, string] } | null>;
  context: { slot: number };
};

/** An RPC's answer that it does not serve a method: a plan without it (-32601), not a refusal for rate. */
const METHOD_UNAVAILABLE = /-32601|only available on dedicated nodes|method not found/i;

/** JSON-RPC to another endpoint, with the backoff of lib-pools' rpc() on 429. Errors never carry the URL. */
async function rpcAt<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    let j: { result?: T; error?: { code?: number; message?: string } };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      j = (await res.json()) as typeof j;
    } catch {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (j.error?.code === 429) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
    return j.result as T;
  }
  throw new Error(`rpc ${method}: still refused after 8 attempts`);
}

/**
 * One JSON-RPC call that gives up at `until` (ms): each try's timeout ends there, a 429 is asked again until then.
 * For a run with a deadline (the hosted job), where lib-pools' rpc() could retry for minutes.
 */
async function rpcUntil<T>(method: string, params: unknown[], until: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const left = until - Date.now();
    if (left <= 0) throw new Error(`rpc ${method}: no answer in the time it was given`);
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(left),
    });
    const j = (res.status === 429 ? { error: { code: 429 } } : await res.json()) as {
      result?: T;
      error?: { code?: number; message?: string };
    };
    if (j.error?.code === 429) {
      await sleep(Math.min(500 * 2 ** attempt, Math.max(0, until - Date.now())));
      continue;
    }
    if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
    return j.result as T;
  }
}

async function blockTime(slot: number): Promise<number | null> {
  try {
    return (await rpc<number | null>('getBlockTime', [slot])) ?? null;
  } catch {
    return null;
  }
}

export async function readSolanaMetrics(o: {
  list: readonly MetricAsset[];
  sources: MetricSources;
  metrics: readonly AssetMetric[];
  prices: boolean;
  db: Db;
  riskHome: string;
  reads: Reads;
  list_: { file: string; fetchedAt: string; method: string };
  sourcesFile: string;
  log: (l: string) => void;
  /** Reads left out of this run (the hosted job's SOL supply, between its daily reads). */
  skipReads?: ReadonlySet<string>;
  /**
   * When the slow reads stop (ms; the hosted job's, before the end of its write window): the holders' and DEX
   * reads not reached by then are not made, their tokens have no row, and the run names them in `cutShort`.
   */
  deadline?: number;
}): Promise<MetricAnswers> {
  const startedAt = new Date().toISOString();
  const A: MetricAnswers = {
    kind: 'asset-metrics-answers',
    chain: 'solana',
    stamp: `${startedAt.slice(0, 16).replace(/[-:]/g, '')}Z`,
    startedAt,
    list: o.list_,
    sources: { file: o.sourcesFile, reviewedOn: o.sources.reviewedOn },
    metrics: [...o.metrics],
    rpcLabel: solanaRpcLabel(),
  };
  const need = readsNeeded(o.list, o.sources, new Set(o.metrics));
  for (const read of o.skipReads ?? []) need.delete(read);
  const R = o.reads;
  const cut = new Set<string>();
  const late = () => o.deadline !== undefined && Date.now() > o.deadline;

  // ------------------------------------------------------------------------------ mints: supply and holders
  const mintAddrs = [
    ...new Set([...(need.get('spl_mint') ?? []), ...(need.get('largest_accounts') ?? [])]),
  ].sort();
  if (mintAddrs.length) {
    A.mints = [];
    await R.timed(
      'solana_mints',
      'getMultipleAccounts of the mints (100 a call) and getBlockTime of each slot',
      async (l) => {
        for (let i = 0; i < mintAddrs.length; i += MINTS_PER_CALL) {
          const part = mintAddrs.slice(i, i + MINTS_PER_CALL);
          const fetchedAt = new Date().toISOString();
          l.calls++;
          const r = await rpc<Ctx>('getMultipleAccounts', [part, { encoding: 'base64' }]);
          l.calls++;
          const bt = await blockTime(r.context.slot);
          const accounts: Record<string, { owner: string; data: string } | null> = {};
          part.forEach((addr, k) => {
            const v = r.value[k];
            accounts[addr] = v ? { owner: v.owner, data: v.data[0] } : null;
          });
          A.mints?.push({ slot: r.context.slot, blockTime: bt, fetchedAt, accounts });
          l.rows += part.length;
        }
      },
    );
  }
  if (need.has('native_supply') && late()) cut.add('native_supply');
  else if (need.has('native_supply')) {
    const fetchedAt = new Date().toISOString();
    const until =
      o.deadline === undefined ? null : Math.min(o.deadline, Date.now() + NATIVE_SUPPLY_MS);
    try {
      A.nativeSupply = await R.timed('solana_supply', 'getSupply (SOL)', async (l) => {
        l.calls += 2;
        type Supply = {
          context: { slot: number };
          value: { total: number; circulating: number; nonCirculating: number };
        };
        const params = [{ excludeNonCirculatingAccountsList: true }];
        const r =
          until === null
            ? await rpc<Supply>('getSupply', params)
            : await rpcUntil<Supply>('getSupply', params, until);
        l.rows = 1;
        return {
          slot: r.context.slot,
          blockTime: await blockTime(r.context.slot),
          fetchedAt,
          value: {
            total: r.value.total,
            circulating: r.value.circulating,
            nonCirculating: r.value.nonCirculating,
          },
        };
      });
    } catch (e) {
      A.nativeSupply = { error: scrub(e), fetchedAt };
    }
  }
  const largest = [...(need.get('largest_accounts') ?? [])].sort();
  if (largest.length) {
    A.largest = {};
    // SOLANA_LARGEST_ACCOUNTS_RPC_URL: another RPC for this one method (the shared one may not serve it)
    const alt = process.env.SOLANA_LARGEST_ACCOUNTS_RPC_URL;
    const ask = alt
      ? <T>(method: string, params: unknown[]) => rpcAt<T>(alt, method, params)
      : <T>(method: string, params: unknown[]) => rpc<T>(method, params);
    // named on the holders' rows only: every other row keeps its source, so its newest stored row still matches
    if (alt) A.largestRpcLabel = 'the RPC in SOLANA_LARGEST_ACCOUNTS_RPC_URL';
    let unavailable: string | null = null;
    await R.timed(
      'solana_largest_accounts',
      'getTokenLargestAccounts, one mint a call',
      async (l) => {
        let k = 0;
        for (const mint of largest) {
          if (late()) {
            cut.add('largest_accounts');
            o.log(
              `getTokenLargestAccounts stopped at the run's deadline: ${k} of ${largest.length}`,
            );
            break;
          }
          const fetchedAt = new Date().toISOString();
          if (unavailable) {
            // the RPC said it does not serve the method: no mint is asked again
            (A.largest as NonNullable<MetricAnswers['largest']>)[mint] = {
              fetchedAt,
              error: unavailable,
              unavailable: true,
            };
            continue;
          }
          l.calls++;
          try {
            const r = await ask<{
              context: { slot: number };
              value: Array<{ address: string; amount: string }>;
            }>('getTokenLargestAccounts', [mint]);
            (A.largest as NonNullable<MetricAnswers['largest']>)[mint] = {
              fetchedAt,
              slot: r.context.slot,
              value: r.value.map((x) => ({ address: x.address, amount: x.amount })),
            };
            l.rows++;
          } catch (e) {
            l.errors++;
            const msg = scrub(e);
            const gone = METHOD_UNAVAILABLE.test(msg);
            if (gone) {
              unavailable = msg;
              o.log(`getTokenLargestAccounts is not served by the RPC: ${msg.slice(0, 160)}`);
            }
            (A.largest as NonNullable<MetricAnswers['largest']>)[mint] = {
              fetchedAt,
              error: msg,
              ...(gone ? { unavailable: true } : {}),
            };
          }
          if (++k % 250 === 0) o.log(`getTokenLargestAccounts ${k}/${largest.length}`);
          await sleep(LARGEST_GAP_MS);
        }
      },
    );
  }
  const reserves = [...(need.get('kamino_reserve') ?? [])].sort();
  if (reserves.length) {
    const fetchedAt = new Date().toISOString();
    try {
      A.kamino = await R.timed(
        'kamino_reserves',
        'getMultipleAccounts of the Kamino reserves the map names',
        async (l) => {
          l.calls += 2;
          const r = await rpc<Ctx>('getMultipleAccounts', [reserves, { encoding: 'base64' }]);
          const accounts: Record<string, { owner: string; data: string } | null> = {};
          reserves.forEach((addr, k) => {
            const v = r.value[k];
            accounts[addr] = v ? { owner: v.owner, data: v.data[0] } : null;
          });
          l.rows = reserves.length;
          return {
            slot: r.context.slot,
            blockTime: await blockTime(r.context.slot),
            fetchedAt,
            accounts,
          };
        },
      );
    } catch (e) {
      A.kamino = { error: scrub(e), fetchedAt };
    }
  }

  // ------------------------------------------------------------------------------------------ the database
  if (need.has('risk_pools')) {
    const fetchedAt = new Date().toISOString();
    // the registry holds one time: once every row asked has its row of that time, reading it again adds nothing
    const builtAt = await riskPoolsBuiltAt(o.db);
    const asked = [...(need.get('risk_pools') ?? [])];
    const stored = builtAt
      ? await addressesObservedAt(o.db, 'solana', 'pool_tvl_usd', builtAt)
      : new Set();
    if (builtAt && asked.every((a) => stored.has(a)))
      A.riskPools = { unchanged: true, observedAt: builtAt, fetchedAt };
    else
      try {
        const p = await R.timed(
          'risk_pools',
          'select of risk_pools (local Postgres)',
          async (l) => {
            l.calls++;
            const x = await readRiskPools(o.db);
            l.rows = x.rows.length;
            return x;
          },
        );
        A.riskPools = p.observedAt
          ? { fetchedAt, observedAt: p.observedAt, rows: p.rows }
          : { error: 'risk_pools is empty', fetchedAt };
      } catch (e) {
        A.riskPools = { error: scrub(e), fetchedAt };
      }
  }
  const seriesOf = [...(need.get('exchange_rate_series') ?? [])].sort();
  if (seriesOf.length) {
    const fetchedAt = new Date().toISOString();
    try {
      A.series = {
        fetchedAt,
        byAddress: await R.timed(
          'exchange_rate_series',
          'select of asset_observations exchange_rate rows',
          async (l) => {
            l.calls++;
            const from = new Date(Date.parse(startedAt) - SERIES_DAYS * 86_400_000).toISOString();
            return readExchangeRateSeries(o.db, 'solana', seriesOf, from);
          },
        ),
      };
    } catch (e) {
      A.series = { error: scrub(e), fetchedAt };
    }
  }

  // ------------------------------------------------------------------------------------------- public GETs
  if (need.has('dexscreener') && late()) cut.add('dexscreener');
  else if (need.has('dexscreener'))
    A.dex = await readDexScreener('solana', [...(need.get('dexscreener') ?? [])].sort(), R, {
      log: o.log,
      deadline: o.deadline,
      onCut: () => cut.add('dexscreener'),
    });
  if (need.has('jupiter_lend')) {
    const fetchedAt = new Date().toISOString();
    try {
      const tokens = await R.timed(
        'jupiter_lend',
        `GET ${o.sources.jupiterLend.url}`,
        async (l) => {
          const t = (await getJson(o.sources.jupiterLend.url, l)) as JupiterLendToken[];
          l.rows = Array.isArray(t) ? t.length : 0;
          return t;
        },
      );
      A.jupiterLend = { fetchedAt, url: o.sources.jupiterLend.url, tokens };
    } catch (e) {
      A.jupiterLend = { error: scrub(e), fetchedAt };
    }
  }
  const pools = [...(need.get('defillama_yield_pool') ?? [])].sort();
  if (pools.length) A.llamaPools = await readLlamaPools(pools, R);
  const charts = [...(need.get('price_path_defillama') ?? [])].sort();
  if (charts.length) A.llamaCharts = await readLlamaCharts('solana', charts, R);
  const kinds = o.sources.issuerSupply.filter(
    (e) => e.chain === 'solana' && (need.get(e.kind)?.has(e.url) ?? false),
  );
  if (kinds.length) A.issuer = await readIssuers(kinds, R);

  // ------------------------------------------------------------------------------------------------ prices
  if (o.prices) {
    const addrs = o.list.map((a) => a.address);
    A.prices = { defillama: await readLlamaPrices('solana', addrs, R) };
    const fetchedAt = new Date().toISOString();
    try {
      const answers: Record<string, { usdPrice?: number; blockId?: number; decimals?: number }> =
        {};
      await R.timed('jupiter_price', 'GET lite-api.jup.ag/price/v3?ids=<50 mints>', async (l) => {
        for (let i = 0; i < addrs.length; i += 50) {
          const d = (await getJson(
            `https://lite-api.jup.ag/price/v3?ids=${addrs.slice(i, i + 50).join(',')}`,
            l,
          )) as Record<string, { usdPrice?: number; blockId?: number; decimals?: number }>;
          for (const [k, v] of Object.entries(d ?? {}))
            if (v) answers[k] = { usdPrice: v.usdPrice, blockId: v.blockId, decimals: v.decimals };
          l.rows = Object.values(answers).filter((v) => typeof v.usdPrice === 'number').length;
        }
      });
      A.prices.jupiter = {
        fetchedAt,
        url: 'https://lite-api.jup.ag/price/v3?ids=<mints>',
        answers,
      };
    } catch (e) {
      A.prices.jupiter = { error: scrub(e), fetchedAt };
    }
    const jobAt = new Date().toISOString();
    const job = await R.timed(
      'price_job_state',
      'select of risk_price_observations; the collectors registries (read only)',
      async (l) => {
        l.calls++;
        const x = await readPriceJobState(o.db, o.riskHome);
        l.rows = x.resolved.length;
        return x;
      },
    );
    A.prices.job = { resolved: job.resolved, newestT: job.newestT, fetchedAt: jobAt };
  }
  if (cut.size) A.cutShort = [...cut].sort();
  return A;
}
