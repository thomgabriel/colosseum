import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { RISK_CACHE_CONTROL, registerRiskReadCache } from './risk-cache';

// The kept answers of GET /risk/*, on an app with routes that count how often they are read.
function app(opts: { slowMs?: number } = {}) {
  let t = 0;
  const a = Fastify();
  registerRiskReadCache(a, { freshMs: 1_000, staleMs: 5_000, now: () => t });
  const reads: Record<string, number> = {};
  const count = (k: string) => {
    reads[k] = (reads[k] ?? 0) + 1;
    return reads[k];
  };
  a.get('/risk/thing', async (req) => {
    const n = count(req.url);
    if (opts.slowMs) await new Promise((d) => setTimeout(d, opts.slowMs));
    return { n };
  });
  a.get('/risk/missing', async (_req, reply) =>
    reply.code(404).send({ error: `read ${count('missing')}` }),
  );
  a.post('/risk/thing', async () => ({ n: count('post') }));
  a.get('/risk/pools/:address/liquidity', async () => ({ n: count('live') }));
  a.get('/v1/thing', async () => ({ n: count('v1') }));
  return { a, reads, at: (ms: number) => (t = ms) };
}

describe('the kept answers of GET /risk/*', () => {
  it('serves a fresh answer without reading again, and says so', async () => {
    const { a, reads } = app();
    const first = await a.inject({ url: '/risk/thing?x=1' });
    expect([first.json(), first.headers['x-read-cache']]).toEqual([{ n: 1 }, 'miss']);
    const again = await a.inject({ url: '/risk/thing?x=1' });
    expect([again.json(), again.headers['x-read-cache']]).toEqual([{ n: 1 }, 'hit']);
    expect(again.headers['content-type']).toBe(first.headers['content-type']);
    expect(again.headers['cache-control']).toBe(RISK_CACHE_CONTROL);
    expect(first.headers['cache-control']).toBe(RISK_CACHE_CONTROL);
    // another query is another answer
    expect((await a.inject({ url: '/risk/thing?x=2' })).json()).toEqual({ n: 1 });
    expect(reads).toEqual({ '/risk/thing?x=1': 1, '/risk/thing?x=2': 1 });
  });

  it('serves a stale answer while one read brings the new one, and the next request has it', async () => {
    const { a, reads, at } = app();
    await a.inject({ url: '/risk/thing' });
    at(2_000);
    const stale = await a.inject({ url: '/risk/thing' });
    expect([stale.json(), stale.headers['x-read-cache']]).toEqual([{ n: 1 }, 'stale']);
    await a.inject({ url: '/risk/thing' });
    await new Promise((d) => setTimeout(d, 20));
    const fresh = await a.inject({ url: '/risk/thing' });
    expect([fresh.json(), fresh.headers['x-read-cache']]).toEqual([{ n: 2 }, 'hit']);
    expect(reads['/risk/thing']).toBe(2);
  });

  it('reads an answer older than the stale limit again before answering', async () => {
    const { a, at } = app();
    await a.inject({ url: '/risk/thing' });
    at(6_000);
    const res = await a.inject({ url: '/risk/thing' });
    expect([res.json(), res.headers['x-read-cache']]).toEqual([{ n: 2 }, 'miss']);
  });

  it('reads once for requests that arrive together', async () => {
    const { a, reads } = app({ slowMs: 30 });
    const all = await Promise.all(
      Array.from({ length: 5 }, () => a.inject({ url: '/risk/thing' })),
    );
    expect(all.map((r) => r.json())).toEqual(Array(5).fill({ n: 1 }));
    expect(reads['/risk/thing']).toBe(1);
  });

  it('keeps no refusal, no POST, no live liquidity and nothing outside /risk', async () => {
    const { a, reads } = app();
    for (let i = 0; i < 2; i++) {
      const miss = await a.inject({ url: '/risk/missing' });
      expect(miss.headers['cache-control']).toBeUndefined();
      await a.inject({ method: 'POST', url: '/risk/thing' });
      await a.inject({ url: '/risk/pools/P/liquidity' });
      await a.inject({ url: '/v1/thing' });
    }
    expect(reads).toEqual({ missing: 2, post: 2, live: 2, v1: 2 });
  });

  it('a request cannot ask past the kept answer by naming the header the read again uses', async () => {
    const { a, reads } = app();
    await a.inject({ url: '/risk/thing' });
    await a.inject({ url: '/risk/thing', headers: { 'x-read-again': 'guess' } });
    expect(reads['/risk/thing']).toBe(1);
  });

  it('lets the oldest answers go past its size', async () => {
    let t = 0;
    const a = Fastify();
    registerRiskReadCache(a, { maxChars: 30, now: () => t });
    let n = 0;
    a.get('/risk/thing', async () => ({ n: ++n, pad: 'xxxxxxxx' }));
    await a.inject({ url: '/risk/thing?a' });
    await a.inject({ url: '/risk/thing?b' });
    t = 1;
    expect((await a.inject({ url: '/risk/thing?b' })).headers['x-read-cache']).toBe('hit');
    expect((await a.inject({ url: '/risk/thing?a' })).headers['x-read-cache']).toBe('miss');
  });
});
