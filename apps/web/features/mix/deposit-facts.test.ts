import { describe, expect, it } from 'vitest';
import { orderOn } from '../order/test/fixtures';
import { unitsFor } from '../order/units';
import { ageSeconds, gapBps, quotePrices } from './deposit-facts';

// The one-screen deposit's facts (gate DEPOSIT-ONE-SCREEN), worked out from the order our server made
// and nothing else: the price each asset is bought at in the order's own quote, and its gap to the feed.

describe('quotePrices: the price the vault buys at, from the order’s quote', () => {
  const units = unitsFor('solana', false);

  it('is what the swap spends over what its quote pays out, with the order as its source', () => {
    // $6 of USDC for 1,000,000 raw SPYx (8 decimals): 0.01 SPYx, so $600 each
    const order = orderOn();
    const prices = quotePrices(order, units);
    expect([...prices.keys()]).toEqual(['solana:spyx']);
    const spy = prices.get('solana:spyx');
    expect(spy?.usdPerToken).toBeCloseTo(600, 6);
    expect(spy?.obs).toMatchObject({
      fetchedAt: order.createdAt,
      provenance: 'sandbox',
    });
    expect(spy?.obs.source).toContain(order.id);
    expect(spy?.obs.method).toMatch(/divided by the tokens its quote pays out/);
  });

  it('is never the worst case the step accepts: the least received does not move it', () => {
    const low = quotePrices(orderOn('solana', '500000'), units).get('solana:spyx');
    expect(low?.usdPerToken).toBeCloseTo(600, 6);
  });

  it('guesses nothing: no units, no quote, or a sale give no price', () => {
    expect(quotePrices(orderOn(), null).size).toBe(0);
    const unquoted = orderOn();
    const noQuote = {
      ...unquoted,
      legs: unquoted.legs.map((leg) => ({ ...leg, expected: [] })),
    };
    expect(quotePrices(noQuote, units).size).toBe(0);
    const sale = {
      ...unquoted,
      legs: unquoted.legs.map((leg) => ({
        ...leg,
        trades: leg.trades.map((trade) => ({ ...trade, sell: trade.buy, buy: trade.sell })),
      })),
    };
    expect(quotePrices(sale, units).size).toBe(0);
  });
});

describe('gapBps and ageSeconds', () => {
  it('signs the gap: above the feed is positive', () => {
    expect(gapBps(600, 590)).toBe(169);
    expect(gapBps(590, 600)).toBe(-167);
    expect(gapBps(0, 600)).toBeNull();
    expect(gapBps(600, 0)).toBeNull();
  });

  it('reads the age of a figure from its time, or says it cannot', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    expect(ageSeconds('2026-10-28T09:00:00.000Z', now)).toBe(10_800);
    expect(ageSeconds('not a time', now)).toBeNull();
  });
});
