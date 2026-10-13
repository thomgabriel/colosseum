import {
  type Address,
  BuiltTx,
  type ChainAdapter,
  type Leg,
  type Principal,
  parseChainConfigs,
  stampTx,
} from '@colosseum/schemas';
import type { GuardDeployment } from '@colosseum/sdk';
import { approvedSteps, deploymentsOf, GuardRefusal, guardTransaction } from '@colosseum/sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../apps/api/src/orders/chains';
import { buildWithdraw, planWithdraw } from '../../apps/api/src/orders/withdraw';
import { nonFinitePaths } from '../../apps/api/src/plugins/finite';
import {
  ACCOUNTS,
  buildTestnetWorld,
  id,
  TESTNET_RECORD,
  type TestnetWorld,
} from '../../packages/chain-evm/test/testnet-world';

// A withdrawal in dollars (gate WITHDRAW-DOLLARS) on an EVM vault, built step by step by the adapter
// on a copy of Robinhood Chain's test network and held to the guard: the vault's two stocks are sold
// for the cash token in one `ownerSwap`, then the cash leaves with `withdraw(token, amount)`, to the
// owner. No contract knows of it: it is the owner's swap and the owner's withdrawal.
//
//   RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run tests/evm-vault/withdraw-dollars.test.ts

const FORK_URL = process.env.RH_TESTNET_FORK_URL;
const PORT = Number(process.env.RH_TESTNET_DOLLARS_PORT ?? 28_766);
const owner = ACCOUNTS.owner as Address;
const DEPOSIT = '100000000';
const BASKET = '93';

describe.skipIf(!FORK_URL)('a withdrawal in dollars on a copy of the test network', () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 300_000 });
  let started: Promise<TestnetWorld> | undefined;
  const start = () => {
    started ??= buildTestnetWorld(FORK_URL ?? '', PORT);
    return started;
  };
  afterAll(async () => (await started)?.stop());

  it('sells half of each holding for cash, then withdraws that cash to the owner, every step passed by the guard', async () => {
    const w = await start();
    const { adapter } = w;
    const land = async (tx: BuiltTx) => {
      const { txId } = await w.send(tx);
      const receipt = await w.client.getTransactionReceipt({ hash: txId as `0x${string}` });
      expect(receipt.status, tx.description).toBe('success');
    };
    const cash = id('tusdg');
    const stocks = [id('ttsla'), id('tgoogl')];
    for (const asset of stocks) await w.movePrice(asset, 0);

    // A vault of $100: $40 of one stock, $40 of another, $20 of cash.
    await land(await adapter.buildApprove({ owner, basketId: BASKET, amountRaw: DEPOSIT }));
    await land(
      await adapter.buildCreateVault({
        owner,
        basketId: BASKET,
        targets: stocks.map((asset) => ({ asset, weightBps: 4_000 })),
        autoFollow: false,
        depositRaw: DEPOSIT,
        trades: stocks.map((asset) => ({ sell: cash, buy: asset, amountInRaw: '40000000' })),
        slippageBps: 100,
      }),
    );
    const vault = (await adapter.getVaults(owner)).find((v) => v.basketId === BASKET);
    if (!vault) throw new Error('no vault');
    expect(vault.cash.raw).toBe('20000000');

    const config = parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: 'testnet' },
      {
        robinhood: {
          factory: TESTNET_RECORD.contracts.factory,
          registry: TESTNET_RECORD.contracts.registry,
        },
      },
    ).robinhood;
    const entry: ChainEntry = {
      chain: 'robinhood',
      mode: 'live',
      provenance: 'sandbox',
      source: 'a local copy of the test network',
      config,
      adapter: adapter as ChainAdapter,
    };
    const chains = { get: () => entry } as unknown as ChainRegistry;
    const principal: Principal = {
      kind: 'user',
      userId: 'did:test:owner',
      wallets: [{ family: 'evm', address: vault.owner, kind: 'external' }],
      ip: '127.0.0.1',
    };
    const request = {
      type: 'withdraw' as const,
      vaults: [vault.address],
      sellToCash: true,
      shareBps: 5_000,
    };
    const plan = await planWithdraw(request, { principal, chains });
    expect(nonFinitePaths(plan)).toEqual([]);
    expect(plan.warnings).toEqual([]);
    // Both sales in one step on an EVM chain, half of each holding, then the cash.
    expect(plan.steps.map((s) => s.kind)).toEqual(['swap', 'withdraw']);
    const [sale, out] = plan.steps;
    if (!sale?.trades || !sale.expected || !out?.withdrawals) throw new Error('no steps');
    expect(sale.trades).toEqual(
      vault.positions.map((p) => ({
        sell: p.asset,
        buy: cash,
        amountInRaw: (BigInt(p.raw) / 2n).toString(),
      })),
    );
    const minimums = sale.expected.reduce((n, e) => n + BigInt(e.minOutRaw), 0n);
    expect(out.withdrawals).toMatchObject([
      { asset: cash, amountRaw: null, leastRaw: (10_000_000n + minimums).toString() },
    ]);

    const legs = plan.steps.map(
      (s, seq) =>
        ({
          id: `leg-${seq}`,
          orderId: 'order',
          chain: 'robinhood',
          seq,
          kind: s.kind,
          signer: 'owner',
          description: s.description,
          trades: s.trades ?? [],
          expected: s.expected ?? [],
          ...(s.withdrawals ? { withdrawals: s.withdrawals } : {}),
          status: 'planned',
          attempt: 0,
          txId: null,
          explorerUrl: null,
          validUntil: null,
          error: null,
          trigger: 'manual',
          provenance: 'sandbox',
        }) as Leg,
    );
    const deployment = deploymentsOf('testnet').robinhood as GuardDeployment;
    // The guard's terms are the review's: the share of the cash the vault held, and nothing named.
    const steps = approvedSteps(
      { id: 'order', owner: { evm: vault.owner }, legs },
      { basketId: BASKET, dollars: { cashRaw: '10000000' } },
      deployment,
    );
    const guarded = (leg: Leg, tx: BuiltTx) =>
      guardTransaction({
        step: steps.find((s) => s.legId === leg.id) as (typeof steps)[number],
        tx: stampTx(tx, { legId: leg.id, attemptId: `${leg.id}-a` }),
        deployment,
        consents: [],
      });
    const [saleLeg, cashLeg] = legs as [Leg, Leg];
    const before = await adapter.getWalletHoldings(owner);
    const walletCash = (held: typeof before) =>
      BigInt(held.find((h) => h.asset === cash)?.raw ?? '0');

    // The cash step is not built before the sales: it would pay less than the order stated.
    await expect(buildWithdraw(request, cashLeg, entry, vault.owner, undefined)).rejects.toThrow(
      /less than .* the order stated/,
    );

    const swap = BuiltTx.parse(
      await buildWithdraw(request, saleLeg, entry, vault.owner, undefined),
    );
    guarded(saleLeg, swap);
    expect(swap.preview.minimums).toEqual(
      sale.trades.map((t, i) => ({
        sell: t.sell,
        buy: t.buy,
        inRaw: t.amountInRaw,
        minOutRaw: sale.expected?.[i]?.minOutRaw,
      })),
    );
    await land(swap);

    const withdrawal = BuiltTx.parse(
      await buildWithdraw(request, cashLeg, entry, vault.owner, undefined),
    );
    guarded(cashLeg, withdrawal);
    // The same bytes held to a withdrawal of a stock, or to more than they pay, are refused.
    const asStock = { ...steps[1], withdrawals: [{ asset: stocks[0], amountRaw: null }] };
    expect(() =>
      guardTransaction({
        step: asStock as (typeof steps)[number],
        tx: stampTx(withdrawal, { legId: cashLeg.id, attemptId: 'a' }),
        deployment,
        consents: [],
      }),
    ).toThrow(GuardRefusal);
    const more = {
      ...steps[1],
      withdrawals: [{ asset: cash, amountRaw: null, minRaw: (10n ** 12n).toString() }],
    };
    expect(() =>
      guardTransaction({
        step: more as (typeof steps)[number],
        tx: stampTx(withdrawal, { legId: cashLeg.id, attemptId: 'a' }),
        deployment,
        consents: [],
      }),
    ).toThrow(GuardRefusal);
    await land(withdrawal);

    const after = await adapter.getVault(vault.address);
    // Half of each stock and half of the cash stay; the owner has the rest as cash, at least the stated.
    for (const p of vault.positions)
      expect(after?.positions.find((x) => x.asset === p.asset)?.raw).toBe(
        (BigInt(p.raw) - BigInt(p.raw) / 2n).toString(),
      );
    expect(after?.cash.raw).toBe('10000000');
    const got = walletCash(await adapter.getWalletHoldings(owner)) - walletCash(before);
    expect(got).toBeGreaterThanOrEqual(10_000_000n + minimums);
  });
});
