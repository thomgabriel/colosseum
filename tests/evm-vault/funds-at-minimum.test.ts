import { mockAddress } from '@colosseum/chain-mock';
import { type Address, parseChainConfigs, parseFlags } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { createChainRegistry } from '../../apps/api/src/orders/chains';
import { checkMix, mixContext, planRetarget } from '../../apps/api/src/orders/mix';
import { firstShort } from '../../packages/chain-evm/src/vault/funds';
import { fixtureLiquidity } from '../../packages/engine/src/personal/testing';

// Why `firstShort` counts a sale's cash at its quote and not at its stated minimum (the review of
// #232 asked for the minimum). A sale's minimum is the pool's quote less the order's slippage, and a
// purchase that takes everything the sale brings may sit above that minimum and still land at any
// price down to about the quote: held to the minimum, such a step would be refused before signing.
// Orders were sized that way until #307; since, `planRetarget` caps the purchases at what the sales'
// stated minimums cover, so an order the planner makes is covered at either. The check stays at the
// quote, and the simulation and the chain hold the rest.

const NOW = '2026-10-08T12:00:00.000Z';
const CASH = 'robinhood:usdc';

async function retarget(allocations: { assetId: string; weightBps: number }[]) {
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), {
    seed: `funds-at-minimum:${allocations.map((a) => a.assetId).join()}`,
  });
  const entry = chains.get('robinhood');
  const mock = entry.mock;
  if (!mock) throw new Error('the test chain is the mock');
  const ctx = await mixContext(
    entry,
    async () => ({ liquidity: { provider: fixtureLiquidity({}), source: 'fixture exit table' } }),
    NOW,
  );
  const owner = mockAddress('robinhood', 'funds-at-minimum') as Address;
  mock.fund(owner, { gasRaw: '1000000000000000000', assets: { [CASH]: '1000000000' } });
  await mock.send(
    await entry.adapter.buildApprove({ owner, basketId: '21', amountRaw: '1000000000' }),
  );
  await mock.send(
    await entry.adapter.buildCreateVault({
      owner,
      basketId: '21',
      targets: [{ asset: 'robinhood:spy', weightBps: 10_000 }],
      autoFollow: false,
      depositRaw: '1000000000',
      trades: [{ sell: CASH, buy: 'robinhood:spy', amountInRaw: '1000000000' }],
      slippageBps: 100,
    }),
  );
  const [vault] = await entry.adapter.getVaults(owner);
  if (!vault) throw new Error('no vault');
  const checked = await checkMix(ctx, allocations, vault);
  const { order } = await planRetarget(ctx, vault, checked, { slippageBps: 100, now: NOW, owner });
  // On EVM the trades ride with the targets they trade toward (gate EVM-MULTICALL-STEPS).
  const swap = order.legs.find((l) => l.trades.length > 0);
  if (!swap) throw new Error('no step that trades');
  const held = new Map([[vault.cash.asset, BigInt(vault.cash.raw)]]);
  for (const p of vault.positions) held.set(p.asset, BigInt(p.raw));
  return {
    swap,
    atQuote: firstShort(
      swap.trades,
      held,
      swap.expected.map((e) => BigInt(e.outRaw)),
    ),
    atMinimum: firstShort(
      swap.trades,
      held,
      swap.expected.map((e) => BigInt(e.minOutRaw)),
    ),
  };
}

describe('what a later trade of a step may spend of an earlier one', () => {
  it('counts a sale at its quote: a purchase above the sale’s minimum and within its quote is covered', () => {
    // Built directly: SPY sold for cash quoted at 495 with a minimum of 490, then 494 of it spent.
    const trades = [
      { sell: 'robinhood:spy', buy: CASH, amountInRaw: '1000' },
      { sell: CASH, buy: 'robinhood:nvda', amountInRaw: '494' },
    ];
    const held = new Map([
      ['robinhood:spy', 1000n],
      [CASH, 0n],
    ]);
    expect(firstShort(trades, held, [495n, 1n])).toBeNull();
    // held to the minimum, the same step is short at its purchase
    expect(firstShort(trades, held, [490n, 1n])).toEqual({ index: 1, asset: CASH, held: 490n });
    // and past the quote it is short whatever the sale is counted at
    expect(firstShort(trades, held, [493n, 1n])).toEqual({ index: 1, asset: CASH, held: 493n });
  });

  it('a change that spends all its sale brings in spends no more than the sale’s minimum: covered at either', async () => {
    // Half of the one stock into another: the purchase takes everything the sale is sure to bring.
    const { swap, atQuote, atMinimum } = await retarget([
      { assetId: 'robinhood:spy', weightBps: 5000 },
      { assetId: 'robinhood:nvda', weightBps: 5000 },
    ]);
    expect(swap.trades.map((t) => [t.sell, t.buy])).toEqual([
      ['robinhood:spy', CASH],
      [CASH, 'robinhood:nvda'],
    ]);
    const purchase = BigInt(swap.trades[1]?.amountInRaw ?? '0');
    const saleMinimum = BigInt(swap.expected[0]?.minOutRaw ?? '0');
    // Capped at what the sale's stated minimum covers (#307), and not a cent short of it.
    expect(purchase).toBeLessThanOrEqual(saleMinimum);
    expect(saleMinimum - purchase).toBeLessThan(10_000n);
    expect(atQuote).toBeNull();
    expect(atMinimum).toBeNull();
  });

  it('a change that leaves a margin (all of one stock into all of another) is covered at either', async () => {
    const { atQuote, atMinimum } = await retarget([
      { assetId: 'robinhood:nvda', weightBps: 10_000 },
    ]);
    expect(atQuote).toBeNull();
    expect(atMinimum).toBeNull();
  });
});
