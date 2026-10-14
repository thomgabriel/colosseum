import { type Leg, OrderDetail } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import {
  changeFigures,
  changeHero,
  depositPicture,
  orderCosts,
  readDollars,
  shareItems,
  stepWordsOf,
  withdrawLeast,
  withdrawPicture,
} from './order-summary';
import { ORDER_ID, orderOn } from './test/fixtures';
import type { ChainUnits } from './units';

// The plain words of the order screen, one screen at a time (gate SIGN-ONE-STEP): what changes and
// its worst case in a sentence, each step by what it does, and a button that names the step and its
// amount. The case Thom sent on Oct 13 is the first: a change of targets whose second step spends
// 1,354.139432 of cash on GOOGLx for at least 3.768519 of it.

const en = dictionary('en');
const pt = dictionary('pt');
const CASH = 'solana:usdc';
const GOOGL = 'solana:googlx';
const TSLA = 'solana:tslax';
const SPY = 'solana:spyx';
const units: ChainUnits = {
  cash: CASH,
  tokens: {
    [CASH]: { symbol: 'USDC', decimals: 6 },
    [GOOGL]: { symbol: 'GOOGLx', decimals: 8 },
    [TSLA]: { symbol: 'TSLAx', decimals: 8 },
    [SPY]: { symbol: 'SPYx', decimals: 8 },
  },
};
const words = { units, t: en, locale: 'en' };

const base = {
  orderId: ORDER_ID,
  chain: 'solana',
  signer: 'owner',
  description: 'server text',
  attempt: 0,
  txId: null,
  explorerUrl: null,
  validUntil: null,
  error: null,
  trigger: 'manual',
  provenance: 'sandbox',
  status: 'planned',
  trades: [],
  expected: [],
} as const;

const order = (legs: Partial<Leg>[], depositRaw?: string) =>
  OrderDetail.parse({
    id: ORDER_ID,
    type: depositRaw ? 'buy' : 'rebalance',
    owner: { solana: 'So11111111111111111111111111111111111111112' },
    summary: 'server text',
    ...(depositRaw ? { depositRaw } : {}),
    legs: legs.map((leg, i) => ({ ...base, id: `leg-${i}`, seq: i, kind: 'swap', ...leg })),
    warnings: [],
    needsConsent: [],
    fees: [],
    preparedBy: 'app',
    status: 'open',
    approvalUrl: `/orders/${ORDER_ID}`,
    expiresAt: 1_791_200_000,
    createdAt: '2026-10-05T12:00:00.000Z',
    attempts: [],
    disclaimer: 'the disclaimer',
  });

// The screenshot's order: new targets, then one swap into GOOGLx.
const googl = {
  trades: [{ sell: CASH, buy: GOOGL, amountInRaw: '1354139432' }],
  expected: [{ inRaw: '1354139432', outRaw: '380658486', minOutRaw: '376851901', costBps: 10 }],
};
const retarget = order([{ kind: 'set_targets' }, googl]);

describe('each step, by what it does', () => {
  it('names the screenshot’s steps for the strip, the card and the button', () => {
    const [targets, swap] = stepWordsOf(retarget, words);
    expect(targets).toEqual({
      name: 'Set targets',
      title: 'Set your vault’s new targets on chain',
      press: 'Sign: set the new targets',
      hero: 'New targets',
    });
    // the amount large, what it may give up small under it
    expect(swap).toEqual({
      name: 'Swap',
      title: 'Swap $1,354 of cash for GOOGLx',
      press: 'Sign: swap $1,354 for GOOGLx',
      hero: '$1,354 → GOOGLx',
      // what it may give up, the least cut down, never rounded up
      least: '3.76 GOOGLx',
      under: '1%',
    });
  });

  it('names several swaps by what each sells or receives, and says a sale with its amount', () => {
    const two = order([{ trades: [{ sell: TSLA, buy: CASH, amountInRaw: '50000000' }] }, googl]);
    const [sale, swap] = stepWordsOf(two, words);
    // the strip tells them apart by what each sells or receives
    expect(sale?.name).toBe('Sell TSLAx');
    expect(sale?.title).toBe('Sell 0.5 TSLAx');
    expect(sale?.press).toBe('Sign: sell 0.5 TSLAx');
    expect(swap?.name).toBe('Swap to GOOGLx');
  });

  it('says a deposit with its amount, and the swap that rides in it', () => {
    const [open, swap] = stepWordsOf(orderOn('solana'), words);
    expect(open).toMatchObject({
      name: 'Deposit',
      title: 'Open your vault and deposit $10',
      press: 'Sign: deposit $10',
    });
    expect(swap?.title).toBe('Swap $6 of cash for SPYx');
    // on an EVM chain the deposit is allowed first; with no units for the cash, no amount is made
    // up, and each step is still named
    const evm = stepWordsOf(orderOn('robinhood'), { units: null, t: en, locale: 'en' });
    const allow = evm.find((w) => w.name === en.order.flow.short.approve);
    expect(allow?.title).toBe(en.order.kind.approve);
    expect(allow?.press).toBe(en.order.flow.press.step);
    expect(evm.some((w) => w.name === en.order.flow.short.deposit)).toBe(true);
  });

  it('says a step that only opens the vault as that', () => {
    const [open] = stepWordsOf(order([{ kind: 'create_vault' }]), words);
    expect(open).toMatchObject({ name: 'Open vault', title: 'Open your vault' });
  });

  it('says a withdrawal with what leaves, all of a token where no amount is named', () => {
    const out = order([
      {
        kind: 'withdraw',
        withdrawals: [
          { asset: TSLA, amountRaw: '25000000', heldRaw: '50000000' },
          { asset: CASH, amountRaw: null, heldRaw: '100000000' },
        ],
      },
    ]);
    const [step] = stepWordsOf(out, words);
    expect(step?.title).toBe('Send 0.25 TSLAx and all of your USDC to your own wallet');
    expect(step?.press).toBe('Sign: withdraw 0.25 TSLAx and all of your USDC');
    // with the token's multiplier at the review, as the withdraw screen showed it
    const [shown] = stepWordsOf(out, { ...words, multipliers: { [TSLA]: '2' } });
    expect(shown?.title).toContain('0.5 TSLAx');
  });
});

describe('the picture of what changes', () => {
  it('lists the targets before beside the targets after, with cash last', () => {
    const items = shareItems(
      [{ asset: GOOGL, weightBps: 6000 }],
      [
        { asset: TSLA, weightBps: 5000 },
        { asset: GOOGL, weightBps: 2500 },
      ],
      words,
    );
    expect(items.map((x) => [x.name, x.beforeBps, x.bps])).toEqual([
      ['TSLAx', 5000, 0],
      ['GOOGLx', 2500, 6000],
      ['Cash', 2500, 4000],
    ]);
    // nothing before is known (the order's own page): the new targets alone
    expect(shareItems([{ asset: GOOGL, weightBps: 3333 }], null, words)).toEqual([
      { key: GOOGL, name: 'GOOGLx', asset: GOOGL, bps: 3333 },
      { key: 'cash', name: 'Cash', cash: true, bps: 6667 },
    ]);
  });

  it('says a change of targets in a few words', () => {
    const before = [
      { asset: SPY, weightBps: 6000 },
      { asset: TSLA, weightBps: 4000 },
    ];
    expect(
      changeHero(
        [
          { asset: SPY, weightBps: 7000 },
          { asset: TSLA, weightBps: 3000 },
        ],
        before,
        words,
      ),
    ).toBe('More SPYx, less TSLAx');
    expect(changeHero([{ asset: SPY, weightBps: 6000 }], before, words)).toBe('Less TSLAx');
    expect(changeHero(before, before, words)).toBe('New targets');
    expect(changeHero(before, null, words)).toBe('New targets');
    expect(
      changeHero([{ asset: SPY, weightBps: 9000 }], before, { units, t: pt, locale: 'pt-BR' }),
    ).toBe('Mais SPYx, menos TSLAx');
  });

  it('says where a deposit goes, and the cash that stays', () => {
    const picture = depositPicture(orderOn('solana'), words);
    expect(picture?.caption).toBe('Where your $10 goes');
    expect(picture?.rows.map((r) => [r.name, r.cells[0]?.shown])).toEqual([
      ['SPYx', '$6'],
      ['Cash', '$4'],
    ]);
    expect(depositPicture(retarget, words)).toBeNull();
  });

  it('says a withdrawal as what goes to the owner’s wallet, and the least it pays where it sells first', () => {
    const inKind = order([
      {
        kind: 'withdraw',
        withdrawals: [
          { asset: TSLA, amountRaw: '25000000', heldRaw: '50000000' },
          { asset: CASH, amountRaw: null, heldRaw: '100000000' },
        ],
      },
    ]);
    // nothing is sold: nothing is swapped, so there is no cost to say
    expect(orderCosts(inKind, words)).toBeNull();
    const inDollars = order([
      {
        trades: [{ sell: TSLA, buy: CASH, amountInRaw: '50000000' }],
        expected: [{ inRaw: '50000000', outRaw: '400000000', minOutRaw: '396000000', costBps: 0 }],
      },
      {
        kind: 'withdraw',
        withdrawals: [
          { asset: CASH, amountRaw: null, heldRaw: '600000000', leastRaw: '996000000' },
        ],
      },
    ]);
    expect(orderCosts(inDollars, words)?.swapped.shown).toBe('$400');
    expect(withdrawLeast(inDollars, words)).toEqual({ shown: '$996', exact: '$996.00' });
  });

  it('lists what a withdrawal takes out', () => {
    const out = order([
      {
        kind: 'withdraw',
        withdrawals: [{ asset: TSLA, amountRaw: null, heldRaw: '123456789' }],
      },
    ]);
    const picture = withdrawPicture(out, words);
    expect(picture.rows).toEqual([
      { key: TSLA, name: 'TSLAx', cells: [{ shown: 'All of it', exact: '1.23456789 TSLAx' }] },
    ]);
  });
});

describe('a least in dollars', () => {
  it('is cut down everywhere it is said: the picture, the step and its button', () => {
    const out = order([
      {
        trades: [{ sell: TSLA, buy: CASH, amountInRaw: '50000000' }],
        expected: [{ inRaw: '50000000', outRaw: '400000000', minOutRaw: '395678900', costBps: 0 }],
      },
      {
        kind: 'withdraw',
        withdrawals: [
          { asset: CASH, amountRaw: null, heldRaw: '600000000', leastRaw: '996700000' },
        ],
      },
    ]);
    expect(withdrawLeast(out, words)).toEqual({ shown: '$996', exact: '$996.70' });
    // the picture is what is sold for it, in its own units
    expect(withdrawPicture(out, words).rows).toEqual([
      { key: TSLA, name: 'TSLAx', cells: [{ shown: '0.5 TSLAx', exact: '0.5 TSLAx' }] },
    ]);
    const [sale, cash] = stepWordsOf(out, words);
    expect(sale?.least).toBe('$395');
    expect(sale?.under).toBe('1.09%');
    expect(cash?.press).toBe('Sign: withdraw at least $996');
    expect(cash?.title).not.toContain('$997');
    // under $100, to the cent below
    const small = order([
      {
        kind: 'withdraw',
        withdrawals: [{ asset: CASH, amountRaw: null, heldRaw: '1', leastRaw: '5678900' }],
      },
    ]);
    expect(stepWordsOf(small, words)[0]?.press).toBe('Sign: withdraw at least $5.67');
  });
});

describe('what a change of targets trades', () => {
  const holds = [
    { asset: SPY, weightBps: 6000 },
    { asset: TSLA, weightBps: 4000 },
  ];
  const after = [
    { asset: SPY, weightBps: 7000 },
    { asset: TSLA, weightBps: 3000 },
  ];
  it('says the dollars swapped and the worst they cost, the cost rounded up', () => {
    expect(changeFigures(after, holds, 99.9, words)).toEqual({
      swapped: { shown: '$19.98', exact: '$19.98' },
      worst: { shown: '$0.20', exact: '$0.20' },
      pct: '1%',
    });
  });
  it('says nothing where nothing moves or what the vault holds is not known', () => {
    expect(changeFigures(holds, holds, 99.9, words)).toBeNull();
    expect(changeFigures(after, null, 99.9, words)).toBeNull();
  });
});

describe('what an order’s trades come to', () => {
  it('reads the same figures in Portuguese', () => {
    const pt$ = orderCosts(order([googl]), { units, t: pt, locale: 'pt-BR' });
    expect(pt$?.swapped.shown).toContain('1.354');
    expect(pt$?.worst?.shown).toContain('13,55');
  });

  it('says what changes hands, the quote’s own cost and the most the minimum gives up, rounded up', () => {
    // $1,354.139432 spent on GOOGLx: the quote costs 0.1% ($1.3541…), its minimum 1% less GOOGLx
    expect(orderCosts(order([googl]), words)).toEqual({
      swapped: { shown: '$1,354', exact: '$1,354.13' },
      expected: { shown: '$1.36', exact: '$1.36' },
      worst: { shown: '$13.55', exact: '$13.55' },
    });
  });

  it('counts a sale by the cash it brings in, and its shortfall in cash', () => {
    const sale = {
      trades: [{ sell: TSLA, buy: CASH, amountInRaw: '50000000' }],
      expected: [{ inRaw: '50000000', outRaw: '200000000', minOutRaw: '198000000', costBps: 0 }],
    };
    expect(orderCosts(order([sale]), words)).toEqual({
      swapped: { shown: '$200', exact: '$200.00' },
      expected: { shown: '$0', exact: '$0.00' },
      worst: { shown: '$2', exact: '$2.00' },
    });
  });

  it('says nothing where nothing is traded for cash, or the cash’s units are not known', () => {
    const swapOnly = { trades: [{ sell: TSLA, buy: GOOGL, amountInRaw: '50000000' }] };
    expect(orderCosts(order([swapOnly]), words)).toBeNull();
    expect(orderCosts(order([googl]), { ...words, units: null })).toBeNull();
  });

  it('says what changes hands, but no cost, where a trade has no quote', () => {
    const unquoted = { trades: [{ sell: CASH, buy: GOOGL, amountInRaw: '10000000' }] };
    expect(orderCosts(order([unquoted]), words)).toEqual({
      swapped: { shown: '$10', exact: '$10.00' },
      expected: null,
      worst: null,
    });
  });
});

describe('dollars to read', () => {
  it('rounds to whole dollars from $100, and keeps the cents under it', () => {
    expect(readDollars(1354.139432, 'en')).toBe('$1,354');
    expect(readDollars(97.951023, 'en')).toBe('$97.95');
    expect(readDollars(10, 'en')).toBe('$10');
    // cut down, never rounded up
    expect(readDollars(996.7, 'en')).toBe('$996');
    expect(readDollars(5.678, 'en')).toBe('$5.67');
    expect(readDollars(99.999, 'en')).toBe('$99.99');
  });
});
