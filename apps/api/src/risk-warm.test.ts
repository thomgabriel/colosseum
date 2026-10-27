import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WARM_MINUTE,
  riskWarmSettings,
  startRiskWarm,
  WARM_PAGES,
  warmPass,
  withParts,
} from './risk-warm';
import { RISK_FRESH_MS, RISK_WARMED_FRESH_MS, registerRiskReadCache } from './routes/risk-cache';
import { dexAssetPath, registerRiskDexRoute } from './routes/risk-dex';

// The hourly warm (gate RISK-WARM) on stand-ins of the routes the pages read, which count their reads.
const Q = { chain: 'solana' as const, sizeUsd: 100_000, days: 30, tau: 0.01 };

async function app() {
  let t = Date.UTC(2026, 9, 27, 12, 26);
  const a = Fastify();
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  // one regime all along: the chains side by side are kept by regime
  registerRiskReadCache(a, { now: () => t, regimeOf: () => 'us_market_hours' });
  const read: string[] = [];
  a.addHook('onRequest', async (req) => {
    if (!req.headers['x-read-cache-probe']) read.push(req.url);
  });
  const ok = async () => ({ ok: 1 });
  a.get('/risk/facts/methodology', ok);
  a.get('/risk/assets', async (req) => ({
    assets: ((req.query as { chain?: string }).chain === 'robinhood'
      ? ['RRR']
      : ['AAAx', 'BBBx']
    ).map((symbol) => ({ symbol, assetMint: `MINT-${symbol}` })),
  }));
  a.get('/risk/chains', ok);
  a.get('/risk/pools/recorded', ok);
  a.get('/risk/facts/lending', ok);
  a.get('/risk/facts/assets/:id', ok);
  a.get('/risk/assets/:id/history', ok);
  a.get('/risk/pools', async () => ({ pools: [] }));
  await registerRiskDexRoute(a);
  /** How a visitor finds an address: without counting it as read. */
  const cacheOf = async (url: string) =>
    (await a.inject({ url, headers: { 'x-read-cache-probe': '1', 'user-agent': 'a browser' } }))
      .headers['x-read-cache'];
  return { a, read, cacheOf, at: (ms: number) => (t += ms) };
}

const browser = { 'user-agent': 'a browser' };

describe('the warm’s settings', () => {
  it(`runs at minute ${DEFAULT_WARM_MINUTE} by default, on what visitors asked for`, () => {
    expect(riskWarmSettings({})).toEqual({ atMinute: DEFAULT_WARM_MINUTE, all: false });
    expect(riskWarmSettings({ RISK_WARM_AT_MINUTE: '30', RISK_WARM_ALL: '1' })).toEqual({
      atMinute: 30,
      all: true,
    });
    expect(riskWarmSettings({ RISK_WARM_AT_MINUTE: 'off' })).toBeNull();
  });

  it('refuses a value it cannot read, naming the variable only', () => {
    expect(() => riskWarmSettings({ RISK_WARM_AT_MINUTE: '60' })).toThrow(/^RISK_WARM_AT_MINUTE:/);
    expect(() => riskWarmSettings({ RISK_WARM_AT_MINUTE: 'soon' })).toThrow(
      /^RISK_WARM_AT_MINUTE:/,
    );
    expect(() => riskWarmSettings({ RISK_WARM_ALL: 'yes' })).toThrow(/^RISK_WARM_ALL:/);
  });
});

describe('a warm pass', () => {
  it('reads every page’s lists again, then what visitors asked for, a batch entry after its parts', async () => {
    const { a, read } = await app();
    await a.inject({ url: '/risk/dex?ids=AAAx', headers: browser });
    read.length = 0;
    const r = await warmPass(a, { pauseMs: 1 });
    const p = withParts(dexAssetPath('AAAx', Q));
    expect(p).toEqual([
      '/risk/facts/assets/AAAx?sizeUsd=100000',
      '/risk/assets/AAAx/history?days=30&tau=0.01',
      '/risk/pools?asset=AAAx',
      dexAssetPath('AAAx', Q),
    ]);
    // every page list, then the asked-for entry's parts and the entry, each read once, in that order
    expect(read).toEqual([...WARM_PAGES, ...p]);
    expect(r).toMatchObject({ read: WARM_PAGES.length + 4, failed: 0, left: 0 });
  });

  it('counts none of its own reads as asked for: the next pass reads the pages alone', async () => {
    const { a, read } = await app();
    await a.inject({ url: '/risk/dex?ids=AAAx', headers: browser });
    await warmPass(a, { pauseMs: 1 });
    read.length = 0;
    await warmPass(a, { pauseMs: 1 });
    expect(read).toEqual([...WARM_PAGES]);
  });

  it('keeps what it read fresh past the next warm, and a visitor’s own read an hour', async () => {
    const { a, cacheOf, at } = await app();
    await a.inject({ url: '/risk/chains?tau=0.01', headers: browser });
    await a.inject({ url: '/risk/facts/assets/ZZZx?sizeUsd=1', headers: browser });
    await warmPass(a, { pauseMs: 1 });
    await a.inject({ url: '/risk/facts/assets/YYYx?sizeUsd=1', headers: browser });
    at(RISK_FRESH_MS + 60_000);
    // an hour and a minute on: the warm's answers are still fresh, a visitor's own is not
    expect(await cacheOf('/risk/chains?tau=0.01')).toBe('hit');
    expect(await cacheOf('/risk/facts/assets/ZZZx?sizeUsd=1')).toBe('hit');
    expect(await cacheOf('/risk/facts/assets/YYYx?sizeUsd=1')).toBe('stale');
    at(RISK_WARMED_FRESH_MS - RISK_FRESH_MS);
    expect(await cacheOf('/risk/chains?tau=0.01')).toBe('stale');
  });

  it('with every asset asked for, reads each listed asset’s entry, Solana’s first', async () => {
    const { a, read } = await app();
    await warmPass(a, { all: true, pauseMs: 1 });
    const entries = read.filter((u) => u.startsWith('/risk/dex/'));
    expect(entries).toEqual([
      dexAssetPath('AAAx', Q),
      dexAssetPath('BBBx', Q),
      dexAssetPath('MINT-RRR', { ...Q, chain: 'robinhood' }),
    ]);
  });

  it('waits while a visitor’s request is under way, and stops at its time limit', async () => {
    const { a, read } = await app();
    let release: () => void = () => {};
    a.get('/v1/slow', async () => {
      await new Promise<void>((d) => {
        release = d;
      });
      return { ok: 1 };
    });
    const person = a.inject({ url: '/v1/slow', headers: browser });
    await new Promise((d) => setTimeout(d, 5));
    const pass = warmPass(a, { pauseMs: 2, maxMs: 40 });
    await new Promise((d) => setTimeout(d, 20));
    expect(read.filter((u) => u.startsWith('/risk/'))).toEqual([]);
    const r = await pass;
    // it gave up behind the visitor: nothing read, every address left
    expect(r).toMatchObject({ read: 0, left: WARM_PAGES.length });
    release();
    await person;
  });
});

describe('the hourly schedule', () => {
  afterEach(() => vi.useRealTimers());

  it('runs a pass at the minute of each UTC hour, the next after the last ended, and keeps going after a failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 27, 12, 0));
    const at: string[] = [];
    let fail = true;
    const pass = vi.fn(async () => {
      at.push(new Date().toISOString().slice(11, 16));
      if (fail) {
        fail = false;
        throw new Error('database asleep');
      }
      return { read: 1, failed: 0, left: 0, ms: 0, cpuMs: 0 };
    });
    const log = { info: vi.fn(), error: vi.fn() };
    const warm = startRiskWarm(Fastify(), {}, { log, pass });
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(at).toEqual(['12:26', '13:26', '14:26']);
    expect(log.error).toHaveBeenCalledWith({ reason: 'database asleep' }, 'risk warm failed');
    warm?.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(at).toHaveLength(3);
  });

  it('is off with RISK_WARM_AT_MINUTE=off, and logs a value it cannot read', () => {
    const log = { info: vi.fn(), error: vi.fn() };
    expect(startRiskWarm(Fastify(), { RISK_WARM_AT_MINUTE: 'off' }, { log })).toBeNull();
    expect(startRiskWarm(Fastify(), { RISK_WARM_AT_MINUTE: '99' }, { log })).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
