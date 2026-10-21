// How the database client is opened, from the environment. Two settings, both for a hosted database
// behind a connection pooler:
//
// DB_POOL_MAX     how many connections this process holds at most. Left out, the driver's own: 10,
//                 or what the address or `PGMAX` says. A
//                 pooler in session mode gives each client one server connection for as long as it is
//                 connected, and caps how many a project may hold: every process that opens the
//                 database (the API, the keeper, a script) counts against that cap with its own pool.
// DB_PGBOUNCER    `transaction` when DATABASE_URL goes through a pooler in transaction mode
//                 (Supabase's on port 6543, PgBouncer's `pool_mode = transaction`). A server connection
//                 is then lent for one transaction at a time, so a statement prepared on one is not
//                 there on the next: the driver is told to prepare none. Left out, or `session`,
//                 statements are prepared as before.
//
// What the API locks with holds in either mode: its advisory locks are transaction-scoped
// (`pg_advisory_xact_lock`) and its timeouts are `SET LOCAL`, both inside one transaction.
//
// A connection left idle in the pool is closed after `IDLE_TIMEOUT_S` (`idleOptions`): a hosted database
// that bills its compute by the hour, and sleeps only when no connection is open and no query runs for a
// few minutes, is otherwise held awake by a pool that keeps its connections for as long as the process
// lives. The driver opens one again at the next query. A connection in a transaction or reserved is not
// idle and is never closed this way. `?idle_timeout=` in the address or `PGIDLE_TIMEOUT` stand over it.

export type PoolEnv = { DB_POOL_MAX?: string; DB_PGBOUNCER?: string };

/** The most connections a process may be set to hold: above it the value is a mistake, not a pool. */
export const POOL_MAX_LIMIT = 100;

/**
 * The options the driver is opened with: only what a variable sets. With neither set nothing is
 * passed, so what the address itself says (`?max=`, `?prepare=false`) and the driver's own
 * environment (`PGMAX`) stand, as they did before. Throws on a value it cannot read, naming the
 * variable.
 */
export function poolOptions(env: PoolEnv): { max?: number; prepare?: boolean } {
  const raw = env.DB_POOL_MAX?.trim();
  const max = raw ? Number(raw) : undefined;
  if (raw && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > POOL_MAX_LIMIT))
    throw new Error(`DB_POOL_MAX: expected a number of connections from 1 to ${POOL_MAX_LIMIT}`);
  const mode = env.DB_PGBOUNCER?.trim().toLowerCase();
  if (mode && mode !== 'transaction' && mode !== 'session')
    throw new Error('DB_PGBOUNCER: expected `transaction` or `session`');
  return {
    ...(max === undefined ? {} : { max }),
    ...(mode ? { prepare: mode !== 'transaction' } : {}),
  };
}

/** Seconds a connection may sit idle in the pool before it is closed (Oct 18, DB-LOAD). */
export const IDLE_TIMEOUT_S = 60;

/**
 * The idle timeout the driver is opened with: `IDLE_TIMEOUT_S`, unless the address (`?idle_timeout=`) or
 * the driver's own variable (`PGIDLE_TIMEOUT`) says, which is then left to stand.
 */
export function idleOptions(
  url: string,
  env: { PGIDLE_TIMEOUT?: string },
): { idle_timeout?: number } {
  if (env.PGIDLE_TIMEOUT?.trim()) return {};
  let named = false;
  try {
    named = new URL(url).searchParams.has('idle_timeout');
  } catch {
    // an address the URL parser cannot read: the driver reads it as it does
  }
  return named ? {} : { idle_timeout: IDLE_TIMEOUT_S };
}
