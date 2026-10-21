// Solana's hourly token bars from the pool collector's mid prices (gate HOURLY-BARS): the rule (one USDC pool an
// hour, the deepest, never blended), the API's answer from them (prices yes, volume never), one bar an hour where a
// swap-built bar and a mid bar meet, and the rows on a database (the table's checks, the upsert).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, marketBars, riskPoolSnapshots, riskPools } from '@colosseum/db';
import {
  type AssetFigure,
  BAR_KEYS,
  type BarRow,
  isMidsVersion,
  MIDS_METHOD_VERSION,
  type MidPool,
  type MidSnapshot,
  midBars,
  oneAnHour,
  preferredBar,
  priceHistoryFigures,
  SWAP_ONLY_KEYS,
  USDC_MINT,
} from '@colosseum/risk';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { dbLookupReads, priceHistoryAnswer } from '../../apps/api/src/asset-lookups';
import { midBarHours, readMidSnapshots, upsertMidBars } from '../../scripts/risk/assets/mid-bars';

const H = 3_600_000;
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenMint1111111111111111111111111111111111';
const pools: MidPool[] = [
  { address: 'deep', assetMint: TOKEN, quoteMint: USDC_MINT, venue: 'raydium_clmm' },
  { address: 'thin', assetMint: TOKEN, quoteMint: USDC_MINT, venue: 'orca_whirlpool' },
  { address: 'solpool', assetMint: TOKEN, quoteMint: SOL, venue: 'meteora_dlmm' },
];
const t = (iso: string) => new Date(iso);
const snap = (
  pool: string,
  at: string,
  midPrice: number,
  inBandLiquidity: number | null,
  provenance: MidSnapshot['provenance'] = 'live',
): MidSnapshot => ({
  pool,
  fetchedAt: t(at),
  midPrice,
  inBandLiquidity,
  methodVersion: 'pools-0.1',
  provenance,
});
const HOURS = { from: t('2026-10-21T10:00:00Z'), to: t('2026-10-21T12:00:00Z') };

describe('mid bars: the rule', () => {
  // out of order on purpose: open and close are by time, not by the order handed in
  const snaps = [
    snap('deep', '2026-10-21T10:55:00Z', 101, 90_000),
    snap('deep', '2026-10-21T10:05:00Z', 100, 100_000),
    snap('deep', '2026-10-21T10:30:00Z', 104, 95_000),
    snap('thin', '2026-10-21T10:10:00Z', 500, 1_000),
    snap('thin', '2026-10-21T10:40:00Z', 1, 2_000),
    // the SOL pool is deeper still, but its quote has no dollar price in a snapshot: never read
    snap('solpool', '2026-10-21T10:20:00Z', 0.5, 9_000_000),
    // 11:00: the thin pool is now the deeper one by its median over the hour
    snap('deep', '2026-10-21T11:05:00Z', 102, 500),
    snap('deep', '2026-10-21T11:35:00Z', 103, 600),
    snap('thin', '2026-10-21T11:15:00Z', 99, 5_000, 'sandbox'),
    snap('thin', '2026-10-21T11:45:00Z', 98, 6_000),
    // outside the hours, and a mid that is not a price
    snap('deep', '2026-10-21T12:00:00Z', 200, 100_000),
    snap('deep', '2026-10-21T09:59:59Z', 200, 100_000),
    snap('thin', '2026-10-21T11:50:00Z', 0, 7_000),
    snap('thin', '2026-10-21T11:51:00Z', Number.NaN, 7_000),
  ];
  const bars = midBars(snaps, pools, HOURS);

  it('one bar a token and hour, from its deepest USDC pool by the median 2% depth, never blended', () => {
    expect(bars.map((b) => [b.hour.toISOString(), b.detail.pool])).toEqual([
      ['2026-10-21T10:00:00.000Z', 'deep'],
      ['2026-10-21T11:00:00.000Z', 'thin'],
    ]);
    const [ten, eleven] = bars;
    // the thin pool's marks (500, 1) are not in the deep pool's bar
    expect(ten).toMatchObject({ openUsd: 100, closeUsd: 101, highUsd: 104, lowUsd: 100 });
    expect(ten?.detail).toMatchObject({
      snapshots: 3,
      depth2pctUsd: 95_000,
      poolsWithSnapshots: 2,
    });
    expect(eleven).toMatchObject({ openUsd: 99, closeUsd: 98, highUsd: 99, lowUsd: 98 });
    // the worst label of the snapshots read: a sandbox snapshot is never served as live
    expect(eleven?.provenance).toBe('sandbox');
    expect(ten?.fetchedAt.toISOString()).toBe('2026-10-21T10:55:00.000Z');
  });

  it('labels itself as mids: its own version, method and source; no swap, no volume', () => {
    for (const b of bars) {
      expect(b).toMatchObject({
        pool: 'asset',
        methodVersion: MIDS_METHOD_VERSION,
        quoteUsdMethod: 'usdc_at_par',
        swaps: 0,
        buySwaps: 0,
        sellSwaps: 0,
        unpricedSwaps: 0,
        volumeUsd: null,
        buyVolumeUsd: null,
        sellVolumeUsd: null,
        vwapUsd: null,
        closeQuote: null,
      });
      expect(b.method).toMatch(/mid price/u);
      expect(b.method).toMatch(/never blended/u);
      expect(b.source).toMatch(/^risk_pool_snapshots\.mid_price of the USDC pool /u);
    }
    expect(isMidsVersion(MIDS_METHOD_VERSION)).toBe(true);
    expect(isMidsVersion('bars-0.1')).toBe(false);
  });

  it('a pool with no depth measured ranks after one with, then by address', () => {
    const b = midBars(
      [snap('thin', '2026-10-21T10:10:00Z', 5, null), snap('deep', '2026-10-21T10:10:00Z', 6, 1)],
      pools,
      HOURS,
    );
    expect(b.map((x) => x.detail.pool)).toEqual(['deep']);
    const tie = midBars(
      [snap('thin', '2026-10-21T10:10:00Z', 5, 1), snap('deep', '2026-10-21T10:10:00Z', 6, 1)],
      pools,
      HOURS,
    );
    expect(tie.map((x) => x.detail.pool)).toEqual(['deep']);
  });

  it('the hours a run rebuilds: the complete hours before the current one', () => {
    const h = midBarHours(t('2026-10-21T15:19:00Z'), 6);
    expect([h.from.toISOString(), h.to.toISOString()]).toEqual([
      '2026-10-21T09:00:00.000Z',
      '2026-10-21T15:00:00.000Z',
    ]);
  });
});

// ------------------------------------------------------------------------------------------- the API's answer

const now = t('2026-10-21T15:19:00Z');
const windowHours = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Math.floor(now.getTime() / H) * H - (n - i) * H).toISOString(),
  );
const asRow = (b: ReturnType<typeof midBars>[number]): BarRow => ({
  hour: b.hour.toISOString(),
  closeUsd: b.closeUsd,
  highUsd: b.highUsd,
  lowUsd: b.lowUsd,
  swaps: b.swaps,
  volumeUsd: b.volumeUsd,
  buyVolumeUsd: b.buyVolumeUsd,
  sellVolumeUsd: b.sellVolumeUsd,
  quoteUsdMethod: b.quoteUsdMethod,
  methodVersion: b.methodVersion,
  source: b.source,
  method: b.method,
  fetchedAt: b.fetchedAt.toISOString(),
  provenance: b.provenance,
});
/** A mid bar of each of the 24 hours before now's: $100 rising a dollar an hour. */
const midRows: BarRow[] = midBars(
  windowHours(24).map((hour, i) =>
    snap('deep', hour.replace(':00:00.000Z', ':10:00.000Z'), 100 + i, 1_000),
  ),
  pools,
  { from: t(windowHours(24)[0] as string), to: t('2026-10-21T15:00:00Z') },
).map(asRow);
const swapRow = (hour: string, close: number): BarRow => ({
  hour,
  closeUsd: close,
  highUsd: close,
  lowUsd: close,
  swaps: 3,
  volumeUsd: 300,
  buyVolumeUsd: 100,
  sellVolumeUsd: 200,
  quoteUsdMethod: 'usdc_at_par',
  methodVersion: 'bars-0.1',
  source: 'held swaps',
  method: 'hourly bars of the pool swaps',
  fetchedAt: hour,
  provenance: 'live',
});
const byKey = (figures: AssetFigure[]) => new Map(figures.map((f) => [f.key, f]));
const before = '2026-10-01T00:00:00.000Z';

describe('mid bars in the API: prices answered, volume never', () => {
  it('a window of mid bars answers close, high, low and change, and every swap figure not collected', () => {
    const figures = byKey(priceHistoryFigures(midRows, before, '24h', now, windowHours(24)));
    expect([...figures.keys()]).toEqual([...BAR_KEYS]);
    // the window is 16:00 yesterday to 14:00 today: the first mid bar (15:00 yesterday) is before it
    expect(figures.get('close')).toMatchObject({ value: 123, unit: 'usd' });
    expect(figures.get('high')?.value).toBe(123);
    expect(figures.get('low')?.value).toBe(101);
    expect(figures.get('change')?.value).toBeCloseTo((123 - 101) / 101, 12);
    for (const key of ['close', 'high', 'low', 'change']) {
      const f = figures.get(key) as AssetFigure & { source: string; method: string };
      expect(f.source).toMatch(
        /^market_bars \(the pool collector's mid prices; risk_pool_snapshots/u,
      );
      expect(f.method).toMatch(/mids-0\.1/u);
      expect(f.method).toMatch(/mid price/u);
    }
    for (const key of SWAP_ONLY_KEYS)
      expect(figures.get(key)).toEqual({ key, value: null, reason: 'not_collected' });
  });

  it('a window of swap bars with mid bars after them: prices from both, the swap figures not collected', () => {
    const rows = [
      ...windowHours(24)
        .slice(0, 12)
        .map((h) => swapRow(h, 50)),
      ...midRows.slice(13),
    ];
    const figures = byKey(priceHistoryFigures(rows, before, '24h', now, windowHours(24)));
    expect(figures.get('low')?.value).toBe(50);
    expect(figures.get('close')?.value).toBe(123);
    expect((figures.get('high') as { source: string }).source).toMatch(
      /DEX swaps, and the pool collector's mid prices where no swap was collected/u,
    );
    for (const key of SWAP_ONLY_KEYS) expect(figures.get(key)?.value).toBeNull();
  });

  it('one bar an hour: a swap-built bar wins over a mid bar of the same hour, whichever comes first', () => {
    const swaps = windowHours(24).map((h) => swapRow(h, 7));
    for (const rows of [
      [...midRows, ...swaps],
      [...swaps, ...midRows],
    ]) {
      const kept = oneAnHour(rows);
      expect(kept.every((r) => r.methodVersion === 'bars-0.1')).toBe(true);
      expect(new Set(kept.map((r) => r.hour)).size).toBe(kept.length);
      const figures = byKey(priceHistoryFigures(rows, before, '24h', now, windowHours(24)));
      // the mids are not counted: the volume is the swap bars' alone, served
      expect(figures.get('close')?.value).toBe(7);
      expect(figures.get('volume')?.value).toBe(23 * 300);
      expect(figures.get('swaps')?.value).toBe(23 * 3);
    }
    // a later mids version does not beat a swap bar; between two of a kind, the later version
    const a = { methodVersion: 'bars-0.1' };
    expect(preferredBar(a, { methodVersion: 'mids-0.9' })).toBe(a);
    expect(preferredBar({ methodVersion: 'mids-0.9' }, a)).toBe(a);
    const m2 = { methodVersion: 'mids-0.2' };
    expect(preferredBar({ methodVersion: 'mids-0.1' }, m2)).toBe(m2);
  });

  it('the labels say where the prices of a mids window come from; a swap window keeps its own', () => {
    const read = { rows: midRows, before, chainHours: windowHours(24) };
    const answer = priceHistoryAnswer('solana:tslax', read, '24h', now);
    const close = answer.facts.find((f) => f.id.endsWith(':close'));
    expect(close?.label).toMatch(/mid price of its deepest USDC pool where no swap was collected/u);
    expect(answer.missing.map((m) => m.id.split(':').at(-1))).toEqual([...SWAP_ONLY_KEYS]);
    expect(answer.missing.every((m) => m.reason === 'not_collected')).toBe(true);
    const swaps = windowHours(24).map((h) => swapRow(h, 7));
    const plain = priceHistoryAnswer('solana:tslax', { ...read, rows: swaps }, '24h', now);
    expect(plain.facts.find((f) => f.id.endsWith(':close'))?.label).toBe(
      "Latest hourly closing price in dollars across the asset's DEX pools, in the last day",
    );
    expect(plain.missing).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------- on a database

describe('mid bars on a database', () => {
  const { db, client } = createDb();
  const chain = `test-mids-${process.pid}`;
  const poolA = `test-mid-pool-a-${process.pid}`;
  const poolB = `test-mid-pool-b-${process.pid}`;
  const mint = `test-mid-token-${process.pid}`;

  afterAll(async () => {
    await db.delete(marketBars).where(eq(marketBars.chain, chain));
    await db.delete(riskPoolSnapshots).where(inArray(riskPoolSnapshots.pool, [poolA, poolB]));
    await db.delete(riskPools).where(inArray(riskPools.address, [poolA, poolB]));
    await client.end();
  });

  it('writes rows the table takes (its checks), rebuilds them in place, never touches a swap-built bar', async () => {
    const reg = {
      program: 'test',
      assetMint: mint,
      assetSymbol: 'TESTx',
      quoteMint: USDC_MINT,
      quoteSymbol: 'USDC',
      exitPath: 'direct_usd',
      assetIsToken0: 1,
      decimals0: 8,
      decimals1: 6,
      tier: 'A',
      status: 'confirmed',
      methodVersion: 'test',
      source: 'test',
      method: 'test',
      fetchedAt: now,
      provenance: 'live' as const,
    };
    await db.insert(riskPools).values([
      { ...reg, address: poolA, venue: 'raydium_clmm' },
      { ...reg, address: poolB, venue: 'orca_whirlpool', quoteMint: SOL, quoteSymbol: 'SOL' },
    ]);
    const hours = midBarHours(now, 3);
    const snapRow = (pool: string, at: number, mid: number) => ({
      pool,
      fetchedAt: new Date(at),
      midPrice: mid,
      sell: [],
      buy: [],
      inBandLiquidity: 10_000,
      methodVersion: 'pools-0.1',
      source: 'test',
      method: 'test',
      provenance: 'live' as const,
    });
    await db
      .insert(riskPoolSnapshots)
      .values([
        snapRow(poolA, hours.from.getTime() + 5 * 60_000, 10),
        snapRow(poolA, hours.from.getTime() + 50 * 60_000, 12),
        snapRow(poolA, hours.from.getTime() + H + 5 * 60_000, 11),
        snapRow(poolA, hours.from.getTime() + 2 * H + 5 * 60_000, 13),
        snapRow(poolB, hours.from.getTime() + 5 * 60_000, 99),
      ]);
    const read = await readMidSnapshots(db, hours);
    const mine = read.snapshots.filter((s) => s.pool === poolA || s.pool === poolB);
    // the SOL pool's snapshot is not read at all
    expect(mine.map((s) => s.pool)).toEqual([poolA, poolA, poolA, poolA]);
    const bars = midBars(read.snapshots, read.pools, hours).filter((b) => b.address === mint);
    expect(bars.map((b) => b.closeUsd)).toEqual([12, 11, 13]);
    // a swap-built bar of the first hour, as the backfill or the held history writes it
    await db.insert(marketBars).values({
      ...swapRowDb(chain, mint, hours.from),
    });
    expect(await upsertMidBars(db, bars, chain)).toBe(3);
    // a later run over the same hours replaces its own rows, and only them
    expect(
      await upsertMidBars(
        db,
        bars.map((b) => ({ ...b, closeUsd: (b.closeUsd as number) + 1 })),
        chain,
      ),
    ).toBe(3);
    const stored = await db
      .select()
      .from(marketBars)
      .where(and(eq(marketBars.chain, chain), eq(marketBars.address, mint)))
      .orderBy(marketBars.hour, marketBars.methodVersion);
    expect(stored.map((r) => [r.methodVersion, r.closeUsd])).toEqual([
      ['bars-0.1', 7],
      [MIDS_METHOD_VERSION, 13],
      [MIDS_METHOD_VERSION, 12],
      [MIDS_METHOD_VERSION, 14],
    ]);
    // the lookups read both rows of the first hour and keep the swap-built one
    const got = await dbLookupReads.bars(db, chain, mint, hours.from);
    expect(got.rows).toHaveLength(4);
    const kept = oneAnHour(got.rows);
    expect(kept.map((r) => r.methodVersion)).toEqual([
      'bars-0.1',
      MIDS_METHOD_VERSION,
      MIDS_METHOD_VERSION,
    ]);
  });

  it('the table refuses a mid bar that claims a volume (market_bars_priced)', async () => {
    const hours = midBarHours(now, 1);
    const [bar] = midBars(
      [snap('deep', new Date(hours.from.getTime() + 60_000).toISOString(), 5, 1)],
      pools,
      hours,
    );
    await expect(
      upsertMidBars(
        db,
        [{ ...(bar as NonNullable<typeof bar>), address: mint, volumeUsd: 5 } as never],
        chain,
      ),
    ).rejects.toThrow();
  });
});

function swapRowDb(chain: string, address: string, hour: Date) {
  return {
    chain,
    address,
    pool: 'asset',
    hour,
    quoteAddress: null,
    openUsd: 7,
    highUsd: 7,
    lowUsd: 7,
    closeUsd: 7,
    vwapUsd: 7,
    swaps: 1,
    buySwaps: 1,
    sellSwaps: 0,
    unpricedSwaps: 0,
    volumeTokens: 1,
    volumeUsd: 7,
    buyVolumeUsd: 7,
    sellVolumeUsd: 0,
    quoteUsdMethod: 'usdc_at_par',
    detail: {},
    methodVersion: 'bars-0.1',
    source: 'test',
    method: 'test',
    fetchedAt: hour,
    provenance: 'live' as const,
  };
}

// keep the fixture reader in use for the shape check of a stored bar (fixtures/risk/assets/lookups)
const fixtureBar = (
  JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/risk/assets/lookups/nvdax-bars.json'), 'utf8'),
  ) as { bars: BarRow[] }
).bars[0] as BarRow;
describe('a mid bar row has the shape of a stored bar the lookups read', () => {
  it('the same keys', () => {
    expect(
      Object.keys(
        asRow(midBars([snap('deep', '2026-10-21T10:10:00Z', 1, 1)], pools, HOURS)[0] as never),
      ).sort(),
    ).toEqual(Object.keys(fixtureBar).sort());
  });
});
