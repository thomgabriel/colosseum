import { ChainError } from '@colosseum/schemas';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { worthAtFeed } from '../src/vault/trade-limits';
import {
  ACCOUNTS,
  BOUND_BPS,
  buildMainnetTradeWorld,
  MAINNET,
  MAX_TRADE_USD,
  type MainnetTradeWorld,
} from './mainnet-trade-world';

// An owner's trade on a local copy of Robinhood Chain mainnet, held to the token's Chainlink price and
// to its largest trade. The pool is the real one, and it is really pushed: a stranger trades through
// the real router until the pool's price is off, and the builder refuses the person's order. Nothing
// is sent to any network.
//
//   RH_FORK_URL=<a node that keeps old state> pnpm exec vitest run packages/chain-evm/test/mainnet-trade.test.ts
//
// It needs anvil (Foundry) and `forge build` in contracts/. Skipped without RH_FORK_URL.
// RH_FORK_BLOCK moves the block (default: the one the pools were measured at); RH_TRADE_PORT moves
// anvil off 28845.

const FORK_URL = process.env.RH_FORK_URL;
const PORT = Number(process.env.RH_TRADE_PORT ?? 28_845);
const USD = 1_000_000n;
const GLD = 'robinhood:gld';
const NVDA = 'robinhood:nvda';
const CASH = 'robinhood:usdg';

describe.skipIf(!FORK_URL)("an owner's trade, held to the feed, on a copy of mainnet", () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 300_000 });
  let started: Promise<MainnetTradeWorld> | undefined;
  const start = () => {
    started ??= buildMainnetTradeWorld(FORK_URL ?? '', PORT);
    return started;
  };
  afterAll(async () => (await started)?.stop());

  const refusal = async (work: () => Promise<unknown>): Promise<ChainError> => {
    try {
      await work();
    } catch (e) {
      if (e instanceof ChainError) return e;
      throw e;
    }
    throw new Error('it was not refused');
  };
  const buy = (asset: string, usd: bigint) => ({
    sell: CASH,
    buy: asset,
    amountInRaw: (usd * USD).toString(),
  });
  const priceOf = async (w: MainnetTradeWorld, asset: string) => {
    const [price] = await w.adapter.getPrices([asset]);
    if (!price) throw new Error(`${asset} has no price`);
    return price;
  };

  it('an honest trade is quoted, built with a minimum no lower than the feed allows, and lands', async () => {
    const w = await start();
    for (const [asset, basketId] of [
      [GLD, '501'],
      [NVDA, '502'],
    ] as const) {
      const quote = await w.adapter.quote(buy(asset, 500n), ACCOUNTS.owner);
      // Within the bound of the feed, fee included.
      expect(Math.abs(quote.costBps), asset).toBeLessThan(BOUND_BPS);
      expect(quote.against).toBe('reference');

      const price = await priceOf(w, asset);
      const fair = worthAtFeed(
        { side: 'buy', cashDecimals: 6, assetDecimals: 18 },
        500n * USD,
        price.usdPerToken,
      );
      const feedFloor = (fair * BigInt(10_000 - BOUND_BPS)) / 10_000n;

      await w.land(
        await w.adapter.buildApprove({
          owner: ACCOUNTS.owner,
          basketId,
          amountRaw: (1000n * USD).toString(),
        }),
      );
      const create = await w.adapter.buildCreateVault({
        owner: ACCOUNTS.owner,
        basketId,
        targets: [{ asset, weightBps: 5000 }],
        autoFollow: false,
        depositRaw: (1000n * USD).toString(),
        trades: [buy(asset, 500n)],
        slippageBps: 100,
      });
      const [minimum] = create.preview.minimums;
      expect(BigInt(minimum?.minOutRaw ?? 0), asset).toBeGreaterThanOrEqual(feedFloor);
      await w.land(create);
      const vault = await w.vaultOf(basketId);
      const token = asset === GLD ? MAINNET.gld : MAINNET.nvda;
      expect(await w.balanceOf(token, vault), asset).toBeGreaterThanOrEqual(
        BigInt(minimum?.minOutRaw ?? 0),
      );
      expect(await w.balanceOf(MAINNET.usdg, vault)).toBe(500n * USD);
    }
  });

  it("a trade above the asset's largest is refused with its limit, whichever way it goes", async () => {
    const w = await start();
    const over = await refusal(() =>
      w.adapter.quote(buy(GLD, BigInt(MAX_TRADE_USD.gld) + 1n), ACCOUNTS.owner),
    );
    expect(over.code).toBe('BadTrade');
    expect(over.message).toMatch(/GLD in one go is more than its pool is trusted to fill/);
    expect(over.message).toMatch(/at most \$1,000 at a time/);
    // At the limit it is quoted.
    await expect(
      w.adapter.quote(buy(GLD, BigInt(MAX_TRADE_USD.gld)), ACCOUNTS.owner),
    ).resolves.toBeDefined();
    // NVDA's is its own, fifty times GLD's.
    await expect(w.adapter.quote(buy(NVDA, 5_000n), ACCOUNTS.owner)).resolves.toBeDefined();
    expect(
      (await refusal(() => w.adapter.quote(buy(NVDA, 50_001n), ACCOUNTS.owner))).message,
    ).toMatch(/at most \$50,000 at a time/);

    // Two trades of one step in the same pool count together.
    const vault = await w.vaultOf('501');
    await w.land(
      await w.adapter.buildApprove({
        owner: ACCOUNTS.owner,
        basketId: '501',
        amountRaw: (1_200n * USD).toString(),
      }),
    );
    const twice = await refusal(() =>
      w.adapter.buildDeposit({
        vault,
        amountRaw: (1_200n * USD).toString(),
        trades: [buy(GLD, 600n), buy(GLD, 600n)],
        slippageBps: 100,
      }),
    );
    expect(twice.code).toBe('BadTrade');
    expect(twice.message).toMatch(/\$1,200 of GLD/);

    // A sale is measured by the feed: 4 GLD is about $1,500 whatever the pool would pay for it.
    const sale = await refusal(() =>
      w.adapter.quote(
        { sell: GLD, buy: CASH, amountInRaw: (4n * 10n ** 18n).toString() },
        ACCOUNTS.owner,
      ),
    );
    expect(sale.code).toBe('BadTrade');
    expect(sale.message).toMatch(/at most \$1,000 at a time/);
  });

  it('a pushed pool: the order is refused while the pool is off the feed, and built again once it is back', async () => {
    const w = await start();
    const vault = await w.vaultOf('501');
    const order = () =>
      w.adapter.buildDeposit({
        vault,
        amountRaw: (500n * USD).toString(),
        trades: [buy(GLD, 500n)],
        slippageBps: 100,
      });
    // Before: the order builds.
    await w.land(
      await w.adapter.buildApprove({
        owner: ACCOUNTS.owner,
        basketId: '501',
        amountRaw: (500n * USD).toString(),
      }),
    );
    const honest = await order();
    const honestMin = BigInt(honest.preview.minimums[0]?.minOutRaw ?? 0);

    // A stranger pushes GLD's pool up with a few thousand dollars.
    const spent = 4_000n * USD;
    const got = await w.push(MAINNET.usdg, MAINNET.gld, spent);
    expect(got).toBeGreaterThan(0n);

    // The step built before the push does not fill at the pushed price: the vault's minimum holds it.
    expect(await w.send(honest)).toBe('reverted');
    expect(await w.balanceOf(MAINNET.usdg, vault)).toBe(500n * USD);

    // A new order is refused before anything is built, in words the person reads.
    const refused = await refusal(order);
    expect(refused.code).toBe('PriceDeviation');
    expect(refused.retryable).toBe(true);
    expect(refused.message).toMatch(
      /the pool's price for GLD is \d+\.\d\d% worse than the reference price, more than the 2\.00% allowed: not trading/,
    );
    expect((await refusal(() => w.adapter.quote(buy(GLD, 500n), ACCOUNTS.owner))).code).toBe(
      'PriceDeviation',
    );
    // So is a sale into the pushed pool, which would pay too well: the price is not one to trade at.
    const held = await w.balanceOf(MAINNET.gld, vault);
    const sale = await refusal(() =>
      w.adapter.buildOwnerSwap({
        vault,
        trades: [{ sell: GLD, buy: CASH, amountInRaw: (held / 2n).toString() }],
        slippageBps: 100,
      }),
    );
    expect(sale.code).toBe('PriceDeviation');
    expect(sale.message).toMatch(/better than the reference price/);
    // NVDA's pool was not touched: its trades go on.
    await expect(w.adapter.quote(buy(NVDA, 500n), ACCOUNTS.owner)).resolves.toBeDefined();

    // The stranger sells back. The pool returns, and the same order builds and lands.
    await w.push(MAINNET.gld, MAINNET.usdg, got);
    const again = await order();
    expect(BigInt(again.preview.minimums[0]?.minOutRaw ?? 0)).toBeGreaterThan(
      (honestMin * 97n) / 100n,
    );
    const before = await w.balanceOf(MAINNET.gld, vault);
    await w.land(again);
    // The deposit's 500 went into GLD: the cash is what it was, and the token is up by the minimum at least.
    expect(await w.balanceOf(MAINNET.usdg, vault)).toBe(500n * USD);
    expect((await w.balanceOf(MAINNET.gld, vault)) - before).toBeGreaterThanOrEqual(
      BigInt(again.preview.minimums[0]?.minOutRaw ?? 0),
    );
  });

  it('a feed gone stale refuses: no witness is not a pass', async () => {
    const w = await start();
    const price = await priceOf(w, GLD);
    await expect(w.adapter.quote(buy(GLD, 100n), ACCOUNTS.owner)).resolves.toBeDefined();
    await w.later((price.maxAgeSeconds ?? 0) + 60);
    const stale = await refusal(() => w.adapter.quote(buy(GLD, 100n), ACCOUNTS.owner));
    expect(stale.code).toBe('PriceStale');
    expect(stale.message).toMatch(
      /reference price of GLD is \d+ s old.*not trading until it is fresh/,
    );
    const vault = await w.vaultOf('501');
    expect(
      (
        await refusal(() =>
          w.adapter.buildOwnerSwap({ vault, trades: [buy(GLD, 100n)], slippageBps: 100 }),
        )
      ).code,
    ).toBe('PriceStale');
  });
});
