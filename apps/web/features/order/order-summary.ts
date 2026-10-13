import type { Leg, OrderDetail, Trade, TradeExpected } from '@colosseum/schemas';
import type { Dictionary } from '../../i18n';
import { formatBps, formatRaw, shortfallBps, shownRaw, tokenName } from './amounts';
import { legsInOrder } from './order-view';
import type { ChainUnits } from './units';

// What the order screen says in plain words, one screen at a time (gate SIGN-ONE-STEP): before the
// first signature, what changes and what it may cost at worst in one sentence; while signing, each
// step by what it does ("Swap $1,354 of cash for GOOGLx") and a button that names it with its amount.
// Figures are rounded for reading and never in the person's favour: a least amount is cut down, never
// rounded up. Each keeps its exact value beside it, for the hover and for the details. Pure: every
// word is the dictionary's, every figure the order's own read with the units this repository committed.

/** A figure as it is read, and exactly. */
export type Figure = { shown: string; exact: string };

/** What words are worked out with. */
export type SummaryWords = {
  units: ChainUnits | null;
  t: Dictionary;
  locale: string;
  /** For a withdrawal: each token's multiplier at the review, which its amounts are shown with. */
  multipliers?: Readonly<Record<string, string>>;
};

const listOf = (names: readonly string[], locale: string) =>
  new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);

/** Dollars to read: whole from $100 up, cents under it. */
export function readDollars(value: number, locale: string): string {
  const whole = Math.abs(value) >= 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole || Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(value);
}

/** Dollars in full, to the cent. */
const exactDollars = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

/**
 * How many places a raw amount is read with: two from one whole token up, else three significant
 * figures. Cut, never rounded (formatRaw), so a least amount read is never more than the least.
 */
function placesOf(raw: string, decimals: number): number {
  if (!/^\d+$/.test(raw) || decimals === 0) return 0;
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  if (BigInt(whole) > 0n) return Math.min(2, decimals);
  const fraction = padded.slice(padded.length - decimals);
  const zeros = fraction.length - fraction.replace(/^0+/, '').length;
  return Math.min(decimals, zeros + 3);
}

/** The words a summary is made with, bound to one order's units and language. */
function reader({ units, t, locale, multipliers }: SummaryWords) {
  const cash = units?.cash ?? null;
  const unitsOf = (asset: string) => units?.tokens[asset];
  const symbol = (asset: string) => unitsOf(asset)?.symbol ?? tokenName(asset);
  /** A raw amount of cash as dollars, or null where the cash token's units are not known. */
  const usd = (raw: string): number | null => {
    const u = cash ? unitsOf(cash) : undefined;
    return u && /^\d+$/.test(raw) ? Number(raw) / 10 ** u.decimals : null;
  };
  const money = (raw: string): Figure | null => {
    const value = usd(raw);
    return value === null
      ? null
      : { shown: readDollars(value, locale), exact: exactDollars(value, locale) };
  };
  /** A raw amount of a token with its symbol, shown with its multiplier where a withdrawal has one. */
  const tokens = (raw: string, asset: string): Figure | null => {
    const u = unitsOf(asset);
    if (!u || !/^\d+$/.test(raw)) return null;
    const read = shownRaw(BigInt(raw), multipliers?.[asset] ?? '1').toString();
    const shown = formatRaw(read, u.decimals, locale, placesOf(read, u.decimals));
    const exact = formatRaw(read, u.decimals, locale, u.decimals);
    return shown === null || exact === null
      ? null
      : { shown: `${shown} ${u.symbol}`, exact: `${exact} ${u.symbol}` };
  };
  /** Cash read as dollars, any other token as itself. */
  const amount = (raw: string, asset: string): Figure | null =>
    asset === cash ? money(raw) : tokens(raw, asset);
  return { cash, symbol, usd, money, tokens, amount, t, locale };
}
type Reader = ReturnType<typeof reader>;

/** The trades of an order, each with its quote where it has one. */
function tradesOf(legs: readonly Leg[]): { trade: Trade; expected: TradeExpected | undefined }[] {
  return legs.flatMap((leg) =>
    leg.trades.map((trade, i) => ({ trade, expected: leg.expected[i] })),
  );
}

const sumRaw = (raws: readonly string[]) =>
  raws.reduce((n, raw) => n + (/^\d+$/.test(raw) ? BigInt(raw) : 0n), 0n).toString();

/**
 * At worst, in one sentence: what the one trade receives at its least and how far under the quote,
 * or, for several, how far under the quote the worst of them may land. Null where no trade is quoted.
 */
function worstOf(
  trades: readonly { trade: Trade; expected: TradeExpected | undefined }[],
  r: Reader,
): string | null {
  const w = r.t.order.flow.worst;
  const quoted = trades.filter(
    (x): x is { trade: Trade; expected: TradeExpected } => x.expected !== undefined,
  );
  if (quoted.length === 0) return null;
  const gaps = quoted.map((x) => shortfallBps(x.expected.outRaw, x.expected.minOutRaw));
  if (gaps.some((gap) => gap === null)) return null;
  const pct = formatBps(Math.max(...(gaps as number[])), r.locale);
  const [one] = quoted;
  if (quoted.length === 1 && trades.length === 1 && one) {
    const least = r.amount(one.expected.minOutRaw, one.trade.buy);
    if (least) return w.one(least.shown, pct);
  }
  return w.each(pct);
}

/** One step, said to the person signing it. */
export type StepWords = {
  /** The step's name in the progress strip: "Set targets", "Swap". */
  name: string;
  /** What it does, in plain words: "Swap $1,354 of cash for GOOGLx". */
  title: string;
  /** What the button that signs it says: "Sign: swap $1,354 for GOOGLx". */
  press: string;
  /** What it may give up at worst, where it trades: "At worst you get 3.76 GOOGLx, 1% under today's price." */
  worst: string | null;
};

/** The parts of a step that trades: sales of what the vault holds, then cash spent. */
function tradeParts(leg: Leg, r: Reader): { title: string[]; press: string[] } {
  const f = r.t.order.flow;
  const spends = leg.trades.filter((x) => r.cash === null || x.sell === r.cash);
  const sells = leg.trades.filter((x) => r.cash !== null && x.sell !== r.cash);
  const title: string[] = [];
  const press: string[] = [];
  if (sells.length > 0) {
    const sold = sells.map((x) => r.tokens(x.amountInRaw, x.sell)?.shown ?? r.symbol(x.sell));
    title.push(f.title.sell(listOf(sold, r.locale)));
    press.push(f.press.sell(listOf(sold, r.locale)));
  }
  if (spends.length > 0) {
    const into = listOf([...new Set(spends.map((x) => r.symbol(x.buy)))], r.locale);
    const spent = r.money(sumRaw(spends.map((x) => x.amountInRaw)));
    title.push(spent ? f.title.swap(spent.shown, into) : f.title.swapInto(into));
    press.push(spent ? f.press.swap(spent.shown, into) : f.press.swapInto(into));
  }
  return { title, press };
}

/** The tokens a withdraw step sends to the owner, each read for the person. */
function withdrawn(leg: Leg, r: Reader): string[] {
  return (leg.withdrawals ?? []).map((w) => {
    const least = w.leastRaw;
    if (least !== undefined) {
      const at = r.amount(least, w.asset);
      return r.t.order.flow.atLeast(at?.shown ?? r.symbol(w.asset));
    }
    if (w.amountRaw === null) return r.t.order.flow.allOf(r.symbol(w.asset));
    return r.amount(w.amountRaw, w.asset)?.shown ?? r.symbol(w.asset);
  });
}

/** Every step of an order in plain words, with the name the progress strip gives it. */
export function stepWordsOf(order: Pick<OrderDetail, 'legs'>, words: SummaryWords): StepWords[] {
  const r = reader(words);
  const f = r.t.order.flow;
  const legs = legsInOrder(order);
  const swaps = legs.filter((leg) => leg.kind === 'swap').length;
  let swap = 0;
  return legs.map((leg) => {
    const trades = tradesOf([leg]);
    const worst = worstOf(trades, r);
    const deposit = leg.cashRaw ? r.money(leg.cashRaw) : null;
    const parts = tradeParts(leg, r);
    const fallback = r.t.order.kind[leg.kind];
    switch (leg.kind) {
      case 'approve':
        return {
          name: f.short.approve,
          title: deposit ? f.title.approve(deposit.shown) : fallback,
          press: deposit ? f.press.approve(deposit.shown) : f.press.step,
          worst: null,
        };
      case 'create_vault':
      case 'deposit': {
        // A step that opens the vault and moves no cash: one only opens it (EVM, before the approval).
        if (!leg.cashRaw)
          return {
            name: f.short.open,
            title: f.title.open,
            press: f.press.open,
            worst: null,
          };
        const opens = leg.kind === 'create_vault';
        // no units for the cash: the step is named, and no amount is made up
        const head = !deposit
          ? fallback
          : opens
            ? f.title.openDeposit(deposit.shown)
            : f.title.deposit(deposit.shown);
        const button = deposit ? f.press.deposit(deposit.shown) : f.press.step;
        const then = parts.title.length > 0 ? f.andThen(head, listOf(parts.title, r.locale)) : head;
        return { name: f.short.deposit, title: then, press: button, worst };
      }
      case 'swap': {
        swap += 1;
        const name = swaps > 1 ? f.short.swapN(swap) : f.short.swap;
        if (parts.title.length === 0) return { name, title: fallback, press: f.press.step, worst };
        return {
          name,
          title: capitalise(listOf(parts.title, r.locale), r.locale),
          press: f.press.of(listOf(parts.press, r.locale)),
          worst,
        };
      }
      case 'set_targets':
        return {
          name: f.short.targets,
          title: f.title.targets,
          press: f.press.targets,
          worst: null,
        };
      case 'accept_version':
        return {
          name: f.short.version,
          title: f.title.version,
          press: f.press.version,
          worst: null,
        };
      case 'set_auto_follow':
        return {
          name: f.short.autoFollow,
          title: fallback,
          press: f.press.autoFollow,
          worst: null,
        };
      case 'withdraw': {
        const what = listOf(withdrawn(leg, r), r.locale);
        return {
          name: f.short.withdraw,
          title: f.title.withdraw(what),
          press: f.press.withdraw(what),
          worst: null,
        };
      }
      case 'publish':
        return {
          name: f.short.publish,
          title: f.title.publish,
          press: f.press.publish,
          worst: null,
        };
      default:
        return { name: fallback, title: fallback, press: f.press.step, worst };
    }
  });
}

const capitalise = (text: string, locale: string) =>
  text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
const lowerFirst = (text: string, locale: string) =>
  text.charAt(0).toLocaleLowerCase(locale) + text.slice(1);

/** One row of the picture of what changes. */
export type PictureRow = {
  key: string;
  name: string;
  /** One figure a column; null where the column has nothing for this row (an asset new to the vault). */
  cells: (Figure | null)[];
};

/** What changes, as one compact table: a name and one or two columns. */
export type Picture = {
  caption: string;
  columns: string[];
  rows: PictureRow[];
};

const share = (bps: number, locale: string): Figure => ({
  shown: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    bps / 10_000,
  ),
  exact: formatBps(bps, locale),
});

/**
 * Targets before and after: every asset either names, then cash, with what is left of 100% on each
 * side. `before` is left out where the screen does not know the vault (the order's own page): the
 * picture is then the new targets alone.
 */
export function targetsPicture(
  after: readonly { asset: string; weightBps: number }[],
  before: readonly { asset: string; weightBps: number }[] | null,
  words: SummaryWords,
  labels: { caption: string; before: string; after: string },
): Picture {
  const r = reader(words);
  const assets = [
    ...new Set([...(before ?? []).map((x) => x.asset), ...after.map((x) => x.asset)]),
  ].filter((asset) => asset !== r.cash);
  const of = (list: readonly { asset: string; weightBps: number }[], asset: string) =>
    list.find((x) => x.asset === asset)?.weightBps ?? 0;
  const left = (list: readonly { weightBps: number }[]) =>
    Math.max(0, 10_000 - list.reduce((n, x) => n + x.weightBps, 0));
  const cell = (list: readonly { asset: string; weightBps: number }[] | null, asset: string) =>
    list === null ? null : share(of(list, asset), r.locale);
  const rows: PictureRow[] = assets.map((asset) => ({
    key: asset,
    name: r.symbol(asset),
    cells: before === null ? [cell(after, asset)] : [cell(before, asset), cell(after, asset)],
  }));
  const cashBefore = before === null ? 0 : left(before);
  const cashAfter = left(after);
  if (cashBefore > 0 || cashAfter > 0)
    rows.push({
      key: 'cash',
      name: r.t.order.flow.picture.cash,
      cells:
        before === null
          ? [share(cashAfter, r.locale)]
          : [share(cashBefore, r.locale), share(cashAfter, r.locale)],
    });
  return {
    caption: labels.caption,
    columns: before === null ? [labels.after] : [labels.before, labels.after],
    rows,
  };
}

/**
 * Where a deposit goes: each asset its trades spend on, with what is spent, and the cash that stays.
 * Null where the order deposits nothing or the cash token's units are not known.
 */
export function depositPicture(
  order: Pick<OrderDetail, 'legs' | 'depositRaw'>,
  words: SummaryWords,
): Picture | null {
  const r = reader(words);
  const f = r.t.order.flow.picture;
  const deposit = order.depositRaw ? r.money(order.depositRaw) : null;
  if (!deposit || r.cash === null) return null;
  const spends = tradesOf(legsInOrder(order)).filter((x) => x.trade.sell === r.cash);
  const by = new Map<string, string[]>();
  for (const { trade } of spends)
    by.set(trade.buy, [...(by.get(trade.buy) ?? []), trade.amountInRaw]);
  const rows: PictureRow[] = [...by].map(([asset, raws]) => ({
    key: asset,
    name: r.symbol(asset),
    cells: [r.money(sumRaw(raws))],
  }));
  const spent = BigInt(sumRaw(spends.map((x) => x.trade.amountInRaw)));
  const stays = BigInt(order.depositRaw as string) - spent;
  if (stays > 0n) rows.push({ key: 'cash', name: f.cash, cells: [r.money(stays.toString())] });
  return { caption: f.deposit(deposit.shown), columns: [f.amount], rows };
}

/** What a withdrawal takes out, each token with its amount, for the owner's own wallet. */
export function withdrawPicture(order: Pick<OrderDetail, 'legs'>, words: SummaryWords): Picture {
  const r = reader(words);
  const f = r.t.order.flow.picture;
  const rows: PictureRow[] = legsInOrder(order).flatMap((leg) =>
    (leg.withdrawals ?? []).map((w) => {
      const least = w.leastRaw;
      const raw = least ?? w.amountRaw;
      const figure = raw === null ? null : r.amount(raw, w.asset);
      return {
        key: w.asset,
        name: r.symbol(w.asset),
        cells: [
          raw === null
            ? { shown: f.all, exact: r.amount(w.heldRaw, w.asset)?.exact ?? f.all }
            : least !== undefined && figure
              ? { shown: r.t.order.flow.atLeast(figure.shown), exact: figure.exact }
              : figure,
        ],
      };
    }),
  );
  return { caption: f.withdraw, columns: [f.amount], rows };
}

/**
 * What the order does to the person's money, and what it may cost at worst, in at most two
 * sentences: "About $1,354 of cash goes into GOOGLx. At worst you get 3.76 GOOGLx, 1% under today's
 * price." A deposit says the deposit first; an order that trades nothing says so.
 */
export function costSentence(
  order: Pick<OrderDetail, 'legs' | 'depositRaw'>,
  words: SummaryWords,
): string {
  const r = reader(words);
  const s = r.t.order.flow.sentence;
  const trades = tradesOf(legsInOrder(order));
  const spends = trades.filter((x) => r.cash === null || x.trade.sell === r.cash);
  const sells = trades.filter((x) => r.cash !== null && x.trade.sell !== r.cash);
  const into = listOf([...new Set(spends.map((x) => r.symbol(x.trade.buy)))], r.locale);
  const spent = r.money(sumRaw(spends.map((x) => x.trade.amountInRaw)));
  const sold = listOf([...new Set(sells.map((x) => r.symbol(x.trade.sell)))], r.locale);
  // what the sales bring in, at the quote: "about"
  const brings = r.money(
    sumRaw(sells.filter((x) => x.trade.buy === r.cash).map((x) => x.expected?.outRaw ?? '0')),
  );
  const deposit = order.depositRaw ? r.money(order.depositRaw) : null;
  // a withdrawal: what leaves for the owner's wallet, and the least it pays where it sells first
  const out = legsInOrder(order).flatMap((leg) => leg.withdrawals ?? []);
  const least = out.find((w) => w.leastRaw !== undefined);
  const parts: string[] = [];
  if (out.length > 0) {
    if (sells.length > 0) parts.push(brings ? s.sell(brings.shown, sold) : s.sellSome(sold));
    const receives = least?.leastRaw ? r.amount(least.leastRaw, least.asset) : null;
    parts.push(
      receives
        ? s.receive(receives.shown)
        : s.withdraw(listOf([...new Set(out.map((w) => r.symbol(w.asset)))], r.locale)),
    );
  } else if (deposit)
    parts.push(
      spends.length === 0
        ? s.depositCash(deposit.shown)
        : spent
          ? s.depositSwap(deposit.shown, spent.shown, into)
          : s.depositInto(deposit.shown, into),
    );
  else {
    if (sells.length > 0)
      parts.push(
        brings && brings.exact !== exactDollars(0, r.locale)
          ? s.sell(brings.shown, sold)
          : s.sellSome(sold),
      );
    if (spends.length > 0) parts.push(spent ? s.spend(spent.shown, into) : s.spendSome(into));
    if (parts.length === 0) parts.push(s.noTrade);
  }
  const [first = s.noTrade, second] = parts;
  const head = second ? s.and(first.replace(/\.$/, ''), lowerFirst(second, r.locale)) : first;
  // a withdrawal that sells says its least already: what reaches the wallet
  const worst = least ? null : worstOf(trades, r);
  return worst ? `${head} ${worst}` : head;
}
