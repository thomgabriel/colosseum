import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createDb, riskAssetSnapshots } from '@colosseum/db';
import { defaultRegimeParams, type RegimeSpan, regimeAt, regimeSpans } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCurveSamples } from '../../scripts/risk/curve-read';
import {
  type CurveRow,
  curveRows,
  curveRowsFromSamples,
  type SnapshotForCurve,
} from '../../scripts/risk/curve-rows';

// `pnpm risk:compute` reads the snapshots reduced by the database (curve-read.ts) instead of the whole
// table. The rows it writes from them must be the rows `curveRows` writes from every snapshot: on the
// frozen SPYx and QQQx snapshots (compute-rows.test.ts), the same under an EVM row's labels, and a mint
// whose points carry the cases a Map keyed by notional decides (a repeated notional, a notional of zero
// or none, an outUsd that is not a number). The rows go into a table of their own schema, so no other
// test's rows are read, through a connection that rounds floats as the hosted database does
// (`extra_float_digits` = 0).
type Frozen = {
  params: { quantile: number; minSamples: number; now: string };
  poolSymbols: Array<[string, string]>;
  snapshots: Array<Omit<SnapshotForCurve, 'fetchedAt'> & { fetchedAt: string }>;
  expected: unknown[];
};
const frozen: Frozen = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk/compute/solana-snapshots.json.gz')).toString(),
);
const regimeParams = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const solana: SnapshotForCurve[] = frozen.snapshots.map((s) => ({
  ...s,
  fetchedAt: new Date(s.fetchedAt),
}));
const [SPYX] = frozen.poolSymbols.find(([, s]) => s === 'SPYx') as [string, string];
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const evm = solana
  .filter((s) => s.assetMint === SPYX)
  .map((s) => ({ ...s, assetMint: NVDA, asset: 'NVDA', methodVersion: 'evmq-0.1' }));
// the cases a Map keyed by notional decides, at times that fall in each regime
const ODD = 'FIXTUREcomputeReadOdd1111111111111111111111';
const odd: SnapshotForCurve[] = [
  '2026-10-05T14:00:00.000Z', // Mon, market hours
  '2026-10-05T23:30:00.000Z', // Mon, off hours
  '2026-10-10T15:00:00.000Z', // Sat, weekend
  '2026-11-26T15:00:00.000Z', // Thanksgiving
  '2026-11-27T17:30:00.000Z', // the day after: closed at 13:00 ET
].map((t, i) => ({
  assetMint: ODD,
  asset: 'ODDx',
  methodVersion: 'pools-0.1',
  fetchedAt: new Date(t),
  sell: [
    { notionalUsd: 100, outUsd: 99.5 - i / 10 },
    { notionalUsd: 1000, outUsd: 990 + i },
    { notionalUsd: 1000, outUsd: 980.25 + i }, // the same notional again: the last one counts
    { notionalUsd: 5000, outUsd: null }, // not a number: no sample
    { notionalUsd: 0, outUsd: 1 }, // a cost that is not finite: a sample of no grid point
    { outUsd: 3 }, // no notional: the same
    { notionalUsd: 10000, outUsd: 9800.123456789 + i * 1e-9, extra: 'kept out' },
  ],
  buy: i % 2 ? [] : [{ notionalUsd: 100, outUsd: 99.1 + i / 7, poolsUsed: 2 }],
}));

const SCHEMA = `compute_read_${process.pid}_${Date.now()}`;
const url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
/** A connection whose unqualified tables are those of `path` first, rounding floats as the hosted one does. */
const open = (path: string) =>
  createDb(
    `${url}${url.includes('?') ? '&' : '?'}max=1&extra_float_digits=0&search_path=${encodeURIComponent(path)}`,
  );
const { db, client } = open(`${SCHEMA},public`);

beforeAll(async () => {
  await db.execute(sql.raw(`create schema "${SCHEMA}"`));
  await db.execute(
    sql.raw(
      `create table "${SCHEMA}".risk_asset_snapshots (like public.risk_asset_snapshots including all)`,
    ),
  );
  const rows = [...solana, ...evm, ...odd].map((s) => ({
    assetMint: s.assetMint,
    asset: s.asset,
    fetchedAt: s.fetchedAt,
    refPool: 'fixture',
    refMidUsd: 1,
    pools: 1,
    sell: s.sell,
    buy: s.buy,
    methodVersion: s.methodVersion,
    source: 'fixture rows',
    method: 'fixture',
    provenance: 'fixture' as const,
  }));
  for (let i = 0; i < rows.length; i += 500)
    await db.insert(riskAssetSnapshots).values(rows.slice(i, i + 500));
});

afterAll(async () => {
  await db.execute(sql.raw(`drop schema "${SCHEMA}" cascade`));
  await client.end();
});

const base = {
  poolSymbols: new Map(frozen.poolSymbols),
  previous: new Map(),
  now: new Date(frozen.params.now),
  quantile: frozen.params.quantile,
  minSamples: frozen.params.minSamples,
  regimeParams,
};
const key = (r: CurveRow) => `${r.assetMint}|${r.side}|${r.regime}`;
const sorted = (rows: CurveRow[]) =>
  JSON.stringify([...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));

describe('risk:compute reads reduced snapshots and writes the same rows', () => {
  it('writes, byte for byte, the rows curveRows writes from every snapshot', async () => {
    const read = await readCurveSamples(db, { quantile: base.quantile, regimeParams });
    const fromDb = curveRowsFromSamples({ ...base, ...read });
    const fromAll = curveRows({ ...base, snapshots: [...solana, ...evm, ...odd] });
    expect(fromDb.rows.length).toBeGreaterThan(frozen.expected.length);
    expect(sorted(fromDb.rows)).toBe(sorted(fromAll.rows));
    expect(fromDb.assets).toBe(fromAll.assets);
    expect(read.snapshots).toBe(solana.length + evm.length + odd.length);
    // and the Solana rows are still the ones compute wrote before RU.8
    const spyQqq = fromDb.rows.filter((r) => r.assetMint !== NVDA && r.assetMint !== ODD);
    expect(sorted(spyQqq)).toBe(sorted(frozen.expected as CurveRow[]));
    // the odd mint met every regime, and its cases were decided as curveRows decides them
    expect(new Set(fromDb.rows.filter((r) => r.assetMint === ODD).map((r) => r.regime))).toEqual(
      new Set(['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday']),
    );
  });

  it('reads nothing and writes nothing from an empty table', async () => {
    // a schema of its own with an empty table of the same name
    const empty = open(`${SCHEMA}_none,public`);
    await db.execute(sql.raw(`create schema "${SCHEMA}_none"`));
    await db.execute(
      sql.raw(
        `create table "${SCHEMA}_none".risk_asset_snapshots (like public.risk_asset_snapshots including all)`,
      ),
    );
    try {
      const read = await readCurveSamples(empty.db, { quantile: 0.5, regimeParams });
      expect(read).toEqual({ groups: [], meta: new Map(), snapshots: 0 });
    } finally {
      await empty.client.end();
      await db.execute(sql.raw(`drop schema "${SCHEMA}_none" cascade`));
    }
  });
});

describe('regimeSpans', () => {
  it('names every minute as regimeAt does, across a clock change, a holiday and an early close', () => {
    const from = new Date('2026-10-30T00:00:00Z');
    const to = new Date('2026-11-30T00:00:00Z');
    const spans = regimeSpans(new Date(from.getTime() + 17_000), to, regimeParams);
    expect(spans[0]?.from).toEqual(from);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]?.from).toEqual(spans[i - 1]?.to);
      expect(spans[i]?.regime).not.toBe(spans[i - 1]?.regime);
    }
    expect((spans.at(-1) as RegimeSpan).to.getTime()).toBeGreaterThan(to.getTime());
    const wrong: string[] = [];
    let s = 0;
    for (let t = from.getTime(); t <= to.getTime(); t += 60_000) {
      while ((spans[s] as RegimeSpan).to.getTime() <= t) s++;
      // any second of the minute
      const at = new Date(t + ((t / 60_000) % 60) * 1000);
      if (spans[s]?.regime !== regimeAt(at, regimeParams)) wrong.push(at.toISOString());
    }
    expect(wrong).toEqual([]);
    expect(new Set(spans.map((x) => x.regime)).size).toBe(4);
  });
});
