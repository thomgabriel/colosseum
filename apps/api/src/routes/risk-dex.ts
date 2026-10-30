import { DISCLAIMER } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { READ_AT_HEADER, RISK_CACHE_CONTROL, riskReadCacheOf } from './risk-cache';

/**
 * `GET /risk/dex`: what Bearing's stocks and commodities pages read of each asset, for up to
 * `DEX_MAX_IDS` assets in one answer. Each asset's three answers are the routes the page read one by
 * one, asked of this app (so each is kept and shared by risk-cache.ts): its fact sheet at `sizeUsd`, its
 * capacity history over `days`, and its pools, each row cut to the fields the page reads. An answer
 * keeps its status and its body as the route gave them; a route's refusal is that asset's, not the
 * whole answer's.
 *
 * One asset's three answers together are `GET /risk/dex/{id}`, kept by risk-cache.ts per asset and size
 * and dated from its oldest part, so kept parts do not add their ages. A batch is put together from those
 * as they were written, with nothing parsed again: on a small host, parsing and writing a batch's
 * megabyte of kept answers each time was most of what a page cost once everything was kept.
 */
export const DEX_MAX_IDS = 16;
/** Assets read at once within one answer: three reads each, against the process's one pool. */
const ASSETS_AT_ONCE = 2;
/** Lending pools read at once within `GET /risk/lending`: three reads each. */
const LEND_POOLS_AT_ONCE = 2;
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
type DexQuery = { chain: 'solana' | 'robinhood'; sizeUsd: number; days: number; tau: number };
/** One asset's three answers together (`GET /risk/dex/{id}`), at the address the batch and the warm read. */
export const dexAssetPath = (id: string, q: DexQuery) =>
  `/risk/dex/${enc(id)}?sizeUsd=${q.sizeUsd}&days=${q.days}&tau=${q.tau}${q.chain === 'solana' ? '' : `&chain=${q.chain}`}`;
/** What the pages read: $100k, 30 days, tau 1%. */
export const DEX_DEFAULTS = { sizeUsd: 100_000, days: 30, tau: 0.01 } as const;
/** The addresses the pages read one by one, as they read them: a kept answer of either serves both. */
export const dexPaths = (id: string, q: DexQuery) => ({
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
  // What the warm-up stays behind: requests from outside under way, and the first one answered.
  let first = () => {};
  const t = { inFlight: 0, served: new Promise<void>((d) => (first = d)) };
  traffic.set(app, t);
  const counted = new WeakSet<object>();
  app.addHook('onRequest', async (req) => {
    if (fromSelf(req)) return;
    counted.add(req);
    t.inFlight++;
  });
  const over = async (req: object) => {
    if (!counted.delete(req)) return;
    t.inFlight--;
    first();
  };
  app.addHook('onResponse', over);
  app.addHook('onRequestAbort', over);
  /** A route's answer as it was written, with when it was read (now, for one that was not kept). */
  const raw = async (url: string, headers: Record<string, string>) => {
    const r = await app.inject({ method: 'GET', url, headers });
    const json = /json/.test(String(r.headers['content-type'] ?? '')) && r.payload.length > 0;
    const at = Number(r.headers[READ_AT_HEADER]);
    return {
      status: r.statusCode,
      body: json ? r.payload : 'null',
      at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    };
  };
  const query = z.object({
    chain: z.enum(['solana', 'robinhood']).default('solana'),
    sizeUsd: z.coerce.number().positive().default(DEX_DEFAULTS.sizeUsd),
    days: z.coerce.number().int().min(1).max(30).default(DEX_DEFAULTS.days),
    tau: z.coerce.number().positive().max(0.5).default(DEX_DEFAULTS.tau),
  });
  const part = (a: { status: number; body: string }) => `{"status":${a.status},"body":${a.body}}`;

  f.get(
    '/risk/dex/:id',
    {
      schema: {
        summary: 'One asset of `GET /risk/dex`: its fact sheet, its capacity history and its pools',
        description: `As one entry of \`GET /risk/dex\`. Kept per asset and size, from the time of its oldest part.\n\n${DISCLAIMER.en}`,
        params: z.object({ id: z.string().min(1).max(64) }),
        querystring: query,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const p = dexPaths(id, req.query);
      // the warm's read of this entry reads its parts as the warm too: they are not counted as asked for
      const h = riskReadCacheOf(app)?.warmHeaders(req) ?? {};
      const [sheet, hist, pools] = await Promise.all([
        raw(p.sheet, h),
        raw(p.hist, h),
        raw(p.pools, h),
      ]);
      let poolsBody = pools.body;
      if (pools.status === 200)
        try {
          poolsBody = JSON.stringify(trimPools({ status: 200, body: JSON.parse(pools.body) }).body);
        } catch {}
      // Kept only when every part is a 200, as the parts are: a refusal or a failure is asked again
      // next time. 207: the parts carry their own status; 502: one of them the server failed.
      const parts = [sheet, hist, pools];
      const code = parts.some((a) => a.status === 0 || a.status >= 500)
        ? 502
        : parts.every((a) => a.status === 200)
          ? 200
          : 207;
      return reply
        .code(code)
        .type('application/json; charset=utf-8')
        .header(READ_AT_HEADER, String(Math.min(sheet.at, hist.at, pools.at)))
        .send(
          `{"id":${JSON.stringify(id)},"sheet":${part(sheet)},"hist":${part(hist)},"pools":${part({ status: pools.status, body: poolsBody })}}`,
        );
    },
  );

  f.get(
    '/risk/dex',
    {
      schema: {
        summary:
          'For each named asset: its fact sheet, its capacity history and its pools, as the routes they come from answer them',
        description: `Up to ${DEX_MAX_IDS} assets, by symbol or address, comma-separated in \`ids\`. Each asset carries the status and body of \`GET /risk/facts/assets/{id}\`, \`GET /risk/assets/{id}/history\` and \`GET /risk/pools?asset={id}\`; a pool row keeps ${POOL_FIELDS.join(', ')}. A route's refusal is that asset's alone.\n\n${DISCLAIMER.en}`,
        querystring: query.extend({
          ids: z
            .string()
            .transform((s) => [...new Set(s.split(',').filter(Boolean))])
            .pipe(z.array(z.string().min(1).max(64)).min(1).max(DEX_MAX_IDS)),
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
    async (req, reply) => {
      const { ids, ...q } = req.query;
      const cache = riskReadCacheOf(app);
      // A fresh kept entry is taken as it is; any other is asked of the route, which reads it.
      const assets = await inTurn(ids, ASSETS_AT_ONCE, async (id) => {
        const url = dexAssetPath(id, q);
        return cache?.peek(url) ?? (await app.inject({ method: 'GET', url })).payload;
      });
      // The kept entries as they were written; a browser may keep the batch as long as each of them.
      // The answer has the schema's shape, already written out: sent as it is, not serialised again.
      const body = `{"chain":${JSON.stringify(q.chain)},"assets":[${assets.join(',')}],"disclaimer":${JSON.stringify(DISCLAIMER.en)}}`;
      return reply
        .type('application/json; charset=utf-8')
        .header('cache-control', RISK_CACHE_CONTROL)
        .send(body as never);
    },
  );

  f.get(
    '/risk/lending',
    {
      schema: {
        summary: 'Every lending pool with its fact sheet and its histories, in one answer',
        description: `What the lending and stablecoins pages read of each pool of \`GET /risk/facts/lending\`: the status and body of \`GET /risk/facts/lending/{account}\` and of its history over 7 and 30 days. A route's refusal is that pool's alone. Dated from its oldest part.\n\n${DISCLAIMER.en}`,
      },
    },
    async (req, reply) => {
      const h = riskReadCacheOf(app)?.warmHeaders(req) ?? {};
      const list = await raw('/risk/facts/lending', h);
      if (list.status !== 200)
        return reply
          .code(list.status >= 500 || list.status === 0 ? 502 : list.status)
          .type('application/json; charset=utf-8')
          .send(list.body as never);
      const accounts =
        (JSON.parse(list.body) as { pools?: Array<{ account: string }> }).pools ?? [];
      let at = list.at;
      let failed = false;
      const pools = await inTurn(accounts, LEND_POOLS_AT_ONCE, async ({ account }) => {
        const base = `/risk/facts/lending/${enc(account)}`;
        const [sheet, h7, h30] = await Promise.all([
          raw(base, h),
          raw(`${base}/history?days=7`, h),
          raw(`${base}/history?days=30`, h),
        ]);
        at = Math.min(at, sheet.at, h7.at, h30.at);
        // Kept only when no part failed: a failure is asked again next time, as a part's own read is.
        if ([sheet, h7, h30].some((a) => a.status === 0 || a.status >= 500)) failed = true;
        return `{"account":${JSON.stringify(account)},"sheet":${part(sheet)},"h7":${part(h7)},"h30":${part(h30)}}`;
      });
      return reply
        .code(failed ? 207 : 200)
        .type('application/json; charset=utf-8')
        .header(READ_AT_HEADER, String(at))
        .send(
          `{"pools":[${pools.join(',')}],"disclaimer":${JSON.stringify(DISCLAIMER.en)}}` as never,
        );
    },
  );
}

/** Requests from outside under way, and whether one has been answered, per app (`registerRiskDexRoute`). */
const traffic = new WeakMap<FastifyInstance, { inFlight: number; served: Promise<void> }>();
/** How many requests from outside are under way, for a warm that stays behind them. */
export const visitorsOf = (app: FastifyInstance) => traffic.get(app);
/** A request the app asks of itself: the batch's parts, the warm-up's reads. */
const fromSelf = (req: { headers: Record<string, unknown> }) =>
  req.headers['user-agent'] === 'lightMyRequest';

export type WarmOptions = {
  log?: (msg: string) => void;
  /** It starts once the first request from outside is answered, or after this long without one. */
  firstMs?: number;
  /** It stops after this long, whatever is left. */
  maxMs?: number;
  /** It starts only once this has settled too, or `maxMs` have passed: another warm-up that goes first. */
  after?: Promise<unknown>;
  /** How long it waits before looking again while requests from outside are under way. */
  pauseMs?: number;
};

/**
 * Reads what costs the Bearing pages most on a cold start, so the first visitor after a start (the host
 * sleeps when idle) mostly finds it kept: each chain's asset list and each asset's fact sheet at the
 * stocks page's size, ten queries apiece. The rest (capacity histories, pools, lending pools) is read when
 * a page asks for it: each start reads the hosted database's free allowance, and a start nobody visits
 * the Bearing pages after should cost little (Oct 18, DB-LOAD). Its reads are the warm's (risk-cache.ts),
 * so they are not counted as asked for by a visitor. It stays behind the people it is for: it starts
 * after the request that woke the server is answered, reads one asset at a time, waits while any request
 * from outside is under way, and stops after `maxMs`.
 */
export async function warmRiskReads(app: FastifyInstance, opts: WarmOptions = {}) {
  const { log = () => {}, firstMs = 30_000, maxMs = 180_000, pauseMs = 250 } = opts;
  const seen = traffic.get(app);
  const pause = (ms: number) => new Promise((d) => setTimeout(d, ms).unref?.());
  if (opts.after) await Promise.race([opts.after.catch(() => {}), pause(maxMs)]);
  if (seen) await Promise.race([seen.served, pause(firstMs)]);
  const started = Date.now();
  const late = () => Date.now() - started > maxMs;
  const behind = async () => {
    while (seen && seen.inFlight > 0 && !late()) await pause(pauseMs);
  };
  const cache = riskReadCacheOf(app);
  const get = async (url: string) => {
    const r = cache
      ? await cache.read(url)
      : await app
          .inject({ method: 'GET', url })
          .then((x) => ({ status: x.statusCode, body: x.payload }));
    try {
      return r.status === 200 ? (JSON.parse(r.body) as unknown) : null;
    } catch {
      return null;
    }
  };
  /** One at a time, each behind the requests from outside, until the time is up. */
  const each = async <I>(items: readonly I[], fn: (item: I) => Promise<unknown>) => {
    for (const item of items) {
      if (late()) return;
      await behind();
      await fn(item);
    }
  };
  let n = 0;
  for (const chain of ['solana', 'robinhood'] as const) {
    await behind();
    const list = (await get(
      `/risk/assets?tau=0.01${chain === 'solana' ? '' : `&chain=${chain}`}`,
    )) as { assets?: Array<{ symbol: string; assetMint: string }> } | null;
    const ids = (list?.assets ?? []).map((a) => (chain === 'solana' ? a.symbol : a.assetMint));
    await each(ids, async (id) => {
      await get(dexPaths(id, { chain, ...DEX_DEFAULTS }).sheet);
      n++;
    });
  }
  log(
    `risk reads warmed: ${n} assets in ${Math.round((Date.now() - started) / 1000)} s${late() ? ' (stopped at its time limit)' : ''}`,
  );
}
