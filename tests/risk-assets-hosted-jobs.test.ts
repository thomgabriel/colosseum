import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MetricAnswers, MetricAsset, MetricSources } from '@colosseum/risk';
import { rowsFromAnswers } from '@colosseum/risk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import robinhoodMainnet from '../deployments/robinhood-mainnet.json';
import robinhoodTestnet from '../deployments/robinhood-testnet.json';
import solanaDevnet from '../deployments/solana-devnet.json';
import sourcesJson from '../scripts/risk/assets/metrics.sources.json';
import { Reads, readDexScreener } from '../scripts/risk/assets/metrics-io';
import { runChain } from '../scripts/risk/assets/metrics-run';
import {
  DAILY_WITHIN_MS,
  type DeployRecord,
  dailyDue,
  dailyParts,
  runPlan,
  servedAssets,
} from '../scripts/risk/assets/metrics-schedule';
import { readSolanaMetrics } from '../scripts/risk/assets/metrics-solana';
import { networkCode, offlineCause, waitForNetwork } from '../scripts/risk/assets/network-wait';
import robinhoodList from '../scripts/risk/assets/robinhood.json';
import shelfRobinhood from '../scripts/risk/assets/shelf-robinhood.json';
import shelfSolana from '../scripts/risk/assets/shelf-solana.json';
import solanaList from '../scripts/risk/assets/solana.json';
import {
  HOSTED_WRITE_WINDOW,
  outsideWriteWindow,
  readDeadline,
  WRITE_MARGIN_MS,
  windowEnd,
} from '../scripts/risk/assets/write-window';

// The hosted asset jobs on Thom's Mac (gate ASSET-METRICS, amended 2026-10-22): the hosted metrics job reads only the
// rows the asset lookups answer for, its slow parts once a day, inside minutes 10 to 25 UTC; every hosted job waits
// for the network after a wake and ends with one line when there is none. The installers are held in
// tests/risk-assets-hosted-install.test.ts.

const sources = sourcesJson as unknown as MetricSources;
const records = [robinhoodMainnet, robinhoodTestnet, solanaDevnet] as DeployRecord[];
const sol = solanaList.assets as unknown as MetricAsset[];
const rh = robinhoodList.assets as unknown as MetricAsset[];
const served = {
  solana: servedAssets(
    'solana',
    sol,
    shelfSolana.rows.map((r) => r.address),
    records,
  ),
  robinhood: servedAssets(
    'robinhood',
    rh,
    shelfRobinhood.rows.map((r) => r.address),
    records,
  ),
};

describe('the rows the hosted metrics job reads', () => {
  it('the shelf, the listed rows and every deploy record token or model: about a twentieth of Solana', () => {
    expect(served.solana.length).toBe(100);
    expect(sol.length).toBe(2249);
    expect(served.robinhood.length).toBe(46);
    expect(rh.length).toBe(272);
    const has = (rows: MetricAsset[], address: string) =>
      rows.some((a) => a.address.toLowerCase() === address.toLowerCase());
    for (const a of sol.filter((x) => x.status === 'listed'))
      expect(has(served.solana, a.address)).toBe(true);
    for (const r of shelfSolana.rows) expect(has(served.solana, r.address)).toBe(true);
    // every Robinhood Chain mainnet token the API lists, BABA among them (a candidate below the shelf's floor)
    for (const t of [robinhoodMainnet.cash, ...robinhoodMainnet.assets, ...robinhoodMainnet.hidden])
      if (has(rh, t.address)) expect(has(served.robinhood, t.address), t.id).toBe(true);
    const baba = rh.find((a) => a.symbol === 'BABA');
    expect(baba?.status).toBe('candidate');
    expect(has(shelfRobinhood.rows as unknown as MetricAsset[], baba?.address ?? '')).toBe(false);
    expect(has(served.robinhood, baba?.address ?? '')).toBe(true);
    // a Solana test-network token reads its model's mainnet row: each model is served
    for (const t of [solanaDevnet.cash, ...solanaDevnet.assets]) {
      const model = sol.filter((a) => a.symbol === t.modelOf && a.status === 'listed');
      expect(
        model.some((m) => has(served.solana, m.address)),
        t.id,
      ).toBe(true);
    }
    // a candidate that is on no shelf and in no record is left out
    const left = sol.find(
      (a) => a.status === 'candidate' && !shelfSolana.rows.some((r) => r.address === a.address),
    );
    expect(left && has(served.solana, left.address)).toBe(false);
  });

  it('the list order is kept, and a record of another chain adds nothing', () => {
    const order = served.solana.map((a) => sol.indexOf(a));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(servedAssets('solana', sol, [], [robinhoodMainnet as DeployRecord])).toEqual(
      sol.filter((a) => a.status === 'listed'),
    );
  });
});

describe('the daily parts: once a day, and what a run did not finish the next hour', () => {
  const now = Date.parse('2026-10-22T15:21:00Z');
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const line = (o: Record<string, unknown>) =>
    JSON.stringify({ kind: 'asset-metrics-job', chain: 'solana', dryRun: false, ...o });
  const parts = dailyParts('served', 'solana');

  it('the hosted Solana job has SOL supply as a daily part; the local job and Robinhood Chain do not', () => {
    expect(parts).toEqual([
      'supply_issuer',
      'holders_top20_share',
      'dex_volume_24h_usd',
      'native_supply',
    ]);
    expect(dailyParts('all', 'solana')).not.toContain('native_supply');
    expect(dailyParts('served', 'robinhood')).not.toContain('native_supply');
  });

  it('an empty log: every part is due, and the run asks every metric', () => {
    const due = dailyDue('', 'solana', now, parts);
    expect([...due].sort()).toEqual([...parts].sort());
    const plan = runPlan(due, parts);
    expect(plan.metrics).toContain('holders_top20_share');
    expect(plan.skipReads.size).toBe(0);
  });

  it('after a full daily run: the hourly metrics only, no getTokenLargestAccounts, no getSupply, no DexScreener', () => {
    const log = line({ at: at(2), daily: parts, cutShort: [] });
    const due = dailyDue(log, 'solana', now, parts);
    expect(due.size).toBe(0);
    const plan = runPlan(due, parts);
    expect(plan.metrics).toEqual([
      'supply_total',
      'pool_tvl_usd',
      'protocol_tvl_usd',
      'exchange_rate',
      'yield_realised_30d',
      'yield_quoted',
    ]);
    expect([...plan.skipReads]).toEqual(['native_supply']);
  });

  it('a part its deadline stopped stays due, alone; the next run that finishes it closes the day', () => {
    const cut = line({ at: at(1), daily: parts, cutShort: ['dexscreener'] });
    expect([...dailyDue(cut, 'solana', now, parts)]).toEqual(['dex_volume_24h_usd']);
    const done = `${cut}\n${line({ at: at(0.1), daily: ['dex_volume_24h_usd'], cutShort: [] })}`;
    expect(dailyDue(done, 'solana', now, parts).size).toBe(0);
  });

  it('a run that wrote nothing (past its window) did not do its parts; nor did a dry run', () => {
    const skipped = line({ at: at(1), daily: parts, skipped: 'past the write window' });
    expect(dailyDue(skipped, 'solana', now, parts).size).toBe(parts.length);
    const dry = line({ at: at(1), daily: parts, dryRun: true });
    expect(dailyDue(dry, 'solana', now, parts).size).toBe(parts.length);
  });

  it('a part read more than 23 hours ago is due again; another chain is not this one', () => {
    const old = line({ at: new Date(now - DAILY_WITHIN_MS - 60_000).toISOString(), daily: parts });
    expect(dailyDue(old, 'solana', now, parts).size).toBe(parts.length);
    const other = JSON.stringify({
      kind: 'asset-metrics-job',
      chain: 'robinhood',
      at: at(1),
      daily: parts,
    });
    expect(dailyDue(other, 'solana', now, parts).size).toBe(parts.length);
  });

  it("a line from before Oct 22 (no parts named) counts its daily metrics, and SOL's supply it read every run", () => {
    // the Oct 22 13:21 run on the hosted Mac: every metric, 1,555 s
    const first = line({
      at: at(2),
      metrics: [
        'supply_total',
        'supply_issuer',
        'holders_top20_share',
        'pool_tvl_usd',
        'dex_volume_24h_usd',
        'protocol_tvl_usd',
        'exchange_rate',
        'yield_realised_30d',
        'yield_quoted',
      ],
    });
    expect(dailyDue(first, 'solana', now, parts).size).toBe(0);
    const hourly = line({ at: at(1), metrics: ['supply_total', 'pool_tvl_usd'] });
    expect([...dailyDue(hourly, 'solana', now, parts)].sort()).toEqual(
      ['dex_volume_24h_usd', 'holders_top20_share', 'supply_issuer'].sort(),
    );
  });

  it('a half-written last line is passed over', () => {
    const log = `${line({ at: at(2), daily: parts })}\n{"kind":"asset-metr`;
    expect(dailyDue(log, 'solana', now, parts).size).toBe(0);
  });
});

describe('the write window of the hosted metrics jobs', () => {
  const hour = Date.parse('2026-10-22T15:00:00Z');
  const m = (min: number, s = 0) => hour + min * 60_000 + s * 1000;

  it('the reads of a run started at :21 stop at :23:30; :25 is the end of its window', () => {
    expect(windowEnd(m(21), HOSTED_WRITE_WINDOW)).toBe(m(25));
    expect(readDeadline(m(21), HOSTED_WRITE_WINDOW)).toBe(m(25) - WRITE_MARGIN_MS);
    expect(readDeadline(m(17), HOSTED_WRITE_WINDOW)).toBe(m(23, 30));
  });

  it('a run started when the Mac wakes at :47 is outside its window from the start', () => {
    expect(outsideWriteWindow(m(47), m(47), HOSTED_WRITE_WINDOW)).toBe(true);
    expect(outsideWriteWindow(m(21), m(24, 59), HOSTED_WRITE_WINDOW)).toBe(false);
    expect(outsideWriteWindow(m(21), m(25), HOSTED_WRITE_WINDOW)).toBe(true);
  });

  it('a run past its window writes nothing and touches no database; its parts stay due', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-metrics-'));
    try {
      const untouchable = new Proxy(
        {},
        {
          get() {
            throw new Error('the database was touched');
          },
        },
      );
      const startedAt = new Date().toISOString();
      const parts = dailyParts('served', 'solana');
      const { summary } = await runChain({
        chain: 'solana',
        list: { chain: 'solana', fetchedAt: startedAt, method: 'test', assets: [] },
        listFile: 'scripts/risk/assets/solana.json',
        sources,
        sourcesFile: 'scripts/risk/assets/metrics.sources.json',
        metrics: ['supply_total'],
        prices: false,
        solanaPrices: 'none',
        dryRun: false,
        dataDir: dir,
        db: untouchable as never,
        kind: 'job',
        log: () => {},
        daily: parts,
        mayWrite: () => false,
        read: async () => ({
          kind: 'asset-metrics-answers',
          chain: 'solana',
          stamp: '20261022T1521Z',
          startedAt,
          list: { file: 'x', fetchedAt: startedAt, method: 'test' },
          sources: { file: 'y', reviewedOn: sources.reviewedOn },
          metrics: ['supply_total'],
          rpcLabel: 'test',
        }),
      });
      expect(summary.skipped).toContain('past the write window');
      expect(summary.written.observations.inserted).toBe(0);
      const log = readFileSync(join(dir, 'runs.jsonl'), 'utf8');
      expect(dailyDue(log, 'solana', Date.now(), parts).size).toBe(parts.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DexScreener stopped at the deadline: no row for a token it did not reach', () => {
  afterEach(() => vi.unstubAllGlobals());
  const token = served.solana.find(
    (a) => a.status === 'listed' && a.cls === 'stock',
  ) as MetricAsset;

  it('the batch names a pair, the pairs call is past the deadline: no dex row, and the cut is named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                chainId: 'solana',
                dexId: 'x',
                pairAddress: 'p',
                baseToken: { address: token.address, symbol: token.symbol },
                quoteToken: { address: 'q', symbol: 'USDC' },
              },
            ]),
          ),
      ),
    );
    let cut = false;
    const dex = await readDexScreener('solana', [token.address], new Reads(), {
      deadline: Date.now() - 1,
      onCut: () => {
        cut = true;
      },
    });
    expect(cut).toBe(true);
    expect('withPair' in dex && dex.withPair).toEqual([token.address]);
    const A = {
      kind: 'asset-metrics-answers',
      chain: 'solana',
      stamp: 's',
      startedAt: new Date().toISOString(),
      list: { file: 'x', fetchedAt: new Date().toISOString(), method: 'test' },
      sources: { file: 'y', reviewedOn: sources.reviewedOn },
      metrics: ['dex_volume_24h_usd'],
      rpcLabel: 'test',
      dex,
    } as MetricAnswers;
    const rows = rowsFromAnswers([token], sources, A).rows.filter(
      (r) => r.metric === 'dex_volume_24h_usd',
    );
    expect(rows).toEqual([]);
    // a token the batch named no pair for still reads as having none (a null with its reason)
    const none = rowsFromAnswers([token], sources, {
      ...A,
      dex: { ...(dex as { chainId: string; batchAt: string }), withPair: [], byToken: {} },
    }).rows.filter((r) => r.metric === 'dex_volume_24h_usd');
    expect(none.map((r) => r.nullReason)).toEqual(['no_dexscreener_pair']);
  });
});

describe("SOL's supply in the hosted job: 45 s, then no row until tomorrow", () => {
  afterEach(() => vi.unstubAllGlobals());
  const solRow = sol.find(
    (a) => a.address === 'So11111111111111111111111111111111111111112',
  ) as MetricAsset;
  const untouchable = new Proxy(
    {},
    {
      get() {
        throw new Error('the database was touched');
      },
    },
  );
  /** fetch for getSupply as `answer` says; getBlockTime answers a time. */
  const stubRpc = (answer: 'hang' | 'error' | 'value') =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { method } = JSON.parse(String(init.body)) as { method: string };
        if (method === 'getBlockTime')
          return new Response(JSON.stringify({ result: 1_761_000_000 }));
        if (answer === 'hang')
          return new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
          );
        if (answer === 'error')
          return new Response(JSON.stringify({ error: { code: -32000, message: 'node behind' } }));
        return new Response(
          JSON.stringify({
            result: {
              context: { slot: 1 },
              value: { total: 6e17, circulating: 5e17, nonCirculating: 1e17 },
            },
          }),
        );
      }),
    );
  const read = (o: { deadlineMs: number; nativeSupplyMs: number }) =>
    readSolanaMetrics({
      list: [solRow],
      sources,
      metrics: ['supply_total'],
      prices: false,
      db: untouchable as never,
      riskHome: tmpdir(),
      reads: new Reads(),
      list_: {
        file: 'scripts/risk/assets/solana.json',
        fetchedAt: new Date().toISOString(),
        method: 'test',
      },
      sourcesFile: 'scripts/risk/assets/metrics.sources.json',
      log: () => {},
      deadline: Date.now() + o.deadlineMs,
      nativeSupplyMs: o.nativeSupplyMs,
    });
  const supplyRows = (A: MetricAnswers) =>
    rowsFromAnswers([solRow], sources, A).rows.filter((r) => r.metric === 'supply_total');
  const doneToday = (A: MetricAnswers) =>
    dailyDue(
      JSON.stringify({
        kind: 'asset-metrics-job',
        chain: 'solana',
        at: new Date().toISOString(),
        daily: ['native_supply'],
        cutShort: A.cutShort ?? [],
      }),
      'solana',
      Date.now(),
      ['native_supply'],
    ).size === 0;

  it('no answer in its own time: no row (SOL keeps its last value), tried, not asked again today', async () => {
    stubRpc('hang');
    const A = await read({ deadlineMs: 60_000, nativeSupplyMs: 50 });
    expect(A.nativeSupply).toBeUndefined();
    expect(A.timedOut).toEqual(['native_supply']);
    expect(A.cutShort).toBeUndefined();
    expect(supplyRows(A)).toEqual([]);
    expect(doneToday(A)).toBe(true);
  });

  it("no answer by the run's deadline: no row, and the part stays due for the next hour", async () => {
    stubRpc('hang');
    const A = await read({ deadlineMs: 50, nativeSupplyMs: 10_000 });
    expect(A.cutShort).toEqual(['native_supply']);
    expect(A.timedOut).toBeUndefined();
    expect(supplyRows(A)).toEqual([]);
    expect(doneToday(A)).toBe(false);
  });

  it('an error the RPC answers is still a null row with its reason, as before', async () => {
    stubRpc('error');
    const A = await read({ deadlineMs: 60_000, nativeSupplyMs: 10_000 });
    expect(A.timedOut).toBeUndefined();
    expect(supplyRows(A).map((r) => r.nullReason)).toEqual(['read_failed']);
  });

  it('an answer is a value', async () => {
    stubRpc('value');
    const A = await read({ deadlineMs: 60_000, nativeSupplyMs: 10_000 });
    const rows = supplyRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBeGreaterThan(0);
  });
});

describe('a Mac that wakes before its network', () => {
  // the errors of the Oct 22 logs, as Node and the libraries wrap them
  const drizzle = Object.assign(
    new Error('Failed query: select max(fetched_at) as t from risk_pools'),
    {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND ep-x.neon.tech'), {
        code: 'ENOTFOUND',
      }),
    },
  );
  const aggregate = Object.assign(new Error('Failed query: select distinct on'), {
    cause: Object.assign(
      new AggregateError([
        Object.assign(new Error('connect EHOSTUNREACH 2600::1:5432'), { code: 'EHOSTUNREACH' }),
      ]),
      { code: 'EHOSTUNREACH' },
    ),
  });
  const fetchFailed = new Error('rpc getMultipleAccounts: fetch failed (8 attempts)');
  const unreachable = Object.assign(
    new Error('RPC unreachable after 3 tries (TypeError ENOTFOUND)'),
    { name: 'RpcUnreachable' },
  );

  it('the errors of the Oct 22 logs read as the network; a query error does not', () => {
    expect(networkCode(drizzle)).toBe('ENOTFOUND');
    expect(networkCode(aggregate)).toBe('EHOSTUNREACH');
    expect(networkCode(fetchFailed)).toBe('fetch failed');
    expect(networkCode(unreachable)).toBe('ENOTFOUND');
    expect(networkCode(new Error('relation "risk_pools" does not exist'))).toBeNull();
    expect(networkCode(undefined)).toBeNull();
  });

  it('waits and tries again until the network is back', async () => {
    let t = 0;
    let tries = 0;
    const lines: string[] = [];
    const out = await waitForNetwork([{ host: 'rpc.example', port: 443 }, { host: 'db.example' }], {
      until: 120_000,
      gapMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      probe: async () => {
        tries++;
        if (t < 30_000)
          throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
      log: (l) => lines.push(l),
    });
    expect(out).toBeNull();
    expect(t).toBe(30_000);
    expect(tries).toBe(5); // three failures on the first host, then both hosts answer
    expect(lines[0]).toContain('no network yet (ENOTFOUND)');
    expect(lines.at(-1)).toContain('the network is back after 30 s');
  });

  it('gives up by its limit with the reason, having tried every ten seconds', async () => {
    let t = 0;
    const out = await waitForNetwork([{ host: 'db.example' }], {
      until: 120_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      probe: async () => {
        throw Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
      },
    });
    expect(out).toBe('EHOSTUNREACH');
    expect(t).toBeLessThanOrEqual(120_000);
    expect(t).toBe(120_000);
  });

  it('an error that reads as the network is offline only when the hosts, probed again, do not answer', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const tls = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    });
    const targets = [{ host: 'rpc.example', port: 443 }, { host: 'db.example' }];
    const up = async () => {};
    const down = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await offlineCause(refused, targets, up)).toBeNull();
    expect(await offlineCause(tls, targets, up)).toBeNull();
    expect(await offlineCause(drizzle, targets, up)).toBeNull();
    expect(await offlineCause(drizzle, targets, down)).toBe('ENOTFOUND');
    expect(await offlineCause(new Error('a bug'), targets, down)).toBeNull();
  });

  describe('the run ends with one line and code 0 when the network is gone, and still crashes otherwise', {
    timeout: 60_000,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'offline-exit-'));
    const server = createServer();
    let open = 0;
    let closed = 0;
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      open = (server.address() as AddressInfo).port;
      const gone = createServer();
      await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
      closed = (gone.address() as AddressInfo).port;
      await new Promise((r) => gone.close(r));
    });
    afterAll(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const run = (port: () => number, body: string) => {
      const file = join(dir, `run-${Math.random().toString(36).slice(2)}.mts`);
      writeFileSync(
        file,
        `import { exitCleanlyWhenOffline } from ${JSON.stringify(resolve('scripts/risk/assets/network-wait.ts'))};\nexitCleanlyWhenOffline('hosted-test', [{ host: '127.0.0.1', port: ${port()} }, { host: 'localhost' }]);\n${body}\n`,
      );
      return spawnSync(resolve('node_modules/.bin/tsx'), [file], {
        encoding: 'utf8',
        timeout: 60_000,
      });
    };
    const notResolved = `await Promise.reject(Object.assign(new Error('Failed query: select 1'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND db'), { code: 'ENOTFOUND' }) }));`;

    it('a query whose host does not resolve, and the hosts do not answer: one line, code 0', () => {
      const r = run(() => closed, notResolved);
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      const l = JSON.parse(lines[0] as string);
      expect(l).toMatchObject({ job: 'hosted-test', offline: 'ECONNREFUSED' });
      expect(r.stderr).not.toContain('    at ');
    });

    it('the same error with the hosts answering is a crash with its stack', () => {
      const r = run(() => open, notResolved);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('ENOTFOUND db');
      expect(r.stderr).toContain('    at ');
    });

    it('a refused connection or a TLS error with the network there is a crash', () => {
      const refused = run(
        () => open,
        `throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });`,
      );
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('ECONNREFUSED 127.0.0.1:5432');
      const tls = run(
        () => open,
        `throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });`,
      );
      expect(tls.status).toBe(1);
      expect(tls.stderr).toContain('fetch failed');
    });

    it('any other error is a crash with its stack, as before', () => {
      const r = run(() => closed, `throw new Error('a bug');`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('a bug');
    });
  });
});
