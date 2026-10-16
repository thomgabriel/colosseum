import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip, createGzip, gzipSync } from 'node:zlib';
import { createDb } from '@colosseum/db';
import { type Manifest, readManifest } from './archive-manifest';
import {
  argValue,
  asDate,
  bytes,
  findPgTool,
  ident,
  qualified,
  said,
  spawnPsql,
  tsLiteral,
} from './lib-pg';
import { agedSql, cutoffOf, newestSql, parseAt, RETENTION, type Retention } from './risk-retention';

// Exports the rows the hosted database no longer keeps (older than each table's window in risk-retention.ts) to
// gzipped CSV files, one per table and UTC day, before the move or a prune drops them. It deletes nothing.
//
//   SOURCE_DATABASE_URL=… pnpm ops:archive-risk --out <dir> [--dry-run] [--at <ISO time>] [--all]
//
// By default only the tables whose rows live nowhere else (`files: null` in risk-retention.ts; today
// risk_pool_flow): the others are kept in the collectors' own files on the Mac, which no job deletes, so reading
// them out of the database again would only spend its transfer. --all archives every windowed table.
//
// <dir>/<table>/manifest.json keeps the cut up to which the table is archived, the columns and every file with
// its rows. A run archives what lies between that cut and its own: the first run everything older than the window
// (<day>.csv.gz), each later run the rows that aged since (<day>.to-<cut>.csv.gz), so the daily job before the
// prune (install-prune.sh) adds only the day's rows and never rewrites a file. A file already listed with its
// rows is not written again: a run that stopped is run again with the same --at. Use the move's --at
// (move-db.ts), so the rows the move leaves behind are exactly the rows archived here. --dry-run prints the rows
// and the estimated sizes and writes nothing. The address is read from SOURCE_DATABASE_URL (else DATABASE_URL)
// and never printed. Every statement runs without the server's statement timeout (Supabase sets 120 s).
//
// Back into a table: gunzip -c <dir>/<table>/*.csv.gz files one at a time into
//   psql -c "\copy public.<table> from stdin with (format csv, header)"

type Sql = ReturnType<typeof createDb>['client'];
type DayCount = { day: string; rows: number };

/** SQL true of the rows a run archives: older than `to`, not older than `from` (archived before). */
export function rangeSql(r: Retention, from: Date | null, to: Date): string {
  const aged = agedSql(r, to);
  return from ? `${aged} and ${ident(r.column)} >= ${tsLiteral(from)}` : aged;
}

/** The file a day's rows of one run go to. */
export function fileName(day: string, from: Date | null, to: Date): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${day}`);
  if (!from) return `${day}.csv.gz`;
  // to the millisecond: two runs' cuts never share a name
  const stamp = to.toISOString().replace(/[-:.]/g, '');
  return `${day}.to-${stamp}.csv.gz`;
}

/** Where a run starts: the manifest's cut. Null archives from the start. */
export function rangeStart(manifest: Manifest | null): Date | null {
  const prev = manifest?.cut ? new Date(manifest.cut) : null;
  if (!prev || Number.isNaN(prev.getTime())) return null;
  return prev;
}

async function daysIn(sql: Sql, r: Retention, where: string): Promise<DayCount[]> {
  const rows = await sql.unsafe<{ day: string; rows: string }[]>(
    `select to_char(${ident(r.column)} at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::text as rows
       from ${qualified(r.schema, r.table)} where ${where} group by 1 order by 1`,
  );
  return rows.map((x) => ({ day: x.day, rows: Number(x.rows) }));
}

/** The SQL that selects one day's rows of the range. */
export function daySelect(r: Retention, where: string, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${day}`);
  const start = `'${day}T00:00:00Z'::timestamptz`;
  const col = ident(r.column);
  return `select * from ${qualified(r.schema, r.table)} where ${where} and ${col} >= ${start} and ${col} < ${start} + interval '1 day'`;
}

async function columnsOf(sql: Sql, r: Retention): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select attname as name from pg_attribute
     where attrelid = ${`${r.schema}.${r.table}`}::regclass and attnum > 0 and not attisdropped
     order by attnum`;
  return rows.map((x) => x.name);
}

/** Bytes a row takes as CSV and gzipped, from a sample of up to 2,000 rows of the range. */
async function sampleSizes(
  sql: Sql,
  r: Retention,
  where: string,
): Promise<{ csv: number; gz: number }> {
  const chunks: Buffer[] = [];
  const stream = await sql
    .unsafe(
      `copy (select * from ${qualified(r.schema, r.table)} where ${where} limit 2000) to stdout with (format csv)`,
    )
    .readable();
  // collected as it comes, never paused: the driver's copy stream stalls under backpressure
  await pipeline(
    stream,
    new Writable({
      write(chunk: Buffer, _e, cb) {
        chunks.push(chunk);
        cb();
      },
    }),
  );
  const buf = Buffer.concat(chunks);
  const lines = buf.length ? buf.toString('utf8').split('\n').length - 1 : 0;
  if (!lines) return { csv: 0, gz: 0 };
  return { csv: buf.length / lines, gz: gzipSync(buf).length / lines };
}

/** The script psql runs for one file: no statement timeout, then the copy. */
export function dayScript(sel: string): string {
  return `set statement_timeout = 0;\ncopy (${sel}) to stdout with (format csv, header);\n`;
}

/** Writes one day's file through a .partial name, so a file that is there is whole. */
async function writeDay(psql: string, url: string, sel: string, file: string): Promise<number> {
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  const run = spawnPsql(psql, url, dayScript(sel));
  await Promise.all([
    run.done,
    pipeline(run.child.stdout, createGzip({ level: 6 }), createWriteStream(partial)),
  ]);
  renameSync(partial, file);
  return statSync(file).size;
}

/** Counts a gzipped CSV file's lines after the header. */
export async function gzLines(file: string): Promise<number> {
  let n = 0;
  await pipeline(
    createReadStream(file),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _e, cb) {
        for (const b of chunk) if (b === 10) n++;
        cb();
      },
    }),
  );
  return Math.max(0, n - 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--dry-run', '--out', '--at', '--all']);
  for (const a of argv)
    if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const dryRun = argv.includes('--dry-run');
  const all = argv.includes('--all');
  const outArg = argValue(argv, '--out');
  if (!outArg) throw new Error('--out <dir> names the folder the files go to');
  const out = resolve(outArg);
  const at = parseAt(argValue(argv, '--at'));
  const url = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('SOURCE_DATABASE_URL (or DATABASE_URL) is not set');
  const psql = dryRun ? '' : findPgTool('psql');
  if (psql === null)
    throw new Error('psql is needed: brew install libpq (found in /opt/homebrew/opt/libpq/bin)');
  const { client: pool } = createDb(url);
  console.log(
    `archive of rows older than each table's window, at ${at.toISOString()}${dryRun ? ' (dry run)' : ''}`,
  );
  console.log(`folder: ${out}`);
  let totalRows = 0;
  let totalCsv = 0;
  let totalGz = 0;
  // one connection for every query, so the timeout set on it holds for all of them
  const sql = await pool.reserve();
  try {
    await sql.unsafe('set statement_timeout = 0');
    for (const r of RETENTION) {
      if (r.files !== null && !all) {
        console.log(
          `${r.table}: its rows are kept in the collectors' files (${r.files}), not read here`,
        );
        continue;
      }
      const newestQ = r.exempt ? `${newestSql(r)} where not (${r.exempt})` : newestSql(r);
      const [nw] = await sql.unsafe<{ t: Date | null }[]>(newestQ);
      const to = cutoffOf(r.keepHours, at, asDate(nw?.t));
      if (!to) {
        console.log(`${r.table}: empty, nothing to archive`);
        continue;
      }
      const dir = join(out, r.table);
      const mpath = join(dir, 'manifest.json');
      const manifest = readManifest(mpath);
      const from = rangeStart(manifest);
      if (from && from.getTime() >= to.getTime()) {
        console.log(`${r.table}: archived up to ${from.toISOString()} already, nothing new`);
        continue;
      }
      const where = rangeSql(r, from, to);
      const days = await daysIn(sql, r, where);
      const rows = days.reduce((a, d) => a + d.rows, 0);
      totalRows += rows;
      const span = `${from ? `from ${from.toISOString()} ` : ''}to ${to.toISOString()}`;
      if (dryRun) {
        const per = rows ? await sampleSizes(sql, r, where) : { csv: 0, gz: 0 };
        totalCsv += per.csv * rows;
        totalGz += per.gz * rows;
        console.log(
          `${r.table}: ${span}, ${rows} rows in ${days.length} day(s)` +
            (days.length ? ` (${days[0]?.day} to ${days.at(-1)?.day})` : '') +
            `, about ${bytes(per.csv * rows)} as CSV, ${bytes(per.gz * rows)} gzipped`,
        );
        continue;
      }
      mkdirSync(dir, { recursive: true });
      const m: Manifest = manifest ?? {
        table: `${r.schema}.${r.table}`,
        cut: null,
        columns: [],
        files: {},
      };
      m.columns = await columnsOf(sql, r);
      let written = 0;
      for (const d of days) {
        const name = fileName(d.day, from, to);
        const file = join(dir, name);
        const had = m.files[name];
        if (had && had.rows === d.rows && existsSync(file)) continue;
        const size = await writeDay(psql, url, daySelect(r, where, d.day), file);
        const lines = await gzLines(file);
        // a quoted line break inside a text value adds a line, never removes one: fewer lines is a short file
        if (lines < d.rows)
          throw new Error(
            `${r.table} ${name}: the file holds ${lines} lines, the database ${d.rows} rows`,
          );
        m.files[name] = {
          day: d.day,
          rows: d.rows,
          bytes: size,
          from: from?.toISOString() ?? null,
          to: to.toISOString(),
        };
        writeFileSync(mpath, `${JSON.stringify(m, null, 2)}\n`);
        totalGz += size;
        written++;
      }
      // the cut moves only once every day of the range is written
      m.cut = to.toISOString();
      writeFileSync(mpath, `${JSON.stringify(m, null, 2)}\n`);
      console.log(
        `${r.table}: ${span}, ${rows} rows in ${days.length} day file(s), ${written} written now`,
      );
    }
  } finally {
    sql.release();
    await pool.end();
  }
  console.log(
    dryRun
      ? `total: ${totalRows} rows, about ${bytes(totalCsv)} as CSV, ${bytes(totalGz)} gzipped`
      : `total: ${totalRows} rows archived; ${bytes(totalGz)} written in this run`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(said(e));
    process.exit(1);
  });
}
