import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { MAX_KEY_CHARS, RISK_CACHE_CONTROL, registerRiskReadCache } from './risk-cache';

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
    registerRiskReadCache(a, { maxChars: 60, now: () => t });
    let n = 0;
    a.get('/risk/thing', async () => ({ n: ++n, pad: 'xxxxxxxx' }));
    await a.inject({ url: '/risk/thing?a' });
    await a.inject({ url: '/risk/thing?b' });
    t = 1;
    expect((await a.inject({ url: '/risk/thing?b' })).headers['x-read-cache']).toBe('hit');
    expect((await a.inject({ url: '/risk/thing?a' })).headers['x-read-cache']).toBe('miss');
  });

  it('stops waiting for a read that never ends: only the first request after it waits', async () => {
    let t = 0;
    const a = Fastify();
    registerRiskReadCache(a, { freshMs: 1, staleMs: 2, joinMs: 200, now: () => t });
    let n = 0;
    a.get('/risk/thing', async () => {
      n += 1;
      if (n === 1) await new Promise(() => {});
      return { n };
    });
    void a.inject({ url: '/risk/thing' });
    await new Promise((d) => setTimeout(d, 5));
    expect((await a.inject({ url: '/risk/thing' })).json()).toEqual({ n: 2 });
    t = 10;
    const start = performance.now();
    expect((await a.inject({ url: '/risk/thing' })).json()).toEqual({ n: 3 });
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('counts the address in its size, keeps a bounded number of answers, and keeps no long address', async () => {
    let t = 0;
    const a = Fastify();
    registerRiskReadCache(a, { maxChars: 10_000, maxEntries: 3, now: () => t });
    let n = 0;
    a.get('/risk/thing', async () => ({ n: ++n }));
    const pad = 'p'.repeat(MAX_KEY_CHARS - 20);
    for (const q of ['a', 'b', 'c', 'd']) await a.inject({ url: `/risk/thing?${q}` });
    t = 1;
    // four kept at most three: the oldest went
    expect((await a.inject({ url: '/risk/thing?a' })).headers['x-read-cache']).toBe('miss');
    expect((await a.inject({ url: '/risk/thing?d' })).headers['x-read-cache']).toBe('hit');
    // an address past the limit is answered and not kept
    const long = `/risk/thing?q=${'x'.repeat(MAX_KEY_CHARS)}`;
    await a.inject({ url: long });
    expect((await a.inject({ url: long })).headers['x-read-cache']).toBeUndefined();
    // the size counts the address: two answers of near-limit addresses go past 1,000 characters
    const b = Fastify();
    registerRiskReadCache(b, { maxChars: 1_000, now: () => t });
    b.get('/risk/thing', async () => ({ ok: 1 }));
    await b.inject({ url: `/risk/thing?a=${pad}` });
    await b.inject({ url: `/risk/thing?b=${pad}` });
    expect((await b.inject({ url: `/risk/thing?a=${pad}` })).headers['x-read-cache']).toBe('miss');
  });

  it('keeps the chains side by side for its half hour only, and no answer worked out from now', async () => {
    let t = Date.UTC(2026, 9, 14, 19, 50); // 15:50 ET, market hours
    const a = Fastify();
    registerRiskReadCache(a, { now: () => t });
    const reads: Record<string, number> = {};
    const count = (k: string) => {
      reads[k] = (reads[k] ?? 0) + 1;
      return { n: reads[k] };
    };
    a.get('/risk/chains', async () => count('chains'));
    a.get('/risk/assets/:id/score', async () => count('score'));
    a.get('/risk/recoverable', async (req) =>
      count((req.query as { at?: string }).at ? 'recov-at' : 'recov-now'),
    );
    for (let i = 0; i < 2; i++) {
      await a.inject({ url: '/risk/chains?tau=0.01' });
      await a.inject({ url: '/risk/assets/X/score?nRef=1' });
      await a.inject({ url: '/risk/recoverable?asset=X&notional=1' });
      await a.inject({ url: '/risk/recoverable?asset=X&notional=1&at=2026-10-14T19:00:00Z' });
    }
    expect(reads).toEqual({ chains: 1, score: 2, 'recov-now': 2, 'recov-at': 1 });
    // 16:00 ET: the market closed, and the chains are read again though the answer is minutes old
    t = Date.UTC(2026, 9, 14, 20, 0);
    const after = await a.inject({ url: '/risk/chains?tau=0.01' });
    expect([after.json(), after.headers['x-read-cache']]).toEqual([{ n: 2 }, 'miss']);
  });

  it('a read that took over from a hung one is still waited for when the hung one ends', async () => {
    const a = Fastify();
    registerRiskReadCache(a, { joinMs: 20 });
    const gates: Array<() => void> = [];
    let n = 0;
    a.get('/risk/thing', async (_req, reply) => {
      const mine = ++n;
      await new Promise<void>((d) => gates.push(d));
      // the hung read ends in a failure, which is not kept
      return mine === 1 ? reply.code(503).send({ error: 'late' }) : { n: mine };
    });
    const first = a.inject({ url: '/risk/thing' });
    await new Promise((d) => setTimeout(d, 5));
    // the second gives up on the first after 20 ms and reads itself
    const second = a.inject({ url: '/risk/thing' });
    await new Promise((d) => setTimeout(d, 40));
    expect(n).toBe(2);
    // the first ends now, failed; the second is still the read under way
    gates[0]?.();
    await first;
    // a third arrives and waits for the second: no third read
    const third = a.inject({ url: '/risk/thing' });
    await new Promise((d) => setTimeout(d, 5));
    gates[1]?.();
    const [two, three] = await Promise.all([second, third]);
    expect(n).toBe(2);
    expect([two.json(), three.json()]).toEqual([{ n: 2 }, { n: 2 }]);
  });

  it('after a failed read the waiters share one more read, and its failure if it fails too', async () => {
    const a = Fastify();
    registerRiskReadCache(a);
    let n = 0;
    a.get('/risk/thing', async (_req, reply) => {
      n += 1;
      await new Promise((d) => setTimeout(d, 10));
      return reply.code(503).send({ error: `down ${n}` });
    });
    const all = await Promise.all(
      Array.from({ length: 6 }, () => a.inject({ url: '/risk/thing' })),
    );
    // the first read and one more, not one for each request
    expect(n).toBe(2);
    expect(all.map((r) => r.statusCode)).toEqual(Array(6).fill(503));
    expect(all.filter((r) => r.headers['x-read-cache'] === 'shared')).toHaveLength(4);
  });
});
