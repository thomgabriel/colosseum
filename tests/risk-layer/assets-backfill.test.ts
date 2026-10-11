import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  type AnchoredPage,
  addToManifest,
  estimateSampled,
  estimateSignatures,
  extrapolate,
  fitsBudget,
  GB,
  type Manifest,
  mergeCovered,
  pageRate,
  quietWaitMs,
  strata,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import {
  classifyPools,
  type Deps,
  fetchLogs,
  LOG_TOPIC,
  logsOf,
  seriesFilters,
} from '../../scripts/risk-evm/backfill-logs';
import { countRounds, fetchRounds, roundIdOf } from '../../scripts/risk-evm/backfill-rounds';
import { CHAINS, type ChainConfig } from '../../scripts/risk-evm/config';
import { replayRpc } from '../../scripts/risk-evm/replay';
import type { RpcReply } from '../../scripts/risk-evm/rpc';

// PLAN-ASSETS AS.8: the backfill walkers, counted and measured, not run in full. The pure parts are checked by
// hand; the walkers replay frozen real answers (fixtures/risk/assets/backfill/, recorded with --record by
// pnpm risk:assets-backfill on 2026-10-11). No test calls the network.
const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const FX = 'fixtures/risk/assets/backfill';
const loadGz = <T>(f: string) => JSON.parse(gunzipSync(readFileSync(join(FX, f))).toString()) as T;

describe('the live loop’s minutes', () => {
  it('reads nothing from minute 1 to minute 14 of an hour, and waits until minute 15', () => {
    expect(quietWaitMs(new Date('2026-10-11T03:00:59Z'))).toBe(0);
    expect(quietWaitMs(new Date('2026-10-11T03:01:00Z'))).toBe(14 * 60_000);
    expect(quietWaitMs(new Date('2026-10-11T03:14:59Z'))).toBe(1_000);
    expect(quietWaitMs(new Date('2026-10-11T03:15:00Z'))).toBe(0);
    expect(quietWaitMs(new Date('2026-10-11T03:59:59Z'))).toBe(0);
  });
});

describe('sampled windows and the estimate of a total', () => {
  it('cuts a span into strata with one window at the middle of each', () => {
    const s = strata(0, 999, 4, 100);
    expect(s.map((x) => [x.from, x.to, ...x.sample])).toEqual([
      [0, 249, 75, 174],
      [250, 499, 325, 424],
      [500, 749, 575, 674],
      [750, 999, 825, 924],
    ]);
    // a stratum shorter than a window is sampled whole
    expect(strata(0, 9, 2, 100).map((x) => x.sample)).toEqual([
      [0, 4],
      [5, 9],
    ]);
  });
  it('scales each window’s count by its stratum’s length', () => {
    const s = strata(0, 999, 2, 100); // strata of 500 blocks, windows of 100: factor 5
    const e = extrapolate([
      { stratum: s[0] as never, counts: { swaps: 10 }, bytes: 1000 },
      { stratum: s[1] as never, counts: { swaps: 30, burns: 2 }, bytes: 3000 },
    ]);
    expect(e.totals).toEqual({ swaps: 200, burns: 10 });
    expect(e.bytes).toBe(20_000);
    expect(e.sampledShare).toBe(0.2);
  });
});

describe('an address’s signatures from anchored pages', () => {
  const page = (t: number, n: number, oldest: number | null, exhausted = false): AnchoredPage => ({
    t,
    n,
    newest: oldest === null ? null : t - 1,
    oldest,
    failed: Math.floor(n / 4),
    exhausted,
  });
  it('a page’s rate is its signatures over the time from its oldest to its anchor', () => {
    expect(pageRate(page(1000, 100, 900))).toBe(1);
    expect(pageRate(page(1000, 0, null))).toBe(0);
  });
  it('integrates the rates between pages, flat beyond them, nothing before the first transaction', () => {
    // rates 1/s at t=950 (the middle of 900…1000) and 3/s at t=2950 (2900…3000)
    const ps = [page(1000, 100, 900), page(3000, 300, 2900)];
    // from 950 to 2950 the mean is 2/s: 4,000; before 950 1/s for 50 s; after 2950 3/s for 50 s
    expect(estimateSignatures(ps, 900, 3000).signatures).toBeCloseTo(50 + 4000 + 150, 9);
    // an exhausted page: nothing before its oldest signature (800)
    const withFirst = [page(1000, 100, 800, true), page(3000, 300, 2900)];
    const r = estimateSignatures(withFirst, 0, 900);
    expect(r.firstSeen).toBe(800);
    // rate at 900 (the middle of 800…1000) is 100/200 = 0.5/s, flat before it: 100 s from 800 to 900
    expect(r.signatures).toBeCloseTo(50, 9);
    expect(r.failedShare).toBeCloseTo(100 / 400, 12);
    // a page that found nothing at 2000: nothing before 2000; after it the rate rises from 0 (at 2000) to
    // 3/s (at 2950), so 2000…2500 holds half of 500 s × 3·500/950
    const none = [page(2000, 0, null), page(3000, 300, 2900)];
    expect(estimateSignatures(none, 0, 2000).signatures).toBe(0);
    expect(estimateSignatures(none, 0, 2500).signatures).toBeCloseTo(
      (500 * ((3 * 500) / 950)) / 2,
      9,
    );
  });
  it('the sampled walk keeps at most a number of transactions an hour', () => {
    // 1 signature a second, a quarter failed: 2,700 successful an hour, 30 kept, over two hours
    const ps = [page(0, 3600, -3600), page(7200, 3600, 3600)];
    const r = estimateSampled(ps, 0, 7200, 30);
    expect(r).toEqual({ fetched: 60, hours: 2 });
  });
});

describe('the budget (DA14, amended)', () => {
  it('fits 35 GB of new data and keeps 25 GB free, and says which it breaks', () => {
    expect(fitsBudget({ estimateBytes: 10 * GB, usedBytes: 1 * GB, freeBytes: 60 * GB }).fits).toBe(
      true,
    );
    // 6 + 30 = 36 GB of new data; 50 − 30 = 20 GB left free
    const over = fitsBudget({ estimateBytes: 30 * GB, usedBytes: 6 * GB, freeBytes: 50 * GB });
    expect(over.fits).toBe(false);
    expect(over.reasons).toHaveLength(2);
    expect(over.reasons[0]).toMatch(/36\.00 GB would pass the 35 GB budget/);
    expect(over.reasons[1]).toMatch(/fall to 20\.00 GB, under the 25 GB floor/);
    // 60 − 30 = 30 GB stays above the floor: only the budget is broken
    expect(
      fitsBudget({ estimateBytes: 30 * GB, usedBytes: 6 * GB, freeBytes: 60 * GB }).reasons,
    ).toHaveLength(1);
    expect(fitsBudget({ estimateBytes: 1 * GB, usedBytes: 0, freeBytes: 25.5 * GB }).fits).toBe(
      false,
    );
  });
});

describe('manifests', () => {
  it('merges the windows covered where they touch, by unit', () => {
    expect(
      mergeCovered(
        [
          { from: 10, to: 19, unit: 'block' },
          { from: 40, to: 49, unit: 'block' },
        ],
        { from: 20, to: 39, unit: 'block' },
      ),
    ).toEqual([{ from: 10, to: 49, unit: 'block' }]);
  });
  it('adds a window’s days and replaces a check of the same name', () => {
    const m: Manifest = {
      series: 'robinhood-logs',
      chain: 'robinhood',
      subject: 'x',
      methodVersion: 'backfill-0.1',
      source: 's',
      provenance: 'live',
      covered: [],
      days: { '2026-10-01': { rows: 5, bytes: 50 } },
      rows: 5,
      bytes: 50,
      checks: [{ name: 'a', passed: false, detail: 'old' }],
      updatedAt: 't0',
    };
    const n = addToManifest(
      m,
      { from: 1, to: 2, unit: 'block' },
      { '2026-10-02': { rows: 3, bytes: 30 } },
      [{ name: 'a', passed: true, detail: 'new' }],
      't1',
    );
    expect([n.rows, n.bytes, n.checks, n.updatedAt]).toEqual([
      8,
      80,
      [{ name: 'a', passed: true, detail: 'new' }],
      't1',
    ]);
  });
});

describe('Robinhood Chain logs: the filters and the pools of the list', () => {
  it('six filters, one subject narrows them to its kind', () => {
    const all = seriesFilters(robinhood, ['0x117cc2133c37b721f49de2a7a74833232b3b4c0c']);
    expect(all.map((f) => f.name)).toEqual([
      'v3_swap',
      'v4_swap',
      'mint',
      'burn',
      'v3_liquidity',
      'v4_liquidity',
    ]);
    expect(all.find((f) => f.name === 'v4_swap')?.address).toBe(robinhood.v4?.poolManager);
    expect(all.find((f) => f.name === 'v4_swap')?.topics).toEqual([LOG_TOPIC.v4Swap]);
    const id = `0x${'ab'.repeat(32)}`;
    const one = seriesFilters(robinhood, [], { subject: id, subjectKind: 'v4', kind: 'swaps' });
    expect(one.map((f) => [f.name, f.topics])).toEqual([['v4_swap', [LOG_TOPIC.v4Swap, id]]]);
  });
  it('a pool is of the list when either token is a row of it', () => {
    const c = classifyPools(
      [
        { kind: 'cl', id: '0xA', token0: '0x1', token1: '0x2', block: 50 },
        { kind: 'v4', id: '0xB', token0: '0x3', token1: '0x4', block: 10 },
      ],
      new Set(['0x2']),
    );
    expect([
      c.classOf('0xa'),
      c.classOf('0xb'),
      c.classOf('0xc'),
      c.listPools,
      c.firstBlock,
    ]).toEqual(['list_pool', 'other_pool', 'unknown_pool', 1, 50]);
  });
  it('halves a window the endpoint refuses for its size', async () => {
    const asked: Array<[number, number]> = [];
    const rpc = replayRpc({}, (r) => {
      const p = (r.params[0] as { fromBlock: string; toBlock: string }) ?? {};
      const a = Number(p.fromBlock);
      const b = Number(p.toBlock);
      asked.push([a, b]);
      // the endpoint's own words (fixtures/risk-evm/rpc-errors.json style): more than 2 blocks is too many
      return (
        b - a > 1
          ? { error: { code: -32005, message: 'query exceeds limit of 10000 results' } }
          : {
              result: [
                {
                  address: '0x1',
                  topics: [],
                  data: '0x',
                  blockNumber: `0x${a.toString(16)}`,
                  transactionHash: '0x',
                  logIndex: '0x0',
                },
              ],
            }
      ) as RpcReply;
    });
    const deps: Deps = {
      rpc,
      sleep: async () => {},
      now: () => new Date('2026-10-11T03:30:00Z'),
      log: () => {},
    };
    const f = seriesFilters(robinhood, [])[0] as never;
    const got = await logsOf(deps, f, 0, 7);
    expect(got.logs.map((l) => Number(l.blockNumber))).toEqual([0, 2, 4, 6]);
    expect(got.halvings).toBe(3);
    expect(asked[0]).toEqual([0, 7]);
  });
});

type Recording = { recordedAt: string; args: string[]; answers: Record<string, RpcReply> };
const fetchFx = join(FX, 'robinhood-logs-fetch.json.gz');
const roundsFx = join(FX, 'chainlink-rounds.json.gz');
const quiet = (d: Date) => () => d;

describe.skipIf(!existsSync(fetchFx))('Robinhood Chain logs: a recorded fetch, replayed', () => {
  it('files a pool’s swaps by day with a manifest, and a second run asks nothing', async () => {
    const rec = loadGz<Recording>('robinhood-logs-fetch.json.gz');
    const window = rec.args[rec.args.indexOf('--window') + 1] as string;
    const pool = rec.args[rec.args.indexOf('--pool') + 1] as string;
    const [from, to] = window.split('-').map(Number) as [number, number];
    const out = mkdtempSync(join(tmpdir(), 'backfill-'));
    const rpc = replayRpc(rec.answers);
    const deps: Deps = {
      rpc,
      sleep: async () => {},
      now: quiet(new Date(rec.recordedAt)),
      log: () => {},
    };
    const filters = seriesFilters(robinhood, [], {
      subject: pool,
      subjectKind: 'v4',
      kind: 'swaps',
    });
    const inp = {
      out,
      filters,
      from,
      to,
      window: 100_000,
      keep: (r: { subject: string }) => r.subject === pool,
      source: 'replay',
    };
    const res = await fetchLogs(deps, inp);
    expect(res.rows).toBeGreaterThan(0);
    const dir = join(out, 'swaps', pool);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    expect(m.covered).toEqual([{ from, to, unit: 'block' }]);
    expect(m.rows).toBe(res.rows);
    expect(m.checks.every((c) => c.passed)).toBe(true);
    const lines = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl.gz'))
      .flatMap((f) =>
        gunzipSync(readFileSync(join(dir, f)))
          .toString()
          .trim()
          .split('\n'),
      );
    expect(lines).toHaveLength(res.rows);
    const rows = lines.map((l) => JSON.parse(l) as { block: number; t: number; topics: string[] });
    expect(rows.every((r) => r.block >= from && r.block <= to && r.topics[1] === pool)).toBe(true);
    expect(rows.every((r) => r.t > 1.7e9)).toBe(true);
    const asked = rpc.asked.length;
    const again = await fetchLogs(deps, inp);
    expect([again.pieces, again.skipped, rpc.asked.length]).toEqual([0, res.pieces, asked]);
  });
});

describe.skipIf(!existsSync(roundsFx))(
  'Chainlink rounds: a recorded count and fetch, replayed',
  () => {
    it('counts the phases and rounds and fetches one feed with its checks', async () => {
      const rec = loadGz<
        Recording & { feeds: Array<{ feed: string; symbol: string }>; feed: string }
      >('chainlink-rounds.json.gz');
      const deps: Deps = {
        rpc: replayRpc(rec.answers),
        sleep: async () => {},
        now: quiet(new Date(rec.recordedAt)),
        log: () => {},
      };
      const c = await countRounds(deps, robinhood, rec.feeds);
      const f = c.feeds.find((x) => x.feed === rec.feed);
      if (!f) throw new Error('feed');
      expect(f.rounds).toBe(f.phases.reduce((a, p) => a + (p.rounds ?? 0), 0));
      expect(f.phase).toBe(f.phases.length);
      const out = mkdtempSync(join(tmpdir(), 'rounds-'));
      const r = await fetchRounds(deps, robinhood, f, out, 'replay');
      expect(r.rounds).toBe(f.rounds);
      expect(r.checks.find((x) => x.name === 'every_round_answered')?.passed).toBe(true);
      expect(roundIdOf(1, 1n).toString()).toBe('18446744073709551617');
      // the rounds SGOV's feed gave on 2026-10-06 (fixtures/risk/sgov-feed-rounds.json, read one by one by
      // scripts/feeds/refresh-models.ts) are the first rounds of this walk, unchanged
      const old = JSON.parse(readFileSync('fixtures/risk/sgov-feed-rounds.json', 'utf8')) as {
        feed: string;
        rounds: Array<{ id: string; answer: string; updatedAt: number }>;
      };
      if (old.feed === rec.feed) {
        const dir = join(out, rec.feed);
        const rows = readdirSync(dir)
          .filter((x) => x.endsWith('.jsonl.gz'))
          .sort()
          .flatMap((x) =>
            gunzipSync(readFileSync(join(dir, x)))
              .toString()
              .trim()
              .split('\n'),
          )
          .map((l) => JSON.parse(l) as { roundId: string; answer: string; updatedAt: number });
        const byId = new Map(rows.map((r) => [r.roundId, r]));
        for (const o of old.rounds) {
          expect(byId.get(o.id)?.answer).toBe(o.answer);
          expect(byId.get(o.id)?.updatedAt).toBe(o.updatedAt);
        }
      }
    });
  },
);
