import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assetObservations, createDb, marketBars, riskPriceObservations } from '@colosseum/db';
import {
  carriedPrice,
  fileEvmPool,
  nativeMedianByHour,
  priceJobHoldBack,
  roundPrice,
  scaled,
  solanaQuoteUsd,
  wholeDaysOfBlocks,
  wholeDaysOfSeconds,
} from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  readPoolTokens,
  readRobinhoodBackfill,
  readSolanaBackfill,
  solanaRegistryPools,
} from '../../scripts/risk/assets/bars-backfill';
import { solanaRegime } from '../../scripts/risk/assets/bars-read';
import {
  type BarRow as BarRowT,
  barRows,
  reconcileBackfillBars,
  upsertBackfillBars,
} from '../../scripts/risk/assets/bars-rows';
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
    resolved: readPoolTokens(F),
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
  it('blocks: a reopened manifest (failed rewalk_ check, days left listed) proves nothing', () => {
    const covered = [{ from: 100, to: 400 }];
    const early = { covered: [{ from: 100, to: 199 }], days: ['2026-10-10'] };
    const reopened = {
      covered: [{ from: 300, to: 400 }],
      days: ['2026-10-13'],
      checks: [{ name: 'rewalk_2026-10-13', passed: false }],
    };
    expect(wholeDaysOfBlocks(covered, [early, reopened])).toEqual([]);
    expect(
      wholeDaysOfBlocks(covered, [
        early,
        { ...reopened, checks: [{ name: 'rewalk_2026-10-13', passed: true }] },
      ]),
    ).toEqual(['2026-10-11', '2026-10-12']);
  });
  it('blocks: a manifest within the header margin of the range edge is not an anchor', () => {
    // rows' times are interpolated between headers 50 blocks apart: a piece within 50 blocks of the edge may hold
    // a row filed on the day before whose true time is past midnight
    const covered = [{ from: 100, to: 400 }];
    const edge = { covered: [{ from: 100, to: 149 }], days: ['2026-10-10'] };
    const inner = { covered: [{ from: 150, to: 199 }], days: ['2026-10-11'] };
    const newest = { covered: [{ from: 300, to: 350 }], days: ['2026-10-13'] };
    expect(wholeDaysOfBlocks(covered, [edge, inner, newest], 50)).toEqual(['2026-10-12']);
    expect(wholeDaysOfBlocks(covered, [edge, inner, newest], 0)).toEqual([
      '2026-10-11',
      '2026-10-12',
    ]);
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
  it("SOL's median: weighted by swaps, carried inside the day only", () => {
    const m = nativeMedianByHour(
      new Map([
        [
          '2026-10-07T22:00:00.000Z',
          [
            { v: 100, w: 1 },
            { v: 120, w: 3 },
          ],
        ],
      ]),
    );
    // weights 1 and 3: half the weight (2) is reached only at 120
    expect(m.get('2026-10-07T22:00:00.000Z')).toEqual({
      usd: 120,
      method: 'native_median_of_2_pools',
      carriedHours: 0,
    });
    expect(m.get('2026-10-07T23:00:00.000Z')).toEqual({
      usd: 120,
      method: 'native_median_of_2_pools_carried_1h',
      carriedHours: 1,
    });
    expect(m.get('2026-10-08T00:00:00.000Z')).toBeUndefined();
  });
  it('a carried price says so, and a price of the hour wins over a carried one', () => {
    const usdcPools = [{ pool: 'U', vwap: new Map([['2026-10-07T21:00:00.000Z', 10]]) }];
    const own = new Map([['2026-10-07T23:00:00.000Z', 5]]);
    const base = { quoteMint: 'SOL', own, usdcPools, regimeOf: () => null };
    expect(solanaQuoteUsd(base).get('2026-10-07T23:00:00.000Z')).toMatchObject({
      quoteUsd: 2,
      method: 'implied_from_U_carried_2h',
    });
    const fresh = solanaQuoteUsd({
      ...base,
      quoteUsdOf: () => ({ usd: 2.5, method: 'native_median_of_3_pools', carriedHours: 0 }),
    }).get('2026-10-07T23:00:00.000Z');
    expect(fresh).toMatchObject({ quoteUsd: 2.5, method: 'native_median_of_3_pools' });
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

  it("SOL's median prices a SOL pool whose asset has no USDC pool: here one pool implies it", () => {
    // JTO's USDC pool is left out of the frozen registry; in each hour AAVE's SOL pool is the one sample, so
    // SOL's dollars are AAVE's USDC VWAP over its SOL VWAP, the figure AAVE's SOL pool is priced at
    const jto = pool('2UhFnySoJi6c89aydGAGS7ZRemo2dbkFRhvSJqDX4gHJ');
    expect(jto?.bars.length).toBe(2);
    for (const b of jto?.bars ?? []) {
      const usdc = legs(USDC_POOL, b.hour);
      const sol = legs(SOL_POOL, b.hour);
      expect(b.quoteUsdMethod).toBe('native_median_of_1_pools');
      expect(b.detail.quoteUsd as number).toBeCloseTo(usdc.q / usdc.a / (sol.q / sol.a), 9);
      expect(b.unpricedSwaps).toBe(0);
    }
  });

  it('none: a quote with no dollar price (JitoSOL, not an asset of the registry) gets no dollar figure', () => {
    const jito = pool('G2FiE1yn9N9ZJx5e1E2LxxMnHvb1H3hCuHLPfKJ98smA');
    expect(jito?.bars.length).toBeGreaterThan(0);
    for (const b of jito?.bars ?? []) {
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
  const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
  it('the whole days come from fetched.json and the manifests: the newest day is on disk and not read', () => {
    expect(read.summary.daysSkippedNotWhole).toEqual(['2026-10-13']);
    const days = new Set(read.pools.flatMap((p) => p.bars.map((b) => b.hour.slice(0, 10))));
    expect(days.has('2026-10-13')).toBe(false);
    expect(days.has('2026-10-11')).toBe(true);
  });
  it('pools resolved from the chain are filed; one off the shelf and one the chain does not know are counted', () => {
    expect(read.summary).toMatchObject({
      poolsResolvedFromChain: 2,
      resolvedButUnknownToChain: 1,
      subjectsWithoutTokens: 1,
    });
    const d = (read.summary.perDay as Array<Record<string, number | string>>).find(
      (x) => x.day === '2026-10-11',
    );
    // 0x000a39…: WETH against a token the shelf does not hold; 0x001ded…: no position manager knows the id
    expect(d).toMatchObject({ notShelfPools: 1, unresolvedPools: 1, unresolvedSwaps: 1 });
    // the NVDA pool against an unlisted token: filed under NVDA, its quote's decimals unknown
    const r = read.pools.find((p) => p.pool.startsWith('0x3daec596'));
    expect(r?.address).toBe(NVDA);
    for (const b of r?.bars ?? []) expect(b.quoteUsdMethod).toBe('none:quote_decimals_unknown');
  });
  it('USDG at par, and ETH and WETH at the one median of the hour', () => {
    const usdg = read.pools.find((p) => p.pool === '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3');
    for (const b of usdg?.bars ?? []) expect(b.quoteUsdMethod).toBe('usdg_at_par');
    const weth = read.pools.find((p) => p.pool === '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c');
    const eth = read.pools.find((p) => p.pool.startsWith('0x71f9660f'));
    for (const b of weth?.bars ?? []) {
      expect(b.quoteUsdMethod).toMatch(/^native_median_of_\d+_pools/);
      const e = eth?.bars.find((x) => x.hour === b.hour);
      if (e?.volumeUsd !== null) expect(e?.detail.quoteUsd).toBe(b.detail.quoteUsd);
    }
  });
  it('a shelf token the list no longer holds (as PONS after SHELF-CRYPTO-1) gets no bar, never a NaN one', () => {
    const list = {
      ...rhList,
      assets: rhList.assets.filter((a) => a.address.toLowerCase() !== NVDA),
    };
    const r = readRobinhoodBackfill({
      dataDir: F,
      creation: JSON.parse(readFileSync(`${F}/creation-logs-robinhood.json`, 'utf8')).created,
      list,
      shelf: count.scopeOf.shelf.tokens.map((x: { address: string }) => x.address),
      scope: count.scope,
      regimeOfT: solanaRegime(),
      resolved: readPoolTokens(F),
    });
    expect(r.summary.shelfTokensNotInList).toContain(NVDA);
    expect(r.pools.filter((p) => p.address === NVDA)).toEqual([]);
  });
  it("ETH's median of 15:00 recomputed from the raw swaps", () => {
    // each pool's price of the hour: its last swap's sqrtPriceX96 (word 2 of the data), quote per NVDA; NVDA in
    // dollars from its USDG pool with the most swaps that day; each ETH- or WETH-quoted pool implies ETH's dollars
    // as NVDA's over its own price, weighted by its swaps in the hour
    const created = JSON.parse(readFileSync(`${F}/creation-logs-robinhood.json`, 'utf8'))
      .created as Array<{
      id: string;
      token0: string;
    }>;
    const hour = Date.parse('2026-10-11T15:00:00Z') / 1000;
    const rowsOf = (pool: string) =>
      lines(`robinhood/swaps/${pool}/2026-10-11.jsonl.gz`).map(
        (l) => JSON.parse(l) as { block: number; logIndex: number; t: number; data: string },
      );
    const sqrtOf = (data: string) => BigInt(`0x${data.slice(2 + 64 * 2, 2 + 64 * 3)}`);
    const lastPrice = (pool: string, quoteDecimals: number) => {
      const inHour = rowsOf(pool).filter((r) => r.t >= hour && r.t < hour + 3600);
      const last = inHour.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).at(-1);
      if (!last) return null;
      const s = Number(sqrtOf(last.data)) / 2 ** 96;
      const nvdaIs0 =
        created.find((c) => c.id.toLowerCase() === pool)?.token0.toLowerCase() === NVDA;
      const p1per0 = s * s * 10 ** (nvdaIs0 ? 18 - quoteDecimals : quoteDecimals - 18);
      return { price: nvdaIs0 ? p1per0 : 1 / p1per0, n: inHour.length };
    };
    const usdgPools = [
      '0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5',
      '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3',
    ].sort((a, b) => rowsOf(b).length - rowsOf(a).length);
    const nvdaUsd = lastPrice(usdgPools[0] as string, 6)?.price as number;
    const samples = [
      '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c',
      '0x71f9660f9535e3e81d720696a58ea80274da8b2c6eb7c3acb22611d977439a5c',
    ]
      .map((p) => lastPrice(p, 18))
      .filter((x): x is { price: number; n: number } => x !== null)
      .map((x) => ({ v: nvdaUsd / x.price, w: x.n }))
      .sort((a, b) => a.v - b.v);
    const total = samples.reduce((a, x) => a + x.w, 0);
    let acc = 0;
    const median = samples.find((x) => {
      acc += x.w;
      return acc * 2 >= total;
    })?.v as number;
    const weth = read.pools.find((p) => p.pool === '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c');
    const b = weth?.bars.find((x) => x.hour === '2026-10-11T15:00:00.000Z');
    expect(b?.quoteUsdMethod).toBe(`native_median_of_${samples.length}_pools`);
    expect(b?.detail.quoteUsd as number).toBeCloseTo(median, 6);
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

describe('written once, and withdrawn (in a transaction that is rolled back)', () => {
  it('a re-run changes nothing; an earlier import row that differs is replaced; another source is never touched', async () => {
    const bars = barRows(solRead(), 'solana', true).rows;
    const { db, client } = createDb();
    const o = {
      first: { inserted: -1, replaced: -1 },
      second: { inserted: -1, replaced: -1 },
      stored: -1,
      foreignSource: '',
      staleMethod: '',
    };
    class Undo extends Error {}
    const [one, two] = bars as [BarRowT, BarRowT];
    try {
      await db.transaction(async (tx) => {
        // the table as a run might find it: an earlier run of this import wrote `one` with another pricing; the
        // held history (another source) holds `two`'s key
        await tx.delete(marketBars).where(keyOf(one));
        await tx.delete(marketBars).where(keyOf(two));
        await tx
          .insert(marketBars)
          .values({ ...one, quoteUsdMethod: 'implied_from_an_earlier_run' });
        await tx.insert(marketBars).values({ ...two, source: 'the held swap history (AS.7)' });
        o.first = await upsertBackfillBars(tx, bars);
        o.second = await upsertBackfillBars(tx, bars);
        o.staleMethod =
          (await tx.select().from(marketBars).where(keyOf(one)))[0]?.quoteUsdMethod ?? '';
        o.foreignSource = (await tx.select().from(marketBars).where(keyOf(two)))[0]?.source ?? '';
        o.stored = await storedOf(tx, bars);
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    } finally {
      await client.end();
    }
    expect(o.staleMethod).toBe(one.quoteUsdMethod);
    expect(o.foreignSource).toBe('the held swap history (AS.7)');
    expect(o.first.replaced).toBeGreaterThanOrEqual(1);
    expect(o.second).toEqual({ inserted: 0, replaced: 0 });
    // `two`'s key belongs to the held history: every other row built is stored
    expect(o.stored).toBe(bars.length);
  }, 60_000);

  it("a manifest whose covered window shrinks between two runs: that day's rows are withdrawn", async () => {
    // a copy of the fixture where AAVE's USDC pool no longer holds 2026-10-07 whole (its owner reopened it)
    const dir = mkdtempSync(join(tmpdir(), 'assets-history-'));
    cpSync(F, dir, { recursive: true });
    const mf = join(dir, 'solana/swaps/6k7hLzFcL3H64uziJboN3WZNXYj6PiBMP1DZh8zFfhSb/manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    m.covered = [
      { from: Date.parse('2026-10-08T00:00:00Z') / 1000, to: m.covered.at(-1).to, unit: 'second' },
    ];
    m.checks.push({ name: 'rewalk_2026-10-13', passed: false, detail: 'test' });
    writeFileSync(mf, JSON.stringify(m));
    const read = (d: string) =>
      readSolanaBackfill({
        dataDir: d,
        registry: solanaRegistryPools(`${F}/shelf-registry-solana.json`),
        registryFile: `${F}/shelf-registry-solana.json`,
        regimeOfT: solanaRegime(),
      });
    const before = barRows(read(F), 'solana', true).rows;
    const after = barRows(read(dir), 'solana', true).rows;
    const aave = (r: BarRowT) =>
      r.address ===
      before.find((x) => x.pool === '6k7hLzFcL3H64uziJboN3WZNXYj6PiBMP1DZh8zFfhSb')?.address;
    // AAVE's day is no longer whole for the token: none of its rows, pool or token, is built
    expect(after.filter(aave).length).toBe(0);
    expect(after.length).toBe(before.filter((r) => !aave(r)).length);
    const range = { from: new Date('2026-10-06T00:00:00Z'), to: new Date('2026-10-07T23:00:00Z') };
    const { db, client } = createDb();
    const o = { dry: -1, withdrawn: -1, again: -1, left: -1 };
    class Undo extends Error {}
    try {
      await db.transaction(async (tx) => {
        // the table as the first run leaves it: the fixture's rows only (a real import's other rows of the range
        // are withdrawn by this same pass, inside the rollback)
        await reconcileBackfillBars(tx, 'solana', before, range);
        await upsertBackfillBars(tx, before);
        o.dry = (await reconcileBackfillBars(tx, 'solana', after, range, true)).withdrawn;
        o.withdrawn = (await reconcileBackfillBars(tx, 'solana', after, range)).withdrawn;
        o.again = (await reconcileBackfillBars(tx, 'solana', after, range)).withdrawn;
        o.left = await storedOf(tx, before.filter(aave));
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    } finally {
      await client.end();
      rmSync(dir, { recursive: true, force: true });
    }
    // every AAVE row withdrawn (the dry run counts the same and deletes nothing); a second pass finds none
    expect(o.dry).toBe(before.filter(aave).length);
    expect(o.withdrawn).toBe(before.filter(aave).length);
    expect(o.again).toBe(0);
    expect(o.left).toBe(0);
  }, 60_000);

  it('the daily series: the first run on fresh keys inserts every row built, the second none', async () => {
    const hist = buildHistory({ dataDir: F, what: 'all', lists, nowT: NOW });
    const distinct = new Set(
      hist.prices.map((r) =>
        [r.priceSource, r.ref, r.mint, (r.observedAt as Date).getTime(), r.slot, r.price].join('|'),
      ),
    ).size;
    const mints = [...new Set(hist.prices.map((r) => r.mint))];
    const { db, client } = createDb();
    const o = { prices: [-1, -1], facts: [-1, -1] };
    class Undo extends Error {}
    try {
      await db.transaction(async (tx) => {
        // the fixture's keys made fresh: what a real import stored under them is removed inside the rollback
        await tx
          .delete(riskPriceObservations)
          .where(
            and(
              inArray(riskPriceObservations.mint, mints),
              eq(riskPriceObservations.methodVersion, 'history-import-0.1'),
            ),
          );
        await tx
          .delete(assetObservations)
          .where(
            and(
              eq(assetObservations.chain, 'all_chains'),
              eq(assetObservations.address, 'protocol:kamino-lend'),
            ),
          );
        const h1 = await insertKeep(tx, hist.prices, hist.facts);
        const h2 = await insertKeep(tx, hist.prices, hist.facts);
        o.prices = [h1.prices, h2.prices];
        o.facts = [h1.facts, h2.facts];
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    } finally {
      await client.end();
    }
    expect(o.prices).toEqual([distinct, 0]);
    expect(o.facts).toEqual([hist.facts.length, 0]);
  }, 60_000);
});

function keyOf(r: BarRowT) {
  return and(
    eq(marketBars.chain, r.chain),
    eq(marketBars.address, r.address),
    eq(marketBars.pool, r.pool),
    eq(marketBars.hour, r.hour as Date),
    eq(marketBars.methodVersion, r.methodVersion),
  );
}
async function storedOf(tx: Pick<ReturnType<typeof createDb>['db'], 'select'>, rows: BarRowT[]) {
  const stored = await tx
    .select({ address: marketBars.address, pool: marketBars.pool, hour: marketBars.hour })
    .from(marketBars)
    .where(
      and(
        eq(marketBars.chain, 'solana'),
        eq(marketBars.methodVersion, 'bars-0.1'),
        gte(marketBars.hour, new Date('2026-10-07T00:00:00Z')),
        lte(marketBars.hour, new Date('2026-10-07T23:00:00Z')),
      ),
    );
  const keys = new Set(stored.map((r) => `${r.address}|${r.pool}|${r.hour.getTime()}`));
  return rows.filter((r) => keys.has(`${r.address}|${r.pool}|${(r.hour as Date).getTime()}`))
    .length;
}
