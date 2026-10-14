import { Order } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { apiDouble } from '../../test/api-double';
import { refusalOf } from '../../test/bites';
import { mockWorld } from '../../test/mock';
import { approvedSteps } from './approved';
import type { PlanTerms } from './types';

// The order the review screen showed, as what each of its steps may sign.

async function bought(chain: 'solana' | 'robinhood') {
  const w = mockWorld(chain);
  const double = apiDouble(w);
  const order = await double.buy(1000);
  return { w, double, order };
}

describe('the approved steps of an order', () => {
  it('a first buy on an EVM chain: the vault opens empty, then the approval and the deposit are about the cash, said once each', async () => {
    const { w, double, order } = await bought('robinhood');
    // What the double answers is an order the shared type takes.
    expect(Order.safeParse(order).success).toBe(true);
    const steps = approvedSteps(order, double.plan, w.deployment);
    // Gate CREATE-BEFORE-APPROVE: the approval names a vault that is there.
    expect(steps.map((s) => s.kind)).toEqual(['create_vault', 'approve', 'deposit']);
    const [create, approve, deposit] = steps;
    expect(create).toMatchObject({
      depositRaw: '0',
      trades: [],
      targets: double.plan.targets,
      follow: null,
      autoFollow: false,
    });
    expect(approve).toMatchObject({ amountRaw: '1000000000', owner: w.owner, basketId: '9001' });
    expect(deposit).toMatchObject({ amountRaw: '1000000000', basketId: '9001' });
    // The trades spend what the plan invests, 95%, and each carries the minimum the order showed.
    if (deposit?.kind !== 'deposit') throw new Error('a deposit');
    expect(deposit.trades.reduce((n, t) => n + BigInt(t.inRaw), 0n)).toBe(950_000_000n);
    expect(deposit.trades.map((t) => t.minOutRaw)).toEqual(
      order.legs[2]?.expected.map((e) => e.minOutRaw),
    );
  });

  it('where the order has an approval, the vault is opened before it and opened empty', async () => {
    // Gate CREATE-BEFORE-APPROVE: an approval names a vault that is there. The client holds the order
    // to that, whatever the API plans.
    const { w, double, order } = await bought('robinhood');
    const [create, approve, deposit] = order.legs;
    if (!create || !approve || !deposit) throw new Error('three steps');
    const refused = (legs: unknown[]) =>
      refusalOf(() => approvedSteps({ ...order, legs } as never, double.plan, w.deployment));
    // The approval first, then the empty create, then the deposit.
    const early = refused([
      { ...approve, seq: 0 },
      { ...create, seq: 1 },
      { ...deposit, seq: 2 },
    ]);
    expect([early?.code, early?.legId]).toEqual(['order', approve.id]);
    // The shape before the gate: the approval, then a create that takes the cash it approves.
    const old = refused([
      { ...approve, seq: 0 },
      { ...deposit, kind: 'create_vault', seq: 1 },
    ]);
    expect(old?.code).toBe('order');
    // A create that takes the cash after its approval: the cash goes in as the vault is made, to an
    // address that had no code when it was approved.
    expect(
      refused([
        { ...create, seq: 0 },
        { ...approve, seq: 1 },
        { ...deposit, kind: 'create_vault', seq: 2 },
      ])?.code,
    ).toBe('order');
    // As the API plans it: passes.
    expect(refused(order.legs)).toBeNull();
  });

  it('a buy on Solana: the create carries the cash, and each trade is a step of its own', async () => {
    const { w, double, order } = await bought('solana');
    const steps = approvedSteps(order, double.plan, w.deployment);
    expect(steps.map((s) => [s.kind, s.legId])).toEqual(order.legs.map((l) => [l.kind, l.id]));
    expect(steps[0]).toMatchObject({ kind: 'create_vault', depositRaw: '1000000000', trades: [] });
    expect(steps[1]).toMatchObject({
      kind: 'swap',
      trades: [{ buy: 'solana:spy', inRaw: '500000000' }],
    });
  });

  it('takes the steps in the order they are signed, whatever order they come in', async () => {
    const { w, double, order } = await bought('solana');
    const shuffled = { ...order, legs: [...order.legs].reverse() };
    expect(approvedSteps(shuffled, double.plan, w.deployment).map((s) => s.legId)).toEqual(
      order.legs.map((l) => l.id),
    );
  });

  it('a plan that is all cash opens a vault with no targets, when the plan says so', async () => {
    const { w, double, order } = await bought('solana');
    const create = { ...order, legs: order.legs.slice(0, 1) };
    const allCash: PlanTerms = { basketId: '1', targets: [] };
    expect(approvedSteps(create, allCash, w.deployment)[0]).toMatchObject({
      targets: [],
      follow: null,
    });
    // Nothing said about targets is not the same as none.
    expect(refusalOf(() => approvedSteps(create, { basketId: '1' }, w.deployment))?.code).toBe(
      'order',
    );
    const follows: PlanTerms = {
      basketId: '1',
      follow: { recipeOnchainId: 'r', version: 2 },
      autoFollow: true,
    };
    expect(approvedSteps(create, follows, w.deployment)[0]).toMatchObject({
      targets: [],
      follow: follows.follow,
      autoFollow: true,
    });
    expect(double.plan.targets?.length).toBe(3);
  });

  it('refuses an order that cannot mean what it says', async () => {
    const { w, double, order } = await bought('robinhood');
    // The approval and the step that moves the cash, with its trades.
    const [, approve, create] = order.legs;
    if (!approve || !create) throw new Error('two steps');
    const cases: [string, object, string][] = [
      ['no steps', { legs: [] }, 'order'],
      ['an owner with no address on the chain', { owner: { solana: w.owner } }, 'order'],
      ['a step on another chain', { legs: [approve, { ...create, chain: 'base' }] }, 'order'],
      ['a step of another order', { legs: [approve, { ...create, orderId: 'x' }] }, 'order'],
      ['two steps in one place', { legs: [approve, { ...create, seq: approve.seq }] }, 'order'],
      ['two steps with one id', { legs: [approve, { ...create, id: approve.id }] }, 'order'],
      [
        'an approval that states no cash',
        { legs: [{ ...approve, cashRaw: undefined }, create] },
        'order',
      ],
      [
        'an approval of nothing',
        {
          depositRaw: '0',
          legs: [
            { ...approve, cashRaw: '0' },
            { ...create, cashRaw: '0' },
          ],
        },
        'order',
      ],
      [
        'a step about more cash than the order deposits',
        { legs: [approve, { ...create, cashRaw: '1000000001' }] },
        'order',
      ],
      ['a trade with no minimum shown', { legs: [approve, { ...create, expected: [] }] }, 'order'],
      [
        'a step the keeper signs',
        { legs: [approve, { ...create, signer: 'keeper' }] },
        'unsupported',
      ],
      ['a keeper step', { legs: [approve, { ...create, kind: 'keeper_leg' }] }, 'unsupported'],
      // Signed since AGT-4, once the screen says what is published: with nothing said, refused.
      [
        'a publish step with no terms',
        { legs: [approve, { ...create, kind: 'publish' }] },
        'order',
      ],
    ];
    for (const [name, change, code] of cases)
      expect(
        refusalOf(() => approvedSteps({ ...order, ...change } as never, double.plan, w.deployment))
          ?.code,
        name,
      ).toBe(code);
  });

  it('an order moves the cash it states, once, and an approval only serves that step', async () => {
    const { w, double, order } = await bought('robinhood');
    const [, approve, deposit] = order.legs;
    if (!approve || !deposit) throw new Error('two steps');
    // A create that carries the cash, as where the chain needs no approval.
    const create = { ...deposit, kind: 'create_vault' as const };
    const refused = (change: object) =>
      refusalOf(() => approvedSteps({ ...order, ...change } as never, double.plan, w.deployment));
    const cases: [string, object][] = [
      // An order that states no deposit moves no cash, whatever its steps say of themselves.
      [
        'no deposit stated, an approval and a deposit at their own figures',
        {
          depositRaw: undefined,
          legs: [
            { ...approve, cashRaw: '999000000' },
            { ...deposit, cashRaw: '5' },
          ],
        },
      ],
      ['no deposit stated, a create that carries cash', { depositRaw: undefined, legs: [create] }],
      [
        'no deposit stated, a deposit',
        { depositRaw: undefined, legs: [{ ...deposit, cashRaw: undefined, seq: 0 }] },
      ],
      [
        'no deposit stated, an approval with no figure',
        { depositRaw: undefined, legs: [{ ...approve, cashRaw: undefined }] },
      ],
      [
        'no deposit stated, cash on a step that moves none',
        { depositRaw: undefined, legs: [{ ...create, kind: 'swap', cashRaw: '7' }] },
      ],
      // An approval is for the step that deposits, and for nothing else.
      ['an approval and no step that deposits', { legs: [approve] }],
      [
        'an approval of nearly everything and no step that deposits',
        {
          depositRaw: ((1n << 255n) - 1n).toString(),
          legs: [{ ...approve, cashRaw: ((1n << 255n) - 1n).toString() }],
        },
      ],
      [
        'an approval after the step it is for',
        {
          legs: [
            { ...create, seq: 0 },
            { ...approve, seq: 1 },
          ],
        },
      ],
      [
        'two approvals',
        { legs: [approve, { ...approve, id: 'another', seq: 5 }, { ...create, seq: 6 }] },
      ],
      [
        'two steps that move the cash',
        { legs: [approve, create, { ...deposit, id: 'another', seq: 3 }] },
      ],
      [
        'a deposit stated and no step that moves it',
        { legs: [{ ...create, kind: 'swap', cashRaw: undefined }] },
      ],
      [
        'a create that carries no cash where the order deposits',
        { legs: [approve, { ...create, cashRaw: undefined }] },
      ],
      [
        'cash on a trade step beside the deposit',
        { legs: [approve, create, { ...create, id: 'another', kind: 'swap', seq: 3 }] },
      ],
    ];
    for (const [name, change] of cases) expect(refused(change)?.code, name).toBe('order');
    // What stands: the order as the API made it, and a create that deposits nothing where none is stated.
    expect(refused({})).toBeNull();
    expect(
      refused({ depositRaw: undefined, legs: [{ ...create, cashRaw: undefined, seq: 0 }] }),
    ).toBeNull();
    expect(
      refused({ depositRaw: undefined, legs: [{ ...create, cashRaw: '0', seq: 0 }] }),
    ).toBeNull();
  });

  it('the other steps take their terms from the plan, and refuse to guess them', async () => {
    const { w, order } = await bought('solana');
    const leg = order.legs[1];
    if (!leg) throw new Error('a step');
    const one = (kind: string) => ({
      ...order,
      depositRaw: undefined,
      legs: [{ ...leg, kind, seq: 0, trades: [], expected: [] }],
    });
    const plan: PlanTerms = {
      basketId: '5',
      targets: [{ asset: 'solana:spy', weightBps: 100 }],
      follow: { recipeOnchainId: 'r', version: 2 },
      autoFollow: true,
      withdrawals: [{ asset: 'solana:spy', amountRaw: null }],
    };
    const stepOf = (kind: string, terms: PlanTerms) =>
      approvedSteps(one(kind) as never, terms, w.deployment)[0];
    expect(stepOf('set_targets', plan)).toMatchObject({ targets: plan.targets });
    expect(stepOf('accept_version', plan)).toMatchObject({ follow: plan.follow });
    expect(stepOf('set_auto_follow', plan)).toMatchObject({ on: true });
    expect(stepOf('withdraw', plan)).toMatchObject({ withdrawals: plan.withdrawals });
    expect(stepOf('withdraw', { basketId: '5' })).toMatchObject({ withdrawals: 'all' });
    for (const kind of ['set_targets', 'accept_version', 'set_auto_follow'])
      expect(refusalOf(() => stepOf(kind, { basketId: '5' }))?.code, kind).toBe('order');
  });

  it('a switch of auto-follow beside a step is the way the review said, and only where it may go (EVM-MULTICALL-STEPS)', async () => {
    const { w, order } = await bought('robinhood');
    const leg = order.legs[2];
    if (!leg) throw new Error('a step');
    const legsOf = (...shapes: object[]) => ({
      ...order,
      depositRaw: undefined,
      legs: shapes.map((shape, seq) => ({
        ...leg,
        cashRaw: undefined,
        seq,
        id: `l${seq}`,
        ...shape,
      })),
    });
    const follow = { recipeOnchainId: `0x${'5a'.repeat(32)}`, version: 2 };
    const steps = (terms: PlanTerms, ...shapes: object[]) =>
      approvedSteps(legsOf(...shapes) as never, terms, w.deployment);
    const refused = (terms: PlanTerms, ...shapes: object[]) =>
      refusalOf(() => steps(terms, ...shapes))?.code;
    const accept = { kind: 'accept_version', trades: [], expected: [] };
    const sale = { kind: 'swap' };
    const out = { kind: 'withdraw', trades: [], expected: [] };

    // as the review said: on after the version, off before it, off before a sale or a withdrawal
    expect(
      steps({ basketId: '5', follow, autoFollow: true }, { ...accept, switchAutoFollow: true })[0],
    ).toMatchObject({ kind: 'accept_version', follow, switchAutoFollow: true });
    expect(
      steps(
        { basketId: '5', follow, autoFollow: false },
        { ...accept, switchAutoFollow: false },
      )[0],
    ).toMatchObject({ switchAutoFollow: false });
    expect(
      steps({ basketId: '5', autoFollow: false }, { ...out, switchAutoFollow: false })[0],
    ).toMatchObject({ kind: 'withdraw', switchAutoFollow: false });
    expect(
      steps({ basketId: '5', autoFollow: false }, { ...sale, switchAutoFollow: false })[0],
    ).toMatchObject({ kind: 'swap', switchAutoFollow: false });
    // none where the step names none
    expect(steps({ basketId: '5', follow, autoFollow: true }, accept)[0]).not.toHaveProperty(
      'switchAutoFollow',
    );

    // the other way from the review, or with nothing in the review about it
    expect(
      refused({ basketId: '5', follow, autoFollow: false }, { ...accept, switchAutoFollow: true }),
    ).toBe('order');
    expect(refused({ basketId: '5', follow }, { ...accept, switchAutoFollow: true })).toBe('order');
    expect(refused({ basketId: '5' }, { ...out, switchAutoFollow: false })).toBe('order');
    // off anywhere but the first step, where something moved before it
    expect(
      refused({ basketId: '5', autoFollow: false }, sale, { ...out, switchAutoFollow: false }),
    ).toBe('order');
    // on beside a sale or a withdrawal, and any switch beside another kind of step
    expect(refused({ basketId: '5', autoFollow: true }, { ...out, switchAutoFollow: true })).toBe(
      'order',
    );
    expect(
      refused(
        { basketId: '5', targets: [{ asset: 'robinhood:spy', weightBps: 100 }], autoFollow: false },
        { kind: 'set_targets', trades: [], expected: [], switchAutoFollow: false },
      ),
    ).toBe('order');
  });
});

// Add money: a buy that names a vault of the person's. Its order is a deposit and its swaps, and the
// terms are the vault's number, from the person's own read of their vaults, with no plan beside it.
describe('the approved steps of an order that adds to a vault', () => {
  async function adding(chain: 'solana' | 'robinhood') {
    const { w, order } = await bought(chain);
    // A first buy on a chain that approves opens its vault empty first: an add has no such step.
    const legs = order.legs
      .filter((l) => l.kind !== 'create_vault' || l.cashRaw !== undefined)
      .map((l) => (l.kind === 'create_vault' ? { ...l, kind: 'deposit' } : l));
    const terms: PlanTerms = { basketId: '424242' };
    return { w, order: { ...order, legs } as typeof order, terms };
  }

  it.each(['solana', 'robinhood'] as const)(
    'on %s holds every step to the vault named and the deposit to the amount reviewed',
    async (chain) => {
      const { w, order, terms } = await adding(chain);
      const steps = approvedSteps(order, terms, w.deployment);
      expect(steps.map((s) => s.kind)).not.toContain('create_vault');
      for (const s of steps) expect(s).toMatchObject({ basketId: '424242', owner: w.owner });
      const deposit = steps.find((s) => s.kind === 'deposit');
      expect(deposit).toMatchObject({ amountRaw: order.depositRaw });
    },
  );

  it('refuses an order whose deposit is not the amount it states: a figure changed after the review', async () => {
    const { w, order, terms } = await adding('solana');
    const changed = (cashRaw: string) => ({
      ...order,
      legs: order.legs.map((l) => (l.kind === 'deposit' ? { ...l, cashRaw } : l)),
    });
    for (const cashRaw of ['1000000001', '999999999', '0'])
      expect(
        refusalOf(() => approvedSteps(changed(cashRaw) as never, terms, w.deployment))?.code,
        cashRaw,
      ).toBe('order');
    // and one that states another deposit than its step moves
    expect(
      refusalOf(() =>
        approvedSteps({ ...order, depositRaw: '5000000000' } as never, terms, w.deployment),
      )?.code,
    ).toBe('order');
  });

  it('refuses one that deposits twice', async () => {
    const { w, order, terms } = await adding('solana');
    const [deposit] = order.legs.filter((l) => l.kind === 'deposit');
    if (!deposit) throw new Error('a deposit');
    const twice = { ...order, legs: [...order.legs, { ...deposit, id: 'again', seq: 99 }] };
    expect(refusalOf(() => approvedSteps(twice as never, terms, w.deployment))?.code).toBe('order');
  });
});

// A rebalance to the targets a vault has: swaps only, every trade through the chain's cash, every
// purchase one of the targets, each with a minimum above zero, and each trade the one reviewed.
describe('the approved steps of a rebalance', () => {
  async function rebalancing(chain: 'solana' | 'robinhood') {
    const { w, order } = await bought(chain);
    const template = order.legs.find((l) => l.kind === 'swap' || l.kind === 'create_vault');
    if (!template) throw new Error('a step');
    const cash = w.deployment.cash;
    const spy = `${chain}:spy`;
    const gold = `${chain}:gold`;
    const swap = (seq: number, sell: string, buy: string, inRaw: string, minOutRaw = '1000') => ({
      ...template,
      id: `leg-${seq}`,
      seq,
      kind: 'swap' as const,
      cashRaw: undefined,
      trades: [{ sell, buy, amountInRaw: inRaw }],
      expected: [{ inRaw, outRaw: '2000', minOutRaw, costBps: 10 }],
    });
    const legs = [swap(0, spy, cash, '300'), swap(1, cash, gold, '400')];
    const rebalance = {
      ...order,
      depositRaw: undefined,
      legs,
    } as unknown as typeof order;
    const terms: PlanTerms = {
      basketId: '42',
      rebalance: {
        targets: [
          { asset: spy, weightBps: 5_000 },
          { asset: gold, weightBps: 5_000 },
        ],
        trades: legs.flatMap((l) => l.trades),
      },
    };
    const refused = (change: (legs: ReturnType<typeof swap>[]) => unknown[], plan = terms) =>
      refusalOf(() =>
        approvedSteps({ ...rebalance, legs: change(legs) } as never, plan, w.deployment),
      )?.code ?? null;
    return { w, cash, spy, gold, swap, legs, rebalance, terms, refused };
  }

  it.each(['solana', 'robinhood'] as const)(
    'on %s signs the reviewed swaps and nothing else',
    async (chain) => {
      const { w, rebalance, terms } = await rebalancing(chain);
      expect(approvedSteps(rebalance, terms, w.deployment).map((s) => s.kind)).toEqual([
        'swap',
        'swap',
      ]);
    },
  );

  it.each(['solana', 'robinhood'] as const)(
    'on %s refuses a withdrawal and a zero minimum riding along (the review of #265)',
    async (chain) => {
      const { swap, cash, gold, refused } = await rebalancing(chain);
      const withdraw = { ...swap(2, cash, gold, '1'), kind: 'withdraw', trades: [], expected: [] };
      expect(refused((legs) => [...legs, withdraw])).toBe('order');
      expect(refused(([a]) => [a, swap(1, cash, gold, '400', '0')])).toBe('order');
    },
  );

  it.each(['solana', 'robinhood'] as const)(
    'on %s refuses any step but a swap, a trade with no cash side, a purchase that is no target, and a trade not as reviewed',
    async (chain) => {
      const { swap, spy, cash, gold, refused, legs } = await rebalancing(chain);
      for (const kind of ['set_targets', 'accept_version', 'set_auto_follow', 'deposit'])
        expect(
          refused((ls) => [...ls, { ...swap(2, cash, gold, '1'), kind, trades: [], expected: [] }]),
          kind,
        ).toBe('order');
      // straight from one asset into another
      expect(refused(([, b]) => [swap(0, spy, gold, '300'), b])).toBe('order');
      // a purchase of something the vault has no target in
      expect(refused(([a]) => [a, swap(1, cash, `${chain}:nvda`, '400')])).toBe('order');
      // another amount than reviewed, and a step the review did not have
      expect(refused(([a]) => [a, swap(1, cash, gold, '401')])).toBe('order');
      expect(refused((ls) => [...ls, swap(2, cash, gold, '5')])).toBe('order');
      // a missing minimum
      expect(refused(([a, b]) => [a, { ...b, expected: [] }])).toBe('order');
      expect(refused(() => legs)).toBeNull();
      // and no withdrawal in dollars rides with a rebalance's terms
      expect(
        refused(() => legs, {
          basketId: '42',
          rebalance: { targets: [{ asset: gold, weightBps: 10_000 }], trades: [] },
          dollars: { cashRaw: '1', sales: [] },
        }),
      ).toBe('order');
    },
  );
});
