import { describe, expect, it } from 'vitest';
import { en } from '../../i18n/en';
import {
  dollarsShapeOk,
  rebalanceShapeOk,
  retargetShapeOk,
  sharedShapeOk,
  stepCalls,
} from './order-check';

// A step on Robinhood Chain may make several of the vault's calls in one transaction (gate
// EVM-MULTICALL-STEPS): a switch of auto-follow beside a version, a sale or a withdrawal, and the
// trades toward new targets. What the order check offers for signing, and what each step is called.

const CASH = 'robinhood:usdg';
const SPY = 'robinhood:spy';
const NVDA = 'robinhood:nvda';
type Shape = Record<string, unknown>;
const leg = (seq: number, kind: string, more: Shape = {}) => ({
  id: `l${seq}`,
  seq,
  kind,
  trades: [],
  expected: [],
  ...more,
});
const order = (...legs: Shape[]) => ({ legs, warnings: [] }) as never;
const withdrawTerms = (autoFollowOff: boolean, dollars?: Shape) =>
  ({
    kind: 'withdraw',
    vault: '0xv',
    basketId: '7',
    owner: '0xo',
    everything: false,
    items: dollars ? [{ asset: CASH, amountRaw: null }] : [{ asset: SPY, amountRaw: null }],
    autoFollowOff,
    ...(dollars ? { dollars } : {}),
  }) as never;
const out = (asset: string, more: Shape = {}) => ({
  asset,
  amountRaw: null,
  heldRaw: '1',
  ...more,
});

describe('a step that makes several of the vault calls at once', () => {
  it('is called by what it does', () => {
    const k = en.order.kind;
    expect(stepCalls(leg(0, 'set_targets', { trades: [{}] }) as never, k)).toBe(k.set_targets_swap);
    expect(stepCalls(leg(0, 'set_targets') as never, k)).toBeNull();
    expect(stepCalls(leg(0, 'accept_version', { switchAutoFollow: true }) as never, k)).toBe(
      k.accept_version_on,
    );
    expect(stepCalls(leg(0, 'accept_version', { switchAutoFollow: false }) as never, k)).toBe(
      k.accept_version_off,
    );
    expect(stepCalls(leg(0, 'swap', { switchAutoFollow: false }) as never, k)).toBe(k.swap_off);
    expect(stepCalls(leg(0, 'withdraw', { switchAutoFollow: false }) as never, k)).toBe(
      k.withdraw_off,
    );
    expect(stepCalls(leg(0, 'accept_version') as never, k)).toBeNull();
  });

  it('a withdrawal switches off where its review said: a step of its own, or beside the first, never both', () => {
    const terms = withdrawTerms(true);
    const taking = { withdrawals: [out(SPY)] };
    expect(
      sharedShapeOk(order(leg(0, 'withdraw', { ...taking, switchAutoFollow: false })), terms),
    ).toBe(true);
    expect(sharedShapeOk(order(leg(0, 'set_auto_follow'), leg(1, 'withdraw', taking)), terms)).toBe(
      true,
    );
    // both, or none where the review said there is one, or one where it said none
    expect(
      sharedShapeOk(
        order(
          leg(0, 'set_auto_follow'),
          leg(1, 'withdraw', { ...taking, switchAutoFollow: false }),
        ),
        terms,
      ),
    ).toBe(false);
    expect(sharedShapeOk(order(leg(0, 'withdraw', taking)), terms)).toBe(false);
    expect(
      sharedShapeOk(
        order(leg(0, 'withdraw', { ...taking, switchAutoFollow: false })),
        withdrawTerms(false),
      ),
    ).toBe(false);
  });

  it('a follow switches beside the version only the way its review set auto-follow', () => {
    const follow = { recipeOnchainId: '0xr', version: 2 };
    const terms = (autoFollow: boolean) =>
      ({
        kind: 'follow',
        slug: 's',
        familyId: 'f',
        vault: '0xv',
        basketId: '7',
        follow,
        autoFollow,
        source: 'chain',
      }) as never;
    const accept = (switchAutoFollow?: boolean) =>
      leg(0, 'accept_version', switchAutoFollow === undefined ? {} : { switchAutoFollow });
    expect(sharedShapeOk(order(accept(true)), terms(true))).toBe(true);
    expect(sharedShapeOk(order(accept(false)), terms(false))).toBe(true);
    expect(sharedShapeOk(order(accept(true)), terms(false))).toBe(false);
    expect(sharedShapeOk(order(accept(true), leg(1, 'set_auto_follow')), terms(true))).toBe(false);
    expect(
      sharedShapeOk(order(leg(0, 'set_auto_follow', { switchAutoFollow: true })), terms(true)),
    ).toBe(false);
  });

  it('a withdrawal in dollars switches off beside its first sale, or beside its cash step when it sells nothing', () => {
    const dollars = { shareBps: 10_000, sales: [{ asset: SPY, amountRaw: '5' }], cashRaw: '100' };
    const sale = {
      trades: [{ sell: SPY, buy: CASH, amountInRaw: '5' }],
      expected: [{ inRaw: '5', outRaw: '100', minOutRaw: '99', costBps: 0 }],
    };
    const cashOut = (more: Shape = {}) =>
      leg(1, 'withdraw', {
        withdrawals: [out(CASH, { leastRaw: '199', mostRaw: '203' })],
        ...more,
      });
    const terms = withdrawTerms(true, dollars);
    expect(
      dollarsShapeOk(
        order(leg(0, 'swap', { ...sale, switchAutoFollow: false }), cashOut()),
        terms,
        {
          cash: CASH,
        },
      ),
    ).toBe(true);
    // the switch riding in the cash step after a sale: not where it goes
    expect(
      dollarsShapeOk(order(leg(0, 'swap', sale), cashOut({ switchAutoFollow: false })), terms, {
        cash: CASH,
      }),
    ).toBe(false);
    const none = withdrawTerms(true, { ...dollars, sales: [] });
    expect(
      dollarsShapeOk(
        order({
          ...cashOut({ switchAutoFollow: false }),
          seq: 0,
          withdrawals: [out(CASH, { leastRaw: '100', mostRaw: '100' })],
        }),
        none,
        { cash: CASH },
      ),
    ).toBe(true);
  });

  it('new targets carry their first trades, each toward a target or cash, each with its minimum', () => {
    const terms = {
      kind: 'retarget',
      vault: '0xv',
      basketId: '7',
      targets: [{ asset: NVDA, weightBps: 10_000 }],
      origin: 'person',
    } as never;
    const trades = [
      { sell: SPY, buy: CASH, amountInRaw: '5' },
      { sell: CASH, buy: NVDA, amountInRaw: '9' },
    ];
    const expected = trades.map(() => ({ inRaw: '1', outRaw: '1', minOutRaw: '1', costBps: 0 }));
    const units = { cash: CASH };
    expect(retargetShapeOk(order(leg(0, 'set_targets', { trades, expected })), terms, units)).toBe(
      true,
    );
    // a purchase of no target, a trade with no minimum, a switch riding along
    expect(
      retargetShapeOk(
        order(
          leg(0, 'set_targets', {
            trades: [{ sell: CASH, buy: SPY, amountInRaw: '1' }],
            expected: [expected[0]],
          }),
        ),
        terms,
        units,
      ),
    ).toBe(false);
    expect(retargetShapeOk(order(leg(0, 'set_targets', { trades })), terms, units)).toBe(false);
    expect(
      retargetShapeOk(
        order(leg(0, 'set_targets', { trades, expected, switchAutoFollow: false })),
        terms,
        units,
      ),
    ).toBe(false);
  });

  it('a rebalance throws no switch', () => {
    const terms = { kind: 'rebalance', targets: [{ asset: NVDA, weightBps: 10_000 }] } as never;
    const trades = [{ sell: CASH, buy: NVDA, amountInRaw: '9' }];
    const expected = [{ inRaw: '9', outRaw: '1', minOutRaw: '1', costBps: 0 }];
    expect(
      rebalanceShapeOk(order(leg(0, 'swap', { trades, expected })), terms, { cash: CASH }),
    ).toBe(true);
    expect(
      rebalanceShapeOk(
        order(leg(0, 'swap', { trades, expected, switchAutoFollow: false })),
        terms,
        {
          cash: CASH,
        },
      ),
    ).toBe(false);
  });
});
