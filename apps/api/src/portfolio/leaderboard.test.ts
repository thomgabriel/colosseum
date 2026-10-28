import type { LeaderboardRow } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { decimalOf, holdingsOf, microOf, pnlOf, ranked, shortOwner } from './leaderboard';

// The leaderboard's arithmetic and its order, without a database: what a vault made, as a share of
// what went in, and where each kind of row stands.

type Unranked = Omit<LeaderboardRow, 'rank'>;

const SOURCED = {
  source: 'test',
  method: 'test',
  fetchedAt: '2026-10-28T12:00:00.000Z',
  provenance: 'sandbox' as const,
};

/** A row with a value and, where `made` is given, a figure for what it made. */
function row(
  address: string,
  valueUsd: string | null,
  made?: { usd: string; pct: number | null },
): Unranked {
  return {
    chain: 'solana',
    address,
    name: null,
    owner: 'Abcd…wxyz',
    holdings: [],
    value: valueUsd === null ? null : { usd: valueUsd, ...SOURCED },
    pnl: made
      ? {
          ...made,
          netInUsd: '0.00',
          depositsUsd: '0.00',
          withdrawalsUsd: '0.00',
          unvaluedWithdrawals: 0,
          ...SOURCED,
        }
      : null,
    noPnl: made ? null : valueUsd === null ? 'never_read' : 'no_deposit_record',
    follows: null,
  };
}

describe('dollars as exact decimals', () => {
  it('reads and writes millionths of a dollar with no float in between', () => {
    expect(microOf('100')).toBe(100_000_000n);
    expect(microOf('0.000001')).toBe(1n);
    expect(microOf('-12.5')).toBe(-12_500_000n);
    // past the sixth place is dropped, never rounded up
    expect(microOf('1.0000009')).toBe(1_000_000n);
    expect(decimalOf(100_000_000n)).toBe('100.00');
    expect(decimalOf(1n)).toBe('0.000001');
    expect(decimalOf(-1_250_000n)).toBe('-1.25');
    expect(decimalOf(0n)).toBe('0.00');
  });
});

describe('what a vault made', () => {
  it('is its value less deposits less withdrawals, and that over what went in', () => {
    // $1,000 in, $200 out, worth $900: it made $100 on the $800 left in.
    expect(pnlOf({ valueUsd: '900.00', depositsUsd: '1000', withdrawalsUsd: '200' })).toEqual({
      usd: '100.00',
      pct: 0.125,
      netInUsd: '800.00',
    });
    // A loss is negative, in dollars and as a share.
    expect(pnlOf({ valueUsd: '95.50', depositsUsd: '100.00', withdrawalsUsd: '0.00' })).toEqual({
      usd: '-4.50',
      pct: -0.045,
      netInUsd: '100.00',
    });
  });

  it('has no share where nothing is left in, or more was taken out than put in', () => {
    expect(pnlOf({ valueUsd: '10.00', depositsUsd: '100', withdrawalsUsd: '100' })).toEqual({
      usd: '10.00',
      pct: null,
      netInUsd: '0.00',
    });
    expect(pnlOf({ valueUsd: '0', depositsUsd: '100', withdrawalsUsd: '150' }).pct).toBeNull();
  });
});

describe('the order of the rows', () => {
  it('ranks by share made, then by dollars made; then rows with no share; then rows with no figure', () => {
    const rows = [
      row('a-no-deposit-rich', '1000000.00'),
      row('b-never-read', null),
      row('c-small-share', '110.00', { usd: '10.00', pct: 0.1 }),
      row('d-big-share', '150.00', { usd: '50.00', pct: 0.5 }),
      row('e-same-share-more-dollars', '1100.00', { usd: '100.00', pct: 0.1 }),
      row('f-loss', '90.00', { usd: '-10.00', pct: -0.1 }),
      row('g-nothing-left-in', '20.00', { usd: '20.00', pct: null }),
      row('h-no-deposit-poor', '5.00'),
    ];
    const order = ranked(rows);
    expect(order.map((r) => r.address)).toEqual([
      'd-big-share',
      'e-same-share-more-dollars',
      'c-small-share',
      'f-loss',
      'g-nothing-left-in',
      'a-no-deposit-rich',
      'h-no-deposit-poor',
      'b-never-read',
    ]);
    expect(order.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('puts full ties in order by address, so an answer is always the same', () => {
    const same = { usd: '1.00', pct: 0.01 };
    expect(ranked([row('z', '101', same), row('m', '101', same)]).map((r) => r.address)).toEqual([
      'm',
      'z',
    ]);
  });
});

describe('what a vault holds', () => {
  it('lists its positions and its cash by share, largest first', () => {
    expect(
      holdingsOf({
        valueUsd: '1000.00',
        cash: { asset: 'solana:usdc' },
        positions: [
          { asset: 'solana:nvda', weightBps: 3000 },
          { asset: 'solana:spy', weightBps: 5000 },
          // a holding with no price weighs nothing and is not listed
          { asset: 'solana:gold', weightBps: 0 },
        ],
      }),
    ).toEqual([
      { asset: 'solana:spy', weightBps: 5000 },
      { asset: 'solana:nvda', weightBps: 3000 },
      { asset: 'solana:usdc', weightBps: 2000 },
    ]);
  });

  it('lists nothing for a vault worth nothing', () => {
    expect(holdingsOf({ valueUsd: '0.00', cash: { asset: 'solana:usdc' }, positions: [] })).toEqual(
      [],
    );
  });
});

describe('the owner', () => {
  it('is the short form of the wallet', () => {
    expect(shortOwner('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe('9xQe…VFin');
  });
});
