import { ChainError } from '@colosseum/schemas';
import { toScaled } from './amounts';

// What an owner's trade is held to before it is built, beside the vault's own minimum.
//
// The vault checks an owner's swap against nothing but `minOut`, and `minOut` used to come from the
// pool's own quote: whatever the pool said was the price. A thin pool can be pushed for a few hundred
// dollars, a person's order quoted and filled there, and the pool sold back. So a trade is also held
// to the asset's Chainlink price, the one witness that is not the pool:
//
// - the pool's quote is within `priceBoundBps` of what the feed says the trade is worth, either way,
//   pool fee included, or the step is refused (`PriceDeviation`);
// - a feed that is stale by the asset's own `maxAge`, or gives no price, refuses (`PriceStale`,
//   `AssetNotPriced`): no witness is not a pass;
// - `minOut` is never under the feed's worth less the bound, so the fill itself is held to it on the
//   chain, whatever the pool does between the quote and the block;
// - one trade is at most the asset's `maxTradeUsd`, the size its pool was measured to fill.
//
// What it does not do: it is the app's check, not the contract's. Someone who builds their own call
// data for their own vault is held to their own `minOut` only. And where the feed is itself made from
// pools (GLD), the witness can be moved with enough money in enough pools: there the size limit is the
// protection that counts.

/** What a network holds its owners' trades to. */
export type TradeLimits = {
  /**
   * How far a pool's quote may be from the Chainlink price, in basis points, pool fee included. Null:
   * not checked on this network, and the record says why.
   */
  priceBoundBps: number | null;
  /** The largest single trade of each asset, in dollars, by token address in lower case. Null or absent: none. */
  maxTradeUsd: Readonly<Record<string, number | null>>;
};

/** No limit at all: for a chain in memory and for tests of something else. */
export const NO_TRADE_LIMITS: TradeLimits = { priceBoundBps: null, maxTradeUsd: {} };

/** The feed's answer for the asset, as the reader gives it. */
export type FeedPrice = {
  usdPerToken: string;
  ageSeconds: number;
  maxAgeSeconds: number;
  /** Whether the asset's market is open by the vault's own calendar, where it has one. */
  market?: 'open' | 'closed' | 'unknown';
};

export type HeldTrade = {
  symbol: string;
  /** `buy`: cash in, the asset out. `sell`: the asset in, cash out. */
  side: 'buy' | 'sell';
  /** This trade's own input, raw. */
  amountIn: bigint;
  /** What the pool quotes for it, raw. */
  out: bigint;
  /** Everything this transaction puts through the same pool up to and including this trade, raw, in the trade's input token. */
  amountInSoFar: bigint;
  cashDecimals: number;
  assetDecimals: number;
  /** Null where the asset has no feed, or the network does not check. */
  price: FeedPrice | null;
};

const SCALE = 10n ** 18n;
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
const hours = (seconds: number) => {
  const h = Math.round(seconds / 3600);
  return h < 1 ? 'under an hour' : h === 1 ? '1 hour' : `${h} hours`;
};

/**
 * A network whose money is real states both limits: null means unchecked, and on a mainnet nothing
 * may be unchecked. Said of the chain's number and of the record's own name, so it holds whichever
 * way a record comes to be admitted. Returns what is missing, or null.
 */
export function unlimitedOnMainnet(record: {
  network: string;
  evmChainId: number;
  priceBoundBps: number | null;
  assets: readonly { symbol: string; maxTradeUsd: number | null }[];
}): string | null {
  const mainnet = [1, 4663, 8453].includes(record.evmChainId) || /-mainnet$/.test(record.network);
  if (!mainnet) return null;
  if (record.priceBoundBps === null)
    return 'a mainnet record states no priceBoundBps: an owner trade would be checked against no price';
  const open = record.assets.filter((a) => a.maxTradeUsd === null).map((a) => a.symbol);
  return open.length
    ? `a mainnet record states no maxTradeUsd for ${open.join(', ')}: a trade of any size would be built`
    : null;
}
const dollars = (usd: number) =>
  `$${usd.toLocaleString('en-US', { maximumFractionDigits: usd < 100 ? 2 : 0 })}`;

/** What `amountIn` is worth on the other side at the feed's price, raw. */
export function worthAtFeed(
  t: Pick<HeldTrade, 'side' | 'cashDecimals' | 'assetDecimals'>,
  amountIn: bigint,
  usdPerToken: string,
): bigint {
  const price = toScaled(usdPerToken);
  if (price <= 0n) throw new ChainError('AssetNotPriced', 'the reference price is not above zero');
  const cash = 10n ** BigInt(t.cashDecimals);
  const asset = 10n ** BigInt(t.assetDecimals);
  return t.side === 'buy'
    ? (amountIn * asset * SCALE) / (cash * price)
    : (amountIn * price * cash) / (asset * SCALE);
}

/**
 * Holds one trade to the limits, or throws the refusal a person reads. Returns the least the trade
 * may fill at by the feed (`feedFloor`, raw output), or null where the network does not check.
 */
export function holdTrade(limits: TradeLimits, token: string, t: HeldTrade): bigint | null {
  const max = limits.maxTradeUsd[token.toLowerCase()] ?? null;
  const checked = limits.priceBoundBps !== null;
  if (checked && !t.price)
    throw new ChainError(
      'AssetNotPriced',
      `${t.symbol} has no reference price to check the pool against: not trading`,
    );
  if (checked && t.price && t.price.ageSeconds > t.price.maxAgeSeconds)
    throw new ChainError(
      'PriceStale',
      t.price.market === 'closed'
        ? `no fresh reference price for ${t.symbol}: the market is closed; trades of ${t.symbol} resume when it opens`
        : `no fresh reference price for ${t.symbol}: the last one is ${hours(t.price.ageSeconds)} old, and it may be ${hours(t.price.maxAgeSeconds)} at most; trades of ${t.symbol} resume when a new one arrives`,
    );

  if (max !== null) {
    // In dollars by the feed where there is one, so a pushed pool cannot make a sale look small;
    // by the cash side otherwise.
    const cash = 10 ** t.cashDecimals;
    const soFar =
      t.side === 'buy'
        ? Number(t.amountInSoFar) / cash
        : t.price
          ? Number(worthAtFeed(t, t.amountInSoFar, t.price.usdPerToken)) / cash
          : (Number(t.out) / cash) * (Number(t.amountInSoFar) / Number(t.amountIn));
    if (soFar > max)
      throw new ChainError(
        'BadTrade',
        `${dollars(soFar)} of ${t.symbol} in one go is more than its pool is trusted to fill: at most ${dollars(max)} at a time. Trade less, or in parts`,
      );
  }

  if (!checked || !t.price) return null;
  const bound = BigInt(limits.priceBoundBps as number);
  const fair = worthAtFeed(t, t.amountIn, t.price.usdPerToken);
  if (fair <= 0n)
    throw new ChainError('BadTrade', `a trade of ${t.symbol} too small to price: not trading`);
  const gap = t.out > fair ? t.out - fair : fair - t.out;
  // Compared without rounding to whole basis points: 2.0099% is past a bound of 2%.
  if (gap * 10_000n > bound * fair) {
    // Shown rounded up, so a gap just past the bound never reads as the bound itself.
    const shown = (gap * 10_000n + fair - 1n) / fair;
    const way = t.out < fair ? 'worse' : 'better';
    // Just past the bound is most often an ordinary move, and passes in a moment; far past it is a
    // pool that is thin for this size, or pushed.
    throw new ChainError(
      'PriceDeviation',
      gap * 10_000n <= bound * fair + (bound * fair) / 2n
        ? `the pool's price for ${t.symbol} is ${pct(shown)} ${way} than the reference price right now, just past the ${pct(bound)} allowed: try again shortly`
        : `the pool's price for ${t.symbol} is ${pct(shown)} ${way} than the reference price, more than the ${pct(bound)} allowed: not trading. The pool may be thin or pushed; try a smaller amount, or later`,
    );
  }
  return (fair * (10_000n - bound)) / 10_000n;
}
