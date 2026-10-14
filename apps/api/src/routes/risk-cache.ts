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
 * Not kept: a pool's live liquidity, read over RPC with its own 60 s cache (risk-pool-liquidity.ts); an
 * answer worked out from the hours ahead of now (a score, a recoverable value without `at`); an address
 * longer than `MAX_KEY_CHARS`. The chains side by side, read in the regime of now, is kept per half hour:
 * every regime boundary (9:30, 13:00 and 16:00 ET, the weekend's 20:00, midnight) falls on one.
 */
export type RiskCacheOptions = {
  freshMs?: number;
  staleMs?: number;
  /** The most the kept answers may hold, in characters of address and body; the oldest go first past it. */
  maxChars?: number;
  /** The most answers kept; the oldest go first past it. */
  maxEntries?: number;
  /** How long a request waits for the same read another request started, before it reads on its own. */
  joinMs?: number;
  now?: () => number;
};

/** Ten minutes fresh, as the conversations' reads (agent-analytics.ts); an hour at most while read again. */
export const RISK_FRESH_MS = 10 * 60_000;
export const RISK_STALE_MS = 60 * 60_000;
const MAX_CHARS = 64 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
/** An address longer than this is not kept: no page reads one, and each would be an entry of its own. */
export const MAX_KEY_CHARS = 512;
const HALF_HOUR_MS = 30 * 60_000;
const JOIN_MS = 30_000;
/** What a `GET /risk/*` answer tells a browser: a minute fresh, five more served while asked again. */
export const RISK_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';
const NOT_KEPT = new Set(['/risk/pools/:address/liquidity', '/risk/assets/:id/score']);
const BY_HALF_HOUR = new Set(['/risk/chains']);

type Kept = { at: number; body: string; type: string };
type Failed = { status: number; body: string; type: string };
/** A read under way: it ends when its request is answered; a failed answer is kept for its waiters. */
type Reading = { ended: Promise<void>; end: () => void; failed?: Failed };

export function registerRiskReadCache(app: FastifyInstance, opts: RiskCacheOptions = {}) {
  const freshMs = opts.freshMs ?? RISK_FRESH_MS;
  const staleMs = opts.staleMs ?? RISK_STALE_MS;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const now = opts.now ?? Date.now;
  const joinMs = opts.joinMs ?? JOIN_MS;
  const kept = new Map<string, Kept>();
  let chars = 0;
  /** Reads under way, by key: the requests that came after wait for them. */
  const reading = new Map<string, Reading>();
  /** The read a request is doing, and under which key. */
  const owns = new WeakMap<FastifyRequest, { key: string; r: Reading }>();
  // A read again of a stale answer goes through the app itself, marked with a value only this process knows.
  const AGAIN = randomUUID();

  /** Where an answer is kept, or null when it is not kept. */
  const keyOf = (req: FastifyRequest): string | null => {
    if (req.method !== 'GET' || !req.url.startsWith('/risk/')) return null;
    if (req.url.length > MAX_KEY_CHARS) return null;
    const route = req.routeOptions.url ?? '';
    if (NOT_KEPT.has(route)) return null;
    if (route === '/risk/recoverable' && !(req.query as { at?: string } | undefined)?.at)
      return null;
    if (BY_HALF_HOUR.has(route)) return `${req.url}#${Math.floor(now() / HALF_HOUR_MS)}`;
    return req.url;
  };
  const size = (key: string, k: Kept) => key.length + k.body.length;
  const keep = (key: string, k: Kept) => {
    const was = kept.get(key);
    if (was) chars -= size(key, was);
    kept.delete(key);
    kept.set(key, k);
    chars += size(key, k);
    for (const [old, e] of kept) {
      if (chars <= maxChars && kept.size <= maxEntries) break;
      kept.delete(old);
      chars -= size(old, e);
    }
  };
  const start = (key: string): Reading => {
    let end = () => {};
    const ended = new Promise<void>((d) => {
      end = d;
    });
    const r: Reading = { ended, end };
    reading.set(key, r);
    return r;
  };
  /** Ends a read; it stops being the one waited for only if a later read has not taken its place. */
  const finish = (key: string, r: Reading) => {
    if (reading.get(key) === r) reading.delete(key);
    r.end();
  };
  const readAgain = (key: string, url: string) => {
    if (reading.has(key)) return;
    const r = start(key);
    app
      .inject({ method: 'GET', url, headers: { 'x-read-again': AGAIN } })
      .then(
        () => {},
        () => {},
      )
      .finally(() => finish(key, r));
  };

  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-read-again'] === AGAIN) return;
    const key = keyOf(req);
    if (key === null) return;
    const serve = (k: Kept, how: 'hit' | 'stale') =>
      reply
        .header('content-type', k.type)
        .header('cache-control', RISK_CACHE_CONTROL)
        .header('x-read-cache', how)
        .send(k.body);
    let k = kept.get(key);
    if (k && now() - k.at < freshMs) return serve(k, 'hit');
    if (k && now() - k.at < staleMs) {
      readAgain(key, req.url);
      return serve(k, 'stale');
    }
    // Wait for a read under way. If it fails, the waiters share one more read: the first to wake
    // makes it and the rest wait for it, and if that one fails too, they all answer with its failure.
    let retried = false;
    for (let under = reading.get(key); under; under = reading.get(key)) {
      const ended = await Promise.race([
        under.ended.then(() => true),
        new Promise<false>((d) => setTimeout(() => d(false), joinMs).unref?.()),
      ]);
      // A read that never ended (its request went away unanswered) is no longer waited for.
      if (!ended) {
        if (reading.get(key) === under) reading.delete(key);
        break;
      }
      k = kept.get(key);
      if (k && now() - k.at < staleMs) return serve(k, 'hit');
      if (retried && under.failed)
        return reply
          .code(under.failed.status)
          .header('content-type', under.failed.type)
          .header('x-read-cache', 'shared')
          .send(under.failed.body);
      retried = true;
    }
    // This request reads it; any that come meanwhile wait for its answer.
    owns.set(req, { key, r: start(key) });
    reply.header('x-read-cache', 'miss');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const how = reply.getHeader('x-read-cache');
    if (how === 'hit' || how === 'stale' || how === 'shared') return payload;
    const key = keyOf(req);
    if (key === null) return payload;
    if (reply.statusCode === 200 && !reply.hasHeader('cache-control'))
      reply.header('cache-control', RISK_CACHE_CONTROL);
    const type = String(reply.getHeader('content-type') ?? 'application/json; charset=utf-8');
    if (reply.statusCode === 200 && typeof payload === 'string')
      keep(key, { at: now(), body: payload, type });
    else {
      const mine = owns.get(req);
      if (mine && typeof payload === 'string')
        mine.r.failed = { status: reply.statusCode, body: payload, type };
    }
    return payload;
  });

  // The read is over, answered or not: whoever waited for it looks again.
  const over = async (req: FastifyRequest) => {
    const mine = owns.get(req);
    if (mine) finish(mine.key, mine.r);
  };
  app.addHook('onResponse', over);
  app.addHook('onRequestAbort', over);
}
