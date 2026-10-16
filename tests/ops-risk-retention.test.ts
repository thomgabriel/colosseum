import * as db from '@colosseum/db';
import { createDb } from '@colosseum/db';
import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asDate, pgEnvOf, sameDatabase } from '../scripts/ops/lib-pg';
import { cleanDump, describePlan, type TablePlan } from '../scripts/ops/move-db';
import { pruneTable } from '../scripts/ops/prune-risk';
import {
  agedSql,
  cutoffOf,
  importFloor,
  KEPT_WHOLE,
  parseAt,
  RETENTION,
  type Retention,
} from '../scripts/ops/risk-retention';

const H = 3_600_000;
const T = new Date('2026-10-16T12:00:00Z');

describe('retention: the cut', () => {
  it('cuts keepHours before now when the table is up to date', () => {
    expect(cutoffOf(96, T, new Date(T.getTime() - 5 * 60_000))?.toISOString()).toBe(
      new Date(T.getTime() - 5 * 60_000 - 96 * H).toISOString(),
    );
    expect(cutoffOf(96, T, T)?.toISOString()).toBe('2026-10-12T12:00:00.000Z');
  });

  it("cuts from the table's newest row when its collector stopped, so the last window stays", () => {
    const newest = new Date('2026-10-10T00:00:00Z');
    expect(cutoffOf(96, T, newest)?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });

  it('never cuts from a row in the future', () => {
    expect(cutoffOf(48, T, new Date('2027-01-01T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-14T12:00:00.000Z',
    );
  });

  it('cuts nothing from an empty table and refuses a window of zero', () => {
    expect(cutoffOf(96, T, null)).toBeNull();
    expect(() => cutoffOf(0, T, T)).toThrow();
    expect(() => cutoffOf(Number.NaN, T, T)).toThrow();
  });

  it('reads --at only as an ISO time with its zone, and never in the future', () => {
    expect(parseAt(undefined, T)).toBe(T);
    expect(parseAt('2026-10-16T09:00:00Z', T).toISOString()).toBe('2026-10-16T09:00:00.000Z');
    expect(parseAt('2026-10-16T09:00:00-03:00', T).toISOString()).toBe('2026-10-16T12:00:00.000Z');
    expect(() => parseAt('2026-10-16', T)).toThrow();
    expect(() => parseAt('2026-10-16T09:00:00', T)).toThrow();
    expect(() => parseAt('2026-10-17T09:00:00Z', T)).toThrow(/future/);
  });

  it('keeps the reconstructed lending history out of the cut', () => {
    const r = RETENTION.find((x) => x.table === 'risk_lending_snapshots') as Retention;
    expect(agedSql(r, T)).toBe(
      `("observed_at" < '2026-10-16T12:00:00.000Z'::timestamptz and not (kind like '%\\_hourly'))`,
    );
  });

  it('lets an importer write nothing older than the window (the prune would delete it again)', () => {
    expect(importFloor('risk_lending_snapshots', T)?.toISOString()).toBe(
      '2026-10-12T12:00:00.000Z',
    );
    expect(importFloor('risk_asset_snapshots', T)?.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(importFloor('risk_lending_positions', T)).toBeNull();
  });
});

describe('retention: every growing table has a decision', () => {
  const tables = new Map<string, PgTable>();
  for (const v of Object.values(db)) if (isTable(v)) tables.set(getTableName(v), v as PgTable);

  it('names each risk table in RETENTION or KEPT_WHOLE, never both', () => {
    const risky = [...tables.keys()].filter(
      (n) => n.startsWith('risk_') || n === 'asset_observations' || n === 'market_bars',
    );
    expect(risky.length).toBeGreaterThan(15);
    for (const n of risky) {
      const cut = RETENTION.some((r) => r.table === n);
      const whole = n in KEPT_WHOLE;
      expect({ n, decided: cut !== whole }).toEqual({ n, decided: true });
    }
  });

  it('ages each windowed table by a timestamp column it has, by four days for raw readings', () => {
    for (const r of RETENTION) {
      const t = tables.get(r.table);
      expect(t, r.table).toBeDefined();
      const col = getTableConfig(t as PgTable).columns.find((c) => c.name === r.column);
      expect(col?.getSQLType(), `${r.table}.${r.column}`).toBe('timestamp with time zone');
      expect(r.schema).toBe('public');
      expect(r.keepHours).toBeGreaterThanOrEqual(48);
    }
    const hours = Object.fromEntries(RETENTION.map((r) => [r.table, r.keepHours]));
    expect(hours.risk_pool_snapshots).toBe(96);
    expect(hours.risk_lending_snapshots).toBe(96);
    expect(hours.risk_asset_snapshots).toBe(168);
  });
});

describe('the move: what it changes in a dump and what it says', () => {
  it('drops row-level security, extensions and the comment on public, and makes no schema twice', () => {
    const dump = [
      'CREATE SCHEMA drizzle;',
      'CREATE SCHEMA public;',
      "COMMENT ON SCHEMA public IS 'standard public schema';",
      'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;',
      'CREATE TABLE public.goals (id uuid DEFAULT gen_random_uuid() NOT NULL);',
      'ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE ONLY public.goals FORCE ROW LEVEL SECURITY;',
    ].join('\n');
    expect(cleanDump(dump).split('\n')).toEqual([
      'CREATE SCHEMA IF NOT EXISTS drizzle;',
      'CREATE SCHEMA IF NOT EXISTS public;',
      'CREATE TABLE public.goals (id uuid DEFAULT gen_random_uuid() NOT NULL);',
    ]);
  });

  it('states the size after the move and the days of room in the budget', () => {
    const mb = 1024 * 1024;
    const plan: TablePlan[] = [
      {
        schema: 'public',
        table: 'risk_pool_snapshots',
        columns: [],
        where: '(true)',
        cut: T,
        rowsAll: 1000,
        rowsKept: 400,
        bytesAll: 500 * mb,
        bytesPerDay: 50 * mb,
      },
      {
        schema: 'public',
        table: 'goals',
        columns: [],
        where: null,
        cut: null,
        rowsAll: 3,
        rowsKept: 3,
        bytesAll: 10 * mb,
        bytesPerDay: 0,
      },
    ];
    const text = describePlan(plan, 1024 * mb).join('\n');
    expect(text).toContain('on the target about 210.0 MB');
    expect(text).toContain('grow about 50.0 MB a day');
    expect(text).toContain('stays near 260.0 MB');
    expect(text).toContain('about 15.3 days of growth');
  });

  it('hands an address to the tools as PG* variables, decoded, and compares databases without passwords', () => {
    const env = pgEnvOf(
      'postgresql://neondb_owner:p%40ss@ep-x.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    );
    expect(env).toEqual({
      PGHOST: 'ep-x.us-west-2.aws.neon.tech',
      PGUSER: 'neondb_owner',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'neondb',
      PGSSLMODE: 'require',
      PGCHANNELBINDING: 'require',
    });
    expect(() => pgEnvOf('https://example.com')).toThrow(/not a connection address/);
    expect(sameDatabase('postgres://a:1@h:5432/d', 'postgres://b:2@h/d')).toBe(true);
    expect(sameDatabase('postgres://a:1@h:5432/d', 'postgres://a:1@h2:5432/d')).toBe(false);
  });

  it("reads the driver's times whether it parsed them or not", () => {
    expect(asDate('2026-10-16 12:00:00.5+00')?.toISOString()).toBe('2026-10-16T12:00:00.500Z');
    expect(asDate(T)).toBe(T);
    expect(asDate(null)).toBeNull();
  });
});

// The prune against Postgres, on tables of its own schema so no other test's rows are touched.
describe('the prune on a database', () => {
  const { client: sql } = createDb();
  const schema = `prune_test_${process.pid}`;
  const r: Retention = {
    schema,
    table: 'readings',
    column: 'fetched_at',
    keepHours: 96,
    exempt: "kind like '%\\_hourly'",
    why: 'test',
  };
  const newest = new Date('2026-10-16T11:55:00Z');

  beforeAll(async () => {
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(
      `create table ${schema}.readings (id serial primary key, fetched_at timestamptz not null, kind text not null)`,
    );
    // a reading every hour for ten days up to `newest`, and old hourly history that never ages out
    await sql.unsafe(
      `insert into ${schema}.readings (fetched_at, kind)
       select '${newest.toISOString()}'::timestamptz - g * interval '1 hour', 'live' from generate_series(0, 239) g
       union all
       select '2026-09-01T00:00:00Z'::timestamptz + g * interval '1 hour', 'kamino_reserve_hourly' from generate_series(0, 9) g`,
    );
  });
  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });

  it('counts without deleting on a dry run', async () => {
    const res = await pruneTable(sql, r, { at: T, batch: 1000, dryRun: true });
    expect(res.cut?.toISOString()).toBe('2026-10-12T11:55:00.000Z');
    expect(res.deleted).toBe(240 - 97);
    const [c] = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from ${schema}.readings`,
    );
    expect(c?.n).toBe(250);
  });

  it('deletes in batches exactly the rows older than the window, keeping the exempt history', async () => {
    const res = await pruneTable(sql, r, { at: T, batch: 50, dryRun: false });
    expect(res.deleted).toBe(143);
    expect(res.batches).toBe(3);
    const [c] = await sql.unsafe<{ live: number; hourly: number; oldest: Date | string }[]>(
      `select count(*) filter (where kind = 'live')::int as live,
              count(*) filter (where kind <> 'live')::int as hourly,
              min(fetched_at) filter (where kind = 'live') as oldest
         from ${schema}.readings`,
    );
    expect(c?.live).toBe(97);
    expect(c?.hourly).toBe(10);
    expect(asDate(c?.oldest)?.toISOString()).toBe('2026-10-12T11:55:00.000Z');
  });

  it('finds nothing to delete when run again', async () => {
    const res = await pruneTable(sql, r, { at: T, batch: 50, dryRun: false });
    expect(res.deleted).toBe(0);
  });

  it('keeps the last window of a table whose collector stopped days ago', async () => {
    const later = new Date('2026-10-30T00:00:00Z');
    const res = await pruneTable(sql, r, { at: later, batch: 50, dryRun: false });
    expect(res.cut?.toISOString()).toBe('2026-10-12T11:55:00.000Z');
    expect(res.deleted).toBe(0);
  });
});
