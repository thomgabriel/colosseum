// What the trades of one transaction may sell. The vault runs a step's swaps in the order they are
// written (`_swapAll`), and the whole step passes or fails together: a trade sells what the vault held
// before the step, less what earlier trades of it sold, plus what they brought in.

type Selling = { sell: string; buy: string; amountInRaw: string };

/**
 * The first trade that sells more than the vault has by its turn, or null when every trade is
 * covered. `held` is what the vault holds now, by asset; `received[i]` is what trade `i` is quoted to
 * bring in. A sale's cash is counted at its quote: the simulation of the built transaction, and the
 * chain itself, still refuse a step whose sale lands under what the purchase after it spends.
 *
 * Not at the sale's stated minimum, which is all the bytes guarantee: a purchase that takes all its
 * sale brings in may sit above the minimum and still land at about the quote, and held to the minimum
 * such a step would be refused. Orders made since #307 cap their purchases at what the sales' minimums
 * cover, so they pass either way (tests/evm-vault/funds-at-minimum.test.ts).
 */
export function firstShort(
  trades: readonly Selling[],
  held: ReadonlyMap<string, bigint>,
  received: readonly bigint[],
): { index: number; asset: string; held: bigint } | null {
  const now = new Map(held);
  for (const [index, t] of trades.entries()) {
    const has = now.get(t.sell) ?? 0n;
    const sells = BigInt(t.amountInRaw);
    if (has < sells) return { index, asset: t.sell, held: has };
    now.set(t.sell, has - sells);
    now.set(t.buy, (now.get(t.buy) ?? 0n) + (received[index] ?? 0n));
  }
  return null;
}
