import type { LeaderboardRow } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import {
  decimalOf,
  holdingsOf,
  leaderboardSince,
  microOf,
  pnlOf,
  ranked,
  shortOwner,
} from './leaderboard';

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
    goal: null,
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
  it('is its value plus withdrawals less deposits, and that over the deposits', () => {
    // $1,000 in, $200 out, worth $900: it made $100 on the $1,000 deposited.
    expect(pnlOf({ valueUsd: '900.00', depositsUsd: '1000', withdrawalsUsd: '200' })).toEqual({
      usd: '100.00',
      pct: 0.1,
      netInUsd: '800.00',
    });
    // A loss is negative, in dollars and as a share.
    expect(pnlOf({ valueUsd: '95.50', depositsUsd: '100.00', withdrawalsUsd: '0.00' })).toEqual({
      usd: '-4.50',
      pct: -0.045,
      netInUsd: '100.00',
    });
  });

  // Over what is left in, these read +10,000%, −98% and no share at all (gate LEADERBOARD, Oct 28).
  const grewThenOut = { valueUsd: '101.00', depositsUsd: '100', withdrawalsUsd: '99' };
  const fellThenOut = { valueUsd: '1.00', depositsUsd: '100', withdrawalsUsd: '49' };
  const cashedOut = { valueUsd: '10.00', depositsUsd: '100', withdrawalsUsd: '150' };

  it('keeps its share after a withdrawal: the share is of what was deposited', () => {
    // $100 in, grew to $200, $99 taken out: it doubled.
    expect(pnlOf(grewThenOut)).toMatchObject({ usd: '100.00', pct: 1 });
    // $100 in, fell to $50, $49 taken out: it lost half.
    expect(pnlOf(fellThenOut)).toMatchObject({ usd: '-50.00', pct: -0.5 });
    // $100 in, grew to $160, $150 taken out: more out than in, and still its real share.
    expect(pnlOf(cashedOut)).toMatchObject({ usd: '60.00', pct: 0.6, netInUsd: '-50.00' });
  });

  it('ranks those three by their real share', () => {
    const rowOf = (address: string, a: typeof grewThenOut) => {
      const { usd, pct } = pnlOf(a);
      return row(address, a.valueUsd, { usd, pct });
    };
    expect(
      ranked([
        rowOf('fell', fellThenOut),
        rowOf('cashed', cashedOut),
        rowOf('grew', grewThenOut),
      ]).map((r) => r.address),
    ).toEqual(['grew', 'cashed', 'fell']);
  });

  it('has no share only where nothing was deposited', () => {
    expect(pnlOf({ valueUsd: '10.00', depositsUsd: '0', withdrawalsUsd: '0' }).pct).toBeNull();
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

describe('the event window', () => {
  it('is unset by default, and an instant with its zone when set', () => {
    expect(leaderboardSince({})).toBeNull();
    expect(leaderboardSince({ LEADERBOARD_SINCE: '  ' })).toBeNull();
    expect(leaderboardSince({ LEADERBOARD_SINCE: '2026-10-29T12:00:00Z' })?.toISOString()).toBe(
      '2026-10-29T12:00:00.000Z',
    );
    expect(leaderboardSince({ LEADERBOARD_SINCE: '2026-10-29T09:00-03:00' })?.toISOString()).toBe(
      '2026-10-29T12:00:00.000Z',
    );
  });

  it('refuses a date alone, an instant with no zone and anything else, never repeating it', () => {
    for (const bad of ['2026-10-29', '2026-10-29T12:00:00', 'tomorrow', '2026-02-30T25:00:00Z']) {
      expect(() => leaderboardSince({ LEADERBOARD_SINCE: bad })).toThrow(/^LEADERBOARD_SINCE: /);
      try {
        leaderboardSince({ LEADERBOARD_SINCE: bad });
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
      }
    }
  });
});
