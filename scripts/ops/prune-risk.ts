import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb } from '@colosseum/db';
import { readManifest } from './archive-manifest';
import { argValue, asDate, qualified, said } from './lib-pg';
import { agedSql, cutoffOf, newestSql, parseAt, RETENTION, type Retention } from './risk-retention';

// The daily prune of the hosted database (Thom, Oct 16): deletes the rows of each table in RETENTION
// (risk-retention.ts) that are older than its window, a batch at a time, then vacuums the table so the space
// is used again. It deletes nothing else and can run any number of times: a second run finds nothing to cut.
//
//   DATABASE_URL=… pnpm ops:prune-risk [--dry-run] [--batch 10000] [--at <ISO time>] [--archived <dir>]
//
// --archived <dir> deletes no row that is in neither the archive in <dir> (archive-risk.ts) nor the collectors'
// files: a table whose only copy is the database (`files: null`) is cut no further than its manifest's cut, and
// left whole with no manifest; a table kept in the collectors' files is cut at its window. The daily job runs the archive and then the
// prune with it. --dry-run counts what it would delete and deletes nothing. The address is read from DATABASE_URL and never
// printed. Run daily by the launchd job scripts/ops/install-prune.sh writes (com.colosseum.risk-prune).

type Sql = ReturnType<typeof createDb>['client'];

export type PruneResult = {
  table: string;
  cut: Date | null;
  deleted: number;
  batches: number;
};

/**
 * How far the archive lets a table be pruned: no limit (undefined) for a table whose rows live in the collectors'
 * files; for one whose only copy is the database, the archive manifest's cut, or null (prune nothing) without one.
 */
export function archivedLimit(
  r: Retention,
  manifestCut: string | null | undefined,
): Date | null | undefined {
  if (r.files !== null) return undefined;
  if (!manifestCut) return null;
  const d = new Date(manifestCut);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Deletes one table's old rows in batches of `batch`; counts them only when `dryRun`. */
export async function pruneTable(
  sql: Sql,
  r: Retention,
  opts: { at: Date; batch: number; dryRun: boolean; archivedTo?: Date | null },
): Promise<PruneResult> {
  const name = `${r.schema}.${r.table}`;
  const newestOf = r.exempt ? `${newestSql(r)} where not (${r.exempt})` : newestSql(r);
  const [row] = await sql.unsafe<{ t: Date | null }[]>(newestOf);
  const own = cutoffOf(r.keepHours, opts.at, asDate(row?.t));
  // never past what the archive holds; with an archive that lacks the table, nothing
  let cut = own;
  if (own && opts.archivedTo !== undefined)
    cut = opts.archivedTo && opts.archivedTo < own ? opts.archivedTo : opts.archivedTo && own;
  if (!cut) return { table: name, cut, deleted: 0, batches: 0 };
  const t = qualified(r.schema, r.table);
  const aged = agedSql(r, cut);
  if (opts.dryRun) {
    const [c] = await sql.unsafe<{ n: string }[]>(
      `select count(*)::text as n from ${t} where ${aged}`,
    );
    return { table: name, cut, deleted: Number(c?.n ?? 0), batches: 0 };
  }
  let deleted = 0;
  let batches = 0;
  for (;;) {
    // ctid batches: no index on the time column is needed, and each statement holds its locks briefly
    const res = await sql.unsafe(
      `delete from ${t} where ctid = any(array(select ctid from ${t} where ${aged} limit ${opts.batch}))`,
    );
    batches++;
    deleted += res.count;
    if (res.count < opts.batch) break;
  }
  return { table: name, cut, deleted, batches };
}

/**
 * Vacuums a table so the deleted rows' space is used again. Only the table's owner may: for another login it says
 * so and leaves the table to autovacuum, which reaches the same end later.
 */
async function vacuum(sql: Sql, r: Retention): Promise<string | null> {
  const name = qualified(r.schema, r.table);
  try {
    const [own] = await sql.unsafe<{ ok: boolean }[]>(
      `select pg_has_role(current_user, relowner, 'USAGE') as ok from pg_class where oid = '${name.replaceAll("'", "''")}'::regclass`,
    );
    if (!own?.ok) return 'this login does not own the table; autovacuum will';
    await sql.unsafe(`vacuum (analyze) ${name}`);
    return null;
  } catch (e) {
    return said(e);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--dry-run', '--batch', '--at', '--archived']);
  for (const a of argv)
    if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const dryRun = argv.includes('--dry-run');
  const batch = Number(argValue(argv, '--batch') ?? 10_000);
  if (!Number.isInteger(batch) || batch < 100 || batch > 100_000)
    throw new Error('--batch takes a whole number from 100 to 100000');
  const at = parseAt(argValue(argv, '--at'));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const archivedArg = argValue(argv, '--archived');
  const archived = archivedArg ? resolve(archivedArg) : null;
  const { client: pool } = createDb(url);
  const t0 = Date.now();
  let failed = false;
  // one connection for every statement, so the timeout set on it holds for all of them
  const sql = await pool.reserve();
  try {
    await sql.unsafe('set statement_timeout = 600000');
    for (const r of RETENTION) {
      const s = Date.now();
      try {
        let archivedTo: Date | null | undefined;
        if (archived) {
          archivedTo = archivedLimit(
            r,
            readManifest(join(archived, r.table, 'manifest.json'))?.cut,
          );
          if (archivedTo === null)
            console.log(`${r.schema}.${r.table}: not in the archive, left whole`);
        }
        const res = await pruneTable(sql, r, { at, batch, dryRun, archivedTo });
        const when = res.cut ? res.cut.toISOString() : 'none (no rows)';
        const what = dryRun
          ? `${res.deleted} rows older than the cut (dry run: nothing deleted)`
          : `${res.deleted} rows deleted in ${res.batches} batch(es)`;
        console.log(
          `${res.table}: keep ${r.keepHours} h, cut ${when}, ${what} (${((Date.now() - s) / 1000).toFixed(1)} s)`,
        );
        if (!dryRun && res.deleted > 0) {
          const w = await vacuum(sql, r);
          if (w) console.log(`${res.table}: vacuum not run (${w})`);
        }
      } catch (e) {
        failed = true;
        console.error(`${r.schema}.${r.table}: ${said(e)}`);
      }
    }
  } finally {
    sql.release();
    await pool.end();
  }
  console.log(
    JSON.stringify({
      kind: 'risk-prune',
      at: at.toISOString(),
      dryRun,
      ok: !failed,
      seconds: Math.round((Date.now() - t0) / 1000),
    }),
  );
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(said(e));
    process.exit(1);
  });
}
