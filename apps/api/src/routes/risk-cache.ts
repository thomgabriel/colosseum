import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The answers of `GET /risk/*`, kept in the process. A read is the same for everyone and the collectors
 * write hourly at most, while one answer can cost seconds of the host's CPU (a fact sheet is ten queries
 * and a week of snapshots): an analytics page asks for about two hundred of them. So an answer is kept:
 * fresh for `freshMs` it is served as it is; older, up to `staleMs`, it is served while one request reads
 * it again; and requests that arrive together for an answer nobody has are read once. Only a 200 is kept.
 * Every answer carries its own reading's time, so a kept one never passes for newer than it is.
 * `x-read-cache` says which answered: `hit`, `stale` or `miss`.
 *
 * Not kept: a pool's live liquidity, read over RPC with its own 60 s cache (risk-pool-liquidity.ts).
 */
export type RiskCacheOptions = {
  freshMs?: number;
  staleMs?: number;
  /** The most the kept answers may hold, in characters; the oldest go first past it. */
  maxChars?: number;
  now?: () => number;
};

/** Ten minutes fresh, as the conversations' reads (agent-analytics.ts); an hour at most while read again. */
export const RISK_FRESH_MS = 10 * 60_000;
export const RISK_STALE_MS = 60 * 60_000;
const MAX_CHARS = 64 * 1024 * 1024;
/** How long a request waits for the same read another request started, before it reads on its own. */
const JOIN_MS = 30_000;
/** What a `GET /risk/*` answer tells a browser: a minute fresh, five more served while asked again. */
export const RISK_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';
const NOT_KEPT = new Set(['/risk/pools/:address/liquidity']);

type Kept = { at: number; body: string; type: string };

export function registerRiskReadCache(app: FastifyInstance, opts: RiskCacheOptions = {}) {
  const freshMs = opts.freshMs ?? RISK_FRESH_MS;
  const staleMs = opts.staleMs ?? RISK_STALE_MS;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const now = opts.now ?? Date.now;
  const kept = new Map<string, Kept>();
  let chars = 0;
  /** Reads under way, by address: the requests that came after wait for them. */
  const reading = new Map<string, Promise<void>>();
  const done = new WeakMap<FastifyRequest, () => void>();
  // A read again of a stale answer goes through the app itself, marked with a value only this process knows.
  const AGAIN = randomUUID();

  const isRead = (req: FastifyRequest) =>
    req.method === 'GET' &&
    req.url.startsWith('/risk/') &&
    !NOT_KEPT.has(req.routeOptions.url ?? '');
  const keep = (key: string, k: Kept) => {
    const was = kept.get(key);
    if (was) chars -= was.body.length;
    kept.delete(key);
    kept.set(key, k);
    chars += k.body.length;
    for (const [old, e] of kept) {
      if (chars <= maxChars) break;
      kept.delete(old);
      chars -= e.body.length;
    }
  };
  const readAgain = (key: string) => {
    if (reading.has(key)) return;
    const p = app
      .inject({ method: 'GET', url: key, headers: { 'x-read-again': AGAIN } })
      .then(
        () => {},
        () => {},
      )
      .finally(() => reading.delete(key));
    reading.set(key, p);
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!isRead(req)) return;
    const key = req.url;
    if (req.headers['x-read-again'] === AGAIN) return;
    const serve = (k: Kept, how: 'hit' | 'stale') =>
      reply
        .header('content-type', k.type)
        .header('cache-control', RISK_CACHE_CONTROL)
        .header('x-read-cache', how)
        .send(k.body);
    let k = kept.get(key);
    if (k && now() - k.at < freshMs) return serve(k, 'hit');
    if (k && now() - k.at < staleMs) {
      readAgain(key);
      return serve(k, 'stale');
    }
    const under = reading.get(key);
    if (under) {
      await Promise.race([under, new Promise((d) => setTimeout(d, JOIN_MS).unref?.())]);
      k = kept.get(key);
      if (k && now() - k.at < staleMs) return serve(k, 'hit');
    }
    // This request reads it; any that come meanwhile wait for its answer.
    if (!reading.has(key)) {
      let end = () => {};
      reading.set(
        key,
        new Promise<void>((d) => {
          end = d;
        }),
      );
      done.set(req, () => {
        reading.delete(key);
        end();
      });
    }
    reply.header('x-read-cache', 'miss');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!isRead(req) || reply.getHeader('x-read-cache') === 'hit') return payload;
    if (reply.getHeader('x-read-cache') === 'stale') return payload;
    if (reply.statusCode === 200 && !reply.hasHeader('cache-control'))
      reply.header('cache-control', RISK_CACHE_CONTROL);
    if (reply.statusCode === 200 && typeof payload === 'string')
      keep(req.url, {
        at: now(),
        body: payload,
        type: String(reply.getHeader('content-type') ?? 'application/json; charset=utf-8'),
      });
    return payload;
  });

  // The read is over, answered or not: whoever waited for it looks again.
  app.addHook('onResponse', async (req) => {
    done.get(req)?.();
  });
}
