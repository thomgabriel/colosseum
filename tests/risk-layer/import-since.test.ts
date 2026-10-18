import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, riskAssetSnapshots, riskPools } from '@colosseum/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsSince } from '../../scripts/risk/lib-import';

// DB-LOAD (Oct 18): the hourly import sent the whole newest day file again on every run (up to 39,000 pool
// rows and 60 MB), every row but the new ones skipped by the database. A run now sends only the rows from the
// table's newest imported time on. A collector stamps every row of a run with the run's start and its runs
// never overlap, so the rows at the newest time are sent again (the run may have been under way), and none
// before it. Robinhood Chain's curves share risk_asset_snapshots on their own clock, so Solana's newest is
// its own. The Jupiter quotes are no longer imported: nothing reads risk_quotes.

describe('rowsSince', () => {
  const rows = ['10:02', '10:02', '10:07', '10:07', '10:12'].map((t, i) => ({
    i,
    fetchedAt: `2026-10-14T${t}:00.000Z`,
  }));
  it('keeps every row with no newest time, and from the newest time on with one', () => {
    expect(rowsSince(rows, null, (r) => r.fetchedAt)).toEqual(rows);
    expect(
      rowsSince(rows, new Date('2026-10-14T10:07:00.000Z'), (r) => r.fetchedAt).map((r) => r.i),
    ).toEqual([2, 3, 4]);
    expect(rowsSince(rows, new Date('2026-10-14T11:00:00Z'), (r) => r.fetchedAt)).toEqual([]);
  });
  it('leaves a row whose time does not read to the insert, as before', () => {
    const odd = [{ fetchedAt: 'not a time' }, { fetchedAt: undefined }];
    expect(rowsSince(odd, new Date('2026-10-14T11:00:00Z'), (r) => r.fetchedAt)).toEqual(odd);
  });
});

const SCHEMA = `import_since_${process.pid}_${Date.now()}`;
const base = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const url = `${base}${base.includes('?') ? '&' : '?'}max=2&search_path=${encodeURIComponent(`${SCHEMA},public`)}`;
const { db, client } = createDb(url);
const home = mkdtempSync(join(tmpdir(), 'risk-import-since-'));
const DAY = '2026-10-14';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const label = { methodVersion: 'fixture', source: 'fixture', method: 'fixture' };
const curve = [{ notionalUsd: 100, outUsd: 99.5, costPct: 0.5 }];
const poolRow = (pool: string, t: string) => ({
  pool,
  fetchedAt: at(t),
  slot: 1,
  midQuotePerAsset: 100,
  sell: curve,
  buy: curve,
  ...label,
});
const assetRow = (t: string) => ({
  assetMint: 'FIXTUREimportSinceMint1111111111111111111111',
  asset: 'ISx',
  fetchedAt: at(t),
  slot: 1,
  refPool: 'IP1',
  refMidUsd: 100,
  pools: 2,
  sell: curve,
  buy: curve,
  ...label,
});
const lines = (rows: object[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

function runImport(all = false) {
  const r = spawnSync('npx', ['tsx', 'scripts/risk/import.ts'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: url,
      RISK_HOME: home,
      RISK_IMPORT_ALL: all ? '1' : '',
    },
  });
  if (r.status !== 0) throw new Error(r.stderr);
  const out = r.stdout.trim().split('\n').at(-1) as string;
  return (JSON.parse(out) as { inserted: Record<string, number> }).inserted;
}

const count = async (table: string) =>
  (
    (await db.execute(
      sql.raw(`select count(*)::int as n from "${SCHEMA}".${table}`),
    )) as unknown as [{ n: number }]
  )[0].n;

beforeAll(async () => {
  await db.execute(sql.raw(`create schema "${SCHEMA}"`));
  for (const t of [
    'risk_pools',
    'risk_pool_snapshots',
    'risk_events',
    'risk_lp_concentration',
    'risk_quotes',
    'risk_asset_snapshots',
  ])
    await db.execute(sql.raw(`create table "${SCHEMA}".${t} (like public.${t} including all)`));
  await db.insert(riskPools).values(
    ['IP1', 'IP2', 'IP3'].map((address) => ({
      address,
      program: 'fixture',
      venue: 'fixture',
      assetMint: 'FIXTUREimportSinceMint1111111111111111111111',
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
  for (const d of ['pools', 'assets', 'lp', 'quotes']) mkdirSync(join(home, d));
  writeFileSync(
    join(home, 'pools', `${DAY}.jsonl`),
    lines([
      poolRow('IP1', '10:02'),
      poolRow('IP2', '10:02'),
      poolRow('IP1', '10:07'),
      poolRow('IP2', '10:07'),
    ]),
  );
  writeFileSync(
    join(home, 'assets', `${DAY}.jsonl`),
    lines([assetRow('10:02'), assetRow('10:07')]),
  );
  writeFileSync(
    join(home, 'lp', `${DAY}.jsonl`),
    lines([
      {
        pool: 'IP1',
        fetchedAt: at('10:02'),
        asset: 'ISx',
        positions: 3,
        inBandPositions: 2,
        top1: 0.5,
        top3: 0.9,
        top10: 1,
        holderKind: 'fixture',
        bandPct: 0.02,
        lpExitN: 1,
        sellBase: curve,
        sellWithoutTopN: curve,
        ...label,
      },
    ]),
  );
  writeFileSync(
    join(home, 'events.jsonl'),
    lines([{ kind: 'lp_withdrawal', pool: 'IP1', asset: 'ISx', fetchedAt: at('10:02'), slot: 1 }]),
  );
  writeFileSync(
    join(home, 'quotes', `${DAY}.jsonl`),
    lines([
      {
        runId: 'q1',
        assetMint: 'FIXTUREimportSinceMint1111111111111111111111',
        asset: 'ISx',
        side: 'sell',
        notionalUsd: 100,
        outAmount: '1',
        fetchedAt: at('10:04'),
        ...label,
      },
    ]),
  );
});

afterAll(async () => {
  await db.execute(sql.raw(`drop schema "${SCHEMA}" cascade`));
  await client.end();
});

describe('the hourly import sends only what is new', () => {
  it('imports everything into empty tables, and no quotes', () => {
    expect(runImport()).toEqual({
      assets: 2,
      snapshots: 4,
      events: 1,
      lp: 1,
      skippedUnknownPool: 0,
      alreadySent: 0,
    });
  }, 60_000);

  it('sends again the rows at the newest time and none before it, whatever Robinhood Chain wrote', async () => {
    expect(await count('risk_quotes')).toBe(0);
    // Robinhood Chain's import wrote a newer curve than Solana's newest
    await db.insert(riskAssetSnapshots).values({
      ...assetRow('10:30'),
      assetMint: '0x00000000000000000000000000000000000000aa',
      fetchedAt: new Date(at('10:30')),
      provenance: 'live',
    });
    // the 10:07 run was still being written when the import read its file; then the 10:12 run
    appendFileSync(
      join(home, 'pools', `${DAY}.jsonl`),
      lines([poolRow('IP3', '10:07'), poolRow('IP1', '10:12'), poolRow('IP2', '10:12')]),
    );
    appendFileSync(join(home, 'assets', `${DAY}.jsonl`), lines([assetRow('10:12')]));
    expect(runImport()).toEqual({
      // the late 10:07 row and the 10:12 run
      snapshots: 3,
      // Solana's 10:12 curve, though older than Robinhood Chain's newest
      assets: 1,
      events: 0,
      lp: 0,
      skippedUnknownPool: 0,
      // the two pool rows and the curve of 10:02, before the newest imported time
      alreadySent: 3,
    });
    expect(await count('risk_pool_snapshots')).toBe(7);
    expect(await count('risk_asset_snapshots')).toBe(4);
  }, 60_000);

  it('sends every row again with RISK_IMPORT_ALL=1, and the database keeps one of each', async () => {
    expect(runImport(true)).toEqual({
      assets: 0,
      snapshots: 0,
      events: 0,
      lp: 0,
      skippedUnknownPool: 0,
      alreadySent: 0,
    });
    expect(await count('risk_pool_snapshots')).toBe(7);
    expect(await count('risk_quotes')).toBe(0);
  }, 60_000);
});
