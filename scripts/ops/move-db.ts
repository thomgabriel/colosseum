import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb } from '@colosseum/db';
import {
  argValue,
  asDate,
  bytes,
  findPgTool,
  ident,
  majorOf,
  qualified,
  said,
  sameDatabase,
  spawnPsql,
  toolEnv,
  toolMajor,
  tsLiteral,
} from './lib-pg';
import { cutoffOf, keptSql, newestSql, parseAt, retentionOf } from './risk-retention';

// Moves the app's database to another server (Supabase to Neon, Oct 16), keeping only the retention window
// of the tables that grow by the hour (risk-retention.ts). Run by a person:
//
//   SOURCE_DATABASE_URL=… pnpm ops:move-db --dry-run [--at <ISO time>] [--budget-mb 1024]
//   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… pnpm ops:move-db --record <file> [--at <ISO time>]
//   SOURCE_DATABASE_URL=… pnpm ops:move-db --recount --record <file>
//   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… pnpm ops:move-db --grants-only
//
// What it copies: the schemas `public` and `drizzle` (so drizzle finds every migration applied) and any other
// schema of ours, never the platform's (auth, storage, realtime, extensions, vault, graphql and the rest);
// every table in full, except the tables in RETENTION, which keep only their window; the sequences' values; the
// indexes and constraints; the grants of our own roles that exist on the target. It leaves out extensions,
// row-level security (enabled on Supabase only to shut its Data API) and ownership: the target's login owns
// what it creates. Then it compares every table's rows with the source, read in one snapshot.
//
// The rows come from one read-only snapshot of the source, so the counts it checks are exact; stop the writers
// first (docs: scripts/ops/README.md). The target must hold none of these schemas' tables: it adds, never
// replaces. --record <file> keeps the counts it checked; after the switch, --recount counts the tables kept
// whole on the source again and names any that changed (a write the move missed). --dry-run prints the plan and
// the sizes and touches nothing; it needs no target. The addresses are
// read from the environment and never printed; pg_dump and psql get them through PG* variables, not their
// command line. Needs pg_dump and psql 17 or newer (`brew install libpq`).

type Sql = ReturnType<typeof createDb>['client'];

/** Schemas a hosted platform owns: never copied. */
export const PLATFORM_SCHEMAS = new Set([
  'auth',
  'storage',
  'realtime',
  '_realtime',
  'extensions',
  'graphql',
  'graphql_public',
  'pgbouncer',
  'vault',
  'supabase_migrations',
  'supabase_functions',
  'net',
  'pgsodium',
  'pgsodium_masks',
  'cron',
  '_analytics',
  'information_schema',
]);

/** Roles a hosted platform owns: their grants are never copied. */
export const PLATFORM_ROLES = new Set([
  'postgres',
  'anon',
  'authenticated',
  'service_role',
  'authenticator',
  'dashboard_user',
  'pgbouncer',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_functions_admin',
  'supabase_realtime_admin',
  'supabase_replication_admin',
  'supabase_read_only_user',
  'supabase_etl_admin',
  'supabase_privileged_role',
  'pg_database_owner',
]);

export type TablePlan = {
  schema: string;
  table: string;
  columns: string[];
  /** SQL true of the rows copied; null copies every row. */
  where: string | null;
  cut: Date | null;
  rowsAll: number;
  rowsKept: number;
  bytesAll: number;
  /** Bytes the window's newest day takes, for a table with a window. */
  bytesPerDay: number;
};

/**
 * What pg_dump wrote, made fit for a fresh database on another platform: row-level security, extensions and the
 * comment on `public` dropped; a schema that is already there not made twice.
 */
export function cleanDump(dump: string): string {
  return dump
    .split('\n')
    .filter(
      (l) =>
        !/^ALTER TABLE (ONLY )?\S+ (ENABLE|FORCE) ROW LEVEL SECURITY;$/.test(l) &&
        !/^(CREATE|COMMENT ON) EXTENSION /.test(l) &&
        !/^COMMENT ON SCHEMA public IS /.test(l),
    )
    .map((l) => l.replace(/^CREATE SCHEMA (\S+);$/, 'CREATE SCHEMA IF NOT EXISTS $1;'))
    .join('\n');
}

/** The grant statement of one privilege of one role on one object. */
export function grantSql(
  kind: 'table' | 'sequence' | 'schema',
  schema: string,
  name: string,
  privilege: string,
  role: string,
): string {
  const role_ = ident(role);
  if (kind === 'schema') return `GRANT ${privilege} ON SCHEMA ${ident(schema)} TO ${role_};`;
  return `GRANT ${privilege} ON ${kind === 'table' ? 'TABLE' : 'SEQUENCE'} ${qualified(schema, name)} TO ${role_};`;
}

const DEFAULT_OBJECTS: Record<string, string> = {
  r: 'TABLES',
  S: 'SEQUENCES',
  f: 'FUNCTIONS',
  T: 'TYPES',
};

async function schemasOf(sql: Sql): Promise<{ copy: string[]; skip: string[] }> {
  const rows = await sql<{ n: string }[]>`
    select nspname as n from pg_namespace
     where nspname not like 'pg\\_%' order by nspname`;
  const copy: string[] = [];
  const skip: string[] = [];
  for (const { n } of rows) (PLATFORM_SCHEMAS.has(n) ? skip : copy).push(n);
  return { copy, skip };
}

/** Every table of the schemas, what is copied of it, its rows and its size, read through `sql`. */
export async function planTables(sql: Sql, schemas: string[], at: Date): Promise<TablePlan[]> {
  const tables = await sql<{ s: string; t: string; oid: number; b: string }[]>`
    select n.nspname as s, c.relname as t, c.oid::int as oid, pg_total_relation_size(c.oid)::text as b
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname = any(${schemas})
     order by pg_total_relation_size(c.oid) desc, 1, 2`;
  const out: TablePlan[] = [];
  for (const t of tables) {
    const cols = await sql<{ c: string }[]>`
      select attname as c from pg_attribute
       where attrelid = ${t.oid} and attnum > 0 and not attisdropped and attgenerated = ''
       order by attnum`;
    const name = qualified(t.s, t.t);
    const r = retentionOf(t.s, t.t);
    const bytesAll = Number(t.b);
    if (!r) {
      const [c] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${name}`);
      const n = Number(c?.n ?? 0);
      out.push({
        schema: t.s,
        table: t.t,
        columns: cols.map((x) => x.c),
        where: null,
        cut: null,
        rowsAll: n,
        rowsKept: n,
        bytesAll,
        bytesPerDay: 0,
      });
      continue;
    }
    const newestQ = r.exempt ? `${newestSql(r)} where not (${r.exempt})` : newestSql(r);
    const [nw] = await sql.unsafe<{ t: Date | null }[]>(newestQ);
    const newest = asDate(nw?.t);
    const cut = cutoffOf(r.keepHours, at, newest, r.hourAligned);
    const where = cut ? keptSql(r, cut) : null;
    const dayAgo = newest ? new Date(newest.getTime() - 86_400_000) : null;
    const [c] = await sql.unsafe<{ all: string; kept: string; day: string }[]>(
      `select count(*)::text as all,
              count(*) filter (where ${where ?? 'true'})::text as kept,
              count(*) filter (where ${dayAgo ? `${ident(r.column)} >= ${tsLiteral(dayAgo)}` : 'false'})::text as day
         from ${name}`,
    );
    const all = Number(c?.all ?? 0);
    out.push({
      schema: t.s,
      table: t.t,
      columns: cols.map((x) => x.c),
      where,
      cut,
      rowsAll: all,
      rowsKept: Number(c?.kept ?? 0),
      bytesAll,
      bytesPerDay: all ? (bytesAll * Number(c?.day ?? 0)) / all : 0,
    });
  }
  return out;
}

const keptBytes = (p: TablePlan) =>
  p.rowsAll ? (p.bytesAll * p.rowsKept) / p.rowsAll : p.bytesAll;

/** The plan as a person reads it, with the size it leaves and the room in `budget` bytes. */
export function describePlan(plan: TablePlan[], budget: number): string[] {
  const lines: string[] = [];
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  lines.push(
    `${pad('table', 40)}${pad('copied', 34)}${pad('rows kept / all', 22)}size now -> after`,
  );
  for (const p of plan) {
    const what = p.where
      ? `from ${p.cut?.toISOString().slice(0, 16)}Z on`
      : retentionOf(p.schema, p.table)
        ? 'empty'
        : 'whole';
    lines.push(
      `${pad(`${p.schema}.${p.table}`, 40)}${pad(what, 34)}${pad(`${p.rowsKept} / ${p.rowsAll}`, 22)}${bytes(p.bytesAll)} -> ${bytes(keptBytes(p))}`,
    );
  }
  const now = plan.reduce((a, p) => a + p.bytesAll, 0);
  const after = plan.reduce((a, p) => a + keptBytes(p), 0);
  const day = plan.reduce((a, p) => a + p.bytesPerDay, 0);
  lines.push('');
  lines.push(`tables now ${bytes(now)}; on the target about ${bytes(after)} (indexes included)`);
  lines.push(
    `the windowed tables grow about ${bytes(day)} a day; with the daily prune the target stays near ${bytes(after + day)}`,
  );
  lines.push(
    `budget ${bytes(budget)}: ${bytes(budget - after - day)} of room, about ${day ? (Math.max(0, budget - after - day) / day).toFixed(1) : '∞'} days of growth if the prune stopped`,
  );
  return lines;
}

function pgTools(sourceMajor: number) {
  const pgDump = findPgTool('pg_dump');
  const psql = findPgTool('psql');
  if (!pgDump || !psql)
    throw new Error(
      'pg_dump and psql are needed: brew install libpq (found in /opt/homebrew/opt/libpq/bin)',
    );
  const dumpMajor = toolMajor(pgDump);
  if (dumpMajor < Math.max(17, sourceMajor))
    throw new Error(
      `pg_dump ${dumpMajor} cannot dump a ${sourceMajor} server: brew install libpq (18) or put a newer pg_dump on PATH`,
    );
  return { pgDump, psql, dumpMajor, psqlMajor: toolMajor(psql) };
}

/**
 * Copies one table's rows: psql reads them on the source inside the exported snapshot and a second psql writes
 * them on the target, the one's output piped into the other's input.
 */
async function copyTable(
  psql: string,
  source: string,
  target: string,
  snapshot: string,
  p: TablePlan,
): Promise<void> {
  const cols = p.columns.map(ident).join(', ');
  const name = qualified(p.schema, p.table);
  const read = spawnPsql(
    psql,
    source,
    [
      'begin isolation level repeatable read read only;',
      `set transaction snapshot '${snapshot.replace(/[^0-9A-Fa-f-]/g, '')}';`,
      'set local statement_timeout = 0;',
      `copy (select ${cols} from ${name}${p.where ? ` where ${p.where}` : ''}) to stdout;`,
      'commit;',
    ].join('\n'),
  );
  const write = spawn(
    psql,
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', `copy ${name} (${cols}) from stdin`],
    { env: toolEnv(target), stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let err = '';
  write.stderr.on('data', (c: Buffer) => {
    if (err.length < 4000) err += c.toString('utf8');
  });
  const written = new Promise<void>((resolve, reject) => {
    write.on('error', reject);
    write.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`writing ${name}: psql ended with ${code}: ${err.trim()}`)),
    );
  });
  read.child.stdout.pipe(write.stdin);
  await Promise.all([read.done, written]);
}

function dumpSection(pgDump: string, url: string, schemas: string[], section: string): string {
  const args = [
    '--schema-only',
    `--section=${section}`,
    '--no-owner',
    '--no-privileges',
    '--no-policies',
    '--no-publications',
    '--no-subscriptions',
    '--no-security-labels',
    '--no-tablespaces',
    ...schemas.flatMap((s) => ['--schema', s]),
  ];
  return execFileSync(pgDump, args, {
    env: toolEnv(url),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPsql(psql: string, url: string, script: string) {
  execFileSync(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], {
    env: toolEnv(url),
    input: script,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** The grants of our own roles on the source, as statements, split by whether the role is on the target. */
async function grantsFor(
  src: Sql,
  dst: Sql,
  schemas: string[],
): Promise<{ statements: string[]; missing: string[] }> {
  const onTarget = new Set(
    (await dst<{ r: string }[]>`select rolname as r from pg_roles`).map((x) => x.r),
  );
  const objects = await src<{ s: string; o: string; k: string; role: string; p: string }[]>`
    select n.nspname as s, c.relname as o, c.relkind::text as k, r.rolname as role, a.privilege_type as p
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
     where n.nspname = any(${schemas}) and c.relkind in ('r', 'p', 'S', 'v', 'm')
     order by 1, 2, 4, 5`;
  const spaces = await src<{ s: string; role: string; p: string }[]>`
    select n.nspname as s, r.rolname as role, a.privilege_type as p
      from pg_namespace n cross join lateral aclexplode(n.nspacl) a join pg_roles r on r.oid = a.grantee
     where n.nspname = any(${schemas}) order by 1, 2, 3`;
  const defaults = await src<{ s: string; k: string; role: string; p: string }[]>`
    select n.nspname as s, d.defaclobjtype::text as k, r.rolname as role, a.privilege_type as p
      from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a join pg_roles r on r.oid = a.grantee
     where n.nspname = any(${schemas}) order by 1, 2, 3, 4`;
  const ours = (role: string) => !PLATFORM_ROLES.has(role) && !role.startsWith('pg_');
  const missing = new Set<string>();
  const statements: string[] = [];
  const take = (role: string, stmt: string) => {
    if (!ours(role)) return;
    if (!onTarget.has(role)) missing.add(role);
    else statements.push(stmt);
  };
  for (const x of spaces) take(x.role, grantSql('schema', x.s, '', x.p, x.role));
  for (const x of objects)
    take(x.role, grantSql(x.k === 'S' ? 'sequence' : 'table', x.s, x.o, x.p, x.role));
  for (const x of defaults) {
    const what = DEFAULT_OBJECTS[x.k];
    if (what)
      take(
        x.role,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(x.s)} GRANT ${x.p} ON ${what} TO ${ident(x.role)};`,
      );
  }
  return { statements, missing: [...missing].sort() };
}

async function serverMajor(sql: Sql): Promise<{ major: number; version: string }> {
  const [v] = await sql<{ v: string }[]>`select current_setting('server_version') as v`;
  const version = v?.v ?? '';
  return { major: majorOf(version), version };
}

export type MoveRecord = {
  at: string;
  movedAt: string;
  tables: { schema: string; table: string; whole: boolean; rows: number }[];
};

/** The tables kept whole whose rows on the source now differ from the move's counts. */
export function recountDiffs(
  rec: MoveRecord,
  now: Map<string, number>,
): { name: string; moved: number; now: number }[] {
  const out: { name: string; moved: number; now: number }[] = [];
  for (const t of rec.tables) {
    if (!t.whole) continue;
    const name = `${t.schema}.${t.table}`;
    const n = now.get(name);
    if (n === undefined || n !== t.rows) out.push({ name, moved: t.rows, now: n ?? -1 });
  }
  return out;
}

/**
 * After the switch: counts the tables kept whole on the source again and compares them with the move's record,
 * so a write that reached the source after the snapshot (an API not yet stopped) shows by its table.
 */
async function recountSource(recordPath: string) {
  const source = process.env.SOURCE_DATABASE_URL;
  if (!source) throw new Error('SOURCE_DATABASE_URL is not set');
  if (!existsSync(recordPath)) throw new Error(`no record at ${recordPath}`);
  const rec = JSON.parse(readFileSync(recordPath, 'utf8')) as MoveRecord;
  const { client: pool } = createDb(source);
  const one = await pool.reserve();
  const now = new Map<string, number>();
  try {
    await one.unsafe('set statement_timeout = 0');
    for (const t of rec.tables.filter((x) => x.whole)) {
      const [c] = await one.unsafe<{ n: string }[]>(
        `select count(*)::text as n from ${qualified(t.schema, t.table)}`,
      );
      now.set(`${t.schema}.${t.table}`, Number(c?.n ?? -1));
    }
  } finally {
    one.release();
    await pool.end();
  }
  const diffs = recountDiffs(rec, now);
  const whole = rec.tables.filter((x) => x.whole).length;
  console.log(`recount of the ${whole} tables kept whole, against the move of ${rec.movedAt}`);
  for (const d of diffs)
    console.log(`  DIFF ${d.name}: moved ${d.moved}, on the source now ${d.now}`);
  if (diffs.length) {
    console.log(
      `${diffs.length} table(s) changed on the source after the move: those rows are not on the target`,
    );
    process.exitCode = 1;
  } else console.log('no table changed on the source since the move');
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set([
    '--dry-run',
    '--at',
    '--budget-mb',
    '--grants-only',
    '--record',
    '--recount',
  ]);
  for (const a of argv)
    if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const dryRun = argv.includes('--dry-run');
  const grantsOnly = argv.includes('--grants-only');
  const recount = argv.includes('--recount');
  const recordArg = argValue(argv, '--record');
  const record = recordArg ? resolve(recordArg) : null;
  if ((recount || !(dryRun || grantsOnly)) && !record)
    throw new Error(
      '--record <file> names the file the move writes its counts to (and --recount reads)',
    );
  if (recount) {
    await recountSource(record as string);
    return;
  }
  const at = parseAt(argValue(argv, '--at'));
  const budget = Number(argValue(argv, '--budget-mb') ?? 1024) * 1024 * 1024;
  const source = process.env.SOURCE_DATABASE_URL;
  const target = process.env.TARGET_DATABASE_URL;
  if (!source) throw new Error('SOURCE_DATABASE_URL is not set');
  if (!dryRun && !target) throw new Error('TARGET_DATABASE_URL is not set');
  if (source && target && sameDatabase(source, target))
    throw new Error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL name the same database');

  const { client: src } = createDb(source);
  const dst = target ? createDb(target).client : null;
  let started = false;
  try {
    const s = await serverMajor(src);
    console.log(`source: PostgreSQL ${s.version}`);
    const tools = pgTools(s.major);
    console.log(`tools: pg_dump ${tools.dumpMajor}, psql ${tools.psqlMajor}`);
    const { copy: schemas, skip } = await schemasOf(src);
    if (!schemas.includes('public') || !schemas.includes('drizzle'))
      throw new Error('the source has no public or no drizzle schema: is this the app database?');
    console.log(`schemas copied: ${schemas.join(', ')}`);
    console.log(`schemas left out (the platform's): ${skip.join(', ') || 'none'}`);

    if (dst) {
      const t = await serverMajor(dst);
      console.log(`target: PostgreSQL ${t.version}`);
    }
    if (grantsOnly) {
      if (!dst) throw new Error('--grants-only needs TARGET_DATABASE_URL');
      const g = await grantsFor(src, dst, schemas);
      if (g.statements.length) runPsql(tools.psql, target as string, g.statements.join('\n'));
      console.log(`grants applied: ${g.statements.length}`);
      if (g.missing.length)
        console.log(`roles not on the target, left out: ${g.missing.join(', ')}`);
      return;
    }

    if (dryRun) {
      // one connection, so the timeout set on it holds for the counts (Supabase sets 120 s)
      const one = await src.reserve();
      await one.unsafe('set statement_timeout = 0');
      const plan = await planTables(one, schemas, at).finally(() => one.release());
      console.log(`\nplan at ${at.toISOString()} (dry run: nothing is written)\n`);
      for (const l of describePlan(plan, budget)) console.log(l);
      if (dst) {
        const g = await grantsFor(src, dst, schemas);
        console.log(`\ngrants to copy: ${g.statements.length}`);
        if (g.missing.length)
          console.log(
            `roles not on the target (create them first, or run --grants-only after): ${g.missing.join(', ')}`,
          );
      }
      return;
    }

    const db = dst as Sql;
    const url = target as string;
    const [busy] = await db<{ n: number }[]>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${schemas}) and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')`;
    if ((busy?.n ?? 0) > 0)
      throw new Error(
        `the target already holds ${busy?.n} tables or sequences in ${schemas.join(', ')}: this script adds, never replaces. ` +
          'Reset the Neon branch (or drop those schemas by hand) and run it again',
      );

    started = true;
    console.log('\n1. schema (tables, types, sequences) on the target');
    runPsql(tools.psql, url, cleanDump(dumpSection(tools.pgDump, source, schemas, 'pre-data')));

    let plan: TablePlan[] = [];
    const seqs: { s: string; n: string; v: string; called: boolean }[] = [];
    console.log('2. rows, from one read-only snapshot of the source');
    await src.begin('isolation level repeatable read read only', async (tx) => {
      await tx.unsafe('set local statement_timeout = 0');
      await tx.unsafe('set local idle_in_transaction_session_timeout = 0');
      const [snap] = await tx<{ id: string }[]>`select pg_export_snapshot() as id`;
      if (!snap?.id) throw new Error('the source exported no snapshot');
      plan = await planTables(tx as unknown as Sql, schemas, at);
      for (const l of describePlan(plan, budget)) console.log(`   ${l}`);
      for (const p of plan) {
        if (!p.rowsKept) continue;
        const t0 = Date.now();
        await copyTable(tools.psql, source, url, snap.id, p);
        console.log(
          `   ${p.schema}.${p.table}: ${p.rowsKept} rows (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
        );
      }
      const list = await tx<{ s: string; n: string }[]>`
        select schemaname as s, sequencename as n from pg_sequences where schemaname = any(${schemas})`;
      for (const q of list) {
        const [v] = await tx.unsafe<{ v: string; called: boolean }[]>(
          `select last_value::text as v, is_called as called from ${qualified(q.s, q.n)}`,
        );
        if (v) seqs.push({ s: q.s, n: q.n, v: v.v, called: v.called });
      }
    });

    console.log('3. sequences');
    for (const q of seqs) {
      await db`select setval(${qualified(q.s, q.n)}::regclass, ${q.v}::bigint, ${q.called})`;
      console.log(`   ${q.s}.${q.n} = ${q.v}${q.called ? '' : ' (not yet called)'}`);
    }

    console.log('4. indexes, keys and constraints');
    runPsql(tools.psql, url, cleanDump(dumpSection(tools.pgDump, source, schemas, 'post-data')));

    console.log('5. grants of our own roles');
    const g = await grantsFor(src, db, schemas);
    if (g.statements.length) runPsql(tools.psql, url, g.statements.join('\n'));
    console.log(`   ${g.statements.length} applied`);
    if (g.missing.length)
      console.log(
        `   roles not on the target, left out: ${g.missing.join(', ')} (create them, then run --grants-only)`,
      );

    console.log('6. analyze');
    await db.unsafe('analyze');

    console.log('7. check: rows of every table, source snapshot against target');
    let bad = 0;
    for (const p of plan) {
      const [c] = await db.unsafe<{ n: string }[]>(
        `select count(*)::text as n from ${qualified(p.schema, p.table)}`,
      );
      const n = Number(c?.n ?? -1);
      const ok = n === p.rowsKept;
      if (!ok) bad++;
      console.log(
        `   ${ok ? 'ok  ' : 'DIFF'} ${p.schema}.${p.table}: source ${p.rowsKept}, target ${n}`,
      );
    }
    for (const q of seqs) {
      const [v] = await db.unsafe<{ v: string }[]>(
        `select last_value::text as v from ${qualified(q.s, q.n)}`,
      );
      if (v?.v !== q.v) {
        bad++;
        console.log(`   DIFF sequence ${q.s}.${q.n}: source ${q.v}, target ${v?.v}`);
      }
    }
    const [size] = await db<
      { b: string }[]
    >`select pg_database_size(current_database())::text as b`;
    console.log(`\ntarget database size: ${bytes(Number(size?.b ?? 0))} of ${bytes(budget)}`);
    writeFileSync(
      record as string,
      `${JSON.stringify(
        {
          at: at.toISOString(),
          movedAt: new Date().toISOString(),
          tables: plan.map((p) => ({
            schema: p.schema,
            table: p.table,
            whole: p.where === null,
            rows: p.rowsKept,
          })),
        } satisfies MoveRecord,
        null,
        2,
      )}\n`,
    );
    console.log(`counts written to ${record} (for --recount after the switch)`);
    if (bad) {
      console.log(`${bad} difference(s): the move is not complete`);
      process.exitCode = 1;
    } else console.log('every table and sequence matches the source snapshot');
  } catch (e) {
    if (started)
      console.error(
        'the move stopped. The target may hold part of it: reset the Neon branch, or run on it\n' +
          '  drop schema if exists drizzle cascade; drop schema if exists archive_rh_testnet cascade;\n' +
          '  drop schema public cascade; create schema public;\n' +
          'then run the move again.',
      );
    throw e;
  } finally {
    await src.end();
    await dst?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    const err = e as { stderr?: unknown };
    if (typeof err?.stderr === 'string' && err.stderr)
      console.error(err.stderr.replace(/postgres(ql)?:\/\/\S+/g, '<address>').slice(0, 2000));
    console.error(said(e));
    process.exit(1);
  });
}
