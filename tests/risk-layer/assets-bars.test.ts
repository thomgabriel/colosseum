import { readFileSync } from 'node:fs';
import {
  addBarSwap,
  assetBars,
  type BarHour,
  barsInWindow,
  type CheckBar,
  checkFlowRow,
  defaultRegimeParams,
  newPoolBars,
  type PoolBar,
  type PoolEvent,
  poolBars,
  type Regime,
  regimeAt,
  withinRounding,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import {
  evmBarSwap,
  type SolanaPoolMeta,
  solanaBarSwaps,
} from '../../scripts/risk/assets/bars-read';
import type { HistoryPool, PoolDecimals, SwapRow } from '../../scripts/risk-evm/history';

// PLAN-ASSETS AS.7: hourly bars from the held swap history. The fixtures are real rows frozen by
// scripts/risk/assets/freeze-bars-fixture.ts (no network): one hour of two Solana NVDAx pools, and three hours
// of four Robinhood Chain pools. Every expected figure below is worked out by hand from the raw amounts in the
// fixture, written out in the test, not taken from the code under test.
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const regimeOfT = (t: number): Regime => regimeAt(new Date(t * 1000), P);

type SolFixture = {
  hour: string;
  pools: Array<{
    meta: SolanaPoolMeta;
    hourly: { regime: Regime; quoteUsd: number; quoteUsdMethod: string; provenance: string };
    rows: Array<{ s: string; q: number; sl: number; t: number; ev: PoolEvent[] }>;
  }>;
};
const sol = JSON.parse(readFileSync('fixtures/risk/assets/bars/solana.json', 'utf8')) as SolFixture;
type RhFixture = {
  pools: Array<{
    hour: string;
    pool: HistoryPool;
    decimals: PoolDecimals | null;
    assetDecimals: number;
    hourly: { quoteUsd: number | null; quoteUsdMethod: string | null };
    swaps: SwapRow[];
  }>;
};
const rh = JSON.parse(
  readFileSync('fixtures/risk/assets/bars/robinhood.json', 'utf8'),
) as RhFixture;

/** Raw units of an 18-decimal token in whole tokens, as the reader converts them. */
const e18 = (raw: bigint) => Number(raw) / 1e18;
const close = (a: number | null, b: number) => {
  expect(a).not.toBeNull();
  expect(Math.abs((a as number) - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(b)));
};

function solBars(address: string): PoolBar[] {
  const p = sol.pools.find((x) => x.meta.address === address);
  if (!p) throw new Error(address);
  const acc = newPoolBars();
  const hour: BarHour = {
    regime: p.hourly.regime,
    quoteUsd: p.hourly.quoteUsd,
    method: p.hourly.quoteUsdMethod,
  };
  for (const r of p.rows)
    for (const s of solanaBarSwaps(r, p.meta)) addBarSwap(acc, s, hour, regimeOfT);
  return poolBars(acc, 'raw_events');
}
function rhBars(address: string): PoolBar[] {
  const p = rh.pools.find((x) => x.pool.address === address);
  if (!p) throw new Error(address);
  const acc = newPoolBars();
  const row: BarHour = {
    regime: regimeOfT(Date.parse(p.hour) / 1000),
    quoteUsd: p.hourly.quoteUsd,
    method: p.hourly.quoteUsdMethod,
  };
  for (const s of p.swaps) {
    const b = evmBarSwap(s, p.pool, p.decimals, p.assetDecimals);
    addBarSwap(
      acc,
      b,
      p.decimals ? row : undefined,
      regimeOfT,
      p.decimals !== null && b.side !== null,
    );
  }
  return poolBars(acc, 'raw_events');
}
/** The table's three checks, on every bar. */
const holdsTheTableChecks = (b: PoolBar | ReturnType<typeof assetBars>[number]) => {
  expect(b.buySwaps + b.sellSwaps).toBe(b.swaps);
  expect(b.unpricedSwaps).toBeGreaterThanOrEqual(0);
  expect(b.unpricedSwaps).toBeLessThanOrEqual(b.swaps);
  expect(b.volumeUsd === null).toBe(b.unpricedSwaps === b.swaps);
  expect(b.buyVolumeUsd === null).toBe(b.volumeUsd === null);
  expect(b.sellVolumeUsd === null).toBe(b.volumeUsd === null);
};

describe('Solana: NVDAx, 2026-09-05 06:00Z (a weekend hour), two pools', () => {
  const USDC = '49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6';
  const SOL = '38rXq2BuwdNcfnwydw6S2srpNK9N4gVzf39f69suPMsF';
  // USDC pool: NVDAx is token 0 (8 decimals), USDC token 1 (6); every swap is zeroForOne, so NVDAx went in: sales.
  // In slot order: [NVDAx, USDC].
  const usdcSwaps = [
    [2546122 / 1e8, 5868821 / 1e6], // slot 444448827
    [169127 / 1e8, 389836 / 1e6], // slot 444451705
    [254970 / 1e8, 587706 / 1e6], // slot 444453711
    [555123 / 1e8, 1279557 / 1e6], // slot 444454324
  ] as const;
  // SOL pool: SOL is token 0 (9 decimals), NVDAx token 1 (8); every swap is not zeroForOne, so NVDAx went in.
  // In slot order: [NVDAx, SOL].
  const solSwaps = [
    [1886413 / 1e8, 42579883 / 1e9], // slot 444445836
    [86752841 / 1e8, 1957043831 / 1e9], // slot 444454827
    [6990039 / 1e8, 157590807 / 1e9], // slot 444456507
  ] as const;
  const SOL_USD = 101.9639; // the hour's quoteUsd in the fixture, implied from the USDC pool (history-replay-0.1)

  it('the USDC pool: four sales, open and close by slot, USDC at par as the flow import prices it (D20)', () => {
    const [b] = solBars(USDC);
    if (!b) throw new Error('no bar');
    // the second and third swaps are dust (0.389836 and 0.587706 USDC, under $1): no price mark, still volume
    const px = [usdcSwaps[0], usdcSwaps[3]].map(
      (x) => (x as readonly [number, number])[1] / (x as readonly [number, number])[0],
    );
    expect(b.hour).toBe('2026-09-05T06:00:00.000Z');
    expect([b.swaps, b.sellSwaps, b.buySwaps, b.unpricedSwaps]).toEqual([4, 4, 0, 0]);
    close(b.openQuote, 5.868821 / 0.02546122);
    close(b.closeQuote, 1.279557 / 0.00555123);
    close(b.highQuote, Math.max(...px));
    close(b.lowQuote, Math.min(...px));
    expect(b.detail).toMatchObject({ dustSwaps: 2 });
    expect(b.detail.marksFromDust).toBeUndefined();
    const tokens = 0.02546122 + 0.00169127 + 0.0025497 + 0.00555123;
    const usdc = 5.868821 + 0.389836 + 0.587706 + 1.279557;
    close(b.volumeTokens, tokens);
    close(b.vwapQuote, usdc / tokens);
    close(b.volumeUsd, usdc);
    close(b.sellVolumeUsd, usdc);
    expect(b.buyVolumeUsd).toBe(0);
    close(b.openUsd, b.openQuote as number);
    expect(b.quoteUsdMethod).toBe('usdc_at_par');
    expect(b.detail).toMatchObject({ layer: 'raw_events', regime: 'weekend', quoteUsd: 1 });
    holdsTheTableChecks(b);
  });

  it('the SOL pool: the stock is token 1, its quote in dollars from the hour of the USDC pool', () => {
    const [b] = solBars(SOL);
    if (!b) throw new Error('no bar');
    expect([b.swaps, b.sellSwaps, b.buySwaps, b.unpricedSwaps]).toEqual([3, 3, 0, 0]);
    close(b.openQuote, 0.042579883 / 0.01886413);
    close(b.closeQuote, 0.157590807 / 0.06990039);
    close(b.openUsd, (0.042579883 / 0.01886413) * SOL_USD);
    close(b.closeUsd, (0.157590807 / 0.06990039) * SOL_USD);
    const sol = 0.042579883 + 1.957043831 + 0.157590807;
    const tokens = 0.01886413 + 0.86752841 + 0.06990039;
    close(b.vwapQuote, sol / tokens);
    close(b.vwapUsd, (sol / tokens) * SOL_USD);
    // dollars are added swap by swap, as the flow import does: Σ (SOL × quoteUsd)
    close(
      b.volumeUsd,
      solSwaps.reduce((a, [, q]) => a + q * SOL_USD, 0),
    );
    expect(b.quoteUsdMethod).toBe(`implied_from_${USDC}`);
    holdsTheTableChecks(b);
  });

  it("the token's bar: counts and dollars summed; open from the earliest priced swap of either pool by slot", () => {
    const [a] = assetBars(
      [
        { pool: USDC, bars: solBars(USDC) },
        { pool: SOL, bars: solBars(SOL) },
      ],
      'raw_events',
      'slot',
    );
    if (!a) throw new Error('no bar');
    expect([a.swaps, a.sellSwaps, a.buySwaps, a.unpricedSwaps]).toEqual([7, 7, 0, 0]);
    // the SOL pool's first swap (slot 444445836) is before the USDC pool's (444448827); its last (444456507)
    // after the USDC pool's (444454324)
    close(a.openUsd, (0.042579883 / 0.01886413) * SOL_USD);
    close(a.closeUsd, (0.157590807 / 0.06990039) * SOL_USD);
    const usd = [
      ...usdcSwaps.map(([t, q]) => ({ t, usd: q, p: q / t, dust: q < 1 })),
      ...solSwaps.map(([t, q]) => ({ t, usd: q * SOL_USD, p: (q / t) * SOL_USD, dust: false })),
    ];
    // high and low over the swaps that are not dust
    close(a.highUsd, Math.max(...usd.filter((x) => !x.dust).map((x) => x.p)));
    close(a.lowUsd, Math.min(...usd.filter((x) => !x.dust).map((x) => x.p)));
    const dollars = usd.reduce((s, x) => s + x.usd, 0);
    const tokens = usd.reduce((s, x) => s + x.t, 0);
    close(a.volumeUsd, dollars);
    close(a.volumeTokens, tokens);
    close(a.vwapUsd, dollars / tokens);
    expect(a.openQuote).toBeNull();
    // the token's row names its priced pools' methods: USDC at par is the flow import's, inherited (DA21)
    expect(a.quoteUsdMethod).toBe(`implied_from_${USDC}; usdc_at_par`);
    expect(a.detail).toMatchObject({ order: 'slot', openPool: SOL, closePool: SOL, dustSwaps: 2 });
    expect(a.detail.openInSharedSlot).toBeUndefined();
    const pools = (a.detail as { pools: Array<{ pool: string; swaps: number; usdShare: number }> })
      .pools;
    // the pools in address order
    expect(pools.map((p) => [p.pool, p.swaps])).toEqual([
      [SOL, 3],
      [USDC, 4],
    ]);
    close(pools[1]?.usdShare ?? null, usdcSwaps.reduce((s, [, q]) => s + q, 0) / dollars);
    holdsTheTableChecks(a);
  });

  it('an hour without a quote in dollars counts its swaps as unpriced and has no dollar figure', () => {
    const p = sol.pools.find((x) => x.meta.address === SOL);
    if (!p) throw new Error(SOL);
    const acc = newPoolBars();
    for (const r of p.rows)
      for (const s of solanaBarSwaps(r, p.meta)) addBarSwap(acc, s, undefined, regimeOfT);
    const [b] = poolBars(acc, 'raw_events');
    if (!b) throw new Error('no bar');
    expect([b.swaps, b.unpricedSwaps]).toEqual([3, 3]);
    expect([b.volumeUsd, b.buyVolumeUsd, b.sellVolumeUsd, b.openUsd, b.vwapUsd]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    close(b.openQuote, 0.042579883 / 0.01886413);
    // no row: the regime is that of the first swap added (the flow import's rule)
    expect(b.detail).toMatchObject({ regime: 'weekend', regimeFrom: 'first_swap_read' });
    holdsTheTableChecks(b);
  });
});

describe('Robinhood Chain: three hours of four pools', () => {
  it('a v4 USDG pool: a purchase, and a swap that logged nothing going in, kept out of the sides', () => {
    const [b] = rhBars('0x98dbe86895a576f964c039c9e35c50a24f02de508e308207ec38efbe8b63f35e');
    if (!b) throw new Error('no bar');
    // block 70005016: the swapper paid 281728 USDG units (6 decimals) and took 1231539033826186 NVDA units
    // (18): NVDA came out of the pool, a purchase. Block 70006901: amounts 0 and 0, no side.
    expect([b.swaps, b.buySwaps, b.sellSwaps, b.unpricedSwaps]).toEqual([1, 1, 0, 0]);
    // its one sided swap is $0.28: dust, so the hour's marks come from the dust, and say so
    expect(b.detail).toMatchObject({ swapsWithoutSide: 1, dustSwaps: 1, marksFromDust: true });
    close(b.openQuote, 0.281728 / e18(1231539033826186n));
    close(b.volumeTokens, e18(1231539033826186n));
    close(b.volumeUsd, 0.281728);
    close(b.buyVolumeUsd, 0.281728);
    expect(b.quoteUsdMethod).toBe('usdg_at_par');
    holdsTheTableChecks(b);
  });

  it("a pool whose quote's decimals are unknown: sides from the signs, no price, every swap unpriced", () => {
    const [b] = rhBars('0x70acec10bf24e34d490f4562e642bf1dd389378344e98b1f49a2d4f171490c23');
    if (!b) throw new Error('no bar');
    // MSTR is token 1 (18 decimals); both swaps took MSTR out of the pool
    expect([b.swaps, b.buySwaps, b.sellSwaps, b.unpricedSwaps]).toEqual([2, 2, 0, 2]);
    close(b.volumeTokens, e18(100499254397397920n) + e18(128407462421842248n));
    expect([b.openQuote, b.vwapQuote, b.volumeUsd, b.quoteUsdMethod]).toEqual([
      null,
      null,
      null,
      'none:quote_decimals_unknown',
    ]);
    holdsTheTableChecks(b);
  });

  it("SPY's two pools: one at par against USDG, one priced from NVDA's own dollar pool that hour", () => {
    const usdg = rhBars('0xcb410a0728986ba05737420556d5fe128ffd6739823cc92fc745d37bad4b313f');
    const nvda = rhBars('0xbc732a1a0baabce2574ec2bca24fccad8e2c38a061a37cefc17a2fd12809394f');
    const NVDA_USD = 231.3159285985732; // the hour's quoteUsd in the fixture (implied_from_0xd4eb…14a3)
    const [u] = usdg;
    const [n] = nvda;
    if (!u || !n) throw new Error('no bar');
    // USDG pool, block 55631478: SPY (token 0, 18) in 18037127844807336, USDG (token 1, 6) out 13956470: a sale
    expect([u.swaps, u.sellSwaps, u.buySwaps]).toEqual([1, 1, 0]);
    close(u.openUsd, 13.95647 / e18(18037127844807336n));
    // NVDA pool: block 55631438 SPY in (a sale), 55637197 and 55637569 SPY out (purchases); both 18 decimals
    const nv = [
      [e18(203310288782991301n), e18(679530850491819647n), 'sell'],
      [e18(38254947585098817n), e18(128020097738143330n), 'buy'],
      [e18(2209932385420494453n), e18(7396069720726328001n), 'buy'],
    ] as const;
    expect([n.swaps, n.sellSwaps, n.buySwaps]).toEqual([3, 1, 2]);
    close(n.openQuote, nv[0][1] / nv[0][0]);
    close(n.closeQuote, nv[2][1] / nv[2][0]);
    close(n.sellVolumeUsd, nv[0][1] * NVDA_USD);
    close(n.buyVolumeUsd, nv[1][1] * NVDA_USD + nv[2][1] * NVDA_USD);
    close(n.closeUsd, (nv[2][1] / nv[2][0]) * NVDA_USD);
    const [a] = assetBars(
      [
        { pool: '0xcb41', bars: usdg },
        { pool: '0xbc73', bars: nvda },
      ],
      'raw_events',
      'place',
    );
    if (!a) throw new Error('no bar');
    // the NVDA pool's first swap (block 55631438) is before the USDG pool's (55631478)
    close(a.openUsd, (nv[0][1] / nv[0][0]) * NVDA_USD);
    close(a.closeUsd, (nv[2][1] / nv[2][0]) * NVDA_USD);
    close(a.volumeUsd, 13.95647 + nv.reduce((s, [, q]) => s + q * NVDA_USD, 0));
    expect([a.swaps, a.sellSwaps, a.buySwaps]).toEqual([4, 2, 2]);
    holdsTheTableChecks(a);
  });
});

describe('the check against risk_pool_flow', () => {
  const bar = (hour: string, regime: Regime, x: Partial<CheckBar>): CheckBar => ({
    hour,
    regime,
    swaps: 0,
    buySwaps: 0,
    sellSwaps: 0,
    unpricedSwaps: 0,
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    swapsWithoutSide: 0,
    ...x,
  });
  const bars = [
    bar('2026-10-05T23:00:00.000Z', 'us_offhours_weekday', {
      swaps: 3,
      buySwaps: 2,
      sellSwaps: 1,
      buyVolumeUsd: 0.1 + 0.2,
      sellVolumeUsd: 5,
    }),
    bar('2026-10-06T00:00:00.000Z', 'us_offhours_weekday', {
      swaps: 1,
      buySwaps: 1,
      buyVolumeUsd: 0.3,
      swapsWithoutSide: 2,
    }),
    // outside the 24-hour window ending 2026-10-06 00:30
    bar('2026-10-04T23:00:00.000Z', 'weekend', { swaps: 9, sellSwaps: 9, sellVolumeUsd: 9 }),
  ];
  const row = {
    regime: 'all' as const,
    window: '24h' as const,
    dataTo: '2026-10-06T00:30:00.000Z',
    swaps: 4,
    sellSwaps: 1,
    buySwaps: 3,
    unpricedSwaps: 0,
    sellUsd: 5,
    buyUsd: 0.6,
  };
  it('sums the window and the regime, and calls a difference of summation order float rounding', () => {
    expect(barsInWindow(bars, row)).toMatchObject({ swaps: 4, buySwaps: 3, hours: 2 });
    // (0.1 + 0.2) + 0.3 is not 0.6 in floats: a difference of order, inside the bound, never a wider one
    expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
    expect(checkFlowRow(bars, row).status).toBe('float_rounding');
    expect(checkFlowRow(bars, { ...row, buyUsd: 0.6 + 1e-9 }).status).toBe('differs');
    expect(withinRounding(1e6, 1e6 + 1e-6, 10)).toBe(false);
  });
  it('names the swaps with no side when counting them as unpriced purchases makes the row equal', () => {
    const r = checkFlowRow(bars, { ...row, swaps: 6, buySwaps: 5, unpricedSwaps: 2 });
    expect(r.status).toBe('differs');
    expect(r.explainedBySwapsWithoutSide).toBe(true);
    expect(checkFlowRow(bars, { ...row, regime: 'weekend' }).sums.swaps).toBe(0);
  });
});

describe('the dust rule and the order of a slot shared by pools', () => {
  const hour: BarHour = { regime: 'weekend', quoteUsd: 1, method: 'usdc_at_par' };
  const swap = (slot: number, q: number, tokens: number, quote: number, minRaw: number) => ({
    t: 1_789_000_000 + slot,
    at: [slot, -q, 0] as const,
    side: 'sell' as const,
    tokens,
    quote,
    minRaw,
  });
  it('2 raw units against 1 sets no mark (the $100 low of a $229 stock), $0.50 neither', () => {
    const acc = newPoolBars();
    addBarSwap(acc, swap(1, 0, 1, 229, 1e8), hour, regimeOfT); // 1 token for $229
    addBarSwap(acc, swap(2, 0, 2e-8, 2e-6, 1), hour, regimeOfT); // 2 raw units for 1: reads $100
    addBarSwap(acc, swap(3, 0, 0.002, 0.5, 2e5), hour, regimeOfT); // $0.50: under $1
    const [b] = poolBars(acc, 'raw_events');
    if (!b) throw new Error('no bar');
    expect([b.highQuote, b.lowQuote, b.openQuote, b.closeQuote]).toEqual([229, 229, 229, 229]);
    expect(b.swaps).toBe(3);
    close(b.volumeTokens, 1 + 2e-8 + 0.002);
    close(b.vwapQuote, (229 + 2e-6 + 0.5) / (1 + 2e-8 + 0.002));
    expect(b.detail).toMatchObject({ dustSwaps: 2 });
  });
  it('a slot shared by two pools: the open from the pool that sorts first, the close from the last', () => {
    const one = (pool: string, slot: number, price: number) => {
      const acc = newPoolBars();
      addBarSwap(acc, swap(slot, 5, 1, price, 1e8), hour, regimeOfT);
      return { pool, bars: poolBars(acc, 'raw_events') };
    };
    const [a] = assetBars([one('Bbb', 7, 200), one('Aaa', 7, 100)], 'raw_events', 'slot');
    if (!a) throw new Error('no bar');
    expect([a.openUsd, a.closeUsd]).toEqual([100, 200]);
    expect(a.detail).toMatchObject({
      openPool: 'Aaa',
      closePool: 'Bbb',
      openInSharedSlot: true,
      closeInSharedSlot: true,
    });
    // by place (Robinhood Chain), the same two are ordered by their whole place: no shared slot
    const [r] = assetBars([one('Bbb', 7, 200), one('Aaa', 8, 100)], 'raw_events', 'place');
    expect([r?.openUsd, r?.closeUsd, r?.detail.openInSharedSlot]).toEqual([200, 100, undefined]);
  });
});
