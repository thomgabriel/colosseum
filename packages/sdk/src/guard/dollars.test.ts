import { type BuiltTx, type ChainId, type Leg, ORDER_LIMITS, type Order } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { refusalOf } from '../../test/bites';
import { mockWorld, stamped, tampered, usd } from '../../test/mock';
import { approvedSteps, DOLLARS_MARGIN_BPS } from './approved';
import { guardTransaction } from './index';
import { mockVaultAddress } from './mock/check';
import type { PlanTerms } from './types';

vi.mock('./rules', () => import('../../test/rules'));
vi.mock('./generated/deployment-files', () => import('../../test/deployments'));

// A withdrawal in dollars (gate WITHDRAW-DOLLARS), as the guard takes it: sales of the vault's own
// holdings into the vault's cash token, then the cash out to the owner, and nothing else. The order's
// shape is held by `approvedSteps`, each step's bytes by the chain's check; here on the mock chain,
// whose transactions the mock itself builds. The real bytes are in solana/check.test.ts and
// evm/check.test.ts (`cashOutStep`).

const BASKET = '77';
type Picked = Pick<Order, 'id' | 'owner' | 'legs' | 'depositRaw'>;

const leg = (chain: ChainId, seq: number, more: Partial<Leg>): Leg =>
  ({
    id: `leg-${seq}`,
    orderId: 'order-1',
    chain,
    seq,
    signer: 'owner',
    description: '',
    trades: [],
    expected: [],
    status: 'planned',
    attempt: 0,
    txId: null,
    explorerUrl: null,
    validUntil: null,
    error: null,
    trigger: 'manual',
    provenance: 'mock',
    ...more,
  }) as Leg;

/** A vault of the owner's holding $600 of cash, $300 of one token and $100 of another. */
async function world(chain: ChainId) {
  const w = mockWorld(chain);
  const { adapter, owner } = w;
  const cash = adapter.mock.cash;
  const [spy, gold] = [`${chain}:spy`, `${chain}:gold`];
  if (adapter.capabilities.needsApprove)
    await w.send(await adapter.buildApprove({ owner, basketId: BASKET, amountRaw: usd(1_000) }));
  await w.send(
    await adapter.buildCreateVault({
      owner,
      basketId: BASKET,
      targets: [
        { asset: spy, weightBps: 3_000 },
        { asset: gold, weightBps: 1_000 },
      ],
      autoFollow: false,
      depositRaw: usd(1_000),
      slippageBps: 100,
    }),
  );
  const vault = mockVaultAddress(chain, owner, BASKET);
  for (const [asset, dollars] of [
    [spy, 300],
    [gold, 100],
  ] as const)
    await w.send(
      await adapter.buildOwnerSwap({
        vault,
        trades: [{ sell: cash, buy: asset, amountInRaw: usd(dollars) }],
        slippageBps: 100,
      }),
    );
  const state = await adapter.getVault(vault);
  if (!state) throw new Error('no vault');
  const held = (asset: string) => state.positions.find((p) => p.asset === asset)?.raw ?? '0';
  // The order as the API plans it: a sale per holding, each with its quote, then the cash.
  const sales = await Promise.all(
    [spy, gold].map(async (asset) => {
      const trade = { sell: asset, buy: cash, amountInRaw: held(asset) };
      const quote = await adapter.quote(trade, owner);
      return {
        trade,
        expected: {
          inRaw: trade.amountInRaw,
          outRaw: quote.outRaw,
          minOutRaw: quote.minOutRaw,
          costBps: quote.costBps,
        },
      };
    }),
  );
  const per = adapter.capabilities.maxTradesPerTx;
  const groups = per === 1 ? sales.map((s) => [s]) : [sales];
  const legs: Leg[] = [
    ...groups.map((group, i) =>
      leg(chain, i, {
        kind: 'swap',
        trades: group.map((s) => s.trade),
        expected: group.map((s) => s.expected),
      }),
    ),
    leg(chain, groups.length, {
      kind: 'withdraw',
      withdrawals: [{ asset: cash, amountRaw: null, heldRaw: state.cash.raw }],
    }),
  ];
  const order: Picked = {
    id: 'order-1',
    owner: { [w.chain === 'solana' ? 'solana' : 'evm']: owner },
    legs,
  };
  const least = sales.reduce((n, s) => n + BigInt(s.expected.minOutRaw), BigInt(state.cash.raw));
  const outs = sales.reduce((n, s) => n + BigInt(s.expected.outRaw), 0n);
  // The most the cash step may pay: the cash reviewed, every sale's quote, and 3% of the quotes.
  const most = BigInt(state.cash.raw) + outs + (outs * 300n) / 10_000n;
  const plan: PlanTerms = {
    basketId: BASKET,
    dollars: {
      cashRaw: state.cash.raw,
      sales: sales.map((s) => ({ asset: s.trade.sell, amountRaw: s.trade.amountInRaw })),
    },
  };
  return { w, vault, cash, spy, gold, order, plan, least, most, sales };
}

type World = Awaited<ReturnType<typeof world>>;

/** Builds, checks and lands every step of the order, as the executor does. */
async function sign(x: World, change?: (tx: BuiltTx, leg: Leg) => BuiltTx) {
  const { w, vault, order, plan } = x;
  const steps = approvedSteps(order, plan, w.deployment);
  for (const [i, l] of order.legs.entries()) {
    const step = steps[i];
    if (!step) throw new Error('no step');
    let tx: BuiltTx;
    if (l.kind === 'swap')
      tx = await w.adapter.buildOwnerSwap({
        vault,
        trades: l.trades,
        slippageBps: 100,
        minimums: l.expected.map((e) => e.minOutRaw),
      });
    else {
      const has = (await w.adapter.getVault(vault))?.cash.raw ?? '0';
      const [built] = await w.adapter.buildWithdrawInKind({
        vault,
        assets: [x.cash],
        amounts: { [x.cash]: has },
      });
      if (!built) throw new Error('nothing was built');
      tx = built;
    }
    const given = change ? change(tx, l) : tx;
    guardTransaction({ step, tx: stamped(given, l.id), deployment: w.deployment, consents: [] });
    await w.send(tx);
  }
}

const orderRefusal = (x: World, order: Picked, plan: PlanTerms = x.plan) =>
  refusalOf(() => approvedSteps(order, plan, x.w.deployment));

it('holds the cash step to the margin the API plans it with', () => {
  expect(DOLLARS_MARGIN_BPS).toBe(ORDER_LIMITS.dollarsMarginBps);
});

describe.each(['solana', 'robinhood'] as const)('a withdrawal in dollars on %s', (chain) => {
  it('passes: each sale at its stated minimum, then the cash to the owner, at least what the review stated', async () => {
    const x = await world(chain);
    const steps = approvedSteps(x.order, x.plan, x.w.deployment);
    expect(steps.at(-1)).toMatchObject({
      kind: 'withdraw',
      withdrawals: [
        {
          asset: x.cash,
          amountRaw: null,
          minRaw: x.least.toString(),
          maxRaw: x.most.toString(),
        },
      ],
    });
    for (const step of steps.slice(0, -1)) expect(step.kind).toBe('swap');
    await sign(x);
    const after = await x.w.adapter.getVault(x.vault);
    expect([after?.cash, ...(after?.positions ?? [])].every((h) => h?.raw === '0')).toBe(true);
  });

  it('passes with the switch that turns auto-follow off first, and only off', async () => {
    const x = await world(chain);
    const legs = [
      leg(chain, 0, { kind: 'set_auto_follow', id: 'switch' }),
      ...x.order.legs.map((l) => ({ ...l, seq: l.seq + 1 })),
    ];
    const order = { ...x.order, legs };
    const off = approvedSteps(order, { ...x.plan, autoFollow: false }, x.w.deployment);
    expect(off[0]).toMatchObject({ kind: 'set_auto_follow', on: false });
    expect(orderRefusal(x, order, { ...x.plan, autoFollow: true })?.code).toBe('order');
    expect(orderRefusal(x, order)?.code).toBe('order');
  });

  it('refuses a sale into another token, and a purchase with the vault’s cash', async () => {
    const x = await world(chain);
    const [first, ...rest] = x.order.legs;
    if (!first) throw new Error('no sale');
    const [trade] = first.trades;
    if (!trade) throw new Error('no trade');
    for (const other of [
      { ...trade, buy: `${chain}:tsla` },
      { sell: x.cash, buy: x.spy, amountInRaw: usd(10) },
    ]) {
      const order = {
        ...x.order,
        legs: [{ ...first, trades: [other, ...first.trades.slice(1)] }, ...rest],
      };
      const refusal = orderRefusal(x, order);
      expect(refusal?.code).toBe('order');
      expect(refusal?.legId).toBe(first.id);
    }
  });

  it('refuses a sale of another amount than the review showed, and of a holding it did not name', async () => {
    const x = await world(chain);
    const dollars = x.plan.dollars;
    if (!dollars) throw new Error('no terms');
    const [spy, gold] = dollars.sales;
    if (!spy || !gold) throw new Error('no sales');
    const more = {
      ...dollars,
      sales: [{ ...spy, amountRaw: (BigInt(spy.amountRaw) - 1n).toString() }, gold],
    };
    expect(orderRefusal(x, x.order, { ...x.plan, dollars: more })?.message).toMatch(/review/);
    const unnamed = { ...dollars, sales: [gold] };
    expect(orderRefusal(x, x.order, { ...x.plan, dollars: unnamed })?.code).toBe('order');
    // a holding the review named and the order left out (it could not be sold) is no fault
    const fewer = {
      ...x.order,
      legs: x.order.legs.filter((l) => !l.trades.some((t) => t.sell === x.spy)),
    };
    expect(orderRefusal(x, fewer)).toBeNull();
  });

  it('refuses a holding sold twice, a sale shown with no minimum, and any step that is neither a sale nor the cash', async () => {
    const x = await world(chain);
    const [first, ...rest] = x.order.legs;
    if (!first) throw new Error('no sale');
    const twice = { ...x.order, legs: [first, { ...first, id: 'again', seq: 0.5 }, ...rest] };
    expect(orderRefusal(x, twice)?.message).toMatch(/sold twice/);
    const bare = { ...x.order, legs: [{ ...first, expected: [] }, ...rest] };
    expect(orderRefusal(x, bare)?.code).toBe('order');
    const free = {
      ...x.order,
      legs: [
        { ...first, expected: first.expected.map((e) => ({ ...e, minOutRaw: '0' })) },
        ...rest,
      ],
    };
    expect(orderRefusal(x, free)?.message).toMatch(/no minimum/);
    for (const kind of ['set_targets', 'accept_version', 'set_auto_follow'] as const) {
      const extra = { ...x.order, legs: [leg(chain, -1, { kind }), ...x.order.legs] };
      expect(orderRefusal(x, extra)?.code, kind).toBe('order');
    }
  });

  it('refuses an order that does not end with the one withdrawal of the cash, and one that names tokens', async () => {
    const x = await world(chain);
    const last = x.order.legs.at(-1) as Leg;
    const none = { ...x.order, legs: x.order.legs.slice(0, -1) };
    expect(orderRefusal(x, none)?.code).toBe('order');
    const early = {
      ...x.order,
      legs: [{ ...last, seq: -1 }, ...x.order.legs.slice(0, -1)],
    };
    expect(orderRefusal(x, early)?.code).toBe('order');
    const two = { ...x.order, legs: [...x.order.legs, { ...last, id: 'second', seq: 99 }] };
    expect(orderRefusal(x, two)?.code).toBe('order');
    const named = { ...x.plan, withdrawals: [{ asset: x.spy, amountRaw: null }] };
    expect(orderRefusal(x, x.order, named)?.code).toBe('order');
  });

  it('refuses a cash step whose bytes take out a holding, less than the review stated, or another person’s vault', async () => {
    const x = await world(chain);
    const lies: [string, (m: { op: { a: Record<string, unknown> } }) => void][] = [
      ['asset', (m) => (m.op.a.assets = [x.spy])],
      ['amount', (m) => (m.op.a.amounts = { [x.cash]: (x.least - 1n).toString() })],
      ['amount', (m) => (m.op.a.amounts = undefined)],
      ['amount', (m) => (m.op.a.amounts = { [x.cash]: (x.most + 1n).toString() })],
      ['vault', (m) => (m.op.a.vault = mockVaultAddress(chain, x.w.stranger, BASKET))],
    ];
    for (const [code, lie] of lies) {
      const fresh = await world(chain);
      const refusal = await sign(fresh, (tx, l) =>
        l.kind === 'withdraw' ? tampered(tx, lie as never) : tx,
      ).then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
      expect(refusal?.code, code).toBe(code);
      // nothing of the cash left the vault
      const after = await fresh.w.adapter.getVault(fresh.vault);
      expect(BigInt(after?.cash.raw ?? '0')).toBeGreaterThanOrEqual(fresh.least);
    }
    expect(x.least).toBeGreaterThan(0n);
  });

  it('refuses a sale whose bytes accept less than the order stated', async () => {
    const x = await world(chain);
    const refusal = await sign(x, (tx, l) =>
      l.kind === 'swap'
        ? tampered(tx, (m) => {
            m.mins = m.mins.map(() => '1');
          })
        : tx,
    ).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(refusal?.code).toBe('minimum');
  });
});
