import { type EnvLike, readEnv } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { riskReadCacheOf } from './routes/risk-cache';
import { DEX_DEFAULTS, dexAssetPath, dexPaths, visitorsOf } from './routes/risk-dex';
import { msToMinute } from './snapshot-in-api';

// The hourly warm of the analytics pages' reads (gate RISK-WARM). Once an hour, after the hourly import
// has written, the API reads again, one at a time and behind any visitor, what the pages will ask for,
// so a visitor is answered from what is kept instead of making the host work it out on its small CPU.
// What it keeps stays fresh past the next warm (risk-cache.ts, `warmedFreshMs`).
//
// What it reads: each page's lists (`WARM_PAGES`), then what visitors asked for since the last warm,
// first asked first. With RISK_WARM_ALL=1 it reads every listed asset's entry of `GET /risk/dex` too,
// Solana's first: about 30 MB from the database each pass, which Neon's free transfer cannot carry
// every hour, so it is off by default. A `/risk/dex/{id}` entry is read after its three parts, so it is
// made of what the warm just read.

/** The minute of each UTC hour the warm starts at: the hourly import has the database awake :10 to :25. */
export const DEFAULT_WARM_MINUTE = 26;
/** Twelve minutes at most, so it ends by :38 at the default minute, before the database would sleep. */
export const WARM_MAX_MS = 12 * 60_000;
/** How long it waits before looking again while a visitor's request is under way. */
const PAUSE_MS = 250;

/** What every analytics page reads first, both chains; the stocks page's first. */
export const WARM_PAGES = [
  '/risk/facts/methodology',
  '/risk/assets?tau=0.01',
  '/risk/chains?tau=0.01',
  '/risk/pools/recorded',
  '/risk/facts/lending',
  '/risk/assets?tau=0.01&chain=robinhood',
] as const;

export type RiskWarmSettings = { atMinute: number; all: boolean };

/**
 * Null when the warm is off (`RISK_WARM_AT_MINUTE=off`). Throws on a value it cannot read, naming the
 * variable and never its value. The minute is 0 to 59, `DEFAULT_WARM_MINUTE` when unset.
 */
export function riskWarmSettings(env: EnvLike): RiskWarmSettings | null {
  const minuteRaw = readEnv(env, 'RISK_WARM_AT_MINUTE');
  if (minuteRaw === 'off') return null;
  const atMinute =
    minuteRaw === undefined
      ? DEFAULT_WARM_MINUTE
      : /^\d{1,2}$/.test(minuteRaw)
        ? Number(minuteRaw)
        : -1;
  if (atMinute < 0 || atMinute > 59)
    throw new Error('RISK_WARM_AT_MINUTE: expected a whole minute, 0 to 59, or off');
  const allRaw = readEnv(env, 'RISK_WARM_ALL');
  if (allRaw !== undefined && allRaw !== '0' && allRaw !== '1')
    throw new Error('RISK_WARM_ALL: expected 1 (every listed asset) or 0');
  return { atMinute, all: allRaw === '1' };
}

/** A `/risk/dex/{id}` entry's three parts, read before it; any other address alone. */
export function withParts(url: string): string[] {
  const m = /^\/risk\/dex\/([^/?]+)\?(.*)$/.exec(url);
  if (!m) return [url];
  const q = new URLSearchParams(m[2]);
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const p = dexPaths(decodeURIComponent(m[1] as string), {
    chain: q.get('chain') === 'robinhood' ? 'robinhood' : 'solana',
    sizeUsd: num('sizeUsd', DEX_DEFAULTS.sizeUsd),
    days: num('days', DEX_DEFAULTS.days),
    tau: num('tau', DEX_DEFAULTS.tau),
  });
  return [p.sheet, p.hist, p.pools, url];
}

export type WarmPassResult = {
  read: number;
  failed: number;
  /** Left unread at the time limit. */
  left: number;
  ms: number;
  /** The process's CPU over the pass (user and system), which visitors' requests share. */
  cpuMs: number;
};

export type WarmPassOptions = {
  all?: boolean;
  maxMs?: number;
  pauseMs?: number;
  log?: (obj: object, msg: string) => void;
};

/** One warm: every address read again in order, one at a time, behind visitors, until `maxMs`. */
export async function warmPass(
  app: FastifyInstance,
  opts: WarmPassOptions = {},
): Promise<WarmPassResult> {
  const { all = false, maxMs = WARM_MAX_MS, pauseMs = PAUSE_MS, log = () => {} } = opts;
  const started = Date.now();
  const cpu0 = process.cpuUsage();
  const cache = riskReadCacheOf(app);
  const out = { read: 0, failed: 0, left: 0 };
  if (!cache) return { ...out, ms: 0, cpuMs: 0 };
  const seen = visitorsOf(app);
  const pause = (ms: number) => new Promise((d) => setTimeout(d, ms).unref?.());
  const late = () => Date.now() - started > maxMs;
  const asked = cache.takeAsked();
  const lists: Record<string, string> = {};
  const queue = new Set<string>();
  const add = (urls: readonly string[]) => {
    for (const u of urls) for (const v of withParts(u)) queue.add(v);
  };
  add(WARM_PAGES);
  for (const url of queue) {
    while (seen && seen.inFlight > 0 && !late()) await pause(pauseMs);
    if (late()) break;
    const r = await cache.read(url, { again: true });
    if (r.status === 200) out.read++;
    else out.failed++;
    if (url.startsWith('/risk/assets?')) lists[url] = r.body;
    // After the lists: every listed asset when told to, then what visitors asked for.
    if (url === WARM_PAGES[WARM_PAGES.length - 1]) {
      if (all) add(listedEntries(lists));
      add(asked);
    }
  }
  out.left = queue.size - out.read - out.failed;
  const c = process.cpuUsage(cpu0);
  const result = {
    ...out,
    ms: Date.now() - started,
    cpuMs: Math.round((c.user + c.system) / 1000),
  };
  log(result, `risk reads warmed: ${out.read} read again, ${out.failed} failed, ${out.left} left`);
  return result;
}

/** Each listed asset's entry of `GET /risk/dex`, Solana's first, from the asset lists just read. */
function listedEntries(lists: Record<string, string>): string[] {
  const of = (url: string) => {
    try {
      return (
        (JSON.parse(lists[url] ?? '') as { assets?: Array<{ symbol: string; assetMint: string }> })
          .assets ?? []
      );
    } catch {
      return [];
    }
  };
  return [
    ...of('/risk/assets?tau=0.01').map((a) =>
      dexAssetPath(a.symbol, { chain: 'solana', ...DEX_DEFAULTS }),
    ),
    ...of('/risk/assets?tau=0.01&chain=robinhood').map((a) =>
      dexAssetPath(a.assetMint, { chain: 'robinhood', ...DEX_DEFAULTS }),
    ),
  ];
}

type Log = {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type RiskWarm = { stop(): void };

/**
 * Starts the hourly warm in the background and returns at once: at `atMinute` of each UTC hour, one pass;
 * the next waits for the next hour's minute, so passes never overlap. A failed pass is logged and the
 * API keeps serving. Null when off or when its settings cannot be read (logged).
 */
export function startRiskWarm(
  app: FastifyInstance,
  env: EnvLike,
  deps: { log: Log; now?: () => number; pass?: typeof warmPass },
): RiskWarm | null {
  let settings: RiskWarmSettings | null;
  try {
    settings = riskWarmSettings(env);
  } catch (e) {
    deps.log.error({ reason: (e as Error).message }, 'risk warm not started');
    return null;
  }
  if (!settings) return null;
  const { atMinute, all } = settings;
  const now = deps.now ?? Date.now;
  const pass = deps.pass ?? warmPass;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const next = () => {
    if (stopped) return;
    timer = setTimeout(run, msToMinute(now(), atMinute));
    timer.unref?.();
  };
  const run = async () => {
    try {
      await pass(app, { all, log: (obj, msg) => deps.log.info(obj, msg) });
    } catch (e) {
      deps.log.error({ reason: (e as Error).message }, 'risk warm failed');
    }
    next();
  };
  deps.log.info({ atMinute, all }, 'risk warm started');
  next();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
