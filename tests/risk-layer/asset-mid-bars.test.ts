// Solana's hourly token bars from the pool collector's mid prices (gate HOURLY-BARS): the rule (one USDC pool an
// hour, the deepest, never blended), the API's answer from them (prices yes, volume never), one bar an hour where a
// swap-built bar and a mid bar meet, and the rows on a database (the table's checks, the upsert).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, marketBars, riskPoolSnapshots, riskPools } from '@colosseum/db';
import {
  type AssetFigure,
  BAR_KEYS,
  type BarRow,
  isMidsVersion,
  MIDS_METHOD_VERSION,
  type MidBar,
  type MidPool,
  type MidSnapshot,
  midBars,
  midCoverage,
  oneAnHour,
  preferredBar,
  priceHistoryFigures,
  SWAP_ONLY_KEYS,
  USDC_MINT,
} from '@colosseum/risk';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { dbLookupReads, poolsAnswer, priceHistoryAnswer } from '../../apps/api/src/asset-lookups';
import {
  daysOf,
  fillHours,
  midBarHours,
  readDayFileSnapshots,
  readMidSnapshots,
  snapshotOfDayFileRow,
  upsertMidBars,
} from '../../scripts/risk/assets/mid-bars';

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
    const a = { methodVersion: 'bars-0.1', closeUsd: 1 };
    expect(preferredBar(a, { methodVersion: 'mids-0.9', closeUsd: 2 })).toBe(a);
    expect(preferredBar({ methodVersion: 'mids-0.9', closeUsd: 2 }, a)).toBe(a);
    const m2 = { methodVersion: 'mids-0.2', closeUsd: 2 };
    expect(preferredBar({ methodVersion: 'mids-0.1', closeUsd: 2 }, m2)).toBe(m2);
  });

  it('a swap bar with no dollar price gives way to a priced mid bar of the hour; an unpriced mid never wins', () => {
    type Pick2 = { methodVersion: string; closeUsd: number | null };
    const unpriced: Pick2 = { methodVersion: 'bars-0.1', closeUsd: null };
    const mid: Pick2 = { methodVersion: 'mids-0.1', closeUsd: 5 };
    expect(preferredBar(unpriced, mid)).toBe(mid);
    expect(preferredBar(mid, unpriced)).toBe(mid);
    const unpricedMid: Pick2 = { methodVersion: 'mids-0.1', closeUsd: null };
    expect(preferredBar(unpriced, unpricedMid)).toBe(unpriced);
    // in a window: the hour reads the mid's price, and the window holds a mid bar, so no volume is served
    const hours = windowHours(24);
    const rows = [
      ...hours
        .map((h) => swapRow(h, 7))
        .map((r, i) =>
          i === 23
            ? {
                ...r,
                closeUsd: null,
                highUsd: null,
                lowUsd: null,
                volumeUsd: null,
                buyVolumeUsd: null,
                sellVolumeUsd: null,
              }
            : r,
        ),
      midRows[23] as BarRow,
    ];
    const figures = byKey(priceHistoryFigures(rows, before, '24h', now, hours));
    expect(figures.get('close')?.value).toBe(123);
    expect(figures.get('volume')?.value).toBeNull();
  });

  it("other tokens' mid bars never make a token's stale bars current (B1)", () => {
    // the reviewer's case: now 12:18; the token's swap bars end ten hours before; the chain's swap collector
    // stopped then too; other tokens' mid bars every hour since
    const at = t('2026-10-21T12:18:00Z');
    const hourly = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * H).toISOString());
    const own = hourly('2026-10-20T13:00:00Z', 14).map((h) => swapRow(h, 1)); // 13:00 .. 02:00
    const swapHours = own.map((r) => r.hour);
    const midHours = hourly('2026-10-21T03:00:00Z', 9); // 03:00 .. 11:00
    const figures = priceHistoryFigures(own, before, '24h', at, swapHours, midHours);
    expect(figures.every((f) => f.value === null && f.reason === 'not_collected')).toBe(true);
    // a token with mid bars of its own reads the chain's mid hours, but only while its own newest bar is current
    const mine = (until: number) =>
      midBars(
        midHours
          .slice(0, until)
          .map((h) => snap('deep', h.replace(':00:00.000Z', ':10:00.000Z'), 9, 1)),
        pools,
        { from: t(midHours[0] as string), to: t('2026-10-21T12:00:00Z') },
      ).map(asRow);
    const current = byKey(
      priceHistoryFigures([...own, ...mine(9)], before, '24h', at, swapHours, midHours),
    );
    expect(current.get('close')?.value).toBe(9);
    // its own mids stopped at 06:00 while the others' went on: not current, never the 06:00 mark as the close
    const stale = priceHistoryFigures([...own, ...mine(4)], before, '24h', at, swapHours, midHours);
    expect(stale.every((f) => f.value === null && f.reason === 'not_collected')).toBe(true);
    expect(stale[0]).toMatchObject({ missingHours: 6 });
    // an hour the others' mids were read and this token's were not is a quiet hour, not an outage
    const holed = [...own, ...mine(9).filter((r) => r.hour !== midHours[4])];
    expect(
      byKey(priceHistoryFigures(holed, before, '24h', at, swapHours, midHours)).get('close')?.value,
    ).toBe(9);
    expect(midCoverage(holed.slice(-1), before, '24h', at, swapHours, [])).toMatchObject({
      covered: false,
    });
  });

  it("the pools' day volume is covered by swap-built bars only (B1)", () => {
    const at = t('2026-10-21T12:18:00Z');
    const hourly = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * H).toISOString());
    const swaps = hourly('2026-10-20T13:00:00Z', 14).map((h) => swapRow(h, 1));
    const mids = midBars(
      hourly('2026-10-21T03:00:00Z', 9).map((h) =>
        snap('deep', h.replace(':00:00.000Z', ':10:00.000Z'), 9, 1),
      ),
      pools,
      { from: t('2026-10-21T03:00:00Z'), to: t('2026-10-21T12:00:00Z') },
    ).map(asRow);
    const reading = {
      metric: 'pool_tvl_usd',
      value: 100,
      unit: 'usd',
      nullReason: null,
      observedAt: '2026-10-21T12:00:00.000Z',
      fetchedAt: '2026-10-21T12:00:00.000Z',
      source: 'test',
      method: 'test',
      methodVersion: 'test',
      provenance: 'live' as const,
      detail: { pools: [{ address: 'deep', venue: 'raydium_clmm', tvlUsd: 100 }] },
    };
    const poolBars = swaps.map((r) => ({ ...r, pool: 'deep' }));
    const answer = poolsAnswer(
      'solana:test',
      {
        reading,
        poolBars,
        day: { rows: [...swaps, ...mids], before, chainHours: swaps.map((r) => r.hour) },
      },
      at,
    );
    const volume = [...answer.facts, ...answer.missing].find((f) => f.id.endsWith(':volume'));
    expect(volume).toMatchObject({ reason: 'not_collected' });
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
  const poolC = `test-mid-pool-c-${process.pid}`;
  const b1 = `${chain}-b1`;
  const mint = `test-mid-token-${process.pid}`;

  afterAll(async () => {
    await db.delete(marketBars).where(inArray(marketBars.chain, [chain, b1]));
    await db
      .delete(riskPoolSnapshots)
      .where(inArray(riskPoolSnapshots.pool, [poolA, poolB, poolC]));
    await db.delete(riskPools).where(inArray(riskPools.address, [poolA, poolB, poolC]));
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
      // a USDC pool the collector does not read (tier X): its old rows are not read either
      { ...reg, address: poolC, venue: 'meteora_dlmm', tier: 'X' },
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
        snapRow(poolC, hours.from.getTime() + 5 * 60_000, 98),
      ]);
    const read = await readMidSnapshots(db, hours);
    const mine = read.snapshots.filter((s) => [poolA, poolB, poolC].includes(s.pool));
    // the SOL pool's snapshot is not read at all, nor the tier X pool's
    expect(read.pools.map((p) => p.address)).not.toContain(poolC);
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

  it("the lookups' chain hours leave mid bars out: a stale swap-only token beside fresh mid bars (B1)", async () => {
    const stale = `${mint}-stale`;
    const fresh = `${mint}-fresh`;
    const at = new Date(Math.floor(Date.now() / H) * H + 18 * 60_000);
    const top = Math.floor(at.getTime() / H) * H;
    // the stale token's swap bars end ten hours before; another token has a mid bar every hour since
    await db.insert(marketBars).values([
      ...Array.from({ length: 14 }, (_, i) => swapRowDb(b1, stale, new Date(top - (24 - i) * H))),
      // the other token: a mid bar every hour since the swap bars stopped, and one before the window
      ...[30, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((back) => ({
        ...swapRowDb(b1, fresh, new Date(top - back * H)),
        vwapUsd: null,
        swaps: 0,
        buySwaps: 0,
        unpricedSwaps: 0,
        volumeTokens: 0,
        volumeUsd: null,
        buyVolumeUsd: null,
        sellVolumeUsd: null,
        methodVersion: MIDS_METHOD_VERSION,
      })),
    ]);
    const from = new Date(top - 23 * H);
    const read = await dbLookupReads.bars(db, b1, stale, from);
    expect(read.chainHours.length).toBe(13);
    expect(read.midChainHours).toHaveLength(10);
    const answer = priceHistoryAnswer('solana:stale', read, '24h', at);
    expect(answer.facts).toEqual([]);
    expect(answer.missing.every((m) => m.reason === 'not_collected')).toBe(true);
    // the token with the mid bars reads its own: current, with no volume
    const own = priceHistoryAnswer(
      'solana:fresh',
      await dbLookupReads.bars(db, b1, fresh, from),
      '24h',
      at,
    );
    expect(own.facts.map((f) => f.id.split(':').at(-1))).toEqual([
      'close',
      'high',
      'low',
      'change',
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

// ------------------------------------------------------------------------------- the one-off fill from day files

describe("mid bars from the collector's day files (the fill of the hours before the snapshots)", () => {
  /** A row as scripts/risk/collector/pools.ts writes it, the curves cut to one point. */
  const fileRow = (pool: string, at: string, mid: number, depth: number | null, curves = true) => ({
    pool,
    venue: 'raydium_clmm',
    asset: 'TESTx',
    assetMint: TOKEN,
    quote: 'USDC',
    exitPath: 'direct_usd',
    tier: 'A',
    fetchedAt: at,
    slot: 1,
    midQuotePerAsset: mid,
    quoteUsd: 1,
    quoteUsdSource: 'stable_par',
    midUsd: mid,
    depth2pct: depth === null ? undefined : { sellQuoteOut: depth, buyAssetOut: 1 },
    activeLiquidity: '1',
    invariantRelErr: 0,
    sell: curves ? [{ notionalUsd: 100, outUsd: 99, costPct: 1, unfilledShare: 0 }] : null,
    buy: curves ? [{ notionalUsd: 100, outUsd: 99, costPct: 1, unfilledShare: 0 }] : null,
    source:
      'Solana RPC getMultipleAccounts (pool, tick/bin arrays, vaults); decoded by @colosseum/risk',
    method: 'simulate_raydium_clmm',
    methodVersion: 'pools-0.1',
    provenance: 'live',
  });

  it('reads a row as the snapshot the hourly import would store; a row without curves is skipped, as the import does', () => {
    expect(snapshotOfDayFileRow(fileRow('deep', '2026-10-16T10:05:00.000Z', 100, 5_000))).toEqual({
      pool: 'deep',
      fetchedAt: t('2026-10-16T10:05:00.000Z'),
      midPrice: 100,
      inBandLiquidity: 5_000,
      methodVersion: 'pools-0.1',
      provenance: 'live',
    });
    expect(
      snapshotOfDayFileRow(fileRow('deep', '2026-10-16T10:05:00.000Z', 100, 5_000, false)),
    ).toBeNull();
    expect(snapshotOfDayFileRow({ ...fileRow('deep', 'x', 1, 1) })).toBeNull();
    expect(
      snapshotOfDayFileRow(fileRow('deep', '2026-10-16T10:05:00.000Z', 100, null))?.inBandLiquidity,
    ).toBeNull();
    // a label it does not know is never served as live
    expect(
      snapshotOfDayFileRow({
        ...fileRow('deep', '2026-10-16T10:05:00.000Z', 1, 1),
        provenance: 'x',
      })?.provenance,
    ).toBe('mock');
  });

  it('streams the days of the hours, skips other pools and a line cut short, and builds the same bars as the database would', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mid-fill-'));
    const rows = [
      fileRow('deep', '2026-10-15T23:55:00.000Z', 1, 1), // before the hours
      fileRow('deep', '2026-10-16T00:05:00.000Z', 100, 90_000),
      fileRow('thin', '2026-10-16T00:06:00.000Z', 500, 10),
      fileRow('solpool', '2026-10-16T00:07:00.000Z', 0.5, 9_000_000),
      fileRow('deep', '2026-10-16T00:35:00.000Z', 104, 95_000),
      fileRow('deep', '2026-10-16T00:55:00.000Z', 101, 100_000, false), // no curves: the import skips it
      fileRow('deep', '2026-10-17T01:05:00.000Z', 99, 1), // past the hours
    ];
    const byDay = (d: string) =>
      rows.filter((r) => r.fetchedAt.startsWith(d)).map((r) => JSON.stringify(r));
    writeFileSync(join(dir, '2026-10-15.jsonl'), `${byDay('2026-10-15').join('\n')}\n`);
    // the newest day ends with a line cut short, as a collector stopped mid-write leaves it
    writeFileSync(
      join(dir, '2026-10-16.jsonl'),
      `${byDay('2026-10-16').join('\n')}\n{"pool":"deep","fetchedAt":"2026-10-16T01`,
    );
    const hours = { from: t('2026-10-16T00:00:00Z'), to: t('2026-10-16T02:00:00Z') };
    const usdc = new Set(pools.filter((p) => p.quoteMint === USDC_MINT).map((p) => p.address));
    const read = await readDayFileSnapshots(dir, hours, usdc);
    expect(read).toMatchObject({ files: 1, unreadable: 1 });
    expect(read.snapshots.map((s) => [s.pool, s.midPrice])).toEqual([
      ['deep', 100],
      ['thin', 500],
      ['deep', 104],
    ]);
    const fromFiles = midBars(read.snapshots, pools, hours, 'day_files');
    expect(fromFiles).toHaveLength(1);
    expect(fromFiles[0]).toMatchObject({
      openUsd: 100,
      highUsd: 104,
      lowUsd: 100,
      closeUsd: 104,
      detail: { pool: 'deep' },
    });
    expect(fromFiles[0]?.source).toMatch(
      /^the pool collector's day files \(pools\/<day>\.jsonl, midQuotePerAsset\) of the USDC pool deep/u,
    );
    // the same readings from the database give the same bar, but for the source
    const fromDb = midBars(read.snapshots, pools, hours);
    const { source: a, ...restFiles } = fromFiles[0] as MidBar;
    const { source: b, ...restDb } = fromDb[0] as MidBar;
    expect(restFiles).toEqual(restDb);
    expect(b).toMatch(/^risk_pool_snapshots\.mid_price/u);
    expect(daysOf(hours)).toEqual(['2026-10-16']);
    expect(daysOf({ from: t('2026-10-15T23:00:00Z'), to: t('2026-10-17T00:00:00Z') })).toEqual([
      '2026-10-15',
      '2026-10-16',
    ]);
  });

  it('fills from the hour after the newest swap-built bar to the first whole hour of the snapshots', () => {
    const h = fillHours(
      t('2026-10-15T23:00:00Z'),
      t('2026-10-17T15:42:00Z'),
      t('2026-10-21T16:20:00Z'),
    );
    expect([h.from.toISOString(), h.to.toISOString()]).toEqual([
      '2026-10-16T00:00:00.000Z',
      // the hour the first snapshot cuts short (15:00) comes from the files
      '2026-10-17T16:00:00.000Z',
    ]);
    // no snapshot: up to now's complete hours; no swap bar: the 31 days the table keeps
    expect(
      fillHours(t('2026-10-15T23:00:00Z'), null, t('2026-10-21T16:20:00Z')).to.toISOString(),
    ).toBe('2026-10-21T16:00:00.000Z');
    expect(fillHours(null, null, t('2026-10-21T16:20:00Z')).from.toISOString()).toBe(
      '2026-09-20T16:00:00.000Z',
    );
    // nothing to fill: an empty span, never a reversed one
    const none = fillHours(
      t('2026-10-21T15:00:00Z'),
      t('2026-10-20T10:00:00Z'),
      t('2026-10-21T16:20:00Z'),
    );
    expect(none.from.getTime()).toBe(none.to.getTime());
  });
});
