import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createDb, marketBars } from '@colosseum/db';
import {
  carriedPrice,
  fileEvmPool,
  priceJobHoldBack,
  roundPrice,
  scaled,
  wholeDaysOfBlocks,
  wholeDaysOfSeconds,
} from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { and, eq, gte, lte } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  readRobinhoodBackfill,
  readSolanaBackfill,
  solanaRegistryPools,
} from '../../scripts/risk/assets/bars-backfill';
import { solanaRegime } from '../../scripts/risk/assets/bars-read';
import { barRows, insertBarsKeep } from '../../scripts/risk/assets/bars-rows';
import { buildHistory, insertKeep } from '../../scripts/risk/assets/history-import';

// PLAN-ASSETS AS.13: the backfill's files into the database. The fixtures are real rows of the backfill's files,
// cut by scripts/risk/assets/freeze-history-fixture.ts and laid out as ASSETS_DATA_DIR lays them out
// (fixtures/risk/assets/history). The figures checked by hand are recomputed here from the raw amounts.
const F = 'fixtures/risk/assets/history';
const DAY = 86_400;
const t = (iso: string) => Date.parse(iso) / 1000;
const lines = (file: string) =>
  gunzipSync(readFileSync(`${F}/${file}`))
    .toString('utf8')
    .split('\n')
    .filter(Boolean);

const solRead = () =>
  readSolanaBackfill({
    dataDir: F,
    registry: solanaRegistryPools(`${F}/shelf-registry-solana.json`),
    registryFile: `${F}/shelf-registry-solana.json`,
    regimeOfT: solanaRegime(),
  });
const count = JSON.parse(readFileSync(`${F}/robinhood/robinhood-logs/count-fixture.json`, 'utf8'));
const rhList = JSON.parse(readFileSync('scripts/risk/assets/robinhood.json', 'utf8')) as AssetList;
const rhRead = () =>
  readRobinhoodBackfill({
    dataDir: F,
    creation: JSON.parse(readFileSync(`${F}/creation-logs-robinhood.json`, 'utf8')).created,
    list: rhList,
    shelf: count.scopeOf.shelf.tokens.map((x: { address: string }) => x.address),
    scope: count.scope,
    regimeOfT: solanaRegime(),
  });
const lists = ['scripts/risk/assets/robinhood.json', 'scripts/risk/universe/robinhood.json'].map(
  (f) => JSON.parse(readFileSync(f, 'utf8')),
);
const NOW = t('2026-10-13T17:00:00Z');

describe('whole days, by hand', () => {
  it('seconds: a day is whole only from 00:00:00 to 23:59:59', () => {
    expect(
      wholeDaysOfSeconds([{ from: t('2026-10-06T13:24:36Z'), to: t('2026-10-09T00:00:00Z') }]),
    ).toEqual(['2026-10-07', '2026-10-08']);
    expect(
      wholeDaysOfSeconds([{ from: t('2026-10-07T00:00:00Z'), to: t('2026-10-07T23:59:58Z') }]),
    ).toEqual([]);
    expect(
      wholeDaysOfSeconds([{ from: t('2026-10-07T00:00:00Z'), to: t('2026-10-07T23:59:59Z') }]),
    ).toEqual(['2026-10-07']);
  });
  it('blocks: strictly between the oldest and newest day manifests inside the range show', () => {
    const covered = [{ from: 100, to: 400 }];
    const inside = { covered: [{ from: 100, to: 199 }], days: ['2026-10-10', '2026-10-11'] };
    const newest = { covered: [{ from: 300, to: 400 }], days: ['2026-10-13'] };
    // a piece below the range (one being written): its day 10-09 proves nothing
    const writing = { covered: [{ from: 50, to: 150 }], days: ['2026-10-09'] };
    expect(wholeDaysOfBlocks(covered, [inside, newest, writing])).toEqual([
      '2026-10-11',
      '2026-10-12',
    ]);
    // without a later day inside the range, nothing is whole
    expect(wholeDaysOfBlocks(covered, [inside])).toEqual([]);
  });
});

describe('the parts of a row, by hand', () => {
  it('files a pool under the side less like a quote, and only on the shelf', () => {
    const rank = (a: string) => (a === 'usdg' ? 0 : a === 'weth' ? 2 : 3) as 0 | 2 | 3;
    const shelf = (a: string) => ['nvda', 'weth', 'usdg', 'tsla'].includes(a);
    expect(fileEvmPool('usdg', 'nvda', rank, shelf)).toEqual({
      asset: 'nvda',
      quote: 'usdg',
      assetIsToken0: false,
    });
    expect(fileEvmPool('nvda', 'weth', rank, shelf)).toMatchObject({ asset: 'nvda' });
    expect(fileEvmPool('nvda', 'tsla', rank, shelf)).toMatchObject({ asset: 'nvda' });
    expect(fileEvmPool('junk', 'weth', rank, shelf)).toEqual({ reason: 'asset_not_on_the_shelf' });
  });
  it('holds back a Solana price inside the price job window, never a Robinhood Chain one', () => {
    const edge = NOW - 6 * DAY - 2 * 3600;
    expect(priceJobHoldBack('solana', edge, NOW)).toBe(true);
    expect(priceJobHoldBack('solana', edge - 1, NOW)).toBe(false);
    expect(priceJobHoldBack('robinhood', NOW, NOW)).toBe(false);
  });
  it('scales an answer by its decimals without float scaling, and refuses an empty round', () => {
    expect(scaled('22553068676', 8)).toBe(225.53068676);
    expect(scaled('5', 3)).toBe(0.005);
    expect(
      roundPrice(
        {
          feed: 'f',
          phase: 1,
          round: 1,
          roundId: '1',
          answer: null,
          startedAt: null,
          updatedAt: null,
          answeredInRound: null,
        },
        8,
      ),
    ).toEqual({ reason: 'unanswered' });
  });
  it('carries a reference price at most to the end of its own UTC day', () => {
    const vwap = new Map([['2026-10-07T23:00:00.000Z', 2]]);
    expect(carriedPrice([{ pool: 'p', vwap }], '2026-10-07T23:00:00.000Z')).toMatchObject({
      usd: 2,
    });
    expect(carriedPrice([{ pool: 'p', vwap }], '2026-10-08T00:00:00.000Z')).toBeNull();
  });
});

describe('Solana swaps to bars', () => {
  const read = solRead();
  const pool = (a: string) => read.pools.find((p) => p.pool === a);
  const USDC_POOL = '6k7hLzFcL3H64uziJboN3WZNXYj6PiBMP1DZh8zFfhSb';
  const SOL_POOL = 'DTm2scPFBDUT3RE5Kc3Z8oUJPusKWk7gsFgJ2iZwhG99';

  it('reads only the days the manifests hold whole: 2026-10-06 is on disk and never read', () => {
    const hours = read.pools.flatMap((p) => p.bars.map((b) => b.hour.slice(0, 10)));
    expect(new Set(hours)).toEqual(new Set(['2026-10-07']));
    expect(lines(`solana/swaps/${USDC_POOL}/2026-10-06.jsonl.gz`).length).toBe(5);
  });

  // AAVE's USDC pool holds AAVE as token 1 (8 decimals) against USDC as token 0 (6), from the frozen registry
  const reg = JSON.parse(readFileSync(`${F}/shelf-registry-solana.json`, 'utf8')).pools as Array<{
    address: string;
    assetIsToken0: number;
    decimals0: number;
    decimals1: number;
  }>;
  const legs = (address: string, hour: string) => {
    const m = reg.find((r) => r.address === address) as (typeof reg)[number];
    let q = 0;
    let a = 0;
    let n = 0;
    for (const l of lines(`solana/swaps/${address}/2026-10-07.jsonl.gz`)) {
      const r = JSON.parse(l) as { t: number; ev: Array<Record<string, string | boolean>> | null };
      if (new Date(Math.floor(r.t / 3600) * 3600 * 1000).toISOString() !== hour) continue;
      for (const e of r.ev ?? []) {
        if (e.kind !== 'swap' || e.pool !== address) continue;
        n++;
        const [ra, rq, da, dq] = m.assetIsToken0
          ? [e.amount0, e.amount1, m.decimals0, m.decimals1]
          : [e.amount1, e.amount0, m.decimals1, m.decimals0];
        a += Number(ra) / 10 ** da;
        q += Number(rq) / 10 ** dq;
      }
    }
    return { n, q, a };
  };

  it('USDC at par: the hour dollar volume is its USDC leg', () => {
    const h = '2026-10-07T00:00:00.000Z';
    const b = pool(USDC_POOL)?.bars.find((x) => x.hour === h);
    const raw = legs(USDC_POOL, h);
    expect(b).toMatchObject({ swaps: raw.n, unpricedSwaps: 0, quoteUsdMethod: 'usdc_at_par' });
    expect(b?.volumeUsd).toBeCloseTo(raw.q, 6);
  });

  it('a SOL pool: the quote implied from the asset USDC pool, VWAP over VWAP', () => {
    const h = '2026-10-07T00:00:00.000Z';
    const b = pool(SOL_POOL)?.bars.find((x) => x.hour === h);
    const usdc = legs(USDC_POOL, h);
    const sol = legs(SOL_POOL, h);
    const solUsd = usdc.q / usdc.a / (sol.q / sol.a);
    expect(b?.quoteUsdMethod).toBe(`implied_from_${USDC_POOL}`);
    expect(b?.detail.quoteUsd as number).toBeCloseTo(solUsd, 9);
    expect(b?.volumeUsd as number).toBeCloseTo(sol.q * solUsd, 6);
  });

  it('none: a pool whose asset has no USDC pool in the registry gets no dollar figure', () => {
    const jto = pool('2UhFnySoJi6c89aydGAGS7ZRemo2dbkFRhvSJqDX4gHJ');
    expect(jto?.bars.length).toBeGreaterThan(0);
    for (const b of jto?.bars ?? []) {
      expect(b.volumeUsd).toBeNull();
      expect(b.unpricedSwaps).toBe(b.swaps);
      expect(b.quoteUsdMethod).toBe('none:no_dollar_price_for_the_quote_this_hour');
    }
  });

  it('two reads give the same rows, each with its source, method, fetched_at and provenance', () => {
    const a = barRows(solRead(), 'solana', true).rows;
    const b = barRows(solRead(), 'solana', true).rows;
    expect(a).toEqual(b);
    for (const r of a) {
      expect(r.source).toBeTruthy();
      expect(r.method).toBeTruthy();
      expect(r.fetchedAt).toBeInstanceOf(Date);
      expect(r.provenance).toBe('live');
      expect(r.methodVersion).toBe('bars-0.1');
    }
  });
});

describe('Robinhood Chain swaps to bars', () => {
  const read = rhRead();
  it('the whole days come from fetched.json and the manifests: 2026-10-10 is on disk and not read', () => {
    expect(read.summary.wholeDays).toEqual(['2026-10-11', '2026-10-12']);
    expect(read.summary.daysSkippedNotWhole).toEqual(['2026-10-10']);
    const days = read.pools.flatMap((p) => p.bars.map((b) => b.hour.slice(0, 10)));
    expect(new Set(days)).toEqual(new Set(['2026-10-11']));
  });
  it('a pool the creation logs do not name is counted, not filed', () => {
    const d = (read.summary.perDay as Array<Record<string, number>>)[0];
    expect(d).toMatchObject({ unresolvedPools: 1, unresolvedSwaps: 1, poolsFiled: 4 });
  });
  it('USDG at par, and ETH and WETH at the one median of the hour', () => {
    const usdg = read.pools.find((p) => p.pool === '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3');
    for (const b of usdg?.bars ?? []) expect(b.quoteUsdMethod).toBe('usdg_at_par');
    const weth = read.pools.find((p) => p.pool === '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c');
    const eth = read.pools.find((p) => p.pool.startsWith('0x71f9660f'));
    for (const b of weth?.bars ?? []) {
      expect(b.quoteUsdMethod).toMatch(/^native_median_of_\d+_pools/);
      const e = eth?.bars.find((x) => x.hour === b.hour);
      expect(e?.detail.quoteUsd).toBe(b.detail.quoteUsd);
    }
  });
});

describe('Chainlink rounds and the external daily series', () => {
  const built = buildHistory({ dataDir: F, what: 'all', lists, nowT: NOW });
  it('a round: its answer over 10^8 at its updatedAt, under chainlink:<proxy>', () => {
    const feed = '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15';
    const first = JSON.parse(lines(`robinhood/chainlink/${feed}/2026-06-22.jsonl.gz`)[0] as string);
    const row = built.prices.find(
      (r) =>
        r.priceSource === `chainlink:${feed}` && r.observedAt.getTime() === first.updatedAt * 1000,
    );
    expect(row).toMatchObject({ chain: 'robinhood', ref: feed, quote: 'usd', slot: 0 });
    expect(row?.price).toBe(Number(first.answer) / 1e8);
    expect(built.prices.filter((r) => r.priceSource === `chainlink:${feed}`).length).toBe(29);
  });
  it('DefiLlama prices; Solana ones inside the price job window held back; protocol TVL as a fact', () => {
    const ext = built.report.external as Record<string, number>;
    const sol = lines('external/solana_XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp/daily.jsonl.gz')
      .map((l) => JSON.parse(l) as { timestamp: number })
      .filter((p) => p.timestamp >= NOW - 6 * DAY - 2 * 3600).length;
    expect(ext.heldBackSolana).toBe(sol);
    expect(ext.solana).toBe(12 - sol);
    expect(ext.robinhood).toBe(12);
    expect(built.facts.length).toBe(12);
    expect(built.facts[0]).toMatchObject({
      chain: 'all_chains',
      address: 'protocol:kamino-lend',
      metric: 'protocol_tvl_usd',
      unit: 'usd',
      nullReason: null,
    });
    for (const r of [...built.prices, ...built.facts]) {
      expect(r.source).toBeTruthy();
      expect(r.method).toBeTruthy();
      expect(r.fetchedAt).toBeInstanceOf(Date);
      expect(r.provenance).toBe('live');
    }
  });
});

describe('written once (in a transaction that is rolled back)', () => {
  it('a second run inserts nothing; every row built is then in the table', async () => {
    const bars = barRows(solRead(), 'solana', true).rows;
    const hist = buildHistory({ dataDir: F, what: 'all', lists, nowT: NOW });
    const { db, client } = createDb();
    const outcome = { bars: [-1, -1], prices: [-1, -1], facts: [-1, -1], stored: -1 };
    class Undo extends Error {}
    try {
      await db.transaction(async (tx) => {
        // a key a real import already wrote is kept as it is, so the first run may insert fewer than built
        outcome.bars = [await insertBarsKeep(tx, bars), await insertBarsKeep(tx, bars)];
        const h1 = await insertKeep(tx, hist.prices, hist.facts);
        const h2 = await insertKeep(tx, hist.prices, hist.facts);
        outcome.prices = [h1.prices, h2.prices];
        outcome.facts = [h1.facts, h2.facts];
        const stored = await tx
          .select({ address: marketBars.address, pool: marketBars.pool, hour: marketBars.hour })
          .from(marketBars)
          .where(
            and(
              eq(marketBars.chain, 'solana'),
              eq(marketBars.methodVersion, 'bars-0.1'),
              gte(marketBars.hour, new Date('2026-10-07T00:00:00Z')),
              lte(marketBars.hour, new Date('2026-10-07T05:00:00Z')),
            ),
          );
        const keys = new Set(stored.map((r) => `${r.address}|${r.pool}|${r.hour.getTime()}`));
        outcome.stored = bars.filter((r) =>
          keys.has(`${r.address}|${r.pool}|${(r.hour as Date).getTime()}`),
        ).length;
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    } finally {
      await client.end();
    }
    expect(outcome.bars[0]).toBeGreaterThanOrEqual(0);
    expect(outcome.bars[1]).toBe(0);
    expect(outcome.prices[1]).toBe(0);
    expect(outcome.facts[1]).toBe(0);
    expect(outcome.stored).toBe(bars.length);
  }, 60_000);
});
