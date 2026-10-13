import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AssetList } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { CHAINS, type ChainConfig } from '../scripts/risk-evm/config';
import { type CutForCollector, listCandidates, listRun } from '../scripts/risk-evm/listed';
import type { DexPair } from '../scripts/risk-evm/pools';
import {
  type ShelfPoolsFile,
  type ShelfRow,
  shelfPoolsOf,
  shelfTokens,
  withShelf,
} from '../scripts/risk-evm/shelf';

// PLAN-ASSETS AS.12 (ledger ASSET-3): the hourly Robinhood Chain loop on the shelf's tokens beside the tracked stocks.
// The list run is the RU.6 fixture (NVDA and GME); no test calls the network.
const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const USDG = robinhood.dollar.address;
const fx = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk-evm/robinhood-list-run.json.gz')).toString(),
) as {
  names: { list: string; cut: string };
  list: Pick<AssetList, 'chain' | 'inputs' | 'assets'>;
  cut: CutForCollector;
};
const run = () => listRun(robinhood, fx.list, fx.cut, fx.names);
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const pair = (id: string, dexId: string, usd: number, quote = USDG): DexPair => ({
  chainId: 'robinhood',
  dexId,
  pairAddress: id,
  baseToken: { address: WETH },
  quoteToken: { address: quote },
  liquidity: { usd },
});
const V4_ID = `0x${'ab'.repeat(32)}`;

describe('which shelf tokens are added', () => {
  const tracked = new Set(run().tokens.map((t) => t.address.toLowerCase()));
  const nvda = [...tracked][0] as string;
  const rows: ShelfRow[] = [
    { address: WETH, symbol: 'WETH', cls: 'crypto' },
    { address: USDG.toLowerCase(), symbol: 'USDG', cls: 'cash' },
    { address: nvda, symbol: 'NVDA', cls: 'stock' },
    { address: '0x00000000000000000000000000000000000000aa', symbol: 'NODEC', cls: 'crypto' },
  ];
  const { add, notAdded } = shelfTokens(rows, {
    dollar: robinhood.dollar,
    tracked,
    decimals: new Map([
      [WETH, 18],
      [nvda, 18],
    ]),
  });
  it('adds a token the list does not track, with its decimals', () => {
    expect(add).toEqual([{ symbol: 'WETH', address: WETH, decimals: 18, cls: 'crypto' }]);
  });
  it('leaves out the dollar token, a tracked token and a token with no decimals, each with its reason', () => {
    expect(notAdded.map((n) => [n.symbol, n.reason.split(':')[0]])).toEqual([
      ['USDG', 'the_dollar_token'],
      ['NVDA', 'tracked_by_the_list'],
      ['NODEC', 'no_decimals_in_the_asset_list'],
    ]);
  });
});

describe('a shelf token’s pools from DexScreener', () => {
  const token = { symbol: 'WETH', address: WETH, decimals: 18 };
  const { pools, againstDollar } = shelfPoolsOf(
    robinhood,
    token,
    [
      pair('0x1111111111111111111111111111111111111111', 'uniswap', 20_000_000),
      pair(V4_ID, 'uniswap', 900_000),
      pair('0x2222222222222222222222222222222222222222', 'ramses', 700_000),
      pair('0x3333333333333333333333333333333333333333', 'uniswap', 9_000),
      pair(
        '0x4444444444444444444444444444444444444444',
        'uniswap',
        5_000_000,
        '0x5555555555555555555555555555555555555555',
      ),
    ],
    { minLiquidityUsd: 10_000, at: '2026-10-13T17:43:08.076Z' },
  );
  it('keeps the pairs against the dollar token above the floor, deepest first', () => {
    expect(againstDollar).toBe(4);
    expect(pools.map((p) => [p.kind, p.venue, p.tvlUsd])).toEqual([
      ['cl', 'uniswap', 20_000_000],
      ['v4', 'uniswap', 900_000],
      ['cl', 'ramses', 700_000],
    ]);
  });
  it('a Uniswap pool is a candidate the chain confirms; another venue’s is never asked', () => {
    expect(pools.map((p) => p.reachable)).toEqual([true, true, false]);
    expect(listCandidates(robinhood, pools).map((c) => c.dex)).toEqual(['uniswap', 'uniswap']);
  });
  it('carries DexScreener’s time on its TVL, and the dollar token as the other side', () => {
    expect(pools.every((p) => p.tvlAt === '2026-10-13T17:43:08.076Z')).toBe(true);
    expect(pools.every((p) => p.other === USDG.toLowerCase() && !p.otherIsStock)).toBe(true);
  });
});

const fileWith = (tokens: ShelfPoolsFile['tokens']): ShelfPoolsFile => ({
  chain: 'robinhood',
  chainId: 4663,
  methodVersion: 'evm-shelf-pools-0.1',
  method: 'dexscreener_pairs_against_the_dollar_token',
  source: 'test',
  fetchedAt: '2026-10-13T17:43:08.076Z',
  provenance: 'live',
  shelf: { file: 'shelf.json', method: null, reading: null },
  list: 'list.json',
  dollar: { symbol: 'USDG', address: USDG.toLowerCase() },
  minLiquidityUsd: 10_000,
  counts: { shelf: 0, tracked: 0, added: tokens.length, notAdded: 0, pools: 0, reachable: 0 },
  tokens,
  notAdded: [],
});
const wethToken = {
  symbol: 'WETH',
  address: WETH,
  decimals: 18,
  cls: 'crypto',
  dexscreener: { pairs: 1, againstDollar: 1, kept: 1 },
  pools: shelfPoolsOf(
    robinhood,
    { symbol: 'WETH', address: WETH, decimals: 18 },
    [
      pair(V4_ID, 'uniswap', 900_000),
      pair('0x1111111111111111111111111111111111111111', 'uniswap', 20_000_000),
    ],
    { minLiquidityUsd: 10_000, at: 'x' },
  ).pools,
};

describe('a list run with the shelf', () => {
  it('adds the shelf’s tokens after the list’s, with their pools deepest first, and says so', () => {
    const before = run();
    const r = withShelf(robinhood, before, fileWith([wethToken]), 'shelf-pools.json');
    expect(r.tokens.map((t) => t.symbol)).toEqual([...before.tokens.map((t) => t.symbol), 'WETH']);
    expect(r.listed.pools.WETH?.map((p) => p.tvlUsd)).toEqual([20_000_000, 900_000]);
    expect(r.listed.shelf).toEqual({ file: 'shelf-pools.json', tokens: ['WETH'] });
    // the list's own tokens and pools are untouched
    for (const t of before.tokens)
      expect(r.listed.pools[t.symbol]).toEqual(before.listed.pools[t.symbol]);
    expect(before.listed.shelf).toBeUndefined();
  });
  it('a hand-list token the shelf adds is no longer named as not read', () => {
    const before = run();
    const tsm = robinhood.tokens.find((t) => t.symbol === 'TSM') as { address: string };
    expect(before.listed.handListNotTracked).toContain('TSM');
    const r = withShelf(
      robinhood,
      before,
      fileWith([{ ...wethToken, symbol: 'TSM', address: tsm.address.toLowerCase(), pools: [] }]),
      'f',
    );
    expect(r.listed.handListNotTracked).not.toContain('TSM');
  });
  it('refuses a token the list tracks, a symbol it uses, the dollar token and another chain', () => {
    const before = run();
    const nvda = before.tokens[0] as { symbol: string; address: string };
    const tracked = { ...wethToken, symbol: 'X', address: nvda.address.toLowerCase() };
    expect(() => withShelf(robinhood, before, fileWith([tracked]), 'f')).toThrow(/tracks/);
    const sameSymbol = { ...wethToken, symbol: nvda.symbol };
    expect(() => withShelf(robinhood, before, fileWith([sameSymbol]), 'f')).toThrow(/second/);
    const dollar = { ...wethToken, symbol: 'USDG', address: USDG.toLowerCase() };
    expect(() => withShelf(robinhood, before, fileWith([dollar]), 'f')).toThrow(/dollar token/);
    expect(() => withShelf(robinhood, before, { ...fileWith([]), chainId: 8453 }, 'f')).toThrow(
      /not robinhood/,
    );
  });
});

describe('the committed shelf pool file', () => {
  const file = JSON.parse(
    readFileSync('scripts/risk/assets/shelf-pools-robinhood.json', 'utf8'),
  ) as ShelfPoolsFile;
  const shelf = JSON.parse(readFileSync('scripts/risk/assets/shelf-robinhood.json', 'utf8')) as {
    rows: ShelfRow[];
  };
  const list = JSON.parse(readFileSync('scripts/risk/universe/robinhood.json', 'utf8')) as {
    assets: Array<{ address: string }>;
  };
  it('accounts for every row of the shelf once: added, or left out with its reason', () => {
    const named = [...file.tokens.map((t) => t.address), ...file.notAdded.map((n) => n.address)];
    expect(named.sort()).toEqual(shelf.rows.map((r) => r.address.toLowerCase()).sort());
  });
  it('adds no tracked token and not the dollar token, and its pools pair the token with the dollar token', () => {
    const tracked = new Set(list.assets.map((a) => a.address.toLowerCase()));
    for (const t of file.tokens) {
      expect(tracked.has(t.address)).toBe(false);
      expect(t.address).not.toBe(USDG.toLowerCase());
      for (const p of t.pools) {
        expect(p.other).toBe(USDG.toLowerCase());
        expect(p.tvlUsd ?? 0).toBeGreaterThanOrEqual(file.minLiquidityUsd);
        expect(p.reachable).toBe(p.venue === 'uniswap');
      }
    }
    expect(file.counts.added).toBe(file.tokens.length);
    expect(file.counts.pools).toBe(file.tokens.reduce((n, t) => n + t.pools.length, 0));
  });
  it('goes on the fixture’s list run without a refusal', () => {
    const r = withShelf(robinhood, run(), file, 'scripts/risk/assets/shelf-pools-robinhood.json');
    expect(r.tokens.length).toBe(run().tokens.length + file.tokens.length);
  });
});
