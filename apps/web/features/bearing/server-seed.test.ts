import { describe, expect, it, vi } from 'vitest';
import { R, TAU } from './data';
import { SEED_MAX_CHARS, SEED_WAIT_MS, seedFor } from './server-seed';

// The first reads of an analytics page, made on the server so the page arrives with them: the paths
// the page itself asks, what came in time, and nothing that failed or is too large to ride in the HTML.

const API = process.env.NEXT_PUBLIC_RISK_API_URL || process.env.NEXT_PUBLIC_API_URL || '';

const assets = {
  tau: TAU,
  methodVersion: 't',
  assets: [
    { symbol: 'TSLAx', chain: 'solana', capacityAtTau: {} },
    { symbol: 'GLDx', chain: 'solana', capacityAtTau: {} },
  ],
};

/** A fetcher that answers by path, and records what it was asked. */
function api(routes: Record<string, { status?: number; body: unknown; ms?: number }>) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    asked.push(path);
    const r = routes[path];
    if (r?.ms)
      await new Promise((done, fail) => {
        const t = setTimeout(done, r.ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          fail(new Error('aborted'));
        });
      });
    return new Response(JSON.stringify(r ? r.body : { message: 'not found' }), {
      status: r ? (r.status ?? 200) : 404,
    });
  });
  return { fetcher: fetcher as unknown as typeof fetch, asked };
}

describe('the first reads of an analytics page, on the server', () => {
  it('reads the chain’s lists, and only the lending list on the lending pages', async () => {
    const { fetcher, asked } = api({
      [R.assets(TAU)]: { body: assets },
      [R.chains(TAU)]: { body: { chains: [] } },
      [R.recorded()]: { body: { pools: [] } },
      [R.lendList()]: { body: { pools: [{ account: 'P1' }] } },
    });
    const seeded = await seedFor('stablecoins', 'solana', fetcher);
    expect(seeded.map((a) => a.path).sort()).toEqual(
      [R.assets(TAU), R.chains(TAU), R.recorded(), R.lendList()].sort(),
    );
    expect(asked.every((p) => !p.startsWith('/risk/dex'))).toBe(true);
    if (API) expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(API), expect.anything());
  });

  it('reads every answer fresh: Next’s data cache would hand on one of any age', async () => {
    const { fetcher } = api({ [R.assets(TAU)]: { body: assets } });
    await seedFor('stocks', 'solana', fetcher);
    for (const [, init] of vi.mocked(fetcher).mock.calls) {
      expect(init?.cache).toBe('no-store');
      expect(init).not.toHaveProperty('next');
    }
  });

  it('reads gold’s hours on the commodities page and the first sale on the simulation, and leaves to the browser what must not ride the HTML', async () => {
    const { fetcher, asked } = api({
      [R.assets(TAU)]: { body: assets },
      [R.heatmap('GLDx', 50_000)]: { body: { cells: [] } },
      [R.sheet('TSLAx', 100_000)]: { body: {} },
      [R.split('TSLAx', 100_000)]: { body: {} },
    });
    const gold = (await seedFor('commodities', 'solana', fetcher)).map((a) => a.path);
    expect(gold).toEqual(expect.arrayContaining([R.heatmap('GLDx', 50_000)]));
    const sim = (await seedFor('simulation', 'solana', fetcher)).map((a) => a.path);
    expect(sim).toEqual(
      expect.arrayContaining([R.sheet('TSLAx', 100_000), R.split('TSLAx', 100_000)]),
    );
    // a batch answers 200 with failures inside, and the API does not keep a recoverable value
    expect(asked.some((p) => p.startsWith('/risk/dex'))).toBe(false);
    expect(asked.some((p) => p.startsWith('/risk/recoverable'))).toBe(false);
  });

  it('hands on nothing that failed, nothing too large, and stops waiting after its time', async () => {
    const { fetcher } = api({
      [R.assets(TAU)]: { body: assets },
      [R.chains(TAU)]: { status: 503, body: { error: 'busy' } },
      [R.recorded()]: { body: { pools: 'x'.repeat(SEED_MAX_CHARS + 1) } },
    });
    const seeded = await seedFor('stocks', 'solana', fetcher);
    expect(seeded.map((a) => a.path)).toEqual([R.assets(TAU)]);

    const slow = api({ [R.assets(TAU)]: { body: assets, ms: SEED_WAIT_MS + 500 } });
    const started = Date.now();
    expect(await seedFor('stocks', 'solana', slow.fetcher)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(SEED_WAIT_MS + 400);
  });

  it('on Robinhood Chain reads its own list, and no recorded or lending pools', async () => {
    const { fetcher, asked } = api({
      [R.assets(TAU, 'robinhood')]: { body: { ...assets, assets: [] } },
    });
    await seedFor('lending', 'robinhood', fetcher);
    expect(asked.sort()).toEqual([R.assets(TAU, 'robinhood'), R.chains(TAU)].sort());
  });
});
