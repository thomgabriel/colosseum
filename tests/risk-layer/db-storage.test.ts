import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createDb, type Db, riskAssetSnapshots, riskPoolSnapshots, riskPools } from '@colosseum/db';
import { defaultRegimeParams, hourOfWeek, packSide, sidePoints } from '@colosseum/risk';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCapacitySeries } from '../../apps/api/src/facts';
import { curveNotionalOut, curvePairs, loadAssetHistory } from '../../apps/api/src/history';
import { heatmapCells, thinnestHour } from '../../apps/api/src/routes/risk';
import { readCurveSamples } from '../../scripts/risk/curve-read';
import { curveRows, type SnapshotForCurve } from '../../scripts/risk/curve-rows';
import {
  fromFullRun,
  LENDING_DETAIL_KEYS,
  lendingDetail,
  poolSidesToStore,
} from '../../scripts/risk/lib-import';

// DB-STORAGE (Oct 18): the hosted database neared Neon's 1 GB. The import now stores each curve as
// [notionalUsd, outUsd] pairs, and a pool side that a ten-minute run found as the pool's last stored curve as
// JSON null; rows stored before keep the object form. Every reader is held here to what it answered on the
// rows stored whole: the heatmap on runs of repeated curves, pools read in some runs only, a pool whose tier
// changes and runs a pool missed; the asset readers on the frozen compute snapshots, Robinhood Chain points
// with a null outUsd and route detail, and sides the pairs cannot hold (kept as written). Each copy of the
// rows sits in a schema of its own.

const RUN = `${process.pid}_${Date.now()}`;
const WAS = `db_storage_was_${RUN}`;
const NOW_ = `db_storage_now_${RUN}`;
const url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const open = (schema: string) =>
  createDb(
    `${url}${url.includes('?') ? '&' : '?'}max=1&extra_float_digits=0&search_path=${encodeURIComponent(`${schema},public`)}`,
  );
const was = open(WAS);
const now = open(NOW_);
const regimeParams = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const snap = JSON.parse(
  readFileSync('fixtures/risk/history/asset-snapshot-tslax.json', 'utf8'),
) as { sell: Array<Record<string, unknown>>; buy: Array<Record<string, unknown>> };
const label = { source: 'fixture rows', method: 'fixture', methodVersion: 'fixture' };
const MIN = 60_000;
const DAY = 86_400_000;

// ------------------------------------------------------------------ the read before, on every curve stored

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

// ------------------------------------------------------------------ the pool rows

const MINT = 'FIXTUREdbStorageMint1111111111111111111111111';
const OTHER = 'FIXTUREdbStorageOther111111111111111111111111';
const LONE = 'FIXTUREdbStorageLone11111111111111111111111111';
const T0 = new Date('2026-10-14T00:00:00.000Z').getTime();

/** A pool side as the collector writes it, at depth step `v`, with the variations the reads must keep. */
function poolSide(points: Array<Record<string, unknown>>, v: number) {
  const out: Array<Record<string, unknown>> = points.map((p) => ({
    ...p,
    outUsd: (p.outUsd as number) * (1 - (v % 11) / 400),
    unfilledShare: 0,
    route: [{ pool: `R${v % 3}` }],
  }));
  if (v % 7 === 0) out.splice(2, 0, { ...(out[2] as object), outUsd: 1 }); // repeated notional
  if (v % 5 === 0) out.push({ notionalUsd: 7_500_000, outUsd: null, costPct: null });
  if (v % 9 === 0) out.splice(out.length - 3, 1); // a size not measured
  if (v % 4 === 0) out.reverse();
  // a notional written as text: the pairs cannot hold it, so the side is kept as written
  if (v % 13 === 0) out.push({ notionalUsd: '50000', outUsd: 1 });
  return out;
}

type PoolRow = {
  pool: string;
  fetchedAt: string;
  tier: 'A' | 'B';
  midQuotePerAsset: number;
  sell: Array<Record<string, unknown>>;
  buy: Array<Record<string, unknown>>;
};

/**
 * Four days of collector runs: a full run at :01 of each hour (every pool) and ten-minute runs of the tier-A
 * pools between, one of them skipped some hours. A pool's depth changes every few runs, its sell and buy on
 * their own clocks, so most ten-minute rows repeat the last curve. PB1 is tier B until day three, then A; PA2
 * misses some runs.
 */
function collectorRuns(): PoolRow[] {
  const rows: PoolRow[] = [];
  const pools = [
    { p: 'PA1', every: [3, 4] },
    { p: 'PA2', every: [2, 5] },
    { p: 'PB1', every: [6, 6] },
    { p: 'PB2', every: [4, 3] },
    { p: 'PX1', every: [5, 2] },
  ];
  let run = 0;
  for (let h = 0; h < 4 * 24; h++)
    for (const m of [1, 11, 21, 31, 41, 51]) {
      if (m === 31 && h % 3 === 0) continue;
      run++;
      const at = new Date(T0 + h * 3_600_000 + m * MIN + 711).toISOString();
      const full = m === 1;
      for (const [k, { p, every }] of pools.entries()) {
        const tier = p === 'PB2' || (p === 'PB1' && h < 48) ? 'B' : 'A';
        if (!full && tier === 'B') continue;
        if (p === 'PA2' && run % 7 === 3) continue;
        const [es, eb] = every as [number, number];
        rows.push({
          pool: p,
          fetchedAt: at,
          tier,
          midQuotePerAsset: 100 + Math.floor(run / es),
          sell: poolSide(snap.sell, Math.floor(run / es) + k),
          buy: poolSide(snap.buy, Math.floor(run / eb) + 2 * k),
        });
      }
    }
  return rows;
}

const asStored = (side: unknown) => (side === null ? sql`'null'::jsonb` : side);
const poolRow = (r: PoolRow, sell: unknown, buy: unknown) => ({
  pool: r.pool,
  fetchedAt: new Date(r.fetchedAt),
  midPrice: r.midQuotePerAsset,
  sell: asStored(sell),
  buy: asStored(buy),
  ...label,
  provenance: 'fixture' as const,
});

// ------------------------------------------------------------------ the asset rows

type Frozen = { snapshots: Array<Omit<SnapshotForCurve, 'fetchedAt'> & { fetchedAt: string }> };
const frozen: Frozen = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk/compute/solana-snapshots.json.gz')).toString(),
);
const EVM = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const ODD = 'FIXTUREdbStorageOdd11111111111111111111111111';
const assetSnaps: SnapshotForCurve[] = [
  ...frozen.snapshots.map((s) => ({ ...s, fetchedAt: new Date(s.fetchedAt) })),
  // Robinhood Chain: route detail, and a null outUsd at a size no pool quoted
  ...frozen.snapshots.slice(0, 60).map((s, i) => ({
    ...s,
    assetMint: EVM,
    asset: 'NVDA',
    methodVersion: 'evmq-0.1',
    fetchedAt: new Date(s.fetchedAt),
    sell: (s.sell as Array<Record<string, unknown>>).map((p, j) => ({
      ...p,
      outUsd: j === 7 && i % 2 ? null : p.outUsd,
      unfilledShare: null,
      pool: 'P',
      midUsd: 1,
      quoted: 2,
    })),
  })),
  // sides the pairs cannot hold, beside sides they can
  ...['2026-10-05T14:00:00.000Z', '2026-10-05T23:30:00.000Z', '2026-10-04T15:00:00.000Z'].map(
    (t, i) => ({
      assetMint: ODD,
      asset: 'ODDx',
      methodVersion: 'pools-0.1',
      fetchedAt: new Date(t),
      sell:
        i === 1
          ? [{ notionalUsd: 100, outUsd: 99.5 }, { outUsd: 3 }]
          : [
              { notionalUsd: 100, outUsd: 99.5 - i / 10, costPct: 0.5 },
              { notionalUsd: 1000, outUsd: 990 + i },
              { notionalUsd: 1000, outUsd: 980.25 + i },
              // a null outUsd (cost 1 to the thinnest hour, as before); once, so no two hours tie
              { notionalUsd: i ? 6000 : 5000, outUsd: i ? 5800 : null },
              { notionalUsd: 0, outUsd: 1 },
            ],
      buy: i === 2 ? [] : [{ notionalUsd: 100, outUsd: 99.1 + i / 7, poolsUsed: 2 }],
    }),
  ),
];
const assetRow = (s: SnapshotForCurve, pack: boolean) => ({
  assetMint: s.assetMint,
  asset: s.asset,
  fetchedAt: s.fetchedAt,
  refPool: 'fixture',
  refMidUsd: 100,
  pools: 2,
  sell: pack ? packSide(s.sell) : s.sell,
  buy: pack ? packSide(s.buy) : s.buy,
  methodVersion: s.methodVersion,
  source: 'fixture rows',
  method: 'fixture',
  provenance: 'fixture' as const,
});

const stored = { rows: 0, nullSides: 0, pairs: 0, kept: 0 };

beforeAll(async () => {
  for (const [c, schema] of [
    [was, WAS],
    [now, NOW_],
  ] as const) {
    await c.db.execute(sql.raw(`create schema "${schema}"`));
    for (const t of ['risk_pools', 'risk_pool_snapshots', 'risk_asset_snapshots'])
      await c.db.execute(sql.raw(`create table "${schema}".${t} (like public.${t} including all)`));
    const pool = (address: string, mint: string, exitPath: string) => ({
      address,
      program: 'fixture',
      venue: 'fixture',
      assetMint: mint,
      assetSymbol: 'DBSx',
      quoteMint: 'FIXTUREquote',
      exitPath,
      assetIsToken0: 1,
      decimals0: 8,
      decimals1: 6,
      tier: 'A',
      status: 'fixture',
      ...label,
      fetchedAt: new Date(T0),
      provenance: 'fixture' as const,
    });
    await c.db
      .insert(riskPools)
      .values([
        pool('PA1', MINT, 'direct_usd'),
        pool('PA2', MINT, 'via_sol'),
        pool('PB1', MINT, 'direct_usd'),
        pool('PB2', MINT, 'other'),
        pool('PX1', OTHER, 'direct_usd'),
        pool('PL1', LONE, 'direct_usd'),
      ]);
  }
  const runs = collectorRuns();
  // before: every row with its curves as written
  const whole = runs.map((r) => poolRow(r, r.sell, r.buy));
  for (let i = 0; i < whole.length; i += 500)
    await was.db.insert(riskPoolSnapshots).values(whole.slice(i, i + 500));
  // now: as the import stores them, in the files' order
  const last = new Map<string, string>();
  const kept = runs.map((r) => {
    const s = poolSidesToStore(r, last);
    stored.rows++;
    for (const x of [s.sell, s.buy])
      if (x === null) stored.nullSides++;
      else if (Array.isArray(x) && Array.isArray(x[0])) stored.pairs++;
      else stored.kept++;
    return poolRow(r, s.sell, s.buy);
  });
  for (let i = 0; i < kept.length; i += 500)
    await now.db.insert(riskPoolSnapshots).values(kept.slice(i, i + 500));
  // a pool whose only rows say "as before": its curve is no longer kept
  await now.db.insert(riskPoolSnapshots).values(
    [1, 2].map((h) =>
      poolRow(
        {
          ...(runs[0] as PoolRow),
          pool: 'PL1',
          fetchedAt: new Date(T0 + h * 600_000).toISOString(),
        },
        null,
        null,
      ),
    ),
  );

  for (let i = 0; i < assetSnaps.length; i += 200) {
    await was.db
      .insert(riskAssetSnapshots)
      .values(assetSnaps.slice(i, i + 200).map((s) => assetRow(s, false)));
    await now.db
      .insert(riskAssetSnapshots)
      .values(assetSnaps.slice(i, i + 200).map((s) => assetRow(s, true)));
  }
}, 120_000);

afterAll(async () => {
  for (const [c, schema] of [
    [was, WAS],
    [now, NOW_],
  ] as const) {
    await c.db.execute(sql.raw(`drop schema "${schema}" cascade`));
    await c.client.end();
  }
});

// ------------------------------------------------------------------ the stored forms

describe('packSide and sidePoints', () => {
  it('stores the two numbers of each point, in order, a repeat and a null kept, as written', () => {
    const side = [
      { notionalUsd: 500, outUsd: 499.49444027863717, costPct: 0.1, poolsUsed: 2 },
      { notionalUsd: 100, outUsd: null, unfilledShare: 1 },
      { notionalUsd: 500, outUsd: 1 },
    ];
    expect(packSide(side)).toEqual([
      [500, 499.49444027863717],
      [100, null],
      [500, 1],
    ]);
    expect(JSON.stringify(packSide(side))).toBe('[[500,499.49444027863717],[100,null],[500,1]]');
    expect(sidePoints(packSide(side))).toEqual([
      { notionalUsd: 500, outUsd: 499.49444027863717 },
      { notionalUsd: 100, outUsd: null },
      { notionalUsd: 500, outUsd: 1 },
    ]);
    expect(packSide([])).toEqual([]);
  });

  it('keeps as written a side the pairs cannot hold exactly', () => {
    for (const side of [
      [{ notionalUsd: 100 }], // outUsd absent, which a reader tells from null
      [{ notionalUsd: '100', outUsd: 1 }],
      [{ outUsd: 1 }],
      [{ notionalUsd: 100, outUsd: '1' }],
      [{ notionalUsd: 100, outUsd: Number.NaN }],
      [null],
      [[100, 1]],
      null,
      { notionalUsd: 100, outUsd: 1 },
    ])
      expect(packSide(side)).toBe(side);
    expect(sidePoints(null)).toEqual([]);
    expect(sidePoints([{ notionalUsd: 1, outUsd: 2, costPct: 3 }])).toEqual([
      { notionalUsd: 1, outUsd: 2, costPct: 3 },
    ]);
  });
});

describe('a pool side a ten-minute run found unchanged is stored as null', () => {
  it('knows the full run by its minute and a pool of tier B by its tier', () => {
    expect(fromFullRun({ fetchedAt: '2026-10-14T10:04:59.999Z', tier: 'A' })).toBe(true);
    expect(fromFullRun({ fetchedAt: '2026-10-14T10:05:00.000Z', tier: 'A' })).toBe(false);
    expect(fromFullRun({ fetchedAt: '2026-10-14T10:25:00.000Z', tier: 'B' })).toBe(true);
    expect(fromFullRun({ fetchedAt: '2026-10-14T10:25:00.000Z' })).toBe(true);
    expect(fromFullRun({ fetchedAt: 'not a time', tier: 'A' })).toBe(true);
  });

  it('keeps every side of a full run, and each side on its own', () => {
    const last = new Map<string, string>();
    const row = (t: string, sell: number, buy: number) => ({
      pool: 'P',
      fetchedAt: `2026-10-14T${t}:00.000Z`,
      tier: 'A',
      sell: [{ notionalUsd: 100, outUsd: sell, costPct: 1 }],
      buy: [{ notionalUsd: 100, outUsd: buy }],
    });
    expect(poolSidesToStore(row('10:01', 99, 98), last)).toEqual({
      sell: [[100, 99]],
      buy: [[100, 98]],
    });
    expect(poolSidesToStore(row('10:11', 99, 98), last)).toEqual({ sell: null, buy: null });
    expect(poolSidesToStore(row('10:21', 99, 97), last)).toEqual({ sell: null, buy: [[100, 97]] });
    expect(poolSidesToStore(row('11:01', 99, 97), last)).toEqual({
      sell: [[100, 99]],
      buy: [[100, 97]],
    });
    // route detail is not compared: it is not stored
    expect(
      poolSidesToStore({ ...row('11:11', 99, 97), sell: [{ notionalUsd: 100, outUsd: 99 }] }, last),
    ).toEqual({ sell: null, buy: null });
  });

  it('stored most ten-minute sides as null in the fixture runs, and kept the odd ones as written', () => {
    expect(stored.nullSides).toBeGreaterThan(stored.rows * 0.4);
    expect(stored.pairs).toBeGreaterThan(stored.rows * 0.3);
    expect(stored.kept).toBeGreaterThan(20);
  });
});

describe('the heatmap answers what it answered on every curve stored', () => {
  it('for every size and both sides, of an asset with pools read in some runs only', async () => {
    let compared = 0;
    for (const s of ['sell', 'buy'] as const)
      for (const n of [100, 2_500, 50_000, 1_000_000, 5_000_000, 7_500_000, 12_345])
        for (const mint of [MINT, OTHER]) {
          const before = await beforeHeatmap(was.db, mint, n, s);
          expect(await heatmapCells(now.db, mint, n, s), `${mint} ${s} ${n}`).toEqual(before);
          // and on rows stored before the change
          expect(await heatmapCells(was.db, mint, n, s), `whole ${mint} ${s} ${n}`).toEqual(before);
          compared += before?.length ?? 0;
        }
    expect(compared).toBeGreaterThan(1_000);
  });

  it('does not count a run whose pool curve is no longer kept', async () => {
    expect(await heatmapCells(now.db, LONE, 50_000, 'sell')).toEqual([]);
    expect(await heatmapCells(now.db, 'FIXTUREnoPools', 50_000, 'sell')).toBeNull();
  });
});

describe('the asset readers answer the same on pairs as on the objects', () => {
  const mints = [...new Set(assetSnaps.map((s) => s.assetMint))];

  it('cuts each side to the same numbers', async () => {
    const read = (db: Db) =>
      db
        .select({
          pairsSell: curvePairs(riskAssetSnapshots.sell),
          pairsBuy: curvePairs(riskAssetSnapshots.buy),
          cutSell: curveNotionalOut(riskAssetSnapshots.sell),
          cutBuy: curveNotionalOut(riskAssetSnapshots.buy),
        })
        .from(riskAssetSnapshots)
        .orderBy(asc(riskAssetSnapshots.assetMint), asc(riskAssetSnapshots.fetchedAt));
    const [a, b] = [await read(was.db), await read(now.db)];
    expect(a.length).toBe(assetSnaps.length);
    expect(b).toEqual(a);
    // the stored form is the pairs where they fit
    const [p] = await now.db
      .select({ n: sql<number>`count(*)::int` })
      .from(riskAssetSnapshots)
      .where(sql`jsonb_typeof(${riskAssetSnapshots.sell}->0) = 'array'`);
    expect(p?.n).toBeGreaterThan(assetSnaps.length - 3);
  });

  it('compute reads the same samples and writes the same curves', async () => {
    for (const quantile of [0.5, 0.9]) {
      const a = await readCurveSamples(was.db, { quantile, regimeParams });
      const b = await readCurveSamples(now.db, { quantile, regimeParams });
      expect(b).toEqual(a);
      expect(a.snapshots).toBe(assetSnaps.length);
    }
    const base = {
      poolSymbols: new Map(mints.map((m) => [m, m])),
      previous: new Map(),
      now: new Date('2026-10-07T00:00:00.000Z'),
      quantile: 0.5,
      minSamples: 4,
      regimeParams,
    };
    const fromObjects = curveRows({ ...base, snapshots: assetSnaps });
    const fromPairs = curveRows({
      ...base,
      snapshots: assetSnaps.map((s) => ({ ...s, sell: packSide(s.sell), buy: packSide(s.buy) })),
    });
    expect(fromObjects.rows.length).toBeGreaterThan(10);
    expect(JSON.stringify(fromPairs)).toBe(JSON.stringify(fromObjects));
  });

  it('the history, the capacity series and the thinnest hour are the same', async () => {
    const at = new Date('2026-10-06T01:00:00.000Z');
    let points = 0;
    for (const mint of mints) {
      const h = (db: Db) =>
        loadAssetHistory(db, mint, { days: 30, tau: 0.01, now: at, regimeParams });
      const ha = await h(was.db);
      expect(await h(now.db)).toEqual(ha);
      points += ha.points.length;
      const c = (db: Db) =>
        loadCapacitySeries(db, mint, new Date(at.getTime() - 30 * DAY), 0.01, regimeParams);
      expect(await c(now.db)).toEqual(await c(was.db));
      for (const value of [50, 100, 3_000, 60_000, 4_000_000, 1e9])
        expect(await thinnestHour(now.db, mint, value, at), `${mint} ${value}`).toEqual(
          await thinnestHour(was.db, mint, value, at),
        );
    }
    expect(points).toBeGreaterThan(100);
  });
});

// ------------------------------------------------------------------ the import

describe('the import stores pairs and null sides', () => {
  const SCHEMA = `db_storage_import_${RUN}`;
  const conn = open(SCHEMA);
  const home = mkdtempSync(join(tmpdir(), 'risk-import-storage-'));
  const DAYS = '2026-10-14';
  const at = (hhmm: string) => `${DAYS}T${hhmm}:00.000Z`;
  const side = (out: number) => [{ notionalUsd: 100, outUsd: out, costPct: 0.5, poolsUsed: 1 }];
  const row = (pool: string, t: string, tier: 'A' | 'B', sell: number, buy: number) => ({
    pool,
    tier,
    fetchedAt: at(t),
    slot: 1,
    midQuotePerAsset: 100,
    sell: side(sell),
    buy: side(buy),
    ...label,
  });
  const lines = (rows: object[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  const runImport = () => {
    const r = spawnSync('npx', ['tsx', 'scripts/risk/import.ts'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: `${url}${url.includes('?') ? '&' : '?'}max=2&search_path=${encodeURIComponent(`${SCHEMA},public`)}`,
        RISK_HOME: home,
        RISK_IMPORT_ALL: '',
      },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').at(-1) as string).inserted as Record<
      string,
      number
    >;
  };
  const storedRows = async () =>
    (await conn.db.execute(
      sql.raw(
        `select pool, to_char(fetched_at at time zone 'UTC', 'HH24:MI') as t, sell::text as sell, buy::text as buy from "${SCHEMA}".risk_pool_snapshots order by fetched_at, pool`,
      ),
    )) as unknown as Array<{ pool: string; t: string; sell: string; buy: string }>;

  beforeAll(async () => {
    await conn.db.execute(sql.raw(`create schema "${SCHEMA}"`));
    for (const t of [
      'risk_pools',
      'risk_pool_snapshots',
      'risk_events',
      'risk_lp_concentration',
      'risk_asset_snapshots',
    ])
      await conn.db.execute(
        sql.raw(`create table "${SCHEMA}".${t} (like public.${t} including all)`),
      );
    await conn.db.insert(riskPools).values(
      ['IP1', 'IP2'].map((address) => ({
        address,
        program: 'fixture',
        venue: 'fixture',
        assetMint: 'FIXTUREimportStorageMint11111111111111111111',
        assetSymbol: 'ISx',
        quoteMint: 'FIXTUREquote',
        exitPath: 'direct_usd',
        assetIsToken0: 1,
        decimals0: 8,
        decimals1: 6,
        tier: 'A',
        status: 'fixture',
        ...label,
        fetchedAt: new Date(at('00:00')),
        provenance: 'fixture' as const,
      })),
    );
    for (const d of ['pools', 'assets']) mkdirSync(join(home, d));
    writeFileSync(
      join(home, 'pools', `${DAYS}.jsonl`),
      lines([
        row('IP1', '10:01', 'A', 99, 98),
        row('IP2', '10:01', 'B', 90, 89),
        row('IP1', '10:11', 'A', 99, 98),
        row('IP1', '10:21', 'A', 99, 97),
      ]),
    );
    writeFileSync(
      join(home, 'assets', `${DAYS}.jsonl`),
      lines([
        {
          assetMint: 'FIXTUREimportStorageMint11111111111111111111',
          asset: 'ISx',
          fetchedAt: at('10:01'),
          slot: 1,
          refPool: 'IP1',
          refMidUsd: 100,
          pools: 2,
          sell: side(99.25),
          buy: side(98.5),
          ...label,
        },
      ]),
    );
  });

  afterAll(async () => {
    await conn.db.execute(sql.raw(`drop schema "${SCHEMA}" cascade`));
    await conn.client.end();
  });

  it('stores the full run whole, and a ten-minute side as before as null', async () => {
    expect(runImport()).toMatchObject({ snapshots: 4, assets: 1, sidesAsBefore: 3 });
    expect(await storedRows()).toEqual([
      { pool: 'IP1', t: '10:01', sell: '[[100, 99]]', buy: '[[100, 98]]' },
      { pool: 'IP2', t: '10:01', sell: '[[100, 90]]', buy: '[[100, 89]]' },
      { pool: 'IP1', t: '10:11', sell: 'null', buy: 'null' },
      { pool: 'IP1', t: '10:21', sell: 'null', buy: '[[100, 97]]' },
    ]);
    const [a] = (await conn.db.execute(
      sql.raw(`select sell::text as sell from "${SCHEMA}".risk_asset_snapshots`),
    )) as unknown as Array<{ sell: string }>;
    expect(a?.sell).toBe('[[100, 99.25]]');
  }, 60_000);

  it('compares a later run with the curves the database holds', async () => {
    appendFileSync(
      join(home, 'pools', `${DAYS}.jsonl`),
      lines([row('IP1', '10:31', 'A', 99, 97), row('IP1', '10:41', 'A', 99.5, 97)]),
    );
    expect(runImport()).toMatchObject({ snapshots: 2, sidesAsBefore: 2 + 3 });
    expect((await storedRows()).slice(-2)).toEqual([
      { pool: 'IP1', t: '10:31', sell: 'null', buy: 'null' },
      { pool: 'IP1', t: '10:41', sell: '[[100, 99.5]]', buy: 'null' },
    ]);
  }, 60_000);
});

// ------------------------------------------------------------------ lending detail

describe("a lending snapshot's detail keeps the keys a reader takes from it", () => {
  it('keeps those keys as written, and only where the row has them', () => {
    const row = {
      kind: 'jl_liquidity',
      account: 'A',
      symbol: 'USDC',
      supplyApr: 0.0412345678901,
      borrowApr: '0.05',
      raw: { big: 'x'.repeat(1000) },
    };
    expect(lendingDetail(row)).toEqual({
      symbol: 'USDC',
      supplyApr: 0.0412345678901,
      borrowApr: '0.05',
    });
    expect(lendingDetail({ kind: 'jl_vault', debtSymbol: null })).toEqual({ debtSymbol: null });
    expect(lendingDetail({ kind: 'kvault' })).toEqual({});
  });

  it('holds every key the lending report reads from detail, and nothing else reads detail', () => {
    const report = readFileSync('scripts/risk/lending-report.ts', 'utf8');
    const read = new Set([
      ...[...report.matchAll(/\.detail\.(\w+)/g)].map((m) => m[1]),
      // apr(k) reads layer.detail[k]
      ...[...report.matchAll(/\bapr\('(\w+)'\)/g)].map((m) => m[1]),
    ]);
    expect([...read].sort()).toEqual([...LENDING_DETAIL_KEYS].sort());
    // the one computed key is apr's
    expect([...report.matchAll(/\.detail\[/g)].length).toBe(2);
    expect(report).toMatch(
      /const apr = \(k: string\) =>\s+layer && Number\.isFinite\(Number\(layer\.detail\[k\]\)\)/,
    );
    // the API reads named columns of the table, never detail
    for (const f of [
      'apps/api/src/history.ts',
      'apps/api/src/routes/risk.ts',
      'apps/api/src/facts.ts',
    ])
      expect(readFileSync(f, 'utf8')).not.toMatch(/riskLendingSnapshots\.detail/);
  });
});
