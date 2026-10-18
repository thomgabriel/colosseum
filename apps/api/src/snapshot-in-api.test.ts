import type { Db } from '@colosseum/db';
import { ChainError, type ChainId } from '@colosseum/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainnetRefusal } from '../../snapshot/src/chains';
import type { SnapshotRun } from '../../snapshot/src/run';
import type { ChainSource } from '../../snapshot/src/source';
import {
  DEFAULT_INTERVAL_S,
  FIRST_PASS_DELAY_MS,
  KEEP_AWAKE_MS,
  type SnapshotInApiDeps,
  snapshotInApiSettings,
  startSnapshotInApi,
} from './snapshot-in-api';

// The snapshot worker's loop inside the API: off without its flag, the worker's own passes with it,
// one pass per chain at a time, a failure logged and never thrown, and the keep-awake only on Render.
// No database and no node: the worker's store and the chain rows are stand-ins, and each chain is a
// source handed in. The passes themselves are the worker's (apps/snapshot/src/pass.ts), not a copy.

const db = vi.hoisted(() => ({
  seeded: 0,
  seedFails: 0,
  runs: { opened: 0, closed: 0 },
}));

vi.mock('@colosseum/db', async (actual) => ({
  ...(await actual<typeof import('@colosseum/db')>()),
  seedChains: async () => {
    if (db.seedFails > 0) {
      db.seedFails--;
      throw new Error('the database did not take a query (ECONNREFUSED)');
    }
    db.seeded++;
  },
}));

vi.mock('../../snapshot/src/store', async (actual) => ({
  ...(await actual<typeof import('../../snapshot/src/store')>()),
  closeOpenRuns: async () => 0,
  knownVaults: async () => [],
  snapshottedAddresses: async () => [],
  ownersOf: async () => [],
  openRun: async () => {
    db.runs.opened++;
    return `run-${db.runs.opened}`;
  },
  closeRun: async () => {
    db.runs.closed++;
  },
  closeStaleRuns: async () => 0,
  insertSnapshot: async () => true,
}));

const ON = { SNAPSHOT_IN_API: '1', SNAPSHOT_INTERVAL_S: '60' };
const FAKE_DB = { fake: 'db' } as unknown as Db;

type Logged = { level: 'info' | 'warn' | 'error'; obj: Record<string, unknown>; msg?: string };

function logger() {
  const lines: Logged[] = [];
  const at = (level: Logged['level']) => (obj: object, msg?: string) => {
    lines.push({ level, obj: obj as Record<string, unknown>, msg });
  };
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}

/** A chain with no vault whose rules take `readMs` to read, or throw. Counts its passes in flight. */
function chain(id: ChainId, o: { readMs?: number; fails?: boolean } = {}) {
  const seen = { started: 0, inFlight: 0, most: 0 };
  const source: ChainSource = {
    chain: id,
    name: `${id} (test)`,
    provenance: 'sandbox',
    source: 'test',
    listAssets: async () => [],
    getPrices: async () => [],
    getVault: async () => null,
    getVaults: async () => [],
    height: async () => null,
    rules: async () => {
      seen.started++;
      seen.inFlight++;
      seen.most = Math.max(seen.most, seen.inFlight);
      try {
        if (o.readMs) await new Promise((r) => setTimeout(r, o.readMs));
        if (o.fails) throw new ChainError('Unavailable', 'the node did not answer');
        return { paused: null, lossCapBps: null, bandBps: null };
      } finally {
        seen.inFlight--;
      }
    },
  };
  return { source, seen };
}

function start(env: Record<string, string>, over: Partial<SnapshotInApiDeps> = {}) {
  const { lines, log } = logger();
  const handle = startSnapshotInApi(env, { log, db: () => FAKE_DB, ...over });
  return { handle, lines };
}

const passesDone = (lines: Logged[], id: ChainId) =>
  lines.filter((l) => {
    const s = l.obj.snapshot as { chain?: string; pass?: string } | undefined;
    return s?.chain === id && s.pass === 'done';
  }).length;

beforeEach(() => {
  vi.useFakeTimers();
  db.seeded = 0;
  db.seedFails = 0;
  db.runs = { opened: 0, closed: 0 };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the settings', () => {
  it('are off without SNAPSHOT_IN_API=1, and half an hour by default with it', () => {
    expect(snapshotInApiSettings({})).toBeNull();
    expect(snapshotInApiSettings({ SNAPSHOT_IN_API: '0' })).toBeNull();
    expect(snapshotInApiSettings({ SNAPSHOT_IN_API: '1' })).toEqual({
      intervalS: DEFAULT_INTERVAL_S,
    });
    expect(DEFAULT_INTERVAL_S).toBe(1800);
    expect(snapshotInApiSettings({ SNAPSHOT_IN_API: '1', SNAPSHOT_INTERVAL_S: '600' })).toEqual({
      intervalS: 600,
    });
  });

  it('refuse an interval under a minute or not in whole seconds, and a flag that is not 1 or 0', () => {
    for (const bad of ['59', '6e2', '-60', 'soon'])
      expect(() =>
        snapshotInApiSettings({ SNAPSHOT_IN_API: '1', SNAPSHOT_INTERVAL_S: bad }),
      ).toThrow('SNAPSHOT_INTERVAL_S: expected whole seconds, 60 or more');
    expect(() => snapshotInApiSettings({ SNAPSHOT_IN_API: 'yes' })).toThrow(
      'SNAPSHOT_IN_API: expected 1 (on) or 0 (off)',
    );
  });
});

describe('the loop', () => {
  it('does not start without the flag: no source asked, no pass, nothing logged', async () => {
    const sources = vi.fn(async () => [chain('solana').source]);
    const { handle, lines } = start({ SNAPSHOT_INTERVAL_S: '60' }, { sources });
    expect(handle).toBeNull();
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS + 10 * 60_000);
    expect(sources).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('logs a setting it cannot read and starts nothing', async () => {
    const sources = vi.fn(async () => [chain('solana').source]);
    const { handle, lines } = start(
      { SNAPSHOT_IN_API: '1', SNAPSHOT_INTERVAL_S: '30' },
      { sources },
    );
    expect(handle).toBeNull();
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS + 10 * 60_000);
    expect(sources).not.toHaveBeenCalled();
    expect(lines).toEqual([
      {
        level: 'error',
        obj: { reason: 'SNAPSHOT_INTERVAL_S: expected whole seconds, 60 or more' },
        msg: 'snapshot loop not started',
      },
    ]);
  });

  it('returns at once and runs the worker on the API pool after the first-pass delay', async () => {
    const runs: SnapshotRun[] = [];
    const run = vi.fn(async (o: SnapshotRun) => {
      runs.push(o);
      await new Promise(() => {});
    });
    const { handle, lines } = start(
      { SNAPSHOT_IN_API: '1' },
      { sources: async () => [chain('solana').source], run },
    );
    expect(handle).not.toBeNull();
    // Nothing before the delay: the listen goes first.
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(runs[0]).toMatchObject({
      db: FAKE_DB,
      loop: true,
      dryRun: false,
      intervalMs: DEFAULT_INTERVAL_S * 1000,
    });
    // The worker's own chain rows, held before the first pass, as its start holds them.
    expect(db.seeded).toBe(1);
    expect(lines).toContainEqual({
      level: 'info',
      obj: { intervalS: DEFAULT_INTERVAL_S },
      msg: 'snapshot loop started',
    });
    handle?.stop();
  });

  it('never runs two passes of a chain at once, even when a pass outlasts the interval', async () => {
    // A pass of 90 s against an interval of 60 s.
    const slow = chain('solana', { readMs: 90_000 });
    const { handle } = start(ON, { sources: async () => [slow.source] });
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS + 15 * 60_000);
    handle?.stop();
    expect(slow.seen.started).toBeGreaterThanOrEqual(5);
    expect(slow.seen.most).toBe(1);
    // Each pass opened its run and closed it before the next opened one.
    expect(db.runs.closed).toBeGreaterThanOrEqual(db.runs.opened - 1);
  });

  it('wakes every chain on one grid of the interval', async () => {
    // One chain reads in 1 s and the other in 40 s: on the worker's own sleep they would drift apart.
    const quick = chain('solana', { readMs: 1_000 });
    const slow = chain('robinhood', { readMs: 40_000 });
    const starts: Record<string, number[]> = { solana: [], robinhood: [] };
    for (const [c, id] of [
      [quick, 'solana'],
      [slow, 'robinhood'],
    ] as const) {
      const rules = c.source.rules;
      c.source.rules = () => {
        starts[id]?.push(Date.now());
        return rules();
      };
    }
    const { handle } = start(ON, { sources: async () => [quick.source, slow.source] });
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS + 10 * 60_000);
    handle?.stop();
    expect(starts.solana?.length).toBeGreaterThanOrEqual(5);
    // Pass for pass, the two chains start within a second of each other.
    for (const [i, at] of (starts.solana ?? []).entries())
      expect(Math.abs(at - (starts.robinhood?.[i] ?? 0))).toBeLessThan(1_000);
  });

  it('keeps a failing chain to itself: it backs off and is logged, the other keeps its interval', async () => {
    const down = chain('solana', { fails: true });
    const up = chain('robinhood');
    const { handle, lines } = start(ON, { sources: async () => [down.source, up.source] });
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS + 10 * 60_000);
    handle?.stop();
    expect(passesDone(lines, 'robinhood')).toBeGreaterThanOrEqual(10);
    const failed = lines.filter(
      (l) => (l.obj.snapshot as { outcome?: string } | undefined)?.outcome === 'round-failed',
    );
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed.every((l) => l.level === 'warn')).toBe(true);
    expect(failed[0]?.obj.snapshot).toMatchObject({
      chain: 'solana',
      reason: 'Unavailable: the node did not answer',
      alert: true,
    });
    expect(lines.some((l) => l.level === 'error')).toBe(false);
  });

  it('refuses to start where the worker would, logs why, and asks again each interval', async () => {
    const sigterm = process.listenerCount('SIGTERM');
    const sigint = process.listenerCount('SIGINT');
    const { handle, lines } = start({
      ...ON,
      CHAIN_MODE_SOLANA: 'readonly',
      CHAIN_NETWORK_SOLANA: 'mainnet',
    });
    expect(handle).not.toBeNull();
    const refusal = {
      level: 'error',
      obj: { reason: mainnetRefusal('CHAIN_NETWORK_SOLANA'), retryInS: 60 },
      msg: 'snapshot loop not started',
    };
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    expect(lines).toEqual([refusal]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toEqual([refusal, refusal]);
    expect(db.seeded).toBe(0);
    // The worker's own signal handlers would end the API; none is installed, however often it starts.
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
    expect(process.listenerCount('SIGINT')).toBe(sigint);
  });

  it('tries again an interval later when the database does not answer at start', async () => {
    db.seedFails = 1;
    const up = chain('solana');
    const { handle, lines } = start(ON, { sources: async () => [up.source] });
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    expect(lines).toContainEqual({
      level: 'error',
      obj: { reason: 'the database did not take a query (ECONNREFUSED)', retryInS: 60 },
      msg: 'snapshot loop stopped; tried again later',
    });
    expect(up.seen.started).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(up.seen.started).toBe(1);
    expect(passesDone(lines, 'solana')).toBe(1);
    handle?.stop();
  });
});

describe('the keep-awake', () => {
  const never = async () => {
    await new Promise(() => {});
  };
  const recorder = () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { urls, fetch };
  };

  it('asks /health every ten minutes once the loop runs, with the flag and RENDER_EXTERNAL_URL', async () => {
    const { urls, fetch } = recorder();
    const { handle } = start(
      { SNAPSHOT_IN_API: '1', RENDER_EXTERNAL_URL: 'https://tenonfi-api.example.invalid/' },
      { sources: async () => [chain('solana').source], run: never, fetch },
    );
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS + KEEP_AWAKE_MS - 1);
    expect(urls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + KEEP_AWAKE_MS);
    expect(urls).toEqual([
      'https://tenonfi-api.example.invalid/health',
      'https://tenonfi-api.example.invalid/health',
    ]);
    handle?.stop();
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_MS);
    expect(urls).toHaveLength(2);
  });

  it('is not there without RENDER_EXTERNAL_URL, without the flag, or when the loop was refused', async () => {
    const { urls, fetch } = recorder();
    const sources = async () => [chain('solana').source];
    const handles = [
      start({ SNAPSHOT_IN_API: '1' }, { sources, run: never, fetch }).handle,
      start({ RENDER_EXTERNAL_URL: 'https://a.example.invalid' }, { sources, run: never, fetch })
        .handle,
      start(
        { SNAPSHOT_IN_API: '1', RENDER_EXTERNAL_URL: 'https://b.example.invalid' },
        {
          sources: async () => {
            throw new Error('no chain to read');
          },
          fetch,
        },
      ).handle,
    ];
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS + 3 * KEEP_AWAKE_MS);
    expect(urls).toEqual([]);
    for (const h of handles) h?.stop();
  });
});
