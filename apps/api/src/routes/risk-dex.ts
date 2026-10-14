import { DISCLAIMER } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * `GET /risk/dex`: what Bearing's stocks and commodities pages read of each asset, for up to
 * `DEX_MAX_IDS` assets in one answer. Each asset's three answers are the routes the page read one by
 * one, asked of this app (so each is kept and shared by risk-cache.ts): its fact sheet at `sizeUsd`, its
 * capacity history over `days`, and its pools, each row cut to the fields the page reads. An answer
 * keeps its status and its body as the route gave them; a route's refusal is that asset's, not the
 * whole answer's.
 */
export const DEX_MAX_IDS = 16;
/** Assets read at once within one answer: three reads each, against the process's one pool. */
const ASSETS_AT_ONCE = 2;
/** What a pool row keeps: the page's fields, and the provenance of its figures. */
const POOL_FIELDS = [
  'address',
  'venue',
  'assetSymbol',
  'quoteSymbol',
  'exitPath',
  'tvlUsd',
  'discoveryVolume24hUsd',
  'fetchedAt',
  'source',
  'method',
  'methodVersion',
  'provenance',
] as const;

const enc = encodeURIComponent;
/** The addresses the pages read one by one, as they read them: a kept answer of either serves both. */
export const dexPaths = (
  id: string,
  q: { chain: 'solana' | 'robinhood'; sizeUsd: number; days: number; tau: number },
) => ({
  sheet: `/risk/facts/assets/${enc(id)}?sizeUsd=${q.sizeUsd}`,
  hist: `/risk/assets/${enc(id)}/history?days=${q.days}&tau=${q.tau}`,
  pools: `/risk/pools?asset=${enc(id)}${q.chain === 'solana' ? '' : `&chain=${q.chain}`}`,
});

type Answer = { status: number; body: unknown };

/** Pools cut to `POOL_FIELDS`; any other answer as it came. */
export function trimPools(a: Answer): Answer {
  const body = a.body as { pools?: Array<Record<string, unknown>> } | null;
  if (a.status !== 200 || !Array.isArray(body?.pools)) return a;
  return {
    status: a.status,
    body: {
      ...body,
      pools: body.pools.map((p) => Object.fromEntries(POOL_FIELDS.map((k) => [k, p[k] ?? null]))),
    },
  };
}

async function inTurn<I, O>(items: readonly I[], n: number, fn: (item: I) => Promise<O>) {
  const out: O[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as I);
    }),
  );
  return out;
}

export async function registerRiskDexRoute(app: FastifyInstance) {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const ask = async (url: string): Promise<Answer> => {
    const r = await app.inject({ method: 'GET', url });
    let body: unknown = null;
    try {
      body = r.json();
    } catch {}
    return { status: r.statusCode, body };
  };

  f.get(
    '/risk/dex',
    {
      schema: {
        summary:
          'For each named asset: its fact sheet, its capacity history and its pools, as the routes they come from answer them',
        description: `Up to ${DEX_MAX_IDS} assets, by symbol or address, comma-separated in \`ids\`. Each asset carries the status and body of \`GET /risk/facts/assets/{id}\`, \`GET /risk/assets/{id}/history\` and \`GET /risk/pools?asset={id}\`; a pool row keeps ${POOL_FIELDS.join(', ')}. A route's refusal is that asset's alone.\n\n${DISCLAIMER.en}`,
        querystring: z.object({
          ids: z
            .string()
            .transform((s) => [...new Set(s.split(',').filter(Boolean))])
            .pipe(z.array(z.string().min(1).max(64)).min(1).max(DEX_MAX_IDS)),
          chain: z.enum(['solana', 'robinhood']).default('solana'),
          sizeUsd: z.coerce.number().positive().default(100_000),
          days: z.coerce.number().int().min(1).max(30).default(30),
          tau: z.coerce.number().positive().max(0.5).default(0.01),
        }),
        response: {
          200: z.object({
            chain: z.string(),
            assets: z.array(
              z.object({
                id: z.string(),
                sheet: z.object({ status: z.number(), body: z.any() }),
                hist: z.object({ status: z.number(), body: z.any() }),
                pools: z.object({ status: z.number(), body: z.any() }),
              }),
            ),
            disclaimer: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const { ids, ...q } = req.query;
      const assets = await inTurn(ids, ASSETS_AT_ONCE, async (id) => {
        const p = dexPaths(id, q);
        const [sheet, hist, pools] = await Promise.all([ask(p.sheet), ask(p.hist), ask(p.pools)]);
        return { id, sheet, hist, pools: trimPools(pools) };
      });
      return { chain: q.chain, assets, disclaimer: DISCLAIMER.en };
    },
  );
}

/**
 * Reads what the Bearing pages read first, once the server is up, so the first visitor after a start
 * (the host sleeps when idle) is not the one who waits: each chain's asset list and each asset's three
 * answers, and Solana's lending pools with their histories. A few at a time, and nothing is waited for.
 */
export async function warmRiskReads(app: FastifyInstance, log: (msg: string) => void = () => {}) {
  const started = Date.now();
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    try {
      return r.statusCode === 200 ? (r.json() as unknown) : null;
    } catch {
      return null;
    }
  };
  let n = 0;
  for (const chain of ['solana', 'robinhood'] as const) {
    const list = (await get(
      `/risk/assets?tau=0.01${chain === 'solana' ? '' : `&chain=${chain}`}`,
    )) as { assets?: Array<{ symbol: string; assetMint: string }> } | null;
    const ids = (list?.assets ?? []).map((a) => (chain === 'solana' ? a.symbol : a.assetMint));
    await inTurn(ids, ASSETS_AT_ONCE, async (id) => {
      const p = dexPaths(id, { chain, sizeUsd: 100_000, days: 30, tau: 0.01 });
      await Promise.all([get(p.sheet), get(p.hist), get(p.pools)]);
      n++;
    });
  }
  const lending = (await get('/risk/facts/lending')) as {
    pools?: Array<{ account: string }>;
  } | null;
  await inTurn(lending?.pools ?? [], ASSETS_AT_ONCE, async ({ account }) => {
    const a = enc(account);
    await Promise.all([
      get(`/risk/facts/lending/${a}`),
      get(`/risk/facts/lending/${a}/history?days=7`),
      get(`/risk/facts/lending/${a}/history?days=30`),
    ]);
  });
  await Promise.all([get('/risk/pools/recorded'), get('/risk/chains?tau=0.01')]);
  log(`risk reads warmed: ${n} assets in ${Math.round((Date.now() - started) / 1000)} s`);
}
