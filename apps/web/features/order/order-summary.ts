import type { Leg, OrderDetail, Trade, TradeExpected } from '@colosseum/schemas';
import type { Dictionary } from '../../i18n';
import { formatBps, formatRaw, shortfallBps, shownRaw, tokenName } from './amounts';
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

// The steps in order, as order-view.ts sorts them: not imported from there, whose types reach the
// runner, since a change's review (ChangeReview, on the /targets route) reads these words too.
const legsInOrder = (order: Pick<OrderDetail, 'legs'>): Leg[] =>
  [...order.legs].sort((a, b) => a.seq - b.seq);

const listOf = (names: readonly string[], locale: string) =>
  new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);

/** Dollars to read: whole from $100 up, cents under it, cut down and never rounded up. */
export function readDollars(value: number, locale: string): string {
  const whole = Math.abs(value) >= 100;
  // to the cent first, as a count of cents, so a float's last digit is not taken for a cent
  const cut = whole ? Math.floor(value) : Math.floor(Math.round(value * 1e6) / 1e4) / 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole || Number.isInteger(cut) ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cut);
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
  /**
   * A raw amount of cash as dollars, cut down to the cent and never rounded up: whole dollars from
   * $100, cents under it, and the cents on hover. Null where the cash token's units are not known.
   */
  const money = (raw: string): Figure | null => {
    const u = cash ? unitsOf(cash) : undefined;
    if (!u || !/^\d+$/.test(raw)) return null;
    const cents = (BigInt(raw) * 100n) / 10n ** BigInt(u.decimals);
    const exact = exactDollars(Number(cents) / 100, locale);
    return {
      shown:
        cents >= 10_000n ? readDollars(Number(cents / 100n), locale) : exact.replace(/[.,]00$/, ''),
      exact,
    };
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
  return { cash, symbol, money, tokens, amount, t, locale };
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
 * At worst: what the one trade receives at its least and how far under the quote, or, for several,
 * how far under the quote the worst of them may land, as a sentence and as the step's small line.
 * Null where no trade is quoted.
 */
function worstOf(
  trades: readonly { trade: Trade; expected: TradeExpected | undefined }[],
  r: Reader,
): { sentence: string; note: string } | null {
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
    if (least)
      return {
        sentence: w.one(least.shown, pct),
        note: r.t.order.flow.note.least(least.shown, pct),
      };
  }
  return { sentence: w.each(pct), note: w.each(pct) };
}

/** One step, said to the person signing it. */
export type StepWords = {
  /** The step's name in the progress strip: "Set targets", "Swap". */
  name: string;
  /** What it does, in plain words: "Swap $1,354 of cash for GOOGLx". */
  title: string;
  /** What the button that signs it says: "Sign: swap $1,354 for GOOGLx". */
  press: string;
  /** The step's one large line: "$1,354 → GOOGLx", "Set the new targets". */
  hero: string;
  /** Small under it, where the step trades: "at least 3.76 GOOGLx · 1% under today's price". */
  note: string | null;
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
  const withdraws = legs.filter((leg) => leg.kind === 'withdraw').length;
  const of = (assets: string[]) => listOf([...new Set(assets.map(r.symbol))], r.locale);
  let swap = 0;
  return legs.map((leg): StepWords => {
    const at = worstOf(tradesOf([leg]), r);
    const worst = at?.sentence ?? null;
    const note = at?.note ?? null;
    const deposit = leg.cashRaw ? r.money(leg.cashRaw) : null;
    const parts = tradeParts(leg, r);
    const fallback = r.t.order.kind[leg.kind];
    const plain = (name: string, title: string, press: string): StepWords => ({
      name,
      title,
      press,
      hero: title,
      note: null,
      worst: null,
    });
    switch (leg.kind) {
      case 'approve':
        return {
          ...plain(
            f.short.approve,
            deposit ? f.title.approve(deposit.shown) : fallback,
            deposit ? f.press.approve(deposit.shown) : f.press.step,
          ),
          hero: deposit ? f.hero.allow(deposit.shown) : fallback,
        };
      case 'create_vault':
      case 'deposit': {
        // A step that opens the vault and moves no cash: one only opens it (EVM, before the approval).
        if (!leg.cashRaw) return plain(f.short.open, f.title.open, f.press.open);
        const opens = leg.kind === 'create_vault';
        // no units for the cash: the step is named, and no amount is made up
        const head = !deposit
          ? fallback
          : opens
            ? f.title.openDeposit(deposit.shown)
            : f.title.deposit(deposit.shown);
        return {
          name: f.short.deposit,
          title: parts.title.length > 0 ? f.andThen(head, listOf(parts.title, r.locale)) : head,
          press: deposit ? f.press.deposit(deposit.shown) : f.press.step,
          hero: deposit ? f.hero.arrow(deposit.shown, f.hero.yourVault) : head,
          note,
          worst,
        };
      }
      case 'swap': {
        swap += 1;
        // Several swaps are told apart by what they sell or receive: "Sell SPY", "GOOGLx".
        const sells = leg.trades.every((x) => r.cash !== null && x.buy === r.cash);
        const buys = leg.trades.every((x) => r.cash === null || x.sell === r.cash);
        const name =
          swaps === 1 || leg.trades.length === 0
            ? swaps > 1
              ? f.short.swapN(swap)
              : f.short.swap
            : sells
              ? f.short.sell(of(leg.trades.map((x) => x.sell)))
              : buys
                ? of(leg.trades.map((x) => x.buy))
                : f.short.swapN(swap);
        if (parts.title.length === 0) return { ...plain(name, fallback, f.press.step), worst };
        const title = capitalise(listOf(parts.title, r.locale), r.locale);
        const spent = buys ? r.money(sumRaw(leg.trades.map((x) => x.amountInRaw))) : null;
        const sold = sells
          ? listOf(
              leg.trades.map((x) => r.tokens(x.amountInRaw, x.sell)?.shown ?? r.symbol(x.sell)),
              r.locale,
            )
          : null;
        return {
          name,
          title,
          press: f.press.of(listOf(parts.press, r.locale)),
          hero: spent
            ? f.hero.arrow(spent.shown, of(leg.trades.map((x) => x.buy)))
            : sold
              ? f.hero.arrow(sold, f.hero.cash)
              : title,
          note,
          worst,
        };
      }
      case 'set_targets':
        return {
          ...plain(f.short.targets, f.title.targets, f.press.targets),
          hero: f.hero.targets,
        };
      case 'accept_version':
        return plain(f.short.version, f.title.version, f.press.version);
      case 'set_auto_follow':
        return plain(f.short.autoFollow, fallback, f.press.autoFollow);
      case 'withdraw': {
        const what = listOf(withdrawn(leg, r), r.locale);
        // several are told apart by what each takes out: "SPY", "NVDA"
        const name =
          withdraws > 1 ? of((leg.withdrawals ?? []).map((w) => w.asset)) : f.short.withdraw;
        return {
          ...plain(name, f.title.withdraw(what), f.press.withdraw(what)),
          hero: f.hero.arrow(capitalise(what, r.locale), f.hero.yourWallet),
        };
      }
      case 'publish':
        return plain(f.short.publish, f.title.publish, f.press.publish);
      default:
        return { ...plain(fallback, fallback, f.press.step), worst };
    }
  });
}

/**
 * A change of targets in a few words: "More SPY, less NVDA". The assets whose share goes up, then
 * those whose share goes down (cash is the rest, and is not named); "New targets" where neither is
 * known or nothing moves.
 */
export function changeHero(
  after: readonly { asset: string; weightBps: number }[],
  before: readonly { asset: string; weightBps: number }[] | null,
  words: SummaryWords,
): string {
  const r = reader(words);
  const h = r.t.order.flow.hero;
  if (!before) return h.targets;
  const assets = [...new Set([...before, ...after].map((x) => x.asset))].filter(
    (asset) => asset !== r.cash,
  );
  const share = (list: readonly { asset: string; weightBps: number }[], asset: string) =>
    list.find((x) => x.asset === asset)?.weightBps ?? 0;
  const more = assets.filter((a) => share(after, a) > share(before, a)).map(r.symbol);
  const less = assets.filter((a) => share(after, a) < share(before, a)).map(r.symbol);
  const list = (names: string[]) => listOf(names, r.locale);
  if (more.length > 0 && less.length > 0) return h.moreLess(list(more), list(less));
  if (more.length > 0) return h.more(list(more));
  if (less.length > 0) return h.less(list(less));
  return h.targets;
}

/** One holding of a picture of targets, in the shape the shared composition takes. */
export type ShareItem = {
  key: string;
  name: string;
  asset?: string;
  cash?: boolean;
  /** The share after, in basis points. */
  bps: number;
  /** The share before; left out where the holding is new, or nothing before is known. */
  beforeBps?: number;
};

/**
 * Targets before and after as one list: every asset either names, in the order the vault had them
 * and then the new ones, then cash with what is left of 100% on each side.
 */
export function shareItems(
  after: readonly { asset: string; weightBps: number }[],
  before: readonly { asset: string; weightBps: number }[] | null,
  words: SummaryWords,
): ShareItem[] {
  const r = reader(words);
  const assets = [...new Set([...(before ?? []), ...after].map((x) => x.asset))].filter(
    (asset) => asset !== r.cash,
  );
  const of = (list: readonly { asset: string; weightBps: number }[], asset: string) =>
    list.find((x) => x.asset === asset)?.weightBps;
  const left = (list: readonly { weightBps: number }[]) =>
    Math.max(0, 10_000 - list.reduce((n, x) => n + x.weightBps, 0));
  const items: ShareItem[] = assets.map((asset) => {
    const was = before ? (of(before, asset) ?? 0) : undefined;
    return {
      key: asset,
      name: r.symbol(asset),
      asset,
      bps: of(after, asset) ?? 0,
      ...(was !== undefined && was > 0 ? { beforeBps: was } : {}),
    };
  });
  const cashBefore = before ? left(before) : 0;
  const cashAfter = left(after);
  if (cashBefore > 0 || cashAfter > 0)
    items.push({
      key: 'cash',
      name: r.t.order.flow.picture.cash,
      cash: true,
      bps: cashAfter,
      ...(before && cashBefore > 0 ? { beforeBps: cashBefore } : {}),
    });
  return items;
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
  // In dollars: what is sold, each holding with its amount; the least that leaves is the large line.
  const sales = legsInOrder(order).flatMap((leg) =>
    leg.trades.filter((x) => r.cash !== null && x.buy === r.cash && x.sell !== r.cash),
  );
  if (sales.length > 0)
    return {
      caption: f.sold,
      columns: [f.amount],
      rows: sales.map((x) => ({
        key: x.sell,
        name: r.symbol(x.sell),
        cells: [r.tokens(x.amountInRaw, x.sell)],
      })),
    };
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

/** The least a withdrawal in dollars pays into the owner's wallet, cut down; null for one in tokens. */
export function withdrawLeast(
  order: Pick<OrderDetail, 'legs'>,
  words: SummaryWords,
): Figure | null {
  const r = reader(words);
  const w = legsInOrder(order)
    .flatMap((leg) => leg.withdrawals ?? [])
    .find((x) => x.leastRaw !== undefined);
  return w?.leastRaw ? r.amount(w.leastRaw, w.asset) : null;
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
    // the screen's large line says the least that leaves: the sentence says what is sold for it
    if (sells.length > 0) parts.push(brings ? s.sell(brings.shown, sold) : s.sellSome(sold));
    else parts.push(s.withdraw);
  } else if (deposit)
    parts.push(
      // the screen's large line says the deposit: the sentence says where it goes
      spends.length === 0
        ? s.depositCash(deposit.shown)
        : spent
          ? s.spend(spent.shown, into)
          : s.spendSome(into),
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
  const worst = least ? null : (worstOf(trades, r)?.sentence ?? null);
  return worst ? `${head} ${worst}` : head;
}
