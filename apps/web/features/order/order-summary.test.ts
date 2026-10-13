import { type Leg, OrderDetail } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import {
  costSentence,
  depositPicture,
  readDollars,
  stepWordsOf,
  targetsPicture,
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

describe('what an order does, in one sentence', () => {
  it('says the screenshot’s change as Thom asked for it, the least cut down, never rounded up', () => {
    expect(costSentence(retarget, words)).toBe(
      'About $1,354 of cash goes into GOOGLx. At worst you get 3.76 GOOGLx, 1% under today’s price.',
    );
  });

  it('says sales and purchases together, and the worst of several swaps', () => {
    const both = order([
      {
        trades: [
          { sell: TSLA, buy: CASH, amountInRaw: '139142021' },
          { sell: CASH, buy: GOOGL, amountInRaw: '97951023' },
        ],
        expected: [
          { inRaw: '139142021', outRaw: '499900029', minOutRaw: '494901029', costBps: 0 },
          { inRaw: '97951023', outRaw: '27762323', minOutRaw: '27207076', costBps: 0 },
        ],
      },
    ]);
    expect(costSentence(both, words)).toBe(
      'About $500 of TSLAx is sold for cash, and about $97.95 of cash goes into GOOGLx. At worst each swap lands 2% under today’s price.',
    );
  });

  it('says a deposit first, and what of it is swapped', () => {
    expect(costSentence(orderOn('solana'), words)).toBe(
      'Your $10 goes into your vault, and about $6 of it into SPYx. At worst you get 0.0099 SPYx, 1% under today’s price.',
    );
    const cash = order([{ kind: 'deposit', cashRaw: '250000000' }], '250000000');
    expect(costSentence(cash, words)).toBe('Your $250 goes into your vault as cash.');
  });

  it('says so when nothing is swapped, and gives no worst case where no swap is quoted', () => {
    expect(costSentence(order([{ kind: 'set_targets' }]), words)).toBe(
      'Nothing is swapped in this order.',
    );
    const unquoted = order([{ trades: googl.trades, expected: [] }]);
    expect(costSentence(unquoted, words)).toBe('About $1,354 of cash goes into GOOGLx.');
  });

  it('says it in Portuguese with the same figures', () => {
    const said = costSentence(retarget, { units, t: pt, locale: 'pt-BR' });
    expect(said).toContain('1.354');
    expect(said).toContain('3,76 GOOGLx');
    expect(said).toContain('1%');
  });

  it('names no token by its smallest units where this app has none for it', () => {
    const said = costSentence(retarget, { units: null, t: en, locale: 'en' });
    expect(said).not.toContain('1354139432');
    expect(said).not.toContain('376851901');
  });
});

describe('each step, by what it does', () => {
  it('names the screenshot’s steps for the strip, the card and the button', () => {
    const [targets, swap] = stepWordsOf(retarget, words);
    expect(targets).toEqual({
      name: 'Set targets',
      title: 'Set your vault’s new targets on chain',
      press: 'Sign: set the new targets',
      worst: null,
    });
    expect(swap).toEqual({
      name: 'Swap',
      title: 'Swap $1,354 of cash for GOOGLx',
      press: 'Sign: swap $1,354 for GOOGLx',
      worst: 'At worst you get 3.76 GOOGLx, 1% under today’s price.',
    });
  });

  it('numbers the swaps when there are several, and says a sale with its amount', () => {
    const two = order([{ trades: [{ sell: TSLA, buy: CASH, amountInRaw: '50000000' }] }, googl]);
    const [sale, swap] = stepWordsOf(two, words);
    expect(sale?.name).toBe('Swap 1');
    expect(sale?.title).toBe('Sell 0.5 TSLAx');
    expect(sale?.press).toBe('Sign: sell 0.5 TSLAx');
    expect(swap?.name).toBe('Swap 2');
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
  it('sets the targets before beside the targets after, with cash last', () => {
    const picture = targetsPicture(
      [{ asset: GOOGL, weightBps: 6000 }],
      [
        { asset: TSLA, weightBps: 5000 },
        { asset: GOOGL, weightBps: 2500 },
      ],
      words,
      { caption: 'c', before: 'Now', after: 'New' },
    );
    expect(picture.columns).toEqual(['Now', 'New']);
    expect(picture.rows.map((r) => [r.name, ...r.cells.map((c) => c?.shown)])).toEqual([
      ['TSLAx', '50%', '0%'],
      ['GOOGLx', '25%', '60%'],
      ['Cash', '25%', '40%'],
    ]);
  });

  it('shows the new targets alone where the vault is not known, the exact share on hover', () => {
    const picture = targetsPicture([{ asset: GOOGL, weightBps: 3333 }], null, words, {
      caption: 'c',
      before: 'Now',
      after: 'New',
    });
    expect(picture.columns).toEqual(['New']);
    expect(picture.rows[0]?.cells[0]).toEqual({ shown: '33%', exact: '33.33%' });
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
    expect(costSentence(inKind, words)).toBe(
      'To your own wallet: TSLAx and USDC. Nothing is sold.',
    );
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
    expect(costSentence(inDollars, words)).toBe(
      'About $400 of TSLAx is sold for cash, and you receive at least $996 in your own wallet.',
    );
    expect(withdrawPicture(inDollars, words).rows).toEqual([
      { key: CASH, name: 'USDC', cells: [{ shown: 'at least $996', exact: '$996.00' }] },
    ]);
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

describe('dollars to read', () => {
  it('rounds to whole dollars from $100, and keeps the cents under it', () => {
    expect(readDollars(1354.139432, 'en')).toBe('$1,354');
    expect(readDollars(97.951023, 'en')).toBe('$97.95');
    expect(readDollars(10, 'en')).toBe('$10');
  });
});
