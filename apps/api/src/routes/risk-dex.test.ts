import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { RISK_FRESH_MS, registerRiskReadCache } from './risk-cache';
import { DEX_MAX_IDS, dexAssetPath, registerRiskDexRoute, warmRiskReads } from './risk-dex';

// GET /risk/dex on stand-ins of the three routes it asks, which count their reads.
const POOL = {
  address: 'P1',
  program: 'prog',
  venue: 'raydium_clmm',
  assetMint: 'MINT',
  assetSymbol: 'AAAx',
  quoteMint: 'Q',
  quoteSymbol: 'USDC',
  exitPath: 'direct_usd',
  decimals0: 8,
  tvlUsd: 10,
  discoveryVolume24hUsd: 5,
  tier: 'A',
  fetchedAt: '2026-10-14T00:00:00.000Z',
  source: 'registry',
  method: 'decode',
  methodVersion: 'registry-0.1',
  provenance: 'live',
};

async function app(opts: { now?: () => number } = {}) {
  const a = Fastify();
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  registerRiskReadCache(a, opts.now ? { now: opts.now } : {});
  const read: string[] = [];
  a.addHook('onRequest', async (req) => {
    if (
      req.url !== '/risk/dex' &&
      !req.url.startsWith('/risk/dex?') &&
      !req.url.startsWith('/risk/dex/')
    )
      read.push(req.url);
  });
  a.get('/risk/facts/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === 'NOPEx') return reply.code(404).send({ error: `unknown asset ${id}` });
    return { symbol: id, sizeUsd: Number((req.query as { sizeUsd: string }).sizeUsd) };
  });
  a.get('/risk/assets/:id/history', async (req) => ({
    asset: (req.params as { id: string }).id,
    points: [],
  }));
  a.get('/risk/pools', async () => ({ pools: [POOL], disclaimer: 'd' }));
  a.get('/risk/assets', async () => ({
    assets: ['AAAx', 'BBBx', 'CCCx'].map((symbol) => ({ symbol, assetMint: `MINT-${symbol}` })),
  }));
  a.get('/risk/facts/lending', async () => ({ pools: [{ account: 'L1' }] }));
  a.get('/risk/facts/lending/:account', async () => ({ ok: 1 }));
  a.get('/risk/facts/lending/:account/history', async () => ({ ok: 1 }));
  a.get('/risk/pools/recorded', async () => ({ pools: [] }));
  a.get('/risk/chains', async () => ({ chains: [] }));
  await registerRiskDexRoute(a);
  return { a, read };
}

describe('GET /risk/dex', () => {
  it('answers each asset with the three routes’ status and body, pools cut to the page’s fields', async () => {
    const { a } = await app();
    const res = await a.inject({ url: '/risk/dex?ids=AAAx,NOPEx,AAAx' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assets.map((x: { id: string }) => x.id)).toEqual(['AAAx', 'NOPEx']);
    const [aaa, nope] = body.assets;
    expect(aaa.sheet).toEqual({ status: 200, body: { symbol: 'AAAx', sizeUsd: 100_000 } });
    expect(aaa.hist).toEqual({ status: 200, body: { asset: 'AAAx', points: [] } });
    expect(aaa.pools.status).toBe(200);
    expect(aaa.pools.body.pools).toEqual([
      {
        address: 'P1',
        venue: 'raydium_clmm',
        assetSymbol: 'AAAx',
        quoteSymbol: 'USDC',
        exitPath: 'direct_usd',
        tvlUsd: 10,
        discoveryVolume24hUsd: 5,
        fetchedAt: '2026-10-14T00:00:00.000Z',
        source: 'registry',
        method: 'decode',
        methodVersion: 'registry-0.1',
        provenance: 'live',
      },
    ]);
    // one asset's refusal is its own
    expect(nope.sheet).toEqual({ status: 404, body: { error: 'unknown asset NOPEx' } });
    expect(nope.hist.status).toBe(200);
  });

  it('asks the routes at the addresses the pages read, so a kept answer serves both', async () => {
    const { a, read } = await app();
    await a.inject({ url: '/risk/dex?ids=AAAx&chain=robinhood' });
    expect(read.sort()).toEqual([
      '/risk/assets/AAAx/history?days=30&tau=0.01',
      '/risk/facts/assets/AAAx?sizeUsd=100000',
      '/risk/pools?asset=AAAx&chain=robinhood',
    ]);
    const direct = await a.inject({ url: '/risk/facts/assets/AAAx?sizeUsd=100000' });
    expect(direct.headers['x-read-cache']).toBe('hit');
  });

  it(`refuses no ids and more than ${DEX_MAX_IDS}`, async () => {
    const { a } = await app();
    expect((await a.inject({ url: '/risk/dex?ids=' })).statusCode).toBe(400);
    const many = Array.from({ length: DEX_MAX_IDS + 1 }, (_, i) => `A${i}x`).join(',');
    expect((await a.inject({ url: `/risk/dex?ids=${many}` })).statusCode).toBe(400);
  });
});

describe('the warm-up', () => {
  it('reads each chain’s list and each asset’s fact sheet, keeps them, and reads nothing else', async () => {
    const { a, read } = await app();
    await warmRiskReads(a, { firstMs: 0 });
    expect([...read].sort()).toEqual(
      [
        '/risk/assets?tau=0.01',
        '/risk/assets?tau=0.01&chain=robinhood',
        ...['AAAx', 'BBBx', 'CCCx'].flatMap((s) => [
          `/risk/facts/assets/${s}?sizeUsd=100000`,
          `/risk/facts/assets/MINT-${s}?sizeUsd=100000`,
        ]),
      ].sort(),
    );
    // the warm answers are kept: a page's own read of a sheet asks nothing new of the routes
    const before = read.length;
    await a.inject({ url: '/risk/facts/assets/AAAx?sizeUsd=100000' });
    await a.inject({ url: '/risk/facts/assets/MINT-AAAx?sizeUsd=100000' });
    expect(read.length).toBe(before);
  });

  it('stays behind the people it is for: after the first answer, one asset at a time, never beside a request', async () => {
    const { a, read } = await app();
    let open = 0;
    let most = 0;
    a.addHook('onRequest', async (req) => {
      if (req.url.startsWith('/risk/facts/assets/')) most = Math.max(most, ++open);
    });
    a.addHook('onResponse', async (req) => {
      if (req.url.startsWith('/risk/facts/assets/')) open--;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((d) => {
      release = d;
    });
    a.get('/v1/slow', async () => {
      await held;
      return { ok: 1 };
    });
    const browser = { 'user-agent': 'a browser' };
    const warm = warmRiskReads(a, { firstMs: 60_000, pauseMs: 5 });
    await new Promise((d) => setTimeout(d, 30));
    // nothing is read before a request from outside is answered
    expect(read).toEqual([]);
    // the first request from outside is still under way: still nothing
    const person = a.inject({ url: '/v1/slow', headers: browser });
    await new Promise((d) => setTimeout(d, 30));
    expect(read).toEqual(['/v1/slow']);
    release();
    await person;
    await warm;
    expect(read.length).toBeGreaterThan(1);
    expect(most).toBe(1);
  });

  it('starts after the warm-up it is told to follow, and not much later than its time limit if that never ends', async () => {
    const { a, read } = await app();
    let release: () => void = () => {};
    const first = new Promise<void>((d) => {
      release = d;
    });
    const warm = warmRiskReads(a, { firstMs: 0, pauseMs: 5, after: first });
    await new Promise((d) => setTimeout(d, 30));
    expect(read).toEqual([]);
    release();
    await warm;
    expect(read.length).toBeGreaterThan(1);

    const { a: b, read: readB } = await app();
    const t = Date.now();
    await warmRiskReads(b, { firstMs: 0, maxMs: 50, pauseMs: 5, after: new Promise(() => {}) });
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(readB.length).toBeGreaterThan(0);
  });

  it('stops at its time limit', async () => {
    const { a, read } = await app();
    // a request from outside that never ends: the warm-up waits behind it, and gives up in time
    a.get('/v1/hung', () => new Promise(() => {}));
    void a.inject({ url: '/v1/hung', headers: { 'user-agent': 'a browser' } });
    const t = Date.now();
    await warmRiskReads(a, { firstMs: 0, maxMs: 50, pauseMs: 5 });
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(read.filter((u) => u.startsWith('/risk/facts/assets/'))).toEqual([]);
  });

  it('keeps no batch: it is put together from each asset’s kept entry each time', async () => {
    const { a, read } = await app();
    await a.inject({ url: '/risk/dex?ids=AAAx' });
    const second = await a.inject({ url: '/risk/dex?ids=AAAx' });
    expect(second.headers['x-read-cache']).toBeUndefined();
    // its parts were kept: the second batch read nothing new
    expect(read.filter((u) => u.startsWith('/risk/facts/assets/'))).toHaveLength(1);
  });
});

describe('one asset of the batch, kept', () => {
  const q = { chain: 'solana' as const, sizeUsd: 100_000, days: 30, tau: 0.01 };

  it('is kept per asset and size, so a second batch asks none of the three routes', async () => {
    const { a, read } = await app();
    await a.inject({ url: '/risk/dex?ids=AAAx,BBBx' });
    const before = read.length;
    const again = await a.inject({ url: '/risk/dex?ids=BBBx,AAAx' });
    expect(again.json().assets.map((x: { id: string }) => x.id)).toEqual(['BBBx', 'AAAx']);
    expect(read.length).toBe(before);
    expect((await a.inject({ url: dexAssetPath('AAAx', q) })).headers['x-read-cache']).toBe('hit');
    // another size is another entry
    const other = await a.inject({ url: dexAssetPath('AAAx', { ...q, sizeUsd: 5_000 }) });
    expect(other.headers['x-read-cache']).toBe('miss');
  });

  it('is dated from its oldest part, so kept parts do not add their ages', async () => {
    let t = Date.UTC(2026, 9, 27, 12);
    const { a } = await app({ now: () => t });
    const sheetAt = t;
    await a.inject({ url: '/risk/facts/assets/AAAx?sizeUsd=100000' });
    t += 50 * 60_000;
    const one = await a.inject({ url: dexAssetPath('AAAx', q) });
    expect(one.headers['x-read-at']).toBe(String(sheetAt));
    // fresh an hour from the sheet's reading, not from its own
    t = sheetAt + RISK_FRESH_MS + 1;
    expect((await a.inject({ url: dexAssetPath('AAAx', q) })).headers['x-read-cache']).toBe(
      'stale',
    );
  });

  it('keeps no entry with a part that was refused or failed: it is asked again next time', async () => {
    const { a } = await app();
    const first = await a.inject({ url: dexAssetPath('NOPEx', q) });
    expect(first.statusCode).toBe(207);
    expect(first.json().sheet.status).toBe(404);
    expect((await a.inject({ url: dexAssetPath('NOPEx', q) })).headers['x-read-cache']).toBe(
      'miss',
    );
  });

  it('a browser may keep the batch as long as its entries', async () => {
    const { a } = await app();
    const res = await a.inject({ url: '/risk/dex?ids=AAAx' });
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });
});
