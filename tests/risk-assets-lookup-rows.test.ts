// What the hosted database keeps of the bars: only what the asset lookups read (scripts/risk/assets/lookup-rows.ts),
// and the guard of the one copy into it (scripts/ops/copy-token-bars.ts).
import { assetObservations, createDb, marketBars } from '@colosseum/db';
import { MAX_POOLS, topPools } from '@colosseum/risk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addedBytes, budgetRefusal } from '../scripts/ops/copy-token-bars';
import type { BarRow } from '../scripts/risk/assets/bars-rows';
import {
  dropOldPoolBars,
  lookupRows,
  POOL_BAR_HOURS,
  readTopPools,
} from '../scripts/risk/assets/lookup-rows';

const H = 3_600_000;
const now = Date.parse('2026-10-21T12:00:00Z');
const bar = (address: string, pool: string, hoursAgo: number, source = 'held'): BarRow => ({
  chain: 'robinhood',
  address,
  pool,
  hour: new Date(now - hoursAgo * H),
  quoteAddress: null,
  swaps: 1,
  buySwaps: 1,
  sellSwaps: 0,
  // no dollar figure, so every swap is unpriced (market_bars_priced)
  unpricedSwaps: 1,
  volumeTokens: 1,
  detail: { weight: 'heavy' },
  methodVersion: 'bars-0.1',
  source,
  method: 'test',
  fetchedAt: new Date(now),
  provenance: 'live',
});

describe('the bars the lookups read', () => {
  const top = new Map([['0xtoken', new Set(['0xpool1'])]]);
  const rows = [
    bar('0xtoken', 'asset', 1),
    bar('0xtoken', 'asset', 100),
    bar('0xtoken', '0xpool1', 1),
    bar('0xtoken', '0xpool1', 60),
    bar('0xtoken', '0xpool9', 1),
    bar('0xother', '0xpool1', 1),
  ];

  it('keeps the token rows since the start and the top pools’ rows of the last two days, with no detail', () => {
    const kept = lookupRows(rows, top, {
      since: new Date(now - 72 * H),
      poolSince: new Date(now - POOL_BAR_HOURS * H),
    });
    expect(kept.map((r) => [r.address, r.pool, (now - (r.hour as Date).getTime()) / H])).toEqual([
      ['0xtoken', 'asset', 1],
      ['0xtoken', '0xpool1', 1],
    ]);
    expect(kept.every((r) => JSON.stringify(r.detail) === '{}')).toBe(true);
    // the rows it was handed are left as they were
    expect(rows[0]?.detail).toEqual({ weight: 'heavy' });
  });

  it('chooses the pools as the lookups do: by dollars held, at most five, a pool with no TVL left out', () => {
    const pools = Array.from({ length: 7 }, (_, i) => ({
      address: `0x${i}`,
      venue: 'v3',
      tvlUsd: i * 10,
    }));
    const chosen = topPools({ pools: [...pools, { address: '0xnone', tvlUsd: null }] });
    expect(chosen).toHaveLength(MAX_POOLS);
    expect(chosen.map((p) => p.address)).toEqual(['0x6', '0x5', '0x4', '0x3', '0x2']);
    expect(topPools(null)).toEqual([]);
    expect(topPools({ pools: 'not a list' })).toEqual([]);
  });
});

describe('the copy into the hosted database', () => {
  it('counts the indexes in what a copy adds, and refuses one that would pass the ceiling', () => {
    const plans = [{ chain: 'solana', rows: 10, bytes: 80 * 1024 ** 2, onTarget: 0 }];
    expect(addedBytes(plans)).toBe(100 * 1024 ** 2);
    expect(budgetRefusal(700 * 1024 ** 2, addedBytes(plans), 900)).toBeNull();
    expect(budgetRefusal(850 * 1024 ** 2, addedBytes(plans), 900)).toMatch(/past --max-mb 900/);
  });
});

describe('the hosted bars job on a database', () => {
  const { db, client } = createDb();
  const chain = `test-${process.pid}`;
  const fixed = new Date(now);

  beforeAll(async () => {
    await db.insert(assetObservations).values([
      {
        chain,
        address: '0xtoken',
        metric: 'pool_tvl_usd',
        value: 100,
        unit: 'usd',
        observedAt: new Date(now - 2 * H),
        detail: { pools: [{ address: '0xold', tvlUsd: 99 }] },
        methodVersion: 'test',
        source: 'test',
        method: 'test',
        fetchedAt: fixed,
        provenance: 'live',
      },
      {
        chain,
        address: '0xtoken',
        metric: 'pool_tvl_usd',
        value: 100,
        unit: 'usd',
        observedAt: new Date(now - H),
        detail: {
          pools: [
            { address: '0xpool1', tvlUsd: 60 },
            { address: '0xpool2', tvlUsd: 40 },
          ],
        },
        methodVersion: 'test',
        source: 'test',
        method: 'test',
        fetchedAt: fixed,
        provenance: 'live',
      },
    ]);
    await db.insert(marketBars).values([
      { ...bar('0xtoken', '0xpool1', 100), chain },
      { ...bar('0xtoken', '0xpool1', 1), chain },
      { ...bar('0xtoken', 'asset', 100), chain },
      {
        ...bar(
          '0xtoken',
          '0xpool2',
          100,
          '<ASSETS_DATA_DIR>/robinhood/swaps/0xpool2/2026-10-17.jsonl.gz',
        ),
        chain,
      },
    ]);
  });
  afterAll(async () => {
    await db.delete(marketBars).where(eq(marketBars.chain, chain));
    await db.delete(assetObservations).where(eq(assetObservations.chain, chain));
    await client.end();
  });

  it('reads each token’s top pools from its newest reading', async () => {
    const top = await readTopPools(db, chain);
    expect([...(top.get('0xtoken') ?? [])]).toEqual(['0xpool1', '0xpool2']);
  });

  it('drops the old pool bars of the held history, never a token bar or a backfill row', async () => {
    const dropped = await dropOldPoolBars(db, chain, new Date(now - POOL_BAR_HOURS * H));
    expect(dropped).toBe(1);
    const left = await db
      .select({ pool: marketBars.pool, hour: marketBars.hour })
      .from(marketBars)
      .where(eq(marketBars.chain, chain))
      .orderBy(marketBars.pool, marketBars.hour);
    expect(left.map((r) => [r.pool, (now - r.hour.getTime()) / H])).toEqual([
      ['0xpool1', 1],
      ['0xpool2', 100],
      ['asset', 100],
    ]);
  });
});
