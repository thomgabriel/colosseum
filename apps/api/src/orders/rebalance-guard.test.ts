import type { Target } from '@colosseum/schemas';
import {
  idleCashToInvest,
  OWNER_REBALANCE_BAND_BPS,
  OWNER_REBALANCE_MIN_TRADE_USD,
  outsideOwnerBand,
  ownerRebalanceOffered,
  ownerShares,
} from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rebalancePlan } from '../../../../packages/basket/src/plan-rebalance';
import { asset, price, vault } from '../../../../packages/basket/src/testing';
import { view } from '../../../../packages/basket/src/view';
import { pastTarget } from './mix';

// The planner and the guard a step is built under (the review of #307): every trade the owner's
// rebalance plans passes `pastTarget` when its turn comes, at any slippage the API accepts (0 to
// 300 bps), whether each trade lands at its quote or loses all of its slippage. A purchase refused
// after its sales landed would leave the order half done, and its refusal is not one to retry.

const CASH = 'solana:usdc';
const IDS = ['solana:a', 'solana:b', 'solana:c', 'solana:d'];
const ASSETS = [CASH, ...IDS].map((id) => ({ id, decimals: 6 }));

const world = fc.record({
  cash: fc.integer({ min: 0, max: 20_000 }),
  // an asset held at nothing is the case that reads furthest over: one large purchase into it
  held: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 20_000 })), {
    minLength: 4,
    maxLength: 4,
  }),
  prices: fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 4, maxLength: 4 }),
  weights: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 4, maxLength: 4 }),
  cashShare: fc.integer({ min: 0, max: 30 }),
  slippageBps: fc.constantFrom(0, 30, 100, 150, 250, 300, 300),
  purchasesOnly: fc.boolean(),
  worst: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
});

describe('the owner’s rebalance, planned and then held at build', { timeout: 120_000 }, () => {
  it('passes every trade it plans, at every slippage the API takes, however each lands', () => {
    let checked = 0;
    fc.assert(
      fc.property(world, (w) => {
        const sum = w.weights.reduce((n, x) => n + x, 0);
        if (sum === 0) return;
        // targets that leave `cashShare` percent in cash, in whole bps
        const scale = 10_000 - w.cashShare * 100;
        const targets: Target[] = IDS.map((asset, i) => ({
          asset,
          weightBps: Math.floor(((w.weights[i] ?? 0) * scale) / sum),
        })).filter((t) => t.weightBps > 0);
        const goal = new Map(targets.map((t) => [t.asset, t.weightBps]));
        const unit = new Map(IDS.map((id, i) => [id, w.prices[i] ?? 1]));
        const state = vault(
          String(w.cash * 1_000_000),
          Object.fromEntries(
            IDS.map((id, i) => [
              id,
              [
                String(Math.round(((w.held[i] ?? 0) / (unit.get(id) ?? 1)) * 1_000_000)),
                goal.get(id) ?? 0,
              ],
            ]),
          ),
        );
        const plan = rebalancePlan(
          state,
          targets,
          IDS.map((id) => price(id, String(unit.get(id)))),
          {
            bandBps: w.purchasesOnly ? 0 : OWNER_REBALANCE_BAND_BPS,
            minTradeUsd: OWNER_REBALANCE_MIN_TRADE_USD,
            costBps: w.slippageBps,
            ...(w.purchasesOnly ? { purchasesOnly: true } : {}),
          },
          ASSETS,
        );
        // the vault in dollars, trade after trade, each trade landing at its quote or at its least
        const value = new Map(
          IDS.map((id) => [
            id,
            (Number(state.positions.find((p) => p.asset === id)?.raw ?? 0) / 1e6) *
              (unit.get(id) ?? 1),
          ]),
        );
        let cash = w.cash;
        const c = w.slippageBps / 10_000;
        plan.trades.forEach((t, i) => {
          const buys = t.sell === CASH;
          const asset = buys ? t.buy : t.sell;
          const moved = buys
            ? Number(t.amountInRaw) / 1e6
            : (Number(t.amountInRaw) / 1e6) * (unit.get(asset) ?? 1);
          const total = [...value.values()].reduce((n, v) => n + v, cash);
          const past = pastTarget({
            buys,
            nowUsd: value.get(asset) ?? 0,
            movedUsd: moved,
            totalUsd: total,
            goalBps: goal.get(asset) ?? 0,
            slippageBps: w.slippageBps,
          });
          expect(past, `${buys ? 'buy' : 'sell'} ${asset} at ${w.slippageBps} bps`).toBe(false);
          const lost = w.worst[i % w.worst.length] ? c : 0;
          if (buys) {
            cash -= moved;
            value.set(asset, (value.get(asset) ?? 0) + moved * (1 - lost));
          } else {
            value.set(asset, (value.get(asset) ?? 0) - moved);
            cash += moved * (1 - lost);
          }
          checked += 1;
        });
      }),
      { numRuns: 8000 },
    );
    expect(checked).toBeGreaterThan(2000);
  });

  it('passes the review’s case: $2,390 into an asset held at nothing, at 300 bps', () => {
    // SPY $2,974, NVDA $2,222, no TSLA, $3,590 cash; targets 34.14%, 25.5%, 26.7%. The purchase was
    // sized to land on 26.7% once it loses 3%: counted whole it read 50 bps over, at the band's edge.
    expect(
      pastTarget({
        buys: true,
        nowUsd: 0,
        movedUsd: 2389.83,
        totalUsd: 8786,
        goalBps: 2670,
        slippageBps: 300,
      }),
    ).toBe(false);
  });

  it('refuses a purchase that would take its asset past its target by more than the band', () => {
    // $1,000, the asset at 50% of a 50% target: $100 more at 1% brings $99, 4.95 points over
    expect(
      pastTarget({
        buys: true,
        nowUsd: 500,
        movedUsd: 100,
        totalUsd: 1000,
        goalBps: 5000,
        slippageBps: 100,
      }),
    ).toBe(true);
    // $5 more brings $4.95: inside the band
    expect(
      pastTarget({
        buys: true,
        nowUsd: 500,
        movedUsd: 5,
        totalUsd: 1000,
        goalBps: 5000,
        slippageBps: 100,
      }),
    ).toBe(false);
  });
});

// What the page offers and what the route plans (the review of #307): wherever the vault's page and
// the chat offer a rebalance (`ownerRebalanceOffered` on the vault's view, in whole bps), the plan
// the route makes for it has a trade, read as `planRetarget` reads it.
const UNITS = [
  asset(CASH, { decimals: 6, cls: 'cash' }),
  ...IDS.map((id) => asset(id, { decimals: 6 })),
];

/** The route's plan for a vault: its band, or purchases alone where only idle cash is to invest. */
function routePlan(
  state: ReturnType<typeof vault>,
  targets: Target[],
  prices: ReturnType<typeof price>[],
) {
  const seen = view(state, prices, UNITS);
  const read = ownerShares(seen.positions, Number(seen.valueUsd));
  if (!read) return { offered: false, trades: [] };
  // the page's, the chat's and the route's reading, the one rule
  const offered = ownerRebalanceOffered(read.rows, read.cashOverBps, 100, read.valueUsd);
  const inside = !outsideOwnerBand(read.rows, read.cashOverBps, 100);
  const purchasesOnly = inside && idleCashToInvest(read.rows, read.cashOverBps, 100, read.valueUsd);
  const plan = rebalancePlan(
    state,
    targets,
    prices,
    {
      bandBps: purchasesOnly ? 0 : OWNER_REBALANCE_BAND_BPS,
      minTradeUsd: OWNER_REBALANCE_MIN_TRADE_USD,
      costBps: 100,
      ...(purchasesOnly ? { purchasesOnly: true } : {}),
    },
    UNITS,
  );
  return { offered, trades: inside && !purchasesOnly ? [] : plan.trades };
}

describe('what is offered is what is planned', { timeout: 120_000 }, () => {
  it('the review’s case: $6 of cash, two assets $5.20 under, two $2.20 over: one purchase', () => {
    const quarter = 2500;
    const state = vault('6000000', {
      'solana:a': [String(494_800_000), quarter],
      'solana:b': [String(494_800_000), quarter],
      'solana:c': [String(502_200_000), quarter],
      'solana:d': [String(502_200_000), quarter],
    });
    const targets = IDS.map((id) => ({ asset: id, weightBps: quarter }));
    const { offered, trades } = routePlan(
      state,
      targets,
      IDS.map((id) => price(id, '1')),
    );
    expect(offered).toBe(true);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.sell).toBe(CASH);
    expect(Number(trades[0]?.amountInRaw) / 1e6).toBeGreaterThanOrEqual(
      OWNER_REBALANCE_MIN_TRADE_USD,
    );
  });

  it('plans a trade wherever it offers one', () => {
    let offers = 0;
    fc.assert(
      fc.property(
        fc.record({
          cash: fc.oneof(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 5_000 })),
          base: fc.oneof(
            fc.integer({ min: 200, max: 5_000 }),
            fc.integer({ min: 5_000, max: 60_000 }),
          ),
          off: fc.array(
            fc.oneof(fc.integer({ min: -30, max: 30 }), fc.integer({ min: -400, max: 400 })),
            {
              minLength: 4,
              maxLength: 4,
            },
          ),
          cashShare: fc.constantFrom(0, 0, 500),
        }),
        (w) => {
          const share = (10_000 - w.cashShare) / 4;
          const targets = IDS.map((id) => ({ asset: id, weightBps: share }));
          const state = vault(
            String(w.cash * 1_000_000),
            Object.fromEntries(
              IDS.map((id, i) => [
                id,
                [String(Math.max(0, w.base + (w.off[i] ?? 0)) * 1_000_000), share],
              ]),
            ),
          );
          const { offered, trades } = routePlan(
            state,
            targets,
            IDS.map((id) => price(id, '1')),
          );
          if (!offered) return;
          offers += 1;
          expect(trades.length, JSON.stringify(w)).toBeGreaterThan(0);
        },
      ),
      { numRuns: 10_000 },
    );
    expect(offers).toBeGreaterThan(500);
  });
});
