import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@colosseum/db';
import {
  type AssetMetric,
  type DiscoveryExtract,
  discoveryExtract,
  type MetricAnswers,
  type MetricAsset,
  type MetricSources,
} from '@colosseum/risk';
import { addressesObservedAt, readExchangeRateSeries } from '../risk/assets/metrics-db';
import {
  getJson,
  type Reads,
  readDexScreener,
  readLlamaCharts,
  readLlamaPools,
  readLlamaPrices,
  readsNeeded,
} from '../risk/assets/metrics-io';
import type { Call } from './abi';
import { CHAINS, rpcFor } from './config';
import { multicall } from './multicall';
import { latestFile, REGISTRY_URL } from './registry';
import { createRpc } from './rpc';

// PLAN-ASSETS AS.5, Robinhood Chain: every read of a run, into its answers. Read-only: totalSupply() of every token
// and convertToAssets(10^decimals), asset(), totalAssets() and totalSupply() of each ERC-4626, by Multicall3 at one
// pinned block, then decimals() of each vault's asset at the same block; the pool TVL of the newest discovery file
// (RISK_EVM_DIR, read only), or of the extract the job's installer made from it; the issuer's registry for SGOV's
// multiplier. The public RPC is never asked in UTC minutes 1 to 14, when the hourly loop reads it, and a request its
// Cloudflare answers with a challenge (HTTP 403, cf-mitigated) is asked again after 15 seconds, as
// scripts/risk-evm/assets.ts does.

const CHALLENGE_TRIES = 8;
const CHALLENGE_WAIT_MS = 15_000;
/** UTC minutes, from and before, in which the hourly collector (scheduled at minute 4) reads the chain. */
export const LOOP_QUIET = [1, 15] as const;
const SERIES_DAYS = 40;
const CHAIN_TRIES = 3;
const CHAIN_RETRY_MS = 30_000;

const SIG = {
  totalSupply: '18160ddd', // totalSupply()
  asset: '38d52e0f', // asset()
  convertToAssets: '07a2d13a', // convertToAssets(uint256)
  totalAssets: '01e1d114', // totalAssets()
  decimals: '313ce567', // decimals()
} as const;

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const word = (n: bigint) => n.toString(16).padStart(64, '0');

/** Waits out the loop's minutes; `now` and `sleep` are given so a test or a dry run can see it. */
export async function outsideLoopMinutes(
  log: (l: string) => void,
  now = () => new Date(),
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
  for (;;) {
    const minute = now().getUTCMinutes();
    if (minute < LOOP_QUIET[0] || minute >= LOOP_QUIET[1]) return;
    log(`minute ${minute}: paused until minute ${LOOP_QUIET[1]}, the collector's hour`);
    await sleep(30_000);
  }
}

/** The pools of the newest discovery file, by token, for the tokens asked. */
export function discoveryFor(dir: string, tokens: readonly string[]) {
  const file = latestFile(dir, 'discovery', 'robinhood');
  if (!file) throw new Error(`no discovery file in ${dir}: set RISK_EVM_DIR`);
  const d = JSON.parse(readFileSync(file, 'utf8')) as {
    fetchedAt: string;
    blocks?: { stateLast?: number };
    pools: Array<{
      id: string;
      venue: string;
      token: string;
      other: string;
      tvlUsd: number | null;
      tvlReason: string | null;
      reachable: boolean;
    }>;
  };
  return {
    file: file.split('/').at(-1) as string,
    fetchedAt: new Date(d.fetchedAt).toISOString(),
    stateLast: d.blocks?.stateLast ?? null,
    byToken: discoveryExtract(d.pools, tokens),
  };
}

export type DiscoveryAnswer = {
  file: string;
  fetchedAt: string;
  stateLast: number | null;
  byToken: Record<string, DiscoveryExtract>;
};

export async function readRobinhoodMetrics(o: {
  list: readonly MetricAsset[];
  sources: MetricSources;
  metrics: readonly AssetMetric[];
  prices: boolean;
  db: Db;
  reads: Reads;
  listMeta: { file: string; fetchedAt: string; method: string };
  sourcesFile: string;
  /** The discovery file's folder (the import), or the extract the installer made (the job). */
  discovery: { dir: string } | { extractFile: string };
  log: (l: string) => void;
  /** When the DexScreener pairs calls stop (ms; the hosted job's): a token not reached has no row. */
  deadline?: number;
}): Promise<MetricAnswers> {
  const chain = CHAINS.find((c) => c.id === 'robinhood');
  if (!chain) throw new Error('no robinhood chain in config.ts');
  const { url, label } = rpcFor(chain);
  const mc3 = chain.multicall3;
  const startedAt = new Date().toISOString();
  const A: MetricAnswers = {
    kind: 'asset-metrics-answers',
    chain: 'robinhood',
    stamp: `${startedAt.slice(0, 16).replace(/[-:]/g, '')}Z`,
    startedAt,
    list: o.listMeta,
    sources: { file: o.sourcesFile, reviewedOn: o.sources.reviewedOn },
    metrics: [...o.metrics],
    rpcLabel: label,
  };
  const need = readsNeeded(o.list, o.sources, new Set(o.metrics));
  const R = o.reads;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let challenged = 0;
  const rpc = createRpc(url, {
    fetch: async (u, init) => {
      for (let attempt = 0; ; attempt++) {
        await outsideLoopMinutes(o.log);
        const res = await fetch(u, init);
        if (res.status !== 403 || !res.headers.get('cf-mitigated') || attempt >= CHALLENGE_TRIES)
          return res;
        challenged++;
        await sleep(CHALLENGE_WAIT_MS);
      }
    },
  });

  // --------------------------------------------------------------------------------- the chain at one block
  const supplyOf = [...(need.get('erc20_total_supply') ?? [])].sort();
  const vaults = [...(need.get('erc4626') ?? [])].sort();
  // a refusal for rate starts the chain part again on a new block after 30 seconds, three times at most (as
  // assets.ts does); then the chain's rows are missing with the reason, and the rest of the run goes on
  for (let attempt = 1; (supplyOf.length || vaults.length) && attempt <= CHAIN_TRIES; attempt++) {
    try {
      await chainPart();
      delete A.chainError;
      break;
    } catch (e) {
      A.chainError = { error: errorOf(e), fetchedAt: new Date().toISOString() };
      o.log(`the chain part, attempt ${attempt} of ${CHAIN_TRIES}: ${A.chainError.error}`);
      delete A.block;
      delete A.totalSupply;
      delete A.erc4626;
      if (attempt < CHAIN_TRIES) await sleep(CHAIN_RETRY_MS);
    }
  }
  if (challenged)
    o.log(`${challenged} requests answered with a Cloudflare challenge and asked again`);

  async function chainPart() {
    await R.timed(
      'robinhood_chain',
      'eth_blockNumber, eth_getBlockByNumber, then eth_call of Multicall3 at that block',
      async (l) => {
        const before = rpc.stats().rpcCalls;
        try {
          const hex = await rpc.call<string>('eth_blockNumber', []);
          const blk = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hex, false]);
          A.block = {
            number: Number(BigInt(hex)),
            timestamp: Number(BigInt(blk.timestamp)),
            fetchedAt: new Date().toISOString(),
          };
          const calls: Call[] = [];
          const at: Array<[string, string]> = [];
          for (const a of supplyOf) {
            calls.push({ target: a, callData: `0x${SIG.totalSupply}` });
            at.push([a, 'totalSupply']);
          }
          const dec = new Map(o.list.map((a) => [a.address, a.decimals]));
          for (const a of vaults) {
            const one = 10n ** BigInt(dec.get(a) ?? 18);
            for (const [k, data] of [
              ['asset', `0x${SIG.asset}`],
              ['convertToAssets', `0x${SIG.convertToAssets}${word(one)}`],
              ['totalAssets', `0x${SIG.totalAssets}`],
              ['vaultSupply', `0x${SIG.totalSupply}`],
            ] as const) {
              calls.push({ target: a, callData: data });
              at.push([a, k]);
            }
          }
          const replies = await multicall(rpc, mc3, calls, hex);
          A.totalSupply = {};
          A.erc4626 = {};
          replies.forEach((r, k) => {
            const [a, what] = at[k] as [string, string];
            if (what === 'totalSupply') (A.totalSupply as Record<string, typeof r>)[a] = r;
            else {
              const all = A.erc4626 as Record<string, Record<string, typeof r>>;
              const v = all[a] ?? {};
              all[a] = v;
              v[what === 'vaultSupply' ? 'totalSupply' : what] = r;
            }
          });
          // decimals() of each vault's asset, at the same block
          const assets = vaults
            .map((v) => [v, A.erc4626?.[v]?.asset] as const)
            .filter(([, r]) => r?.success)
            .map(([v, r]) => [v, `0x${(r as { data: string }).data.slice(-40)}`] as const);
          if (assets.length) {
            const d = await multicall(
              rpc,
              mc3,
              assets.map(([, t]) => ({ target: t, callData: `0x${SIG.decimals}` })),
              hex,
            );
            assets.forEach(([v], k) => {
              const e = A.erc4626?.[v];
              if (e) e.assetDecimals = d[k];
            });
          }
          l.rows = supplyOf.length + vaults.length;
        } catch (e) {
          l.errors++;
          throw e;
        } finally {
          l.calls += rpc.stats().rpcCalls - before;
        }
      },
    );
  }

  // ----------------------------------------------------------------------------------- the discovery file
  if (need.has('discovery_file')) {
    const fetchedAt = new Date().toISOString();
    try {
      const tokens = [...(need.get('discovery_file') ?? [])];
      const d: DiscoveryAnswer = await R.timed(
        'discovery_file',
        'the newest discovery-robinhood-<stamp>.json (read only)',
        async (l) => {
          l.calls++;
          const x =
            'dir' in o.discovery
              ? discoveryFor(o.discovery.dir, tokens)
              : (JSON.parse(readFileSync(o.discovery.extractFile, 'utf8')) as DiscoveryAnswer);
          l.rows = Object.keys(x.byToken).length;
          return x;
        },
      );
      // the file holds one time: once every row asked has its row of that time, reading it again adds nothing
      const stored = await addressesObservedAt(o.db, 'robinhood', 'pool_tvl_usd', d.fetchedAt);
      A.discovery = tokens.every((t) => stored.has(t))
        ? { unchanged: true, file: d.file, fetchedAt: d.fetchedAt }
        : d;
    } catch (e) {
      A.discovery = { error: errorOf(e), fetchedAt };
    }
  }

  // ------------------------------------------------------------------------------------------- public GETs
  if (need.has('issuer_multiplier')) {
    const fetchedAt = new Date().toISOString();
    const want = new Set([...(need.get('issuer_multiplier') ?? [])].map((a) => a.toLowerCase()));
    try {
      const reg = (await R.timed('issuer_registry', `GET ${REGISTRY_URL.robinhood}`, async (l) =>
        getJson(REGISTRY_URL.robinhood as string, l),
      )) as {
        assets?: Array<{
          currentMultiplier?: string;
          pendingMultiplier?: string;
          deployments?: Array<{ contractAddress: string; chainId: number }>;
        }>;
      };
      const byAddress: Record<string, { currentMultiplier?: string; pendingMultiplier?: string }> =
        {};
      for (const t of reg.assets ?? [])
        for (const d of t.deployments ?? [])
          if (d.chainId === chain.chainId && want.has(d.contractAddress.toLowerCase()))
            byAddress[d.contractAddress.toLowerCase()] = {
              currentMultiplier: t.currentMultiplier,
              pendingMultiplier: t.pendingMultiplier,
            };
      R.log('issuer_registry', '').rows = Object.keys(byAddress).length;
      A.registry = { fetchedAt, url: REGISTRY_URL.robinhood as string, byAddress };
    } catch (e) {
      A.registry = { error: errorOf(e), fetchedAt };
    }
  }
  const late = () => o.deadline !== undefined && Date.now() > o.deadline;
  if (need.has('dexscreener') && late()) A.cutShort = ['dexscreener'];
  else if (need.has('dexscreener'))
    A.dex = await readDexScreener(
      chain.dexscreener,
      [...(need.get('dexscreener') ?? [])].sort(),
      R,
      {
        log: o.log,
        deadline: o.deadline,
        onCut: () => {
          A.cutShort = ['dexscreener'];
        },
      },
    );
  const pools = [...(need.get('defillama_yield_pool') ?? [])].sort();
  if (pools.length) A.llamaPools = await readLlamaPools(pools, R);
  const charts = [...(need.get('price_path_defillama') ?? [])].sort();
  if (charts.length) A.llamaCharts = await readLlamaCharts('robinhood', charts, R);
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
            return readExchangeRateSeries(
              o.db,
              'robinhood',
              seriesOf,
              new Date(Date.parse(startedAt) - SERIES_DAYS * 86_400_000).toISOString(),
            );
          },
        ),
      };
    } catch (e) {
      A.series = { error: errorOf(e), fetchedAt };
    }
  }
  if (o.prices)
    A.prices = {
      defillama: await readLlamaPrices(
        'robinhood',
        o.list.filter((a) => a.standard !== 'native').map((a) => a.address),
        R,
      ),
    };
  return A;
}

export const robinhoodDiscoveryDir = () => process.env.RISK_EVM_DIR ?? join('data', 'risk-evm');
