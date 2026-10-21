import { pathToFileURL } from 'node:url';
import { createDb, marketBars } from '@colosseum/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { upsertBackfillBars } from '../risk/assets/bars-rows';
import { argValue, bytes, said, sameDatabase } from './lib-pg';

// Puts the token bars of the last days (market_bars, `pool = 'asset'`) of one database into another, once: the
// 30 days the backfill built on the Mac (PLAN-ASSETS AS.13) into the hosted database, which the asset lookups
// read (asset_price_history). Only token rows: a pool's bars are read over the last day alone (lookup-rows.ts),
// and the hosted bars job writes those. Each row goes with an empty `detail`, which the lookups never read and
// which is a third to a half of a bar's size.
//
//   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… pnpm ops:copy-token-bars --dry-run [--chain <id>] [--days 31]
//   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… pnpm ops:copy-token-bars [--chain <id>] [--days 31] [--max-mb 900]
//
// A new key is inserted; a key an earlier copy or the backfill import wrote is replaced only when it now differs;
// a row of any other source on the target (the hosted bars job's) is never touched (upsertBackfillBars). So a
// second run changes nothing. Before writing it reads the target's size and refuses a copy that would take it
// past --max-mb (default 900, under Neon's 1 GB a branch). --dry-run reads both and writes nothing. Neither
// address is printed.

export type CopyPlan = {
  chain: string;
  rows: number;
  /** The rows' size with an empty `detail`, as stored (heap; the indexes add about a quarter). */
  bytes: number;
  onTarget: number;
};

/** What a copy would add to the target, with its indexes (about a quarter more than the rows: measured locally). */
export function addedBytes(plans: readonly CopyPlan[]): number {
  return Math.round(plans.reduce((a, p) => a + p.bytes, 0) * 1.25);
}

/** Why a copy is refused, or null: the target's size after it, against the ceiling. */
export function budgetRefusal(targetBytes: number, added: number, maxMb: number): string | null {
  const after = targetBytes + added;
  return after > maxMb * 1024 ** 2
    ? `the target would hold ${bytes(after)} after the copy (now ${bytes(targetBytes)}), past --max-mb ${maxMb}`
    : null;
}

async function main(argv: string[]) {
  const known = new Set(['--dry-run', '--chain', '--days', '--max-mb']);
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown ${a}`);
  const dry = argv.includes('--dry-run');
  const only = argValue(argv, '--chain');
  const days = Number(argValue(argv, '--days') ?? 31);
  const maxMb = Number(argValue(argv, '--max-mb') ?? 900);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('--days is 1 to 31');
  if (!Number.isFinite(maxMb) || maxMb <= 0) throw new Error('--max-mb is a size in MB');
  const source = process.env.SOURCE_DATABASE_URL;
  const target = process.env.TARGET_DATABASE_URL;
  if (!source || !target)
    throw new Error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL are both needed');
  if (sameDatabase(source, target))
    throw new Error('the source and the target are the same database');
  const since = new Date(Date.now() - days * 86_400_000);
  const from = createDb(source);
  const to = createDb(target);
  try {
    const chainIs = only ? eq(marketBars.chain, only) : undefined;
    const tokenRows = and(eq(marketBars.pool, 'asset'), gte(marketBars.hour, since), chainIs);
    const counted = await from.db
      .select({
        chain: marketBars.chain,
        rows: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(pg_column_size(${marketBars}.*) - pg_column_size(${marketBars.detail}) + 2), 0)::bigint`,
      })
      .from(marketBars)
      .where(tokenRows)
      .groupBy(marketBars.chain)
      .orderBy(marketBars.chain);
    const already = await to.db
      .select({ chain: marketBars.chain, rows: sql<number>`count(*)::int` })
      .from(marketBars)
      .where(tokenRows)
      .groupBy(marketBars.chain);
    const plans: CopyPlan[] = counted.map((c) => ({
      chain: c.chain,
      rows: Number(c.rows),
      bytes: Number(c.bytes),
      onTarget: Number(already.find((a) => a.chain === c.chain)?.rows ?? 0),
    }));
    const [size] = await to.client.unsafe<{ b: string }[]>(
      'select pg_database_size(current_database())::text as b',
    );
    const targetBytes = Number(size?.b ?? 0);
    const added = addedBytes(plans);
    const refusal = budgetRefusal(targetBytes, added, maxMb);
    const head = {
      since: since.toISOString(),
      plans,
      target: { bytes: bytes(targetBytes), added: bytes(added), maxMb },
    };
    if (dry || refusal) {
      console.log(
        JSON.stringify({ dryRun: dry, ...head, ...(refusal ? { refused: refusal } : {}) }, null, 1),
      );
      if (refusal) process.exitCode = 1;
      return;
    }
    const results: Array<{ chain: string; inserted: number; replaced: number }> = [];
    for (const p of plans) {
      const rows = await from.db
        .select()
        .from(marketBars)
        .where(and(tokenRows, eq(marketBars.chain, p.chain)))
        .orderBy(marketBars.hour, marketBars.address);
      const r = await upsertBackfillBars(
        to.db,
        rows.map((row) => ({ ...row, detail: {} })),
      );
      results.push({ chain: p.chain, ...r });
    }
    console.log(JSON.stringify({ dryRun: false, ...head, results }, null, 1));
  } finally {
    await from.client.end();
    await to.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(said(e));
    process.exit(1);
  });
}
