import { API } from '../../lib/api';
import type { BearingChain } from './chain';

// The risk API as the Bearing pages read it: the `/risk/*` routes apps/api serves (apps/risk-api serves
// the same routes alone). Every read resolves to an answer the page can show; none rejects. A failed
// read is a reason, never a made-up figure. Reads are cached for the life of the page, so moving
// between pages does not read the same route twice, and `READS_AT_ONCE` go to the API at a time, in the
// order they were asked: on a small host, a dozen at once make each of them slower.

/** Where the risk routes are: their own API when set, else the app's API, which mounts them. */
export const RISK_API = (process.env.NEXT_PUBLIC_RISK_API_URL || API).replace(/\/$/, '');

export type Res<T = unknown> =
  | { ok: true; status: number; body: T; reason: null }
  | {
      ok: false;
      status: number;
      body: { error?: string; message?: string } | null;
      reason: string;
    };

/** A 404 for a route Fastify does not have says "Route GET:… not found": the API does not serve it. */
const notServed = (status: number, body: unknown) =>
  status === 404 && /^Route /.test(String((body as { message?: string } | null)?.message ?? ''));

/**
 * A failure the reader does not keep: no answer, or the server's own error. Reading the same route
 * again asks the API again, so a caller may ask once more before it says the read failed.
 */
export const notKept = (r: Res) => !r.ok && (r.status === 0 || r.status >= 500);

/** How long one probe of the API waits, and how many it makes before saying the API did not answer. */
const PROBE_MS = 3000;
const PROBE_TRIES = 3;
/** Reads of the risk API out at once, from one page. The probe is not one of them. */
export const READS_AT_ONCE = 3;
/** The longest a read holds its place: past it, it is given up as no answer and the next read goes. */
export const READ_MS = 30_000;

/** `fetcher` given up after `ms`: aborted, and answered as a failure even if it ignores the abort. */
function within(fetcher: typeof fetch, url: string, init: RequestInit, ms: number) {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    fetcher(url, { ...init, signal: stop.signal }),
    new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        stop.abort();
        fail(new Error('timeout'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export type Reader = {
  get: <T>(path: string) => Promise<Res<T>>;
  /** True when the API answered its methodology route: the one probe for "is it there". */
  probe: () => Promise<boolean>;
  /**
   * Calls `heard` each time the API answers a read from here on, one kept from before not counted;
   * gives back the way to stop. A reader of a stub may leave it out.
   */
  onAnswer?: (heard: () => void) => () => void;
};

/** An answer as the pages read it: its body when the API answered 2xx, else the reason it did not. */
export function resOf(status: number, body: unknown): Res {
  return status >= 200 && status < 300
    ? { ok: true, status, body, reason: null }
    : {
        ok: false,
        status,
        body: body as { error?: string; message?: string } | null,
        reason: notServed(status, body) ? 'not_served' : 'api_error',
      };
}

export function makeReader(base: string = RISK_API, fetcher: typeof fetch = fetch): Reader {
  const cache = new Map<string, Promise<Res>>();
  const listeners = new Set<() => void>();
  const turn = gate(READS_AT_ONCE);
  const get = <T>(path: string): Promise<Res<T>> => {
    let p = cache.get(path);
    if (!p) {
      // The API says how long an answer may be kept (a minute); the probe always asks the API itself.
      p = turn(() =>
        within(
          fetcher,
          `${base}${path}`,
          { cache: path === R.methodology() ? 'no-store' : 'default' },
          READ_MS,
        ).then(async (r): Promise<Res> => resOf(r.status, await r.json().catch(() => null))),
      )
        .catch((): Res => ({ ok: false, status: 0, body: null, reason: 'api_error' }))
        .then((r) => {
          // An answer is kept; a failure (no answer, or the server's own error) is not, so the next
          // read asks again.
          if (notKept(r)) cache.delete(path);
          else for (const heard of listeners) heard();
          return r;
        });
      cache.set(path, p);
    }
    return p as Promise<Res<T>>;
  };
  // The probe asks the API each time, never an answer kept from before: after a retry, the API that
  // answered an hour ago says nothing about the API now. A try that waited its time out leaves its
  // request out, and the next try waits for that same one: a slow API is asked once, not three times.
  let asking: Promise<boolean> | null = null;
  const ask = () => {
    asking ??= within(fetcher, `${base}${R.methodology()}`, { cache: 'no-store' }, READ_MS)
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        asking = null;
      });
    return asking;
  };
  const once = () =>
    Promise.race([ask(), new Promise<boolean>((done) => setTimeout(() => done(false), PROBE_MS))]);
  // A slow first answer is not "the API is down": three tries, a second apart. Probes asked while one
  // is under way share it.
  let probing: Promise<boolean> | null = null;
  const probe = () => {
    probing ??= (async () => {
      for (let i = 0; i < PROBE_TRIES; i++) {
        if (await once()) return true;
        if (i < PROBE_TRIES - 1) await new Promise((done) => setTimeout(done, 1000));
      }
      return false;
    })().finally(() => {
      probing = null;
    });
    return probing;
  };
  const onAnswer = (heard: () => void) => {
    listeners.add(heard);
    return () => {
      listeners.delete(heard);
    };
  };
  return { get, probe, onAnswer };
}

/**
 * Run `fn` over `items`, `n` at a time. Once `stop` says so no further item is started: the ones
 * already started are let finish, and the rest of the queue is dropped.
 */
export async function inPool<I, O>(
  items: readonly I[],
  n: number,
  fn: (item: I) => Promise<O>,
  stop?: () => boolean,
) {
  const queue = items.slice();
  const out: O[] = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let item = queue.shift(); item !== undefined && !stop?.(); item = queue.shift())
        out.push(await fn(item));
    }),
  );
  return out;
}

/**
 * A gate `n` wide: of the tasks handed to it, whoever hands them, `n` run at a time and the rest wait
 * their turn, in order. `inPool` bounds one queue; a gate bounds every queue that shares it, so a
 * queue that replaces another does not read beside the reads the first still has out.
 */
export function gate(n: number) {
  let free = n;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (free > 0) free--;
    else await new Promise<void>((turn) => waiting.push(turn));
    try {
      return await task();
    } finally {
      // the place goes to the next in line, or back to the gate
      const next = waiting.shift();
      if (next) next();
      else free++;
    }
  };
}

const enc = encodeURIComponent;
const size = (n: number) => Math.max(1, Math.round(n));

/** The routes the five pages read: the same paths Rodrigo's prototype reads, and the chains side by side. */
export const R = {
  methodology: () => '/risk/facts/methodology',
  // Solana's addresses are the prototype's, unchanged; another chain is named in them.
  assets: (tau: number, chain: BearingChain = 'solana') =>
    `/risk/assets?tau=${tau}${chain === 'solana' ? '' : `&chain=${chain}`}`,
  pools: (chain: BearingChain = 'solana') =>
    chain === 'solana' ? '/risk/pools' : `/risk/pools?chain=${chain}`,
  poolsOf: (asset: string, chain: BearingChain = 'solana') =>
    `/risk/pools?asset=${enc(asset)}${chain === 'solana' ? '' : `&chain=${chain}`}`,
  chains: (tau: number) => `/risk/chains?tau=${tau}`,
  sheet: (asset: string, n: number) => `/risk/facts/assets/${enc(asset)}?sizeUsd=${size(n)}`,
  hist: (asset: string, tau: number) => `/risk/assets/${enc(asset)}/history?days=30&tau=${tau}`,
  lendList: () => '/risk/facts/lending',
  lend: (account: string) => `/risk/facts/lending/${enc(account)}`,
  lendH: (account: string, days: number) =>
    `/risk/facts/lending/${enc(account)}/history?days=${days}`,
  heatmap: (asset: string, n: number) =>
    `/risk/assets/${enc(asset)}/heatmap?notional=${Math.round(n)}`,
  liquidity: (pool: string) => `/risk/pools/${enc(pool)}/liquidity?bands=60&rangePct=0.3`,
  recorded: () => '/risk/pools/recorded',
  liqHist: (pool: string) => `/risk/pools/${enc(pool)}/liquidity/history?hours=720`,
  split: (asset: string, n: number) =>
    `/risk/assets/${enc(asset)}/split?side=sell&sizeUsd=${size(n)}`,
  /** Many assets' sheet at `n`, 30-day history and pools in one answer (`GET /risk/dex`). */
  dex: (assets: readonly string[], n: number, chain: BearingChain = 'solana') =>
    `/risk/dex?ids=${assets.map(enc).join(',')}&sizeUsd=${size(n)}${chain === 'solana' ? '' : `&chain=${chain}`}`,
  recov: (asset: string, n: number) =>
    `/risk/recoverable?asset=${enc(asset)}&notional=${Math.round(n)}&hours=168&holderKyc=false`,
};
