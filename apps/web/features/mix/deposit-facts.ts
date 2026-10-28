import type { OrderDetail } from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';
import type { ChainUnits } from '../order/units';

// The facts each holding's row shows on the one-screen deposit (gate DEPOSIT-ONE-SCREEN), worked out
// from what our server already answered and nothing else: the price the vault trades at is the
// order's own quote for the swap that buys the asset (what the step spends over what the quote pays
// out, the same figures "at most $X each" is read from), set beside the reference feed's price from
// the server's review, with the gap between them. No new read and no figure of this screen's own.

/** The price one token of an asset costs in the order's quote, with where that figure comes from. */
export type QuotePrice = {
  /** Dollars per token at the quote: what the swap spends over what the quote pays out. */
  usdPerToken: number;
  obs: PinSource;
};

/** A price that means something: above zero, finite, and not a dust amount's. */
function priceOf(cashRaw: string, cashDecimals: number, tokenRaw: string, tokenDecimals: number) {
  const cash = Number(cashRaw) / 10 ** cashDecimals;
  const tokens = Number(tokenRaw) / 10 ** tokenDecimals;
  if (!(cash > 0) || !(tokens > 0)) return null;
  const price = cash / tokens;
  return Number.isFinite(price) && price > 0 && price < 1e9 ? price : null;
}

/**
 * The price of each asset an order buys with the chain's cash, from the quote each of its swaps was
 * made with. An asset this app has no units for, a trade with no quote and a sale are left out: no
 * figure is guessed. Where an order buys an asset in more than one trade, the first quote stands.
 */
export function quotePrices(
  order: Pick<OrderDetail, 'id' | 'legs' | 'createdAt'>,
  units: ChainUnits | null,
): Map<string, QuotePrice> {
  const prices = new Map<string, QuotePrice>();
  const cash = units ? units.tokens[units.cash] : undefined;
  if (!units || !cash) return prices;
  for (const leg of order.legs) {
    leg.trades.forEach((trade, i) => {
      const expected = leg.expected[i];
      const bought = units.tokens[trade.buy];
      if (!expected || !bought || trade.sell !== units.cash || prices.has(trade.buy)) return;
      const usdPerToken = priceOf(expected.inRaw, cash.decimals, expected.outRaw, bought.decimals);
      if (usdPerToken === null) return;
      prices.set(trade.buy, {
        usdPerToken,
        obs: {
          source: `the quote of order ${order.id}, for the swap that buys ${bought.symbol}`,
          method:
            'the cash the swap spends divided by the tokens its quote pays out, before the least the step accepts',
          fetchedAt: order.createdAt,
          provenance: leg.provenance,
        },
      });
    });
  }
  return prices;
}

/** How far the quote is from the reference feed, in basis points: above the feed is positive. */
export function gapBps(quoteUsd: number, feedUsd: number): number | null {
  if (!(quoteUsd > 0) || !(feedUsd > 0)) return null;
  return Math.round(((quoteUsd - feedUsd) / feedUsd) * 10_000);
}

/** Seconds from a figure's `fetchedAt` to `now`, or null where its time does not read. */
export function ageSeconds(fetchedAt: string, now: number): number | null {
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / 1000));
}
