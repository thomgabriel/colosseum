import type { Dictionary, Lang } from '../../i18n';
import { dollars, parseNumber } from '../goal/sheet';

// What an amount typed on the amount card is, and what is wrong with it, in the card's own quiet
// words ("At least $10", "More than your balance"). Pure, so the words a person reads for each case
// are held by a test. The card says a problem only once the amount has been still for a moment; this
// says what the problem is.

export type AmountBounds = {
  /** The least one deposit or withdrawal may be, in dollars. */
  least: number;
  /** The most, in dollars. */
  most: number;
  /** What there is to spend or take, in dollars: the wallet's balance, or the vault's value. Null: not read. */
  available: number | null;
  /** What `available` is: the wallet's balance on a deposit, the vault on a withdrawal. */
  of: 'balance' | 'vault';
};

export type AmountRead = {
  /** The amount in dollars, when it is one within the bounds; null otherwise. */
  amount: number | null;
  /** What to change, in the card's words; null when nothing is wrong or nothing is typed. */
  problem: string | null;
  /** The amount is more than `available`. */
  over: boolean;
};

export function readAmount(
  text: string,
  lang: Lang,
  bounds: AmountBounds,
  t: Pick<Dictionary, 'amount'>,
): AmountRead {
  const e = t.amount.errors;
  if (!text.trim()) return { amount: null, problem: null, over: false };
  const typed = parseNumber(text, lang);
  if (typed === null || Number.isNaN(typed))
    return { amount: null, problem: e.notAmount, over: false };
  if (typed < bounds.least)
    return { amount: null, problem: e.belowMin(dollars(bounds.least, lang)), over: false };
  if (typed > bounds.most)
    return { amount: null, problem: e.aboveMax(dollars(bounds.most, lang)), over: false };
  const over = bounds.available !== null && typed > bounds.available;
  return {
    amount: typed,
    problem: over ? (bounds.of === 'vault' ? e.overVault : e.overBalance) : null,
    over,
  };
}

/**
 * What "Max" types: the whole of what is there, down to the cent and never above it, written the way
 * the field reads it back in the page's language ("1234.56", "1234,56"), with no grouping.
 */
export function maxText(available: number, lang: Lang): string {
  const cents = Math.floor(available * 100 + 1e-6);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  if (rest === 0) return String(whole);
  return `${whole}${lang === 'pt' ? ',' : '.'}${String(rest).padStart(2, '0')}`;
}

/**
 * A balance as the card shows it: cut down to the cent, never rounded up, so typing the figure as it
 * is shown is never more than there is.
 */
export function shownBalance(amount: number, symbol: string, locale: string): string {
  const cut = Math.floor(amount * 100 + 1e-6) / 100;
  return `${cut.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
}
