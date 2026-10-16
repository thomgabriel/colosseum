import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// What the database scripts under scripts/ops share: the client tools, a connection address handed to them
// without printing it, and the quoting of names and times. Nothing here prints an address.

/** Where Homebrew puts the client tools when they are not on PATH (`brew install libpq` is keg-only). */
const TOOL_DIRS = [
  '/opt/homebrew/opt/libpq/bin',
  '/usr/local/opt/libpq/bin',
  '/opt/homebrew/opt/postgresql@18/bin',
  '/usr/local/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@17/bin',
];

/** The path of a client tool (`pg_dump`, `psql`): PATH first, then the Homebrew folders. Null when none. */
export function findPgTool(name: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of [...path.split(delimiter).filter(Boolean), ...TOOL_DIRS]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The major version a tool reports (`pg_dump (PostgreSQL) 18.6` → 18). */
export function toolMajor(tool: string): number {
  const out = execFileSync(tool, ['--version'], { encoding: 'utf8' });
  return majorOf(out);
}

/** The first major version in a version string: `PostgreSQL 17.11 on …` and `pg_dump (PostgreSQL) 18.6` alike. */
export function majorOf(version: string): number {
  const m = version.match(/(\d+)(?:\.\d+)?/);
  if (!m?.[1]) throw new Error(`no version in "${version.slice(0, 40)}"`);
  return Number(m[1]);
}

/**
 * The libpq environment of a connection address, so a child tool connects without the address on its command
 * line (where `ps` shows it). Every part is passed: host, port, user, password, database and the query's
 * sslmode, channel_binding and options. Throws on an address that is not postgres:// or postgresql://.
 */
export function pgEnvOf(url: string): Record<string, string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('not a connection address (expected postgres://…)');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:')
    throw new Error('not a connection address (expected postgres://…)');
  const env: Record<string, string> = {};
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) env.PGDATABASE = decodeURIComponent(db);
  const params: Record<string, string> = {
    sslmode: 'PGSSLMODE',
    channel_binding: 'PGCHANNELBINDING',
    options: 'PGOPTIONS',
    sslrootcert: 'PGSSLROOTCERT',
    connect_timeout: 'PGCONNECT_TIMEOUT',
  };
  for (const [k, v] of u.searchParams) {
    const name = params[k];
    if (name) env[name] = v;
  }
  return env;
}

/** Whether two addresses name the same database (host, port and database), passwords aside. */
export function sameDatabase(a: string, b: string): boolean {
  const x = pgEnvOf(a);
  const y = pgEnvOf(b);
  return (
    (x.PGHOST ?? '') === (y.PGHOST ?? '') &&
    (x.PGPORT ?? '5432') === (y.PGPORT ?? '5432') &&
    (x.PGDATABASE ?? '') === (y.PGDATABASE ?? '')
  );
}

/** A quoted identifier. */
export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** A quoted schema-qualified name. */
export const qualified = (schema: string, name: string) => `${ident(schema)}.${ident(name)}`;
/** A timestamptz literal of a time the script computed itself. */
export const tsLiteral = (d: Date) => {
  if (Number.isNaN(d.getTime())) throw new Error('not a time');
  return `'${d.toISOString()}'::timestamptz`;
};

/** Bytes for a person, in binary units as hosts state their limits: 1.00 GB is 1024 MB. */
export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${Math.round(n)} B`;
}

/** The value of `--name <value>` in argv, or undefined. */
export function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

/** An error's code and message, never its cause: a driver's error can carry the address it was given. */
export function said(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return `${typeof code === 'string' ? `${code}: ` : ''}${e.message}`
      .replace(/postgres(ql)?:\/\/\S+/g, '<address>')
      .slice(0, 400);
  }
  return String(e)
    .replace(/postgres(ql)?:\/\/\S+/g, '<address>')
    .slice(0, 400);
}

/**
 * A time the driver returned: a Date, or the string drizzle's driver setup leaves timestamps as (it turns the
 * driver's own parsing off). Null stays null.
 */
export function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d =
    v instanceof Date
      ? v
      : new Date(
          String(v)
            .replace(' ', 'T')
            .replace(/([+-]\d{2})$/, '$1:00'),
        );
  if (Number.isNaN(d.getTime())) throw new Error('the database returned a time that is not one');
  return d;
}

/** The environment of a client tool: this process's without any PG* of its own, plus the address's. */
export function toolEnv(url: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PG')) env[k] = v;
  return { ...env, ...pgEnvOf(url) };
}

/**
 * psql running `script` from its stdin (`-f -`, errors stop it), its output on stdout. COPY … TO STDOUT goes
 * through psql rather than the driver's stream: the driver's copy stream stalled under backpressure (a gzip or
 * a second connection that reads slower) in the local trials.
 */
export function spawnPsql(psql: string, url: string, script: string, args: string[] = []) {
  const child = spawn(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args, '-f', '-'], {
    env: toolEnv(url),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    if (stderr.length < 4000) stderr += c.toString('utf8');
  });
  child.stdin.end(script);
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `psql ended with ${code}: ${stderr.trim().replace(/postgres(ql)?:\/\/\S+/g, '<address>')}`,
            ),
          ),
    );
  });
  return { child, done };
}
