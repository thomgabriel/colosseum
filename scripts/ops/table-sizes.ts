import { pathToFileURL } from 'node:url';
import { createDb } from '@colosseum/db';
import { argValue, bytes, qualified, said } from './lib-pg';

// What each table of the database takes on disk, read-only, so a person can compare before and after a change
// to what is stored (DB-STORAGE, Oct 18; Neon's free plan stops writes at 1 GB). Per table: the total, the heap,
// TOAST and indexes, live and dead rows, the average stored row and the average stored size of each jsonb column.
// For risk_pool_snapshots also the sides stored as "as before" (JSON null) and as pairs.
//
//   DATABASE_URL=… pnpm ops:table-sizes [--min-mb 1] [--json]
//
// Every statement runs in a read-only transaction. The averages read every row of each table listed (one
// sequential pass, on the server; nothing but the sums comes back). The address is never printed.

type Sql = ReturnType<typeof createDb>['client'];

export type TableSize = {
  table: string;
  totalBytes: number;
  heapBytes: number;
  toastBytes: number;
  indexBytes: number;
  liveRows: number;
  deadRows: number;
  avgRowBytes: number | null;
  /** Average stored size of each jsonb column, compressed as stored. */
  jsonb: Record<string, number | null>;
  /** risk_pool_snapshots: sides stored as JSON null ("as before") and as [notionalUsd, outUsd] pairs. */
  sides?: { asBefore: number; pairs: number; objects: number };
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The sizes of the tables of `public` at or above `minBytes`, largest first. */
export async function tableSizes(sql: Sql, minBytes: number): Promise<TableSize[]> {
  const tables = await sql.unsafe<
    {
      name: string;
      total: string;
      heap: string;
      toast: string;
      idx: string;
      live: string;
      dead: string;
    }[]
  >(
    `select c.relname as name, pg_total_relation_size(c.oid)::text as total,
       pg_relation_size(c.oid)::text as heap,
       coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)::text as toast,
       pg_indexes_size(c.oid)::text as idx,
       coalesce(s.n_live_tup, 0)::text as live, coalesce(s.n_dead_tup, 0)::text as dead
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     left join pg_stat_user_tables s on s.relid = c.oid
     where n.nspname = 'public' and c.relkind in ('r', 'p') and pg_total_relation_size(c.oid) >= ${Math.floor(minBytes)}
     order by pg_total_relation_size(c.oid) desc`,
  );
  const out: TableSize[] = [];
  for (const t of tables) {
    const cols = await sql.unsafe<{ name: string }[]>(
      `select a.attname as name from pg_attribute a join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 and not a.attisdropped
         and a.atttypid = 'jsonb'::regtype order by a.attnum`,
      [t.name],
    );
    const name = qualified('public', t.name);
    const avgs = cols.map(
      (c, i) => `avg(pg_column_size(${qualified('t', c.name)}))::float8 as j${i}`,
    );
    const [a] = await sql.unsafe<Record<string, unknown>[]>(
      `select avg(pg_column_size(t.*))::float8 as row${avgs.length ? `, ${avgs.join(', ')}` : ''} from ${name} t`,
    );
    const row: TableSize = {
      table: t.name,
      totalBytes: Number(t.total),
      heapBytes: Number(t.heap),
      toastBytes: Number(t.toast),
      indexBytes: Number(t.idx),
      liveRows: Number(t.live),
      deadRows: Number(t.dead),
      avgRowBytes: num(a?.row),
      jsonb: Object.fromEntries(cols.map((c, i) => [c.name, num(a?.[`j${i}`])])),
    };
    if (t.name === 'risk_pool_snapshots') {
      const [s] = await sql.unsafe<{ b: string; p: string; o: string }[]>(
        `select count(*) filter (where jsonb_typeof(x) = 'null')::text as b,
           count(*) filter (where jsonb_typeof(x->0) = 'array')::text as p,
           count(*) filter (where jsonb_typeof(x->0) = 'object')::text as o
         from (select sell as x from ${name} union all select buy from ${name}) u`,
      );
      row.sides = { asBefore: Number(s?.b), pairs: Number(s?.p), objects: Number(s?.o) };
    }
    out.push(row);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--min-mb', '--json']);
  for (const a of argv)
    if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const minMb = Number(argValue(argv, '--min-mb') ?? 1);
  if (!Number.isFinite(minMb) || minMb < 0) throw new Error('--min-mb takes a number of MB');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { client: pool } = createDb(url);
  const sql = await pool.reserve();
  try {
    await sql.unsafe('set statement_timeout = 600000');
    await sql.unsafe('begin read only');
    const [db] = await sql.unsafe<{ size: string }[]>(
      'select pg_database_size(current_database())::text as size',
    );
    const rows = await tableSizes(sql, minMb * 1024 * 1024);
    await sql.unsafe('commit');
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ databaseBytes: Number(db?.size), tables: rows }, null, 2));
      return;
    }
    console.log(`database: ${bytes(Number(db?.size))}`);
    for (const r of rows) {
      const j = Object.entries(r.jsonb)
        .map(([k, v]) => `${k} ${v === null ? '-' : bytes(v)}`)
        .join(', ');
      console.log(
        `${r.table}: ${bytes(r.totalBytes)} (heap ${bytes(r.heapBytes)}, toast ${bytes(r.toastBytes)}, indexes ${bytes(r.indexBytes)}); ${r.liveRows} rows, ${r.deadRows} dead; row ${r.avgRowBytes === null ? '-' : bytes(r.avgRowBytes)}${j ? `; ${j}` : ''}${r.sides ? `; sides: ${r.sides.asBefore} as before, ${r.sides.pairs} pairs, ${r.sides.objects} objects` : ''}`,
      );
    }
  } finally {
    sql.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(said(e));
    process.exit(1);
  });
}
