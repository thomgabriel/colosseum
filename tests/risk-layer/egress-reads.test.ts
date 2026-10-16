import { readFileSync } from 'node:fs';
import {
  createDb,
  type Db,
  riskAssetSnapshots,
  riskLendingPositions,
  riskLendingSnapshots,
} from '@colosseum/db';
import { defaultRegimeParams, type Regime, regimeAt } from '@colosseum/risk';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCapacitySeries, loadLendingCollateral } from '../../apps/api/src/facts';
import {
  assetHistoryPoints,
  capacityAtTau,
  HISTORY_METHOD_VERSION,
  LENDING_HISTORY_KINDS,
  lendingHistoryPoints,
  loadAssetHistory,
  loadLendingHistory,
  seriesProvenance,
} from '../../apps/api/src/history';

// The series and fact-sheet reads of risk_asset_snapshots, risk_lending_snapshots and
// risk_lending_positions now read only what they answer with: each side cut to [notionalUsd, outUsd],
// the last row of each hour or day, each market's latest hour. Each answer is held here to the answer
// the read gave before, written out below as it was (`before*`), on the same rows: several snapshots an
// hour with route detail on their points and points that are not numbers, method versions and
// provenances that change, five-minute lending rows of two kinds and two sources, markets whose latest
// hour has no USD value. The rows sit in a schema of their own, so no other test's rows are read.

const SCHEMA = `egress_reads_${process.pid}_${Date.now()}`;
const url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const { db, client } = createDb(
  `${url}${url.includes('?') ? '&' : '?'}max=2&search_path=${encodeURIComponent(`${SCHEMA},public`)}`,
);
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const snap = JSON.parse(
  readFileSync('fixtures/risk/history/asset-snapshot-tslax.json', 'utf8'),
) as {
  sell: Array<{ notionalUsd: number; outUsd: number }>;
  buy: Array<{ notionalUsd: number; outUsd: number }>;
};

const MINT = 'FIXTUREegressMint11111111111111111111111111';
const ACCOUNT = 'FIXTUREegressLending1111111111111111111111';
const SYMBOL = 'EGRx';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const MIN = 60_000;
const label = { source: 'fixture rows', method: 'fixture' };

// ------------------------------------------------------------------ the reads as they were

async function beforeAssetHistory(
  db: Db,
  mint: string,
  opts: { days: number; tau: number; now: Date },
) {
  const rows = await db
    .select({
      fetchedAt: riskAssetSnapshots.fetchedAt,
      sell: riskAssetSnapshots.sell,
      buy: riskAssetSnapshots.buy,
      refMidUsd: riskAssetSnapshots.refMidUsd,
      pools: riskAssetSnapshots.pools,
      source: riskAssetSnapshots.source,
      method: riskAssetSnapshots.method,
      methodVersion: riskAssetSnapshots.methodVersion,
      provenance: riskAssetSnapshots.provenance,
    })
    .from(riskAssetSnapshots)
    .where(
      and(
        eq(riskAssetSnapshots.assetMint, mint),
        gte(riskAssetSnapshots.fetchedAt, new Date(opts.now.getTime() - opts.days * 86_400_000)),
        lte(riskAssetSnapshots.fetchedAt, opts.now),
      ),
    )
    .orderBy(asc(riskAssetSnapshots.fetchedAt));
  const points = assetHistoryPoints(rows, opts.tau, P);
  const head = rows.at(-1);
  const versions = [...new Set(rows.map((r) => r.methodVersion))].sort();
  return {
    points,
    source: `risk_asset_snapshots (${head ? `${head.source}; ${head.method}` : 'no rows in window'}${versions.length ? `; snapshot method ${versions.join(', ')}` : ''})`,
    provenance: seriesProvenance(rows.map((r) => r.provenance)),
  };
}

async function beforeLendingHistory(db: Db, account: string, opts: { days: number; now: Date }) {
  const resolution = opts.days <= 14 ? ('hour' as const) : ('day' as const);
  const rows = await db
    .select({
      observedAt: riskLendingSnapshots.observedAt,
      kind: riskLendingSnapshots.kind,
      available: riskLendingSnapshots.available,
      priceUsd: riskLendingSnapshots.priceUsd,
      suppliedUsd: riskLendingSnapshots.suppliedUsd,
      borrowedUsd: riskLendingSnapshots.borrowedUsd,
      shareLentOut: riskLendingSnapshots.shareLentOut,
      supplyApy: riskLendingSnapshots.supplyApy,
      borrowApy: riskLendingSnapshots.borrowApy,
      usdNullReason: riskLendingSnapshots.usdNullReason,
      source: riskLendingSnapshots.source,
      method: riskLendingSnapshots.method,
      provenance: riskLendingSnapshots.provenance,
    })
    .from(riskLendingSnapshots)
    .where(
      and(
        eq(riskLendingSnapshots.account, account),
        inArray(riskLendingSnapshots.kind, LENDING_HISTORY_KINDS),
        gte(riskLendingSnapshots.observedAt, new Date(opts.now.getTime() - opts.days * 86_400_000)),
        lte(riskLendingSnapshots.observedAt, opts.now),
      ),
    )
    .orderBy(asc(riskLendingSnapshots.observedAt));
  const points = lendingHistoryPoints(rows, resolution);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const sources = [...new Set(rows.map((r) => `${r.source}; ${r.method}`))];
  return {
    resolution,
    points,
    source: `risk_lending_snapshots (${kinds.length ? kinds.join(', ') : 'no rows in window'}${sources.length ? `: ${sources.join(' | ')}` : ''})`,
    provenance: seriesProvenance(rows.map((r) => r.provenance)),
  };
}

async function beforeCapacity(db: Db, mint: string, from: Date, tau: number) {
  const snaps = await db
    .select({
      fetchedAt: riskAssetSnapshots.fetchedAt,
      sell: riskAssetSnapshots.sell,
      source: riskAssetSnapshots.source,
      methodVersion: riskAssetSnapshots.methodVersion,
      provenance: riskAssetSnapshots.provenance,
    })
    .from(riskAssetSnapshots)
    .where(and(eq(riskAssetSnapshots.assetMint, mint), gte(riskAssetSnapshots.fetchedAt, from)));
  const series: Partial<Record<Regime, number[]>> = {};
  for (const s of snaps) {
    const cap = capacityAtTau(s.sell, tau).capacityUsd;
    if (cap === null) continue;
    const r = regimeAt(s.fetchedAt, P);
    const xs = series[r] ?? [];
    xs.push(cap);
    series[r] = xs;
  }
  const lastSnap = snaps.reduce<(typeof snaps)[number] | null>(
    (a, s) => (!a || s.fetchedAt > a.fetchedAt ? s : a),
    null,
  );
  return {
    byRegime: series,
    last: lastSnap && {
      fetchedAt: lastSnap.fetchedAt,
      methodVersion: lastSnap.methodVersion,
      provenance: lastSnap.provenance,
    },
  };
}

async function beforeCollateral(db: Db, symbol: string, now: Date) {
  const posRows = await db
    .select()
    .from(riskLendingPositions)
    .where(
      and(
        eq(riskLendingPositions.collateralAsset, symbol),
        gte(riskLendingPositions.observedAt, new Date(now.getTime() - 2 * 86_400_000)),
      ),
    )
    .orderBy(desc(riskLendingPositions.observedAt));
  const latestByMarket = new Map<string, (typeof posRows)[number]>();
  for (const r of posRows)
    if (r.collateralUsd !== null && !latestByMarket.has(r.market)) latestByMarket.set(r.market, r);
  const latest = [...latestByMarket.values()];
  return latest.length
    ? {
        usd: latest.reduce((a, r) => a + (r.collateralUsd as number), 0),
        fetchedAt: new Date(Math.min(...latest.map((r) => r.observedAt.getTime()))).toISOString(),
        source: `risk_lending_positions (${latest.length} markets, each market's latest hour)`,
        method: (latest[0] as (typeof latest)[number]).method,
        methodVersion: (latest[0] as (typeof latest)[number]).methodVersion,
        provenance: (latest[0] as (typeof latest)[number]).provenance,
      }
    : null;
}

// ------------------------------------------------------------------ the rows

const like = (t: string) =>
  db.execute(sql.raw(`create table "${SCHEMA}".${t} (like public.${t} including all)`));

beforeAll(async () => {
  await db.execute(sql.raw(`create schema "${SCHEMA}"`));
  for (const t of [
    'risk_asset_snapshots',
    'risk_lending_snapshots',
    'risk_lending_facts',
    'risk_lending_positions',
  ])
    await like(t);

  // three days of snapshots, one every 17 minutes: two or three an hour
  const snaps = Array.from({ length: (3 * 24 * 60) / 17 }, (_, i) => {
    const f = 1 - (i % 11) / 400; // the depth moves from row to row
    const sell = snap.sell.map((p) => ({ ...p, outUsd: p.outUsd * f, pool: `P${i % 3}` }));
    if (i % 5 === 0) sell.push({ notionalUsd: 1e6, outUsd: null as unknown as number, pool: 'x' });
    if (i % 7 === 0) sell.push({ ...(sell[1] as (typeof sell)[number]), outUsd: 1 }); // a repeated notional
    return {
      assetMint: MINT,
      asset: SYMBOL,
      fetchedAt: new Date(NOW.getTime() - 3 * 86_400_000 + i * 17 * MIN + 3_123),
      refPool: 'fixture',
      refMidUsd: 100 + i / 3,
      pools: 1 + (i % 4),
      sell,
      // some rows' buy side has no finite point
      buy: i % 9 === 0 ? snap.buy.map((p) => ({ ...p, outUsd: null })) : snap.buy,
      methodVersion: i < 100 ? 'pools-0.1' : 'pools-0.2',
      source: i < 150 ? 'collector one' : 'collector two',
      method: label.method,
      provenance:
        i === 120 ? ('fixture' as const) : i === 200 ? ('mock' as const) : ('live' as const),
    };
  });
  await db.insert(riskAssetSnapshots).values(snaps);

  // twenty days of lending rows: hourly reconstructed, and live five-minute rows over the last two days
  const lend = [
    ...Array.from({ length: 20 * 24 }, (_, i) => ({
      t: NOW.getTime() - 20 * 86_400_000 + i * 60 * MIN + 30_000,
      kind: 'kamino_reserve_hourly',
      source: 'reconstructed',
      i,
    })),
    ...Array.from({ length: 2 * 24 * 12 }, (_, i) => ({
      t: NOW.getTime() - 2 * 86_400_000 + i * 5 * MIN + 7_000,
      kind: 'kamino_reserve',
      source: 'live collector',
      i,
    })),
  ];
  for (let k = 0; k < lend.length; k += 500)
    await db.insert(riskLendingSnapshots).values(
      lend.slice(k, k + 500).map((r) => ({
        account: ACCOUNT,
        observedAt: new Date(r.t),
        kind: r.kind,
        chain: 'solana',
        venue: 'kamino',
        market: 'Fixture Market',
        symbol: 'USDC',
        available: r.i % 13 === 0 ? null : 1000 + r.i,
        shareLentOut: r.i / 1000,
        supplyApy: 0.01 + r.i / 1e5,
        borrowApy: 0.02 + r.i / 1e5,
        priceUsd: r.i % 17 === 0 ? null : 1,
        suppliedUsd: r.i % 17 === 0 ? null : 5000 + r.i,
        borrowedUsd: r.i % 17 === 0 ? null : 3000 + r.i,
        usdNullReason: r.i % 17 === 0 ? 'stale' : null,
        detail: {},
        methodVersion: 'fixture',
        source: r.source,
        method: label.method,
        fetchedAt: new Date(r.t),
        provenance:
          r.i === 40 && r.kind === 'kamino_reserve_hourly'
            ? ('fixture' as const)
            : ('live' as const),
      })),
    );

  // hourly positions in three markets; one market's latest hour has no USD value, one is older than two days
  const pos = ['Market A', 'Market B', 'Market C'].flatMap((market, m) =>
    Array.from({ length: 72 }, (_, h) => {
      const t = new Date(NOW.getTime() - (h + 1) * 60 * MIN - (m === 2 ? 3 * 86_400_000 : 0));
      return {
        market,
        collateralAsset: SYMBOL,
        observedAt: t,
        chain: 'solana',
        venue: 'kamino',
        positions: 3,
        collateralUnits: 10,
        collateralUsd: m === 1 && h < 2 ? null : 1000 * (m + 1) + h,
        ltvBucketsPct: {},
        buckets: {},
        ltvNull: 0,
        ltvNullUnits: 0,
        methodVersion: `positions-0.${m + 1}`,
        source: 'fixture rows',
        method: `method ${m}`,
        fetchedAt: t,
        provenance: 'live' as const,
      };
    }),
  );
  await db.insert(riskLendingPositions).values(pos);
});

afterAll(async () => {
  await db.execute(sql.raw(`drop schema "${SCHEMA}" cascade`));
  await client.end();
});

// ------------------------------------------------------------------ the same answers

describe('the reads cut to what they answer with give the answers they gave', () => {
  it('asset history: the same points, source and provenance', async () => {
    for (const [days, tau] of [
      [1, 0.01],
      [2, 0.0025],
      [30, 0.05],
    ] as const) {
      const now = days === 2 ? new Date(NOW.getTime() - 5 * 3_600_000) : NOW;
      const was = await beforeAssetHistory(db, MINT, { days, tau, now });
      const is = await loadAssetHistory(db, MINT, { days, tau, now, regimeParams: P });
      expect(was.points.length).toBeGreaterThan(10);
      expect(JSON.stringify(is.points)).toBe(JSON.stringify(was.points));
      expect(is.source).toBe(was.source);
      expect(is.provenance).toBe(was.provenance);
      expect(is.methodVersion).toBe(HISTORY_METHOD_VERSION);
    }
    // the window held a fixture row before a mock one, and both versions
    const all = await loadAssetHistory(db, MINT, {
      days: 30,
      tau: 0.01,
      now: NOW,
      regimeParams: P,
    });
    expect(all.provenance).toBe('fixture');
    expect(all.source).toBe(
      'risk_asset_snapshots (collector two; fixture; snapshot method pools-0.1, pools-0.2)',
    );
    // nothing in the window
    const none = await loadAssetHistory(db, MINT, {
      days: 1,
      tau: 0.01,
      now: new Date('2026-01-01T00:00:00Z'),
      regimeParams: P,
    });
    const wasNone = await beforeAssetHistory(db, MINT, {
      days: 1,
      tau: 0.01,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect([none.points, none.source, none.provenance]).toEqual([
      wasNone.points,
      wasNone.source,
      wasNone.provenance,
    ]);
  });

  it('lending history: the same points, source and provenance, hourly and daily', async () => {
    for (const days of [1, 7, 14, 30]) {
      const was = await beforeLendingHistory(db, ACCOUNT, { days, now: NOW });
      const is = await loadLendingHistory(db, ACCOUNT, { days, now: NOW });
      expect(is?.resolution).toBe(was.resolution);
      expect(was.points.length).toBeGreaterThan(10);
      expect(JSON.stringify(is?.points)).toBe(JSON.stringify(was.points));
      expect(is?.source).toBe(was.source);
      expect(is?.provenance).toBe(was.provenance);
    }
    expect((await loadLendingHistory(db, ACCOUNT, { days: 30, now: NOW }))?.provenance).toBe(
      'fixture',
    );
  });

  it('fact sheet: the same capacity series and the same lending collateral', async () => {
    for (const [hours, tau] of [
      [24 * 7, 0.01],
      [30, 0.0025],
    ] as const) {
      const from = new Date(NOW.getTime() - hours * 3_600_000);
      const was = await beforeCapacity(db, MINT, from, tau);
      const is = await loadCapacitySeries(db, MINT, from, tau, P);
      const sorted = (x: typeof was.byRegime) =>
        Object.fromEntries(
          Object.entries(x)
            .sort()
            .map(([k, v]) => [k, [...(v ?? [])].sort((a, b) => a - b)]),
        );
      expect(Object.keys(was.byRegime).length).toBeGreaterThan(0);
      expect(sorted(is.byRegime)).toEqual(sorted(was.byRegime));
      expect(is.last).toEqual(was.last);
    }
    for (const now of [NOW, new Date(NOW.getTime() - 90 * MIN), new Date('2026-01-01T00:00:00Z')]) {
      const was = await beforeCollateral(db, SYMBOL, now);
      expect(await loadLendingCollateral(db, SYMBOL, now)).toEqual(was);
    }
    expect((await loadLendingCollateral(db, SYMBOL, NOW))?.source).toContain('2 markets');
  });
});
