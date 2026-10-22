import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

// The hosted jobs on a Mac that wakes from sleep before its network does (Oct 22: getaddrinfo ENOTFOUND, connect
// EHOSTUNREACH, fetch failed, each a stack trace in the job's log). A scheduled run first waits for the network a
// short while: every host it needs must resolve, and the RPC's must take a TCP connection (nothing is sent on it;
// the database's host is only resolved, so the probe never wakes it). A run that finds no network, or loses it half
// way, ends with one line and exit code 0, having written nothing more: the next hour's run picks up. An error that
// reads as the network's counts as offline only when the hosts, probed again, do not answer: a refused connection or
// a TLS error with the network there, like any other error, still ends the run as a crash, with its stack.

/** The error codes that mean the network, not the job: a name that does not resolve, a host that cannot be reached. */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * The network's code in an error, looking through its `cause` and an AggregateError's `errors` (what postgres.js,
 * Drizzle and undici's fetch wrap it in), else in its message; null when it is not the network's.
 */
export function networkCode(e: unknown, depth = 0): string | null {
  if (!e || typeof e !== 'object' || depth > 8) return null;
  const x = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof x.code === 'string' && NETWORK_CODES.has(x.code)) return x.code;
  for (const inner of [x.cause, ...(Array.isArray(x.errors) ? x.errors : [])]) {
    const code = networkCode(inner, depth + 1);
    if (code) return code;
  }
  if (typeof x.message === 'string') {
    for (const word of x.message.match(/\b[A-Z][A-Z_]{4,}\b/gu) ?? [])
      if (NETWORK_CODES.has(word)) return word;
    if (/fetch failed/u.test(x.message)) return 'fetch failed';
  }
  return null;
}

/** A host a run needs; with `port`, a TCP connection to it is opened and closed at once. */
export type NetTarget = { host: string; port?: number };

/** The host of a URL, or null; the URL itself is never logged (it may hold a key). */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Resolves the host and, with a port, opens a connection; throws the network's error. */
export async function probeTarget(t: NetTarget, timeoutMs = 5_000): Promise<void> {
  await lookup(t.host);
  const port = t.port;
  if (port === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: t.host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(Object.assign(new Error(`connect ETIMEDOUT ${t.host}`), { code: 'ETIMEDOUT' }));
    });
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

/**
 * Waits until every target answers, trying again every `gapMs` until `until` (ms). Null once the network is
 * there; else the last error's code (or its message), with nothing read or written.
 */
export async function waitForNetwork(
  targets: readonly NetTarget[],
  o: {
    until: number;
    gapMs?: number;
    log?: (l: string) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    probe?: (t: NetTarget) => Promise<void>;
  },
): Promise<string | null> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const probe = o.probe ?? ((t: NetTarget) => probeTarget(t));
  const gap = o.gapMs ?? 10_000;
  const t0 = now();
  for (let attempt = 1; ; attempt++) {
    try {
      for (const t of targets) await probe(t);
      if (attempt > 1)
        o.log?.(
          `the network is back after ${Math.round((now() - t0) / 1000)} s (${attempt} tries)`,
        );
      return null;
    } catch (e) {
      const why = networkCode(e) ?? (e instanceof Error ? e.message.slice(0, 120) : String(e));
      if (now() + gap > o.until) return why;
      if (attempt === 1) o.log?.(`no network yet (${why}): trying again every ${gap / 1000} s`);
      await sleep(gap);
    }
  }
}

/** The one line a run that found no network ends with, and exit code 0. */
export function exitOffline(
  job: string,
  why: string,
  log: (l: string) => void = console.log,
): never {
  log(
    JSON.stringify({
      job,
      at: new Date().toISOString(),
      offline: why,
      note: "no network: nothing more read or written; the next hour's run picks up",
    }),
  );
  process.exit(0);
}

/**
 * Whether an error ended the run because the network is gone: it reads as the network's (`networkCode`) and the
 * targets do not answer when probed again (the RPC's host resolved and connected to, the database's only resolved).
 * A refused connection, a TLS or certificate error, or a server that hung up, with the network there, is not.
 */
export async function offlineCause(
  e: unknown,
  targets: readonly NetTarget[],
  probe: (t: NetTarget) => Promise<void> = (t) => probeTarget(t),
): Promise<string | null> {
  if (!networkCode(e)) return null;
  try {
    for (const t of targets) await probe(t);
    return null;
  } catch (again) {
    return (
      networkCode(again) ?? (again instanceof Error ? again.message.slice(0, 120) : 'no answer')
    );
  }
}

/**
 * From here on, an error that `offlineCause` puts on a network that is gone ends the run with `exitOffline`'s line
 * instead of a crash; any other error is printed with its stack and ends the run with code 1, as before.
 */
export function exitCleanlyWhenOffline(
  job: string,
  targets: readonly NetTarget[],
  log: (l: string) => void = console.log,
) {
  let handling = false;
  const onError = async (e: unknown) => {
    if (handling) return;
    handling = true;
    const why = await offlineCause(e, targets).catch(() => null);
    if (why) exitOffline(job, why, log);
    console.error(e);
    process.exit(1);
  };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
}
