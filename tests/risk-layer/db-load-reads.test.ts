import { readFileSync } from 'node:fs';
import { createDb, type Db, riskAssetSnapshots, riskPoolSnapshots, riskPools } from '@colosseum/db';
import { hourOfWeek } from '@colosseum/risk';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { curveNotionalOut, curvePointAt } from '../../apps/api/src/history';
import { heatmapCells, THINNEST_HOUR_DAYS, thinnestHour } from '../../apps/api/src/routes/risk';

// DB-LOAD (Oct 18): the heatmap read every retained snapshot's whole curve of the asset's pools to use one
// point, and the borrow capacity's thinnest hour read every asset snapshot's sell side with no time bound.
// The heatmap now picks its one point in the database, and the thinnest hour reads the retained week cut to
// the two numbers it uses. Each answer is held here to the answer the read gave before, written out below
// as it was (`before*`), on the same rows: route detail on every point, a repeated notional, a notional
// stored as 50000.0, points without the asked size, an outUsd of null, pools of every exit path, two
// pools read in the same run. The rows sit in a schema of their own, so no other test's rows are read.

const SCHEMA = `db_load_reads_${process.pid}_${Date.now()}`;
const url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const { db, client } = createDb(
  `${url}${url.includes('?') ? '&' : '?'}max=2&search_path=${encodeURIComponent(`${SCHEMA},public`)}`,
);
const snap = JSON.parse(
  readFileSync('fixtures/risk/history/asset-snapshot-tslax.json', 'utf8'),
) as { sell: Array<Record<string, unknown>>; buy: Array<Record<string, unknown>> };

const MINT = 'FIXTUREdbLoadMint111111111111111111111111111';
const OTHER = 'FIXTUREdbLoadOther11111111111111111111111111';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;
const label = { source: 'fixture rows', method: 'fixture', methodVersion: 'fixture' };

// ------------------------------------------------------------------ the reads as they were

async function beforeHeatmap(db: Db, mint: string, notional: number, side: 'sell' | 'buy') {
  const pools = await db
    .select({ address: riskPools.address })
    .from(riskPools)
    .where(
      and(eq(riskPools.assetMint, mint), inArray(riskPools.exitPath, ['direct_usd', 'via_sol'])),
    );
  if (!pools.length) return null;
  const snaps = await db
    .select({
      fetchedAt: riskPoolSnapshots.fetchedAt,
      curve: side === 'sell' ? riskPoolSnapshots.sell : riskPoolSnapshots.buy,
    })
    .from(riskPoolSnapshots)
    .where(
      inArray(
        riskPoolSnapshots.pool,
        pools.map((p) => p.address),
      ),
    );
  const bestAt = new Map<string, number>();
  for (const s of snaps) {
    const pt = (s.curve as Array<{ notionalUsd: number; outUsd: number }>).find(
      (x) => x.notionalUsd === notional,
    );
    if (!pt) continue;
    const k = s.fetchedAt.toISOString();
    bestAt.set(k, Math.max(bestAt.get(k) ?? 0, pt.outUsd));
  }
  const byHow = new Map<number, number[]>();
  for (const [t, out] of bestAt) {
    const h = hourOfWeek(new Date(t));
    const arr = byHow.get(h) ?? [];
    arr.push(1 - out / notional);
    byHow.set(h, arr);
  }
  return [...byHow.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([how, xs]) => {
      const s = [...xs].sort((p, q) => p - q);
      return {
        hourOfWeekEt: how,
        medianCost: s[Math.floor((s.length - 1) / 2)],
        samples: s.length,
      };
    });
}

async function beforeThinnest(db: Db, mint: string, valueUsd: number) {
  const rows = await db
    .select({ fetchedAt: riskAssetSnapshots.fetchedAt, sell: riskAssetSnapshots.sell })
    .from(riskAssetSnapshots)
    .where(eq(riskAssetSnapshots.assetMint, mint));
  const byHow = new Map<number, number[]>();
  for (const r of rows) {
    const pts = (r.sell as Array<{ notionalUsd: number; outUsd: number }>)
      .map((p) => ({ n: p.notionalUsd, c: 1 - p.outUsd / p.notionalUsd }))
      .sort((x, y) => x.n - y.n);
    const hi = pts.findIndex((p) => p.n >= valueUsd);
    const cost = hi < 0 ? null : (pts[hi] as { c: number }).c;
    if (cost === null) continue;
    const how = hourOfWeek(r.fetchedAt);
    byHow.set(how, [...(byHow.get(how) ?? []), cost]);
  }
  const med = (xs: number[]) =>
    [...xs].sort((x, y) => x - y)[Math.floor((xs.length - 1) / 2)] as number;
  return (
    [...byHow.entries()]
      .map(([how, xs]) => ({
        hourOfWeekEt: how,
        medianSellCost: med(xs),
        samples: xs.length,
      }))
      .sort((x, y) => y.medianSellCost - x.medianSellCost)[0] ?? null
  );
}

// ------------------------------------------------------------------ the rows

const like = (t: string) =>
  db.execute(sql.raw(`create table "${SCHEMA}".${t} (like public.${t} including all)`));

/** A side as the collector writes it, its depth moved by `f`, with the variations the reads must keep. */
function side(points: Array<Record<string, unknown>>, i: number, f: number) {
  const out: Array<Record<string, unknown>> = points.map((p) => ({
    ...p,
    outUsd: (p.outUsd as number) * f,
    route: [{ pool: `R${i % 4}`, share: 0.5 + (i % 3) / 10 }],
  }));
  // a repeated notional: the first one is the one read
  if (i % 7 === 0) out.splice(2, 0, { ...(out[2] as object), outUsd: 1 });
  // a size the collector could not route
  if (i % 5 === 0) out.push({ notionalUsd: 7_500_000, outUsd: null, costPct: null });
  // a run that measured fewer sizes
  if (i % 9 === 0) out.splice(out.length - 3, 1);
  // out of order
  if (i % 4 === 0) out.reverse();
  return out;
}

beforeAll(async () => {
  await db.execute(sql.raw(`create schema "${SCHEMA}"`));
  for (const t of ['risk_pools', 'risk_pool_snapshots', 'risk_asset_snapshots']) await like(t);
  // risk_pool_snapshots points at risk_pools; the copy has no such key, which this test does not need
  const pool = (address: string, mint: string, exitPath: string) => ({
    address,
    program: 'fixture',
    venue: 'fixture',
    assetMint: mint,
    assetSymbol: 'DBLx',
    quoteMint: 'FIXTUREquote',
    exitPath,
    assetIsToken0: 1,
    decimals0: 8,
    decimals1: 6,
    tvlUsd: 1_000,
    tier: 'A',
    status: 'fixture',
    ...label,
    fetchedAt: NOW,
    provenance: 'fixture' as const,
  });
  await db
    .insert(riskPools)
    .values([
      pool('PD1', MINT, 'direct_usd'),
      pool('PD2', MINT, 'via_sol'),
      pool('PD3', MINT, 'other'),
      pool('PD4', OTHER, 'direct_usd'),
    ]);

  // four days of pool snapshots every 20 minutes; PD1 and PD2 read in the same runs
  const poolRows = [];
  for (let i = 0; i < (4 * 24 * 60) / 20; i++) {
    const at = new Date(NOW.getTime() - 4 * DAY + i * 20 * MIN + 711);
    for (const [k, p] of ['PD1', 'PD2', 'PD3', 'PD4'].entries()) {
      if (p === 'PD2' && i % 3 === 1) continue;
      const f = 1 - ((i + k) % 13) / 300;
      const sell = side(snap.sell, i + k, f);
      const buy = side(snap.buy, i + 2 * k, f);
      poolRows.push({
        pool: p,
        fetchedAt: at,
        midPrice: 100,
        sell,
        buy,
        ...label,
        provenance: 'fixture' as const,
      });
    }
  }
  await db.insert(riskPoolSnapshots).values(poolRows);
  // a notional stored as 50000.0, which JavaScript reads as 50000
  await db.execute(
    sql.raw(
      `update "${SCHEMA}".risk_pool_snapshots set sell = regexp_replace(sell::text, '"notionalUsd": 50000([,}])', '"notionalUsd": 50000.0\\1', 'g')::jsonb where extract(minute from fetched_at) = 20`,
    ),
  );

  // the retained week of asset snapshots, every 25 minutes, up to the asset's newest
  const assetRows = [];
  const newest = new Date(NOW.getTime() - 2 * 3_600_000 + 333);
  for (let i = 0; i <= (THINNEST_HOUR_DAYS * 24 * 60) / 25; i++) {
    const at =
      i === 0
        ? new Date(newest.getTime() - THINNEST_HOUR_DAYS * DAY) // the window's first instant
        : new Date(newest.getTime() - THINNEST_HOUR_DAYS * DAY + i * 25 * MIN);
    if (at > newest) break;
    assetRows.push({
      assetMint: MINT,
      asset: 'DBLx',
      fetchedAt: at,
      refPool: 'PD1',
      refMidUsd: 100,
      pools: 2,
      sell: side(snap.sell, i, 1 - (i % 17) / 250),
      buy: snap.buy,
      ...label,
      provenance: 'fixture' as const,
    });
  }
  assetRows.push({ ...(assetRows.at(-1) as (typeof assetRows)[number]), fetchedAt: newest });
  await db.insert(riskAssetSnapshots).values(assetRows).onConflictDoNothing();
});

afterAll(async () => {
  await db.execute(sql.raw(`drop schema "${SCHEMA}" cascade`));
  await client.end();
});

// ------------------------------------------------------------------ the reads now

describe('the heatmap picks its one point in the database', () => {
  it('answers what the whole-curve read answered, for every size and both sides', async () => {
    let compared = 0;
    for (const s of ['sell', 'buy'] as const)
      for (const n of [100, 2_500, 50_000, 1_000_000, 7_500_000, 12_345]) {
        const was = await beforeHeatmap(db, MINT, n, s);
        const is = await heatmapCells(db, MINT, n, s);
        expect(is, `${s} ${n}`).toEqual(was);
        compared += is?.length ?? 0;
      }
    // the comparison is not of empty answers
    expect(compared).toBeGreaterThan(400);
    expect(await heatmapCells(db, 'FIXTUREnoPools', 50_000, 'sell')).toBeNull();
    expect(await beforeHeatmap(db, 'FIXTUREnoPools', 50_000, 'sell')).toBeNull();
  });

  it('reads one point of a snapshot, cut to its outUsd, and nothing at a size it lacks', async () => {
    const rows = await db
      .select({ a: curvePointAt(riskPoolSnapshots.sell, 50_000), b: riskPoolSnapshots.sell })
      .from(riskPoolSnapshots)
      .where(eq(riskPoolSnapshots.pool, 'PD1'));
    let withPoint = 0;
    for (const r of rows) {
      const first = (r.b as Array<{ notionalUsd: number; outUsd: unknown }>).find(
        (p) => p.notionalUsd === 50_000,
      );
      expect(r.a).toEqual(first ? { outUsd: first.outUsd } : null);
      if (first) withPoint++;
    }
    expect(withPoint).toBeGreaterThan(100);
    const [stored] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(riskPoolSnapshots)
      .where(sql`${riskPoolSnapshots.sell}::text like '%"notionalUsd": 50000.0%'`);
    expect(stored?.n).toBeGreaterThan(50);
    const [none] = await db
      .select({ a: curvePointAt(riskPoolSnapshots.sell, 12_345) })
      .from(riskPoolSnapshots)
      .limit(1);
    expect(none?.a).toBeNull();
  });
});

describe("the borrow capacity's thinnest hour reads the retained week, two numbers a point", () => {
  it('answers what the unbounded read answered on the rows the database keeps', async () => {
    const [newest] = await db
      .select({ t: riskAssetSnapshots.fetchedAt })
      .from(riskAssetSnapshots)
      .where(eq(riskAssetSnapshots.assetMint, MINT))
      .orderBy(sql`${riskAssetSnapshots.fetchedAt} desc`)
      .limit(1);
    const at = newest?.t as Date;
    let found = 0;
    for (const value of [50, 100, 2_500, 3_000, 60_000, 4_000_000, 7_000_000, 1e9]) {
      const was = await beforeThinnest(db, MINT, value);
      const is = await thinnestHour(db, MINT, value, at);
      expect(is, String(value)).toEqual(was);
      if (is) found++;
    }
    expect(found).toBeGreaterThan(4);
  });

  it('cuts each point to notionalUsd and outUsd, keeping every point, its order and a null', async () => {
    const rows = await db
      .select({ cut: curveNotionalOut(riskAssetSnapshots.sell), whole: riskAssetSnapshots.sell })
      .from(riskAssetSnapshots)
      .where(eq(riskAssetSnapshots.assetMint, MINT));
    for (const r of rows)
      expect(r.cut).toEqual(
        (r.whole as Array<Record<string, unknown>>).map(({ notionalUsd, outUsd }) => ({
          notionalUsd,
          outUsd,
        })),
      );
  });

  it('leaves out rows older than the week before the newest, which the daily prune deletes', async () => {
    const [newest] = await db
      .select({ t: sql<Date>`max(${riskAssetSnapshots.fetchedAt})` })
      .from(riskAssetSnapshots);
    const at = new Date(newest?.t as unknown as string);
    const hour = Math.floor((at.getTime() - THINNEST_HOUR_DAYS * DAY) / 3_600_000) * 3_600_000;
    const before = await thinnestHour(db, MINT, 2_500, at);
    // rows past the window, in one hour, that would make it the thinnest of all were they read
    await db.insert(riskAssetSnapshots).values(
      Array.from({ length: 6 }, (_, k) => ({
        assetMint: MINT,
        asset: 'DBLx',
        fetchedAt: new Date(hour - 3_600_000 + k * 5 * MIN),
        refPool: 'PD1',
        refMidUsd: 100,
        pools: 2,
        sell: snap.sell.map((p) => ({ ...p, outUsd: 1 })),
        buy: snap.buy,
        ...label,
        provenance: 'fixture' as const,
      })),
    );
    expect(await thinnestHour(db, MINT, 2_500, at)).toEqual(before);
    expect((await beforeThinnest(db, MINT, 2_500))?.medianSellCost).not.toBe(
      before?.medianSellCost,
    );
  });
});
