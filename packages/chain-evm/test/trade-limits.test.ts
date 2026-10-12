import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainError } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { deploymentLimits, EvmDeploymentRecord } from '../src/vault/deployment';
import {
  type HeldTrade,
  holdTrade,
  NO_TRADE_LIMITS,
  type TradeLimits,
  worthAtFeed,
} from '../src/vault/trade-limits';

// What an owner's trade is held to before it is built: the feed's price, and the asset's largest
// trade. No node: the numbers are worked by hand.

const GLD_AT = '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e';
const LIMITS: TradeLimits = { priceBoundBps: 200, maxTradeUsd: { [GLD_AT]: 1_000 } };
const USD = 1_000_000n;
const ONE = 10n ** 18n;
const FRESH = { usdPerToken: '400', ageSeconds: 60, maxAgeSeconds: 93_600 };
/** $400 of cash for GLD at $400: one token at the feed's price. */
const buyOf = (out: bigint, over: Partial<HeldTrade> = {}): HeldTrade => ({
  symbol: 'GLD',
  side: 'buy',
  amountIn: 400n * USD,
  amountInSoFar: 400n * USD,
  out,
  cashDecimals: 6,
  assetDecimals: 18,
  price: FRESH,
  ...over,
});
/** One GLD for cash: $400 at the feed's price. */
const sellOf = (out: bigint, over: Partial<HeldTrade> = {}): HeldTrade => ({
  ...buyOf(out),
  side: 'sell',
  amountIn: ONE,
  amountInSoFar: ONE,
  ...over,
});
const refusalOf = (work: () => unknown): ChainError => {
  try {
    work();
  } catch (e) {
    if (e instanceof ChainError) return e;
    throw e;
  }
  throw new Error('it was not refused');
};

describe("what a trade is worth at the feed's price", () => {
  it('is exact, in raw units, both ways and at other decimals', () => {
    const d = { cashDecimals: 6, assetDecimals: 18 };
    expect(worthAtFeed({ side: 'buy', ...d }, 400n * USD, '400')).toBe(ONE);
    expect(worthAtFeed({ side: 'sell', ...d }, ONE, '400')).toBe(400n * USD);
    expect(worthAtFeed({ side: 'buy', ...d }, 100n * USD, '225.28949995')).toBe(
      (100n * USD * ONE * ONE) / (USD * 225_289_499_950_000_000_000n),
    );
    // An 8-decimal token against 6-decimal cash.
    const btc = { cashDecimals: 6, assetDecimals: 8 };
    expect(worthAtFeed({ side: 'buy', ...btc }, 50_000n * USD, '100000')).toBe(50_000_000n);
    expect(worthAtFeed({ side: 'sell', ...btc }, 100_000_000n, '100000')).toBe(100_000n * USD);
    expect(() => worthAtFeed({ side: 'buy', ...d }, 1n, '0')).toThrow(ChainError);
  });
});

describe('the bound to the feed', () => {
  it("passes a quote inside the bound and gives the feed's floor: the worth less the bound", () => {
    // 0.5% under the feed: a pool's fee and a little impact.
    expect(holdTrade(LIMITS, GLD_AT, buyOf((ONE * 995n) / 1000n))).toBe((ONE * 98n) / 100n);
    expect(holdTrade(LIMITS, GLD_AT, sellOf(398n * USD))).toBe(392n * USD);
    // Exactly at the bound, either side, still passes.
    expect(holdTrade(LIMITS, GLD_AT, buyOf((ONE * 98n) / 100n))).toBe((ONE * 98n) / 100n);
    expect(holdTrade(LIMITS, GLD_AT, buyOf((ONE * 102n) / 100n))).toBe((ONE * 98n) / 100n);
  });

  it('refuses a quote further from the feed than the bound, worse or better, in words a person reads', () => {
    const worse = refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 95n) / 100n)));
    expect(worse.code).toBe('PriceDeviation');
    expect(worse.retryable).toBe(true);
    expect(worse.message).toBe(
      "the pool's price for GLD is 5.00% worse than the reference price, more than the 2.00% allowed: not trading. The pool may be thin or pushed; try a smaller amount, or later",
    );
    // A sale into a pool pushed down pays too little.
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, sellOf(380n * USD))).message).toMatch(
      /5\.00% worse/,
    );
    // And a price too good is not a price to trade at either: the pool is off its feed.
    const better = refusalOf(() => holdTrade(LIMITS, GLD_AT, sellOf(420n * USD)));
    expect(better.code).toBe('PriceDeviation');
    expect(better.message).toMatch(/5\.00% better than the reference price/);
    // One basis point past the bound.
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 9_799n) / 10_000n))).code).toBe(
      'PriceDeviation',
    );
  });

  it('refuses where there is no witness: a stale feed, or no feed at all', () => {
    const stale = refusalOf(() =>
      holdTrade(LIMITS, GLD_AT, buyOf(ONE, { price: { ...FRESH, ageSeconds: 93_601 } })),
    );
    expect(stale.code).toBe('PriceStale');
    expect(stale.message).toMatch(/GLD is 93601 s old, more than the 93600 s it may be/);
    // At its limit to the second it is still a price.
    expect(
      holdTrade(LIMITS, GLD_AT, buyOf(ONE, { price: { ...FRESH, ageSeconds: 93_600 } })),
    ).not.toBeNull();
    const none = refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf(ONE, { price: null })));
    expect(none.code).toBe('AssetNotPriced');
    expect(none.message).toMatch(/GLD has no reference price to check the pool against/);
  });

  it('a network that does not check holds nothing to the feed, and says so with null', () => {
    expect(holdTrade(NO_TRADE_LIMITS, GLD_AT, buyOf(ONE / 2n))).toBeNull();
    expect(holdTrade(NO_TRADE_LIMITS, GLD_AT, buyOf(ONE, { price: null }))).toBeNull();
    expect(
      holdTrade({ priceBoundBps: null, maxTradeUsd: { [GLD_AT]: null } }, GLD_AT, sellOf(1n)),
    ).toBeNull();
  });
});

describe("the asset's largest trade", () => {
  const big = (usd: bigint) =>
    buyOf((ONE * usd) / 400n, { amountIn: usd * USD, amountInSoFar: usd * USD });

  it('passes a trade at the limit and refuses a dollar more, with the limit named', () => {
    expect(holdTrade(LIMITS, GLD_AT, big(1_000n))).not.toBeNull();
    const over = refusalOf(() => holdTrade(LIMITS, GLD_AT, big(1_001n)));
    expect(over.code).toBe('BadTrade');
    expect(over.message).toBe(
      '$1,001 of GLD in one go is more than its pool is trusted to fill: at most $1,000 at a time. Trade less, or in parts',
    );
  });

  it('counts what the same step already put through the pool', () => {
    const second = buyOf(ONE, { amountInSoFar: 1_200n * USD });
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, second)).message).toMatch(/\$1,200 of GLD/);
  });

  it('measures a sale by the feed, so a pool pushed down cannot make it look small', () => {
    // Three tokens are $1,200 at the feed, though this pool would pay $600 for them.
    const cheap = sellOf(600n * USD, { amountIn: 3n * ONE, amountInSoFar: 3n * ONE });
    const refused = refusalOf(() => holdTrade(LIMITS, GLD_AT, cheap));
    expect(refused.code).toBe('BadTrade');
    expect(refused.message).toMatch(/\$1,200 of GLD/);
  });

  it('holds a network that checks no feed by the cash side', () => {
    const sized: TradeLimits = { priceBoundBps: null, maxTradeUsd: { [GLD_AT]: 1_000 } };
    expect(holdTrade(sized, GLD_AT, big(1_000n))).toBeNull();
    expect(refusalOf(() => holdTrade(sized, GLD_AT, big(1_001n))).code).toBe('BadTrade');
    const sale = sellOf(1_100n * USD, { amountIn: 3n * ONE, amountInSoFar: 3n * ONE, price: null });
    expect(refusalOf(() => holdTrade(sized, GLD_AT, sale)).message).toMatch(/\$1,100 of GLD/);
  });

  it("is the asset's own: another token has another, or none", () => {
    const other = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
    expect(holdTrade(LIMITS, other, big(40_000n))).not.toBeNull();
    // Looked up whatever the case the address is written in.
    expect(
      refusalOf(() => holdTrade(LIMITS, GLD_AT.toUpperCase().replace('0X', '0x'), big(2_000n)))
        .code,
    ).toBe('BadTrade');
  });
});

describe("a network's limits, from its record", () => {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'deployments', 'robinhood-testnet.json'),
      'utf8',
    ),
  );

  it('the test network checks nothing against its feeds and limits no trade, and says both', () => {
    const record = EvmDeploymentRecord.parse(raw);
    expect(record.priceBoundBps).toBeNull();
    const limits = deploymentLimits(record);
    expect(limits.priceBoundBps).toBeNull();
    expect(Object.keys(limits.maxTradeUsd).sort()).toEqual(
      record.assets.map((a) => a.address).sort(),
    );
    expect(Object.values(limits.maxTradeUsd).every((v) => v === null)).toBe(true);
  });

  it('a record has to say: no bound and no limit are stated, never left out', () => {
    const parses = (change: (r: typeof raw) => void) => {
      const copy = structuredClone(raw);
      change(copy);
      return EvmDeploymentRecord.safeParse(copy).success;
    };
    expect(parses(() => {})).toBe(true);
    expect(parses((r) => delete r.priceBoundBps)).toBe(false);
    expect(parses((r) => delete r.assets[0].maxTradeUsd)).toBe(false);
    expect(parses((r) => (r.priceBoundBps = 200))).toBe(true);
    expect(parses((r) => (r.priceBoundBps = 0))).toBe(false);
    expect(parses((r) => (r.priceBoundBps = 1_001))).toBe(false);
    expect(parses((r) => (r.assets[0].maxTradeUsd = 1_000))).toBe(true);
    expect(parses((r) => (r.assets[0].maxTradeUsd = 0))).toBe(false);
    expect(parses((r) => (r.assets[0].maxTradeUsd = 1.5))).toBe(false);
    const record = EvmDeploymentRecord.parse(
      (() => {
        const copy = structuredClone(raw);
        copy.priceBoundBps = 200;
        copy.assets[0].maxTradeUsd = 1_000;
        return copy;
      })(),
    );
    expect(deploymentLimits(record)).toMatchObject({
      priceBoundBps: 200,
      maxTradeUsd: { [record.assets[0]?.address ?? '']: 1_000 },
    });
  });
});
