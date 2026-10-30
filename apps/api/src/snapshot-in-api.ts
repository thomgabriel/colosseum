import { type Db, sharedDb } from '@colosseum/db';
import { type ChainId, type EnvLike, type Provenance, readEnv } from '@colosseum/schemas';
import { MIN_INTERVAL_S } from '../../snapshot/src/args';
import { sourcesFromEnv } from '../../snapshot/src/chains';
import { hiderFromEnv } from '../../snapshot/src/hide';
import { lastWords, type StartDeps, start } from '../../snapshot/src/main';
import { said, snapshotVault, type VaultRead } from '../../snapshot/src/pass';
import { runSnapshots } from '../../snapshot/src/run';
import type { ChainSource } from '../../snapshot/src/source';

// The snapshot worker's loop inside the API process (apps/snapshot/README.md, "Inside the API"), so the
// hosted API keeps `vault_snapshots` fresh with no machine of its own. Off unless SNAPSHOT_IN_API=1.
//
// It is the worker's own start (`start` of apps/snapshot/src/main.ts): the same chain flags, the same
// mainnet refusals, the same node checks, the same passes and back-off. What changes is around it: the
// database is the API's one pool (`sharedDb`), the interval is SNAPSHOT_INTERVAL_S (half an hour by
// default, for a database that sleeps when nobody asks it anything), the lines go to the API's log, and
// nothing here ends the process: a refusal, a failed pass or a database that does not answer is logged
// and the API keeps serving.
//
// Hosted, SNAPSHOT_AT_MINUTE puts the passes at one minute of each UTC hour (gate SNAPSHOT-IN-API,
// amended Oct 19): the minute the hourly market-data import already has the database awake, so the
// passes do not wake it a second time each hour.

/** Half an hour when no minute is set. A snapshot is stale after two hours (SNAPSHOT_STALE_AFTER_SECONDS). */
export const DEFAULT_INTERVAL_S = 1800;
/** The one interval SNAPSHOT_AT_MINUTE runs on: a pass an hour. */
export const HOURLY_INTERVAL_S = 3600;
const HOUR_MS = HOURLY_INTERVAL_S * 1000;
/** After the listen, so the start's own reads (the shelf, the risk warm-up) go first. */
export const FIRST_PASS_DELAY_MS = 30_000;
/** Render's free plan sleeps a service after 15 minutes with no request from outside. */
export const KEEP_AWAKE_MS = 600_000;

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type SnapshotInApiSettings = {
  intervalS: number;
  /** The minute of each UTC hour a pass starts at; null for a grid from the first pass. */
  atMinute: number | null;
};

/**
 * Null when the loop is off. Throws on a value it cannot read, naming the variable and never its value.
 * The interval is whole seconds, the worker's floor or more (apps/snapshot/src/args.ts). A minute, 0 to
 * 59, needs the hourly interval: with no interval set it is that one, and any other is refused.
 */
export function snapshotInApiSettings(env: EnvLike): SnapshotInApiSettings | null {
  const flag = readEnv(env, 'SNAPSHOT_IN_API');
  if (flag === undefined || flag === '0') return null;
  if (flag !== '1') throw new Error('SNAPSHOT_IN_API: expected 1 (on) or 0 (off)');
  const minuteRaw = readEnv(env, 'SNAPSHOT_AT_MINUTE');
  const atMinute =
    minuteRaw === undefined ? null : /^\d{1,2}$/.test(minuteRaw) ? Number(minuteRaw) : -1;
  if (atMinute !== null && (atMinute < 0 || atMinute > 59))
    throw new Error('SNAPSHOT_AT_MINUTE: expected a whole minute, 0 to 59');
  const raw = readEnv(env, 'SNAPSHOT_INTERVAL_S');
  if (raw === undefined)
    return { intervalS: atMinute === null ? DEFAULT_INTERVAL_S : HOURLY_INTERVAL_S, atMinute };
  const intervalS = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(intervalS) || intervalS < MIN_INTERVAL_S)
    throw new Error(`SNAPSHOT_INTERVAL_S: expected whole seconds, ${MIN_INTERVAL_S} or more`);
  if (atMinute !== null && intervalS !== HOURLY_INTERVAL_S)
    throw new Error(
      `SNAPSHOT_AT_MINUTE: needs SNAPSHOT_INTERVAL_S=${HOURLY_INTERVAL_S}, one pass an hour`,
    );
  return { intervalS, atMinute };
}

/** Milliseconds from `at` to the next start of `minute` in a UTC hour: never zero, at most an hour. */
export function msToMinute(at: number, minute: number): number {
  const into = (((at - minute * 60_000) % HOUR_MS) + HOUR_MS) % HOUR_MS;
  return HOUR_MS - into;
}

export type SnapshotInApiDeps = {
  log: Log;
  /** Default: the API's one pool. */
  db?: () => Db;
  /** The worker's chain sources. Default: its own `sourcesFromEnv`. A test hands in its own. */
  sources?: StartDeps['sources'];
  /** Default: the worker's `runSnapshots`. */
  run?: typeof runSnapshots;
  fetch?: typeof fetch;
  now?: () => number;
  firstPassDelayMs?: number;
};

export type SnapshotInApi = {
  stop(): void;
  /** Whether the loop's start set up a source for this chain and label: none before it, or after a refusal. */
  readsChain(chain: ChainId, provenance: Provenance): boolean;
  /**
   * Reads one vault now and keeps its row (apps/snapshot's `snapshotVault`), on a chain the loop reads
   * and under the label it reads it with. Null when the loop has no source for that chain and label
   * yet (not started, refused, or a chain it does not read): nothing is read. Throws as the read does,
   * with a reason that names no node.
   */
  readVault(chain: ChainId, provenance: Provenance, address: string): Promise<VaultRead | null>;
};

/** Said by a stopped loop's sleep, so the worker's loop ends and nothing logs it as a failure. */
class Stopped extends Error {}

/**
 * Starts the loop in the background and returns at once: the listen is never held up. Null when the
 * loop is off or its settings cannot be read (logged). One pass per chain at a time: the worker's loop
 * sleeps after a pass, never beside it. The chains wake on one schedule, so their passes meet the
 * database together rather than waking it once each: a grid of the interval from the first pass, or,
 * with a minute set, that minute of every UTC hour. The first pass is always the delay after the
 * start, so a deploy shows fresh values at once; the minute holds from the pass after it. A pass that
 * runs past the minute waits for the next hour's. The back-off after a failed pass is the worker's.
 *
 * A refusal at start (a mainnet the worker does not read, no chain, a missing node address, a node of
 * another network) is logged and the loop stays off: the worker would refuse the same. Anything after
 * that (the database did not answer the chain rows or the run cleanup) is logged and tried again an
 * interval later, or at the next minute when one is set.
 */
export function startSnapshotInApi(env: EnvLike, deps: SnapshotInApiDeps): SnapshotInApi | null {
  const { log } = deps;
  let settings: SnapshotInApiSettings | null;
  try {
    settings = snapshotInApiSettings(env);
  } catch (e) {
    log.error({ reason: lastWords(env, e) }, 'snapshot loop not started');
    return null;
  }
  if (!settings) return null;

  const { atMinute } = settings;
  const intervalMs = settings.intervalS * 1000;
  const hide = hiderFromEnv(env);
  const now = deps.now ?? Date.now;
  // The grid's origin: the first pass. Set again when the loop is started again.
  let epoch = now();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sleeping = new Set<(e: Error) => void>();
  let keepAwake: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  // The chains the worker's start set up, kept for the reads of one vault: the same sources, so the
  // same chains, labels, nodes and refusals.
  let sources: ChainSource[] = [];

  const later = (ms: number, then: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      then();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };

  // The worker's back-off is its own (15 s doubling to 5 min). The interval is waited out to the next
  // tick of one schedule shared by every chain: the grid, or the next minute set.
  const nextTick = () =>
    atMinute === null ? intervalMs - ((now() - epoch) % intervalMs) : msToMinute(now(), atMinute);
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (stopped) return reject(new Stopped());
      const wait = ms === intervalMs ? nextTick() : ms;
      sleeping.add(reject);
      later(wait, () => {
        sleeping.delete(reject);
        resolve();
      });
    });

  const startKeepAwake = () => {
    const base = env.RENDER_EXTERNAL_URL?.trim().replace(/\/+$/, '');
    if (!base || keepAwake) return;
    const post = deps.fetch ?? fetch;
    // /health answers from memory and asks the database nothing (app.ts).
    keepAwake = setInterval(() => {
      post(`${base}/health`, { signal: AbortSignal.timeout(10_000) }).then(
        (res) => {
          if (!res.ok) log.warn({ status: res.status }, 'keep-awake ping answered');
        },
        () => log.warn({}, 'keep-awake ping could not be sent'),
      );
    }, KEEP_AWAKE_MS);
    keepAwake.unref?.();
  };

  const out = (line: string) => {
    let parsed: unknown = line;
    try {
      parsed = JSON.parse(line);
    } catch {}
    const alert = typeof parsed === 'object' && parsed !== null && 'alert' in parsed;
    (alert ? log.warn : log.info).call(log, { snapshot: parsed }, 'snapshot');
  };

  const attempt = async () => {
    let configured = false;
    epoch = now();
    try {
      await start(['--loop', '--interval', String(settings.intervalS)], env, {
        sources: async (...args) => {
          const made = await (deps.sources ?? sourcesFromEnv)(...args);
          configured = true;
          sources = made;
          return made;
        },
        // The API's pool, which outlives the loop: nothing here may end it.
        open: () => ({ db: (deps.db ?? (() => sharedDb().db))(), client: { end: async () => {} } }),
        // The API process is stopped as the API is; the worker's signal handler would end it early.
        onStop: () => {},
        // The worker's own warn hides node URLs; this one replaces it, so it hides them too.
        warn: (line) => log.warn({ reason: hide(line) }, 'snapshot'),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        run: (o) => {
          startKeepAwake();
          log.info(
            atMinute === null
              ? { intervalS: settings.intervalS }
              : { intervalS: settings.intervalS, atMinute },
            'snapshot loop started',
          );
          return (deps.run ?? runSnapshots)({ ...o, out, sleep });
        },
      });
    } catch (e) {
      if (stopped && e instanceof Stopped) return;
      const reason = lastWords(env, e);
      // An interval later, or at the next minute set, where the database is awake anyway.
      const retryMs = atMinute === null ? intervalMs : msToMinute(now(), atMinute);
      const retryInS = Math.ceil(retryMs / 1000);
      // A refusal at start is tried again each interval: a node behind a load balancer can lag once
      // (an empty eth_getCode), and the standalone worker would have been restarted by launchd.
      log.error(
        { reason, retryInS },
        configured ? 'snapshot loop stopped; tried again later' : 'snapshot loop not started',
      );
      if (!stopped) later(retryMs, () => void attempt());
    }
  };

  function stop() {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const reject of sleeping) reject(new Stopped());
    sleeping.clear();
    if (keepAwake) clearInterval(keepAwake);
    keepAwake = null;
  }

  const sourceOf = (chain: ChainId, provenance: Provenance) =>
    sources.find((s) => s.chain === chain && s.provenance === provenance);

  async function readVault(chain: ChainId, provenance: Provenance, address: string) {
    const source = sourceOf(chain, provenance);
    if (!source) return null;
    try {
      return await snapshotVault((deps.db ?? (() => sharedDb().db))(), source, address);
    } catch (e) {
      // Said as a pass says it: no node's address, the first line only.
      throw new Error(said({ hide }, e));
    }
  }

  later(deps.firstPassDelayMs ?? FIRST_PASS_DELAY_MS, () => void attempt());
  return {
    stop,
    readsChain: (chain, provenance) => sourceOf(chain, provenance) !== undefined,
    readVault,
  };
}
