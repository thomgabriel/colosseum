// The Solana shelf's registry (PLAN-ASSETS AS.12, `pnpm risk:shelf-pools-solana`): the picking rule on three real
// DexScreener answers frozen on 2026-10-13 (addresses replaced by placeholders), the confirmation's refusals, and the
// file name the default registry choice never takes.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignPools,
  type DsPair,
  impliedPrice,
  pickPools,
  referencePrice,
  SHELF_POOL_RULE,
  supportedVenue,
} from '../../scripts/risk/assets/shelf-pools';
import { latestRegistryFile } from '../../scripts/risk/lib-history';
import { confirmPool, VENUES } from '../../scripts/risk/lib-venues';

const frozen = JSON.parse(
  readFileSync(
    join(__dirname, '../../fixtures/risk/assets/shelf-pools/dexscreener-solana-20261013.json'),
    'utf8',
  ),
) as { tokens: Array<{ symbol: string; mint: string; pairs: DsPair[] }> };
const token = (s: string) => frozen.tokens.find((t) => t.symbol === s) as (typeof frozen.tokens)[0];
const pick = (s: string) => pickPools(token(s).mint, token(s).pairs);

describe('the venues the rule takes', () => {
  it('are the four the swap decoders read, by DexScreener names', () => {
    expect(supportedVenue({ dexId: 'raydium', labels: ['CLMM'] })).toBe('raydium_clmm');
    expect(supportedVenue({ dexId: 'raydium', labels: ['CPMM'] })).toBe('raydium_cpmm');
    expect(supportedVenue({ dexId: 'orca', labels: ['wp'] })).toBe('orca_whirlpool');
    expect(supportedVenue({ dexId: 'meteora', labels: ['DLMM'] })).toBe('meteora_dlmm');
    // Raydium's AMM v4, Meteora's DAMM pools and others have no swap decoder here
    for (const v of [
      { dexId: 'raydium' },
      { dexId: 'meteora', labels: ['DYN'] },
      { dexId: 'meteora', labels: ['DYN2'] },
      { dexId: 'pumpswap' },
      { dexId: 'orca', labels: ['v2'] },
    ])
      expect(supportedVenue(v)).toBeNull();
  });
});

describe('the picking rule on frozen answers', () => {
  it('JitoSOL: a mispriced pair is re-valued, and three pools reach 90%', () => {
    const p = pick('JitoSOL');
    expect(p.pairs).toBe(30);
    // the JitoSOL/JupSOL pair DexScreener put at $2.4 billion, valued at the reference price instead
    expect(p.repriced).toHaveLength(1);
    expect(p.repriced[0]?.dexscreenerUsd).toBeGreaterThan(2e9);
    expect(p.repriced[0]?.usd).toBeLessThan(1e6);
    expect(p.referencePriceUsd).toBeCloseTo(139.66, 2);
    expect(p.picked.map((x) => [x.venue, Math.round(x.liquidityUsd)])).toEqual([
      ['orca_whirlpool', 6_104_065],
      ['raydium_clmm', 1_748_186],
      ['meteora_dlmm', 1_315_536],
    ]);
    expect(p.coveredShare).toBeGreaterThanOrEqual(SHELF_POOL_RULE.share);
    expect(p.coveredUsd + p.leftOutUsd).toBeCloseTo(p.supported.liquidityUsd, 2);
    expect(p.unsupported.byVenue['meteora:DYN']).toBeGreaterThan(2e6);
    expect(p.belowMin.pools).toBe(13);
  });

  it('GLDx: the five-pool cap stops it short of 90%', () => {
    const p = pick('GLDx');
    expect(p.picked).toHaveLength(SHELF_POOL_RULE.maxPools);
    expect(p.coveredShare).toBeCloseTo(0.7943, 4);
    const liq = p.picked.map((x) => x.liquidityUsd);
    expect([...liq].sort((a, b) => b - a)).toEqual(liq);
  });

  it('GRND: only two pools clear $10,000, the rest is left out', () => {
    const p = pick('GRND');
    expect(p.picked).toHaveLength(2);
    expect(p.picked.every((x) => x.liquidityUsd >= SHELF_POOL_RULE.minLiquidityUsd)).toBe(true);
    expect(p.belowMin.pools).toBe(11);
    expect(p.coveredShare).toBeCloseTo(0.4325, 4);
  });

  it('every picked pool names the other side as its quote', () => {
    for (const t of frozen.tokens)
      for (const x of pickPools(t.mint, t.pairs).picked) expect(x.quoteMint).not.toBe(t.mint);
  });
});

const pair = (address: string, usd: number, quote = 'USDC', price = '1'): DsPair => ({
  pairAddress: address,
  dexId: 'orca',
  labels: ['wp'],
  baseToken: { address: 'TOK', symbol: 'TOK' },
  quoteToken: { address: quote, symbol: quote },
  priceUsd: price,
  priceNative: price,
  liquidity: { usd },
  volume: { h24: 5_000 },
});

describe('the picking rule, by construction', () => {
  it('skips a rejected pool and keeps its liquidity as left out', () => {
    const pairs = [pair('A', 500_000), pair('B', 300_000), pair('C', 200_000)];
    const all = pickPools('TOK', pairs);
    expect(all.picked.map((x) => x.address)).toEqual(['A', 'B', 'C']);
    const without = pickPools('TOK', pairs, SHELF_POOL_RULE, new Set(['A']));
    expect(without.picked.map((x) => x.address)).toEqual(['B', 'C']);
    expect(without.leftOutUsd).toBe(500_000);
    expect(without.coveredShare).toBe(0.5);
  });

  it('ignores pairs that do not hold the token and counts a pair once', () => {
    const other = { ...pair('X', 9e6), baseToken: { address: 'ELSE' } };
    const p = pickPools('TOK', [pair('A', 100_000), pair('A', 100_000), other]);
    expect(p.pairs).toBe(1);
    expect(p.supported.liquidityUsd).toBe(100_000);
  });

  it('prices the token from either side and takes the median of traded pairs', () => {
    const asQuote: DsPair = {
      ...pair('Q', 1),
      baseToken: { address: 'ELSE' },
      quoteToken: { address: 'TOK' },
      priceUsd: '6',
      priceNative: '3',
    };
    expect(impliedPrice('TOK', asQuote)).toBe(2);
    expect(
      referencePrice('TOK', [pair('A', 1, 'USDC', '2'), pair('B', 1, 'USDC', '2.2'), asQuote]),
    ).toBe(2);
  });

  it('keeps a pool shared by two subjects once, under the first', () => {
    const p = (address: string) => ({
      address,
      venue: 'orca_whirlpool' as const,
      dsVenue: 'orca:wp',
      liquidityUsd: 1,
      dexscreenerLiquidityUsd: 1,
      repriced: false,
      volume24hUsd: 0,
      quoteMint: 'Q',
      quoteSymbol: null,
    });
    const { owner, sharedWith } = assignPools(
      ['T1', 'T2'],
      new Map([
        ['T1', [p('P1'), p('P2')]],
        ['T2', [p('P2'), p('P3')]],
      ]),
    );
    expect(owner.get('P2')).toBe('T1');
    expect(owner.get('P3')).toBe('T2');
    expect(sharedWith.get('T2')).toEqual([{ address: 'P2', owner: 'T1' }]);
  });
});

describe('the on-chain confirmation', () => {
  it('refuses a missing account, a program that is no venue, and the wrong venue', () => {
    expect(confirmPool(null)).toEqual({ ok: false, reason: 'account not found' });
    expect(confirmPool({ owner: 'NotAVenue', data: new Uint8Array(8) })).toEqual({
      ok: false,
      reason: 'unsupported program NotAVenue',
    });
    const r = confirmPool(
      { owner: VENUES.orca_whirlpool.program, data: new Uint8Array(8) },
      { expected: 'raydium_clmm' },
    );
    expect(r).toEqual({ ok: false, reason: 'owner is orca_whirlpool, not raydium_clmm' });
    const short = confirmPool({ owner: VENUES.orca_whirlpool.program, data: new Uint8Array(8) });
    expect(short.ok).toBe(false);
  });
});

describe("the shelf registry's file name", () => {
  it('is never the default registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shelf-reg-'));
    for (const n of [
      'registry-20261001T0139.json',
      'registry-search-20261001T0049.json',
      'shelf-registry-solana-20261013T1352.json',
      'shelf-dexscreener-solana-20261013T1349.jsonl',
    ])
      writeFileSync(join(dir, n), '{"pools":[]}');
    expect(latestRegistryFile(dir)).toBe(join(dir, 'registry-20261001T0139.json'));
  });
});
