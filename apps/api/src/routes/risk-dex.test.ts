import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { registerRiskReadCache } from './risk-cache';
import { DEX_MAX_IDS, registerRiskDexRoute, warmRiskReads } from './risk-dex';

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

async function app() {
  const a = Fastify();
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  registerRiskReadCache(a);
  const read: string[] = [];
  a.addHook('onRequest', async (req) => {
    if (req.url !== '/risk/dex' && !req.url.startsWith('/risk/dex?')) read.push(req.url);
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
  it('reads each chain’s list, each asset’s three answers and the lending pools, and keeps them', async () => {
    const { a, read } = await app();
    await warmRiskReads(a, { firstMs: 0 });
    expect(read).toEqual(
      expect.arrayContaining([
        '/risk/assets?tau=0.01',
        '/risk/assets?tau=0.01&chain=robinhood',
        '/risk/facts/assets/AAAx?sizeUsd=100000',
        '/risk/assets/AAAx/history?days=30&tau=0.01',
        '/risk/pools?asset=AAAx',
        '/risk/facts/assets/MINT-AAAx?sizeUsd=100000',
        '/risk/pools?asset=MINT-AAAx&chain=robinhood',
        '/risk/facts/lending/L1',
        '/risk/facts/lending/L1/history?days=7',
        '/risk/facts/lending/L1/history?days=30',
        '/risk/pools/recorded',
        '/risk/chains?tau=0.01',
      ]),
    );
    // the warm answers are kept: the batch and a page's own read ask nothing new of the routes
    const before = read.length;
    expect((await a.inject({ url: '/risk/dex?ids=AAAx' })).statusCode).toBe(200);
    await a.inject({ url: '/risk/facts/assets/AAAx?sizeUsd=100000' });
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
    const warm = warmRiskReads(a, { firstMs: 60_000, yieldMs: 5 });
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

  it('stops at its time limit', async () => {
    const { a, read } = await app();
    // a request from outside that never ends: the warm-up waits behind it, and gives up in time
    a.get('/v1/hung', () => new Promise(() => {}));
    void a.inject({ url: '/v1/hung', headers: { 'user-agent': 'a browser' } });
    const t = Date.now();
    await warmRiskReads(a, { firstMs: 0, maxMs: 50, yieldMs: 5 });
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(read.filter((u) => u.startsWith('/risk/facts/assets/'))).toEqual([]);
  });

  it('keeps no batch: it is put together from kept parts each time', async () => {
    const { a, read } = await app();
    await a.inject({ url: '/risk/dex?ids=AAAx' });
    const second = await a.inject({ url: '/risk/dex?ids=AAAx' });
    expect(second.headers['x-read-cache']).toBeUndefined();
    // its parts were kept: the second batch read nothing new
    expect(read.filter((u) => u.startsWith('/risk/facts/assets/'))).toHaveLength(1);
  });
});
