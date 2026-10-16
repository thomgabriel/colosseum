import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
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
import { argValue, asDate, bytes, findPgTool, ident, qualified, said, spawnPsql } from './lib-pg';
import { agedSql, cutoffOf, newestSql, parseAt, RETENTION, type Retention } from './risk-retention';

// Exports the rows the hosted database no longer keeps (older than each table's window in risk-retention.ts) to
// gzipped CSV files, one per table and UTC day, before the move or a prune drops them. It deletes nothing.
//
//   SOURCE_DATABASE_URL=… pnpm ops:archive-risk --out <dir> [--dry-run] [--at <ISO time>]
//
// <dir>/<table>/<YYYY-MM-DD>.csv.gz holds the day's old rows with a header line; <dir>/<table>/manifest.json
// the rows of each file, the cut and the columns. A day whose file is there with the manifest's row count, and
// the same count in the database, is not written again, so a run that stopped can be run again. Use the same
// --at as the move (move-db.ts), so the rows the move leaves behind are exactly the rows archived here.
// --dry-run prints the rows and the estimated sizes and writes nothing. The address is read from
// SOURCE_DATABASE_URL (else DATABASE_URL) and never printed.
//
// Back into a table: gunzip -c <file> | psql -c "\copy public.<table> from stdin with (format csv, header)"

type Sql = ReturnType<typeof createDb>['client'];
type DayCount = { day: string; rows: number };
type Manifest = {
  table: string;
  cut: string;
  columns: string[];
  days: Record<string, { rows: number; bytes: number }>;
};

/** The UTC days that hold rows older than the cut, with their counts. */
export async function oldDays(sql: Sql, r: Retention, cut: Date): Promise<DayCount[]> {
  const rows = await sql.unsafe<{ day: string; rows: string }[]>(
    `select to_char(${ident(r.column)} at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::text as rows
       from ${qualified(r.schema, r.table)} where ${agedSql(r, cut)} group by 1 order by 1`,
  );
  return rows.map((x) => ({ day: x.day, rows: Number(x.rows) }));
}

/** The SQL that selects one day's old rows. */
export function daySelect(r: Retention, cut: Date, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${day}`);
  const from = `'${day}T00:00:00Z'::timestamptz`;
  const col = ident(r.column);
  return `select * from ${qualified(r.schema, r.table)} where ${agedSql(r, cut)} and ${col} >= ${from} and ${col} < ${from} + interval '1 day'`;
}

async function columnsOf(sql: Sql, r: Retention): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select attname as name from pg_attribute
     where attrelid = ${`${r.schema}.${r.table}`}::regclass and attnum > 0 and not attisdropped
     order by attnum`;
  return rows.map((x) => x.name);
}

/** Bytes a row takes as CSV and gzipped, from a sample of up to 2,000 old rows. */
async function sampleSizes(
  sql: Sql,
  r: Retention,
  cut: Date,
): Promise<{ csv: number; gz: number }> {
  const chunks: Buffer[] = [];
  const stream = await sql
    .unsafe(
      `copy (select * from ${qualified(r.schema, r.table)} where ${agedSql(r, cut)} limit 2000) to stdout with (format csv)`,
    )
    .readable();
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

function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Writes one day's file through a .partial name, so a file that is there is whole. */
async function writeDay(psql: string, url: string, sel: string, file: string): Promise<number> {
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  const run = spawnPsql(psql, url, `copy (${sel}) to stdout with (format csv, header);`);
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
  const known = new Set(['--dry-run', '--out', '--at']);
  for (const a of argv)
    if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const dryRun = argv.includes('--dry-run');
  const outArg = argValue(argv, '--out');
  if (!outArg) throw new Error('--out <dir> names the folder the files go to');
  const out = resolve(outArg);
  const at = parseAt(argValue(argv, '--at'));
  const url = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('SOURCE_DATABASE_URL (or DATABASE_URL) is not set');
  const psql = dryRun ? '' : findPgTool('psql');
  if (psql === null)
    throw new Error('psql is needed: brew install libpq (found in /opt/homebrew/opt/libpq/bin)');
  const { client: sql } = createDb(url);
  console.log(
    `archive of rows older than each table's window, at ${at.toISOString()}${dryRun ? ' (dry run)' : ''}`,
  );
  console.log(`folder: ${out}`);
  let totalRows = 0;
  let totalCsv = 0;
  let totalGz = 0;
  try {
    await sql.unsafe('set statement_timeout = 0');
    for (const r of RETENTION) {
      const newestQ = r.exempt ? `${newestSql(r)} where not (${r.exempt})` : newestSql(r);
      const [nw] = await sql.unsafe<{ t: Date | null }[]>(newestQ);
      const cut = cutoffOf(r.keepHours, at, asDate(nw?.t));
      if (!cut) {
        console.log(`${r.table}: empty, nothing to archive`);
        continue;
      }
      const days = await oldDays(sql, r, cut);
      const rows = days.reduce((a, d) => a + d.rows, 0);
      totalRows += rows;
      if (dryRun) {
        const per = rows ? await sampleSizes(sql, r, cut) : { csv: 0, gz: 0 };
        totalCsv += per.csv * rows;
        totalGz += per.gz * rows;
        console.log(
          `${r.table}: cut ${cut.toISOString()}, ${rows} rows in ${days.length} day(s)` +
            (days.length ? ` (${days[0]?.day} to ${days.at(-1)?.day})` : '') +
            `, about ${bytes(per.csv * rows)} as CSV, ${bytes(per.gz * rows)} gzipped`,
        );
        continue;
      }
      const dir = join(out, r.table);
      mkdirSync(dir, { recursive: true });
      const mpath = join(dir, 'manifest.json');
      const columns = await columnsOf(sql, r);
      const old = readManifest(mpath);
      const manifest: Manifest = {
        table: `${r.schema}.${r.table}`,
        cut: cut.toISOString(),
        columns,
        days: old?.days ?? {},
      };
      let written = 0;
      for (const d of days) {
        const file = join(dir, `${d.day}.csv.gz`);
        const had = manifest.days[d.day];
        if (had && had.rows === d.rows && existsSync(file)) continue;
        const size = await writeDay(psql, url, daySelect(r, cut, d.day), file);
        const lines = await gzLines(file);
        // a quoted line break inside a text value adds a line, never removes one: fewer lines is a short file
        if (lines < d.rows)
          throw new Error(
            `${r.table} ${d.day}: the file holds ${lines} lines, the database ${d.rows} rows`,
          );
        manifest.days[d.day] = { rows: d.rows, bytes: size };
        writeFileSync(mpath, `${JSON.stringify(manifest, null, 2)}\n`);
        totalGz += size;
        written++;
      }
      writeFileSync(mpath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(
        `${r.table}: cut ${cut.toISOString()}, ${rows} rows in ${days.length} day file(s), ${written} written now`,
      );
    }
  } finally {
    await sql.end();
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
