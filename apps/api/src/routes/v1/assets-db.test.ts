import { randomInt } from 'node:crypto';
import { assetObservations, marketBars } from '@colosseum/db';
import type { BasketAsset } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbLookupReads } from '../../asset-lookups';
import type { ChainRegistry } from '../../orders/chains';
import { testApp, testDb } from '../../testing/harness';
import { AssetFactsResponse } from './assets';

// GET /v1/assets/{id}/facts through the whole app, its server reader and a real Postgres: rows written
// here under a token address made for this run, read back as facts, and deleted after. Runs where a
// database is (CI); skipped on a machine with none.

const DB = Boolean(process.env.CI || process.env.DATABASE_URL);
vi.setConfig({ testTimeout: 60_000 });

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const address = `Lkp${Array.from({ length: 41 }, () => BASE58[randomInt(BASE58.length)]).join('')}`;
const slug = `lookups-${address.slice(3, 11).toLowerCase()}`;
const id = `solana:${slug}`;
const POOL_A = `PoA${address.slice(3)}`;
const POOL_B = `PoB${address.slice(3)}`;
// another token of the chain, whose bars say the chain's collector ran in hours this one has none
const OTHER = `Oth${address.slice(3)}`;

/** The chain's catalog with one more token, the one this test writes rows for; `live` drops the mock. */
const withToken =
  (live: boolean) =>
  (inner: ChainRegistry): ChainRegistry => {
    const add = (entry: ReturnType<ChainRegistry['get']>) => {
      if (entry.chain !== 'solana') return entry;
      return {
        ...entry,
        ...(live ? { provenance: 'live' as const, mock: undefined } : {}),
        adapter: {
          ...entry.adapter,
          listAssets: async () => {
            const listed = await entry.adapter.listAssets();
            const stock = listed.find((a) => a.cls === 'stock') as BasketAsset;
            const token: BasketAsset = {
              ...stock,
              id,
              symbol: 'LKPx',
              address,
              provenance: 'live',
            };
            return [...listed, token];
          },
        },
      };
    };
    return {
      ...inner,
      get: (chain) => add(inner.get(chain)),
      active: () => inner.active().map(add),
    };
  };

describe.skipIf(!DB)('the facts of one asset, from the database', () => {
  let data: Awaited<ReturnType<typeof testDb>>;
  let mock: FastifyInstance;
  let live: FastifyInstance;
  const now = Date.now();
  const hour = (back: number) =>
    new Date(Math.floor(now / 3_600_000) * 3_600_000 - back * 3_600_000);
  const pin = {
    methodVersion: 'test-0.1',
    source: 'assets-db.test.ts rows',
    method: 'written by the test',
    fetchedAt: new Date(now - 60_000),
    provenance: 'live' as const,
  };

  beforeAll(async () => {
    data = await testDb();
    await data.db.insert(assetObservations).values([
      {
        chain: 'solana',
        address,
        metric: 'supply_total',
        value: 1_234_567.5,
        unit: 'tokens',
        observedAt: new Date(now - 10 * 60_000),
        ...pin,
      },
      {
        chain: 'solana',
        address,
        metric: 'holders_top20_share',
        value: null,
        nullReason: 'rpc_method_unavailable',
        unit: 'fraction',
        observedAt: new Date(now - 10 * 60_000),
        ...pin,
      },
      {
        chain: 'solana',
        address,
        metric: 'pool_tvl_usd',
        value: 1_000_000,
        unit: 'usd',
        // older than three hours: served with its age
        observedAt: new Date(now - 5 * 3_600_000),
        detail: {
          pools: [
            { address: POOL_A, venue: 'orca_whirlpool', tvlUsd: 750_000 },
            { address: POOL_B, venue: 'uniswap-v4', tvlUsd: 250_000 },
          ],
        },
        ...pin,
      },
    ]);
    // Thirty hours of the token across its pools, and of its largest pool: the last day is covered,
    // the last week is not.
    const rows = Array.from({ length: 30 }, (_, back) => back).flatMap((back) => {
      const bar = {
        chain: 'solana',
        address,
        hour: hour(back),
        closeUsd: 100 + back,
        highUsd: 101 + back,
        lowUsd: 99 + back,
        swaps: 10,
        buySwaps: 6,
        sellSwaps: 4,
        unpricedSwaps: 0,
        volumeTokens: 50,
        volumeUsd: 5_000,
        buyVolumeUsd: 3_000,
        sellVolumeUsd: 2_000,
        quoteUsdMethod: 'usdc_at_par',
        ...pin,
      };
      return [
        { ...bar, pool: 'asset' },
        { ...bar, pool: POOL_A, volumeUsd: 4_000, buyVolumeUsd: 2_400, sellVolumeUsd: 1_600 },
      ];
    });
    await data.db.insert(marketBars).values(rows);
    await data.db.insert(marketBars).values(
      [40, 41].map((back) => ({
        chain: 'solana',
        address: OTHER,
        pool: 'asset',
        hour: hour(back),
        closeUsd: 1,
        highUsd: 1,
        lowUsd: 1,
        swaps: 1,
        buySwaps: 1,
        sellSwaps: 0,
        unpricedSwaps: 0,
        volumeTokens: 1,
        volumeUsd: 1,
        buyVolumeUsd: 1,
        sellVolumeUsd: 0,
        quoteUsdMethod: 'usdc_at_par',
        ...pin,
      })),
    );
    ({ app: mock } = await testApp({ issuer: null, db: data.db, wrap: withToken(false) }));
    ({ app: live } = await testApp({ issuer: null, db: data.db, wrap: withToken(true) }));
  });
  afterAll(async () => {
    await mock?.close();
    await live?.close();
    if (data) {
      await data.db.delete(assetObservations).where(eq(assetObservations.address, address));
      await data.db.delete(marketBars).where(eq(marketBars.address, address));
      await data.db.delete(marketBars).where(eq(marketBars.address, OTHER));
      await data.cleanUp();
    }
  });

  const get = async (app: FastifyInstance, url: string) => {
    // the first ask may find a read still running: it answers `reading`, and the next finds it kept
    for (let tries = 0; ; tries += 1) {
      const res = await app.inject({ method: 'GET', url });
      if (res.statusCode !== 200) return res;
      const body = AssetFactsResponse.parse(res.json());
      if (tries > 20 || !Object.values(body.parts).some((part) => part?.unread === 'reading'))
        return res;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  it('answers the profile, the day of bars and the pools, as live on a live chain', async () => {
    const res = await get(
      live,
      `/v1/assets/${id}/facts?parts=profile,price_history,pools&window=24h`,
    );
    expect(res.statusCode).toBe(200);
    const body = AssetFactsResponse.parse(res.json());
    expect(body).toMatchObject({ assetId: id, chain: 'solana', provenance: 'live', window: '24h' });
    expect(Object.keys(body.parts).sort()).toEqual(['pools', 'price_history', 'profile']);
    const facts = new Map(
      Object.values(body.parts).flatMap((part) => part?.facts.map((f) => [f.id, f]) ?? []),
    );
    expect(facts.get(`profile:${id}:supply_total`)).toMatchObject({
      value: 1_234_567.5,
      unit: 'tokens',
      provenance: 'live',
      method: 'written by the test (test-0.1)',
    });
    expect(facts.get(`profile:${id}:pool_tvl_usd`)?.staleAgeSec).toBeGreaterThan(5 * 3_600 - 120);
    expect(body.parts.profile?.missing).toEqual([
      expect.objectContaining({ id: `profile:${id}:holders_top20_share`, reason: 'not_collected' }),
    ]);
    // the bars of the current hour and the 23 before it: close is the newest, the change first to last
    expect(facts.get(`bars:${id}:24h:close`)).toMatchObject({ value: 100, unit: 'USD' });
    expect(facts.get(`bars:${id}:24h:high`)?.value).toBe(124);
    expect(facts.get(`bars:${id}:24h:change`)?.value).toBeCloseTo((100 - 123) / 123, 12);
    expect(facts.get(`bars:${id}:24h:swaps`)?.value).toBe(240);
    expect(facts.get(`bars:${id}:24h:gaps`)?.value).toBe(0);
    expect(facts.get(`pool:${id}:1:tvl`)).toMatchObject({ value: 750_000, unit: 'USD' });
    expect(facts.get(`pool:${id}:1:share`)?.value).toBe(0.75);
    expect(facts.get(`pool:${id}:1:volume`)?.value).toBe(24 * 4_000);
    // the second pool has no bars: its volume is not collected, never zero
    expect(body.parts.pools?.missing).toEqual([
      expect.objectContaining({ id: `pool:${id}:2:volume`, reason: 'not_collected' }),
    ]);
    for (const part of Object.values(body.parts))
      for (const item of [...(part?.facts ?? []), ...(part?.missing ?? [])])
        expect(/\p{N}/u.test(item.label)).toBe(false);
  });

  it('labels every fact mock on a chain on the mock; a week the bars do not reach is not collected', async () => {
    const res = await get(mock, `/v1/assets/${id}/facts`);
    expect(res.statusCode).toBe(200);
    const body = AssetFactsResponse.parse(res.json());
    expect(body.provenance).toBe('mock');
    expect(body.window).toBe('7d');
    expect(Object.keys(body.parts).sort()).toEqual([
      'bearing',
      'lending',
      'pools',
      'price_history',
      'profile',
    ]);
    const all = Object.values(body.parts).flatMap((part) => part?.facts ?? []);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((fact) => fact.provenance === 'mock')).toBe(true);
    expect(body.parts.price_history?.facts).toEqual([]);
    const gap = body.parts.price_history?.missing ?? [];
    expect(gap).toHaveLength(9);
    expect(gap.every((m) => m.reason === 'not_collected' && (m.missingHours ?? 0) >= 138)).toBe(
      true,
    );
    expect(body.parts.lending).toEqual({ facts: [], missing: [], modelledOn: null });
    expect(body.disclaimer.length).toBeGreaterThan(0);
  });

  it("reads the hours the chain's collector ran: any asset's bar, not only this token's", async () => {
    const read = await dbLookupReads.bars(data.db, 'solana', address, hour(48));
    expect(read.rows).toHaveLength(30);
    expect(read.before).toBeNull();
    // this token's thirty hours, and the two of the other token's, before them
    for (const back of [0, 29, 40, 41]) expect(read.chainHours).toContain(hour(back).toISOString());
    expect(read.chainHours.every((at) => Date.parse(at) >= hour(48).getTime())).toBe(true);
    expect(new Set(read.chainHours).size).toBe(read.chainHours.length);
  });

  it('a cash token has no facts; an unknown id is a 404; an unknown part a 400', async () => {
    const res = await get(mock, '/v1/assets/solana:usdc/facts?parts=profile');
    expect(res.statusCode).toBe(200);
    expect(AssetFactsResponse.parse(res.json()).parts).toEqual({
      profile: { facts: [], missing: [], modelledOn: null },
    });
    expect(
      (await mock.inject({ method: 'GET', url: '/v1/assets/solana:nothing/facts' })).statusCode,
    ).toBe(404);
    expect(
      (await mock.inject({ method: 'GET', url: '/v1/assets/base:thing/facts' })).statusCode,
    ).toBe(404);
    expect(
      (await mock.inject({ method: 'GET', url: `/v1/assets/${id}/facts?parts=screener` }))
        .statusCode,
    ).toBe(400);
  });
});
