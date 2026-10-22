import {
  type AssetMetric,
  type DexPair,
  llamaKey,
  type MetricAnswers,
  type MetricAsset,
  type MetricSources,
  metricPlan,
} from '@colosseum/risk';

// PLAN-ASSETS AS.5: the reads both chains share (DexScreener, DefiLlama, the issuers' public files), each GET counted
// with its calls, seconds and errors. Public endpoints, no key (DA8). A refusal for rate or a server error is asked
// again, slowly; a failure is kept in the answers as the error, never as a figure.

export type ReadLog = {
  name: string;
  what: string;
  calls: number;
  seconds: number;
  errors: number;
  rows: number;
};

export class Reads {
  readonly logs: Record<string, ReadLog> = {};
  log(name: string, what: string): ReadLog {
    this.logs[name] ??= { name, what, calls: 0, seconds: 0, errors: 0, rows: 0 };
    return this.logs[name];
  }
  /** Times `f` into the log of `name`: its seconds, and an error when it throws (rethrown). */
  async timed<T>(name: string, what: string, f: (l: ReadLog) => Promise<T>): Promise<T> {
    const l = this.log(name, what);
    const t0 = Date.now();
    try {
      return await f(l);
    } finally {
      l.seconds = Math.round((l.seconds + (Date.now() - t0) / 1000) * 10) / 10;
    }
  }
  list() {
    return Object.values(this.logs);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HTTP_TRIES = 4;

/** A public GET as JSON: asked again on 429 or 5xx after 2, 4 and 8 seconds; the log counts every attempt. */
export async function getJson(url: string, l: ReadLog, init?: RequestInit): Promise<unknown> {
  let last = '';
  for (let k = 0; k < HTTP_TRIES; k++) {
    if (k) await sleep(2000 * 2 ** (k - 1));
    l.calls++;
    try {
      const res = await fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status >= 500) {
        last = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        l.errors++;
        throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      }
      return await res.json();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('HTTP ')) throw e;
      last = e instanceof Error ? e.name : 'network error';
    }
  }
  l.errors++;
  throw new Error(`${new URL(url).host}: ${last} after ${HTTP_TRIES} tries`);
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const nowIso = () => new Date().toISOString();

/** Which reads a run needs, from the plans of its rows and the metrics asked. */
export function readsNeeded(
  list: readonly MetricAsset[],
  sources: MetricSources,
  metrics: ReadonlySet<string>,
) {
  const need = new Map<string, Set<string>>();
  for (const a of list) {
    const plan = metricPlan(a, { sources });
    for (const [m, p] of Object.entries(plan)) {
      if (!metrics.has(m) || !('read' in p)) continue;
      const k = p.read;
      const s = need.get(k) ?? new Set<string>();
      s.add(p.ref ?? a.address);
      need.set(k, s);
    }
  }
  return need;
}

// ------------------------------------------------------------------------------------------------ DexScreener

/** DexScreener's batch endpoint answers one pair per token; this many tokens per call. */
const DEX_BATCH = 30;
const DEX_GAP_MS = 250;

/**
 * DexScreener, under its own name (VOLUME-DEXSCREENER). The batch endpoint (`tokens/v1`, 30 tokens a call) says which
 * tokens have a pair at all; it answers only one pair per token, so each token it names is then asked for its pairs
 * (`token-pairs/v1`, up to 30 pairs). A token the batch does not name has no pairs call and no pair.
 */
export async function readDexScreener(
  chainId: string,
  addresses: readonly string[],
  reads: Reads,
  opts: {
    log?: (l: string) => void;
    /** When the pairs calls stop (ms): a token not reached has no row, and `onCut` is called. */
    deadline?: number;
    onCut?: () => void;
  } = {},
): Promise<NonNullable<MetricAnswers['dex']>> {
  const norm = (a: string) => (chainId === 'solana' ? a : a.toLowerCase());
  const want = new Set(addresses.map(norm));
  const withPair = new Set<string>();
  const batchAt = nowIso();
  try {
    await reads.timed(
      'dexscreener_batch',
      `GET api.dexscreener.com/tokens/v1/${chainId}/<30 tokens>`,
      async (l) => {
        for (let i = 0; i < addresses.length; i += DEX_BATCH) {
          const part = addresses.slice(i, i + DEX_BATCH);
          const pairs = (await getJson(
            `https://api.dexscreener.com/tokens/v1/${chainId}/${part.join(',')}`,
            l,
          )) as DexPair[];
          for (const p of Array.isArray(pairs) ? pairs : []) {
            for (const t of [p.baseToken?.address, p.quoteToken?.address])
              if (t && want.has(norm(t))) withPair.add(norm(t));
          }
          l.rows = withPair.size;
          await sleep(DEX_GAP_MS);
        }
      },
    );
  } catch (e) {
    return { error: errorOf(e), fetchedAt: nowIso() };
  }
  const byToken: NonNullable<Extract<MetricAnswers['dex'], { byToken: unknown }>>['byToken'] = {};
  await reads.timed(
    'dexscreener_pairs',
    `GET api.dexscreener.com/token-pairs/v1/${chainId}/<token>`,
    async (l) => {
      let k = 0;
      for (const t of [...withPair].sort()) {
        if (opts.deadline !== undefined && Date.now() > opts.deadline) {
          opts.onCut?.();
          opts.log?.(`dexscreener pairs stopped at the run's deadline: ${k} of ${withPair.size}`);
          break;
        }
        const fetchedAt = nowIso();
        try {
          const pairs = (await getJson(
            `https://api.dexscreener.com/token-pairs/v1/${chainId}/${t}`,
            l,
          )) as DexPair[];
          byToken[t] = { fetchedAt, pairs: (Array.isArray(pairs) ? pairs : []).map(trimPair) };
          l.rows++;
        } catch (e) {
          byToken[t] = { fetchedAt, error: errorOf(e) };
        }
        if (++k % 200 === 0) opts.log?.(`dexscreener pairs ${k}/${withPair.size}`);
        await sleep(DEX_GAP_MS);
      }
    },
  );
  return { chainId, batchAt, withPair: [...withPair].sort(), byToken };
}

const trimPair = (p: DexPair): DexPair => ({
  chainId: p.chainId,
  dexId: p.dexId,
  pairAddress: p.pairAddress,
  baseToken: { address: p.baseToken.address, symbol: p.baseToken.symbol },
  quoteToken: { address: p.quoteToken.address, symbol: p.quoteToken.symbol },
  volume: { h24: p.volume?.h24 },
  liquidity: { usd: p.liquidity?.usd },
});

// ------------------------------------------------------------------------------------------------- DefiLlama

/** The newest points kept of a yield pool's chart. */
const POOL_POINTS = 40;

/** The chart of each reviewed DefiLlama yield pool (`yields.llama.fi/chart/<pool>`). */
export async function readLlamaPools(pools: readonly string[], reads: Reads) {
  const out: NonNullable<MetricAnswers['llamaPools']> = {};
  await reads.timed('defillama_yield_pools', 'GET yields.llama.fi/chart/<pool>', async (l) => {
    for (const pool of pools) {
      const url = `https://yields.llama.fi/chart/${pool}`;
      const fetchedAt = nowIso();
      try {
        const d = (await getJson(url, l)) as { data?: Array<Record<string, unknown>> };
        const points = (d.data ?? []).slice(-POOL_POINTS).map((p) => ({
          timestamp: String(p.timestamp),
          tvlUsd: typeof p.tvlUsd === 'number' ? p.tvlUsd : null,
          apy: typeof p.apy === 'number' ? p.apy : null,
          apyBase: typeof p.apyBase === 'number' ? p.apyBase : null,
          apyReward: typeof p.apyReward === 'number' ? p.apyReward : null,
        }));
        out[pool] = { fetchedAt, url, points };
        l.rows++;
      } catch (e) {
        out[pool] = { fetchedAt, error: errorOf(e) };
      }
    }
  });
  return out;
}

const CHART_BATCH = 10;
const one = (key: string) => `https://coins.llama.fi/chart/${key}?span=31&period=1d`;

/** DefiLlama coins' daily chart of 31 days per token, as `fetchRealised30d` reads it, ten tokens a call. */
export async function readLlamaCharts(chain: string, addresses: readonly string[], reads: Reads) {
  const out: NonNullable<MetricAnswers['llamaCharts']> = {};
  await reads.timed(
    'defillama_coins_chart',
    'GET coins.llama.fi/chart/<coins>?span=31&period=1d',
    async (l) => {
      for (let i = 0; i < addresses.length; i += CHART_BATCH) {
        const keys = addresses.slice(i, i + CHART_BATCH).map((a) => llamaKey(chain, a));
        const url = `https://coins.llama.fi/chart/${keys.join(',')}?span=31&period=1d`;
        const fetchedAt = nowIso();
        try {
          const d = (await getJson(url, l)) as {
            coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }>;
          };
          for (const k of keys) {
            // the request for this token alone, as fetchRealised30d makes it (the call asked ten at once)
            out[k] = { fetchedAt, url: one(k), prices: d.coins?.[k]?.prices ?? [] };
            if (d.coins?.[k]) l.rows++;
          }
        } catch (e) {
          for (const k of keys) out[k] = { fetchedAt, error: errorOf(e) };
        }
      }
    },
  );
  return out;
}

const PRICE_BATCH = 50;

/** DefiLlama coins' current price per token, fifty tokens a call. */
export async function readLlamaPrices(chain: string, addresses: readonly string[], reads: Reads) {
  const coins: Record<
    string,
    { price?: number; timestamp?: number; decimals?: number; confidence?: number }
  > = {};
  const fetchedAt = nowIso();
  try {
    await reads.timed(
      'defillama_coins_current',
      'GET coins.llama.fi/prices/current/<coins>',
      async (l) => {
        for (let i = 0; i < addresses.length; i += PRICE_BATCH) {
          const keys = addresses.slice(i, i + PRICE_BATCH).map((a) => llamaKey(chain, a));
          const d = (await getJson(
            `https://coins.llama.fi/prices/current/${keys.join(',')}`,
            l,
          )) as {
            coins?: typeof coins;
          };
          Object.assign(coins, d.coins ?? {});
          l.rows = Object.keys(coins).length;
        }
      },
    );
  } catch (e) {
    return { error: errorOf(e), fetchedAt };
  }
  return { fetchedAt, url: 'https://coins.llama.fi/prices/current/<coins>', coins };
}

/** The issuers' own public files named in the reviewed map. */
export async function readIssuers(
  kinds: ReadonlyArray<{ kind: string; url: string }>,
  reads: Reads,
) {
  const out: NonNullable<MetricAnswers['issuer']> = {};
  for (const { kind, url } of kinds) {
    if (out[kind]) continue;
    const fetchedAt = nowIso();
    try {
      const answer = await reads.timed(`issuer_${kind}`, `GET ${url}`, async (l) => {
        const a = await getJson(url, l);
        l.rows++;
        return a;
      });
      out[kind] = { fetchedAt, url, answer };
    } catch (e) {
      out[kind] = { fetchedAt, error: errorOf(e) };
    }
  }
  return out;
}

/** The metrics a `--metrics` list names, or all of them; `price_usd` asks for the prices. */
export function parseMetrics(arg: string | undefined, all: readonly AssetMetric[]) {
  const names = arg
    ? arg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [...all, 'price_usd'];
  const bad = names.filter((n) => n !== 'price_usd' && !all.includes(n as AssetMetric));
  if (bad.length)
    throw new Error(`unknown metric ${bad.join(', ')}; known: ${all.join(', ')}, price_usd`);
  return {
    metrics: names.filter((n): n is AssetMetric => n !== 'price_usd'),
    prices: names.includes('price_usd'),
  };
}
