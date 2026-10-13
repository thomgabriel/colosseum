import {
  createEvmRpc,
  createEvmVaultAdapter,
  deploymentAddresses,
  deploymentAssets,
  deploymentLimits,
  deploymentPools,
} from '@colosseum/chain-evm/vault';
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
import { Refusal } from '../../apps/api/src/orders/errors';
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
      {
        basketId: BASKET,
        dollars: {
          cashRaw: '10000000',
          sales: vault.positions.map((p) => ({
            asset: p.asset,
            amountRaw: (BigInt(p.raw) / 2n).toString(),
          })),
        },
      },
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

  /** A JSON-RPC call to the copy. */
  const rpc = async (w: TestnetWorld, method: string, params: unknown[]) => {
    const res = await fetch(w.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  /**
   * Moves the test feed of `asset` by `bps` and leaves its pool where it is, as the price writer:
   * the pool's quote then sits that far from the reference price.
   */
  const moveFeedOnly = async (w: TestnetWorld, asset: string, bps: number) => {
    const a = TESTNET_RECORD.assets.find((x) => x.id === asset);
    if (!a?.feed) throw new Error(`${asset} has no test feed`);
    const read = (await rpc(w, 'eth_call', [
      { to: a.feed, data: '0xfeaf968c' },
      'latest',
    ])) as string;
    const answer = BigInt(`0x${read.slice(2 + 64, 2 + 128)}`);
    const block = (await rpc(w, 'eth_getBlockByNumber', ['latest', false])) as {
      timestamp: string;
    };
    const word = (n: bigint) => n.toString(16).padStart(64, '0');
    const writer = TESTNET_RECORD.roles.priceWriter;
    await rpc(w, 'anvil_impersonateAccount', [writer]);
    await rpc(w, 'anvil_setBalance', [writer, '0xde0b6b3a7640000']);
    const hash = await rpc(w, 'eth_sendTransaction', [
      {
        from: writer,
        to: a.feed,
        data: `0xd7020576${word((answer * BigInt(10_000 + bps)) / 10_000n)}${word(BigInt(block.timestamp))}`,
      },
    ]);
    await rpc(w, 'anvil_stopImpersonatingAccount', [writer]);
    const receipt = (await rpc(w, 'eth_getTransactionReceipt', [hash])) as { status: string };
    expect(receipt.status).toBe('0x1');
  };

  it('with a 2% price bound: a sale out of a pool 1.5% under the feed is planned at the feed’s floor and lands; at 3% it stays', async () => {
    const w = await start();
    const cash = id('tusdg');
    const tsla = id('ttsla');
    const land = async (tx: BuiltTx) => {
      const { txId } = await w.send(tx);
      const receipt = await w.client.getTransactionReceipt({ hash: txId as `0x${string}` });
      expect(receipt.status, tx.description).toBe('success');
    };
    await w.movePrice(tsla, 0);
    // A vault of $100, all of it in one stock, opened by the world's own adapter.
    await land(await w.adapter.buildApprove({ owner, basketId: '94', amountRaw: DEPOSIT }));
    await land(
      await w.adapter.buildCreateVault({
        owner,
        basketId: '94',
        targets: [{ asset: tsla, weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: DEPOSIT,
        trades: [{ sell: cash, buy: tsla, amountInRaw: DEPOSIT }],
        slippageBps: 100,
      }),
    );
    const vault = (await w.adapter.getVaults(owner)).find((v) => v.basketId === '94');
    if (!vault) throw new Error('no vault');

    // The same copy, held to a 2% bound to the feed, as Robinhood Chain mainnet holds an owner's trade.
    const config = parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: 'testnet' },
      {
        robinhood: {
          factory: TESTNET_RECORD.contracts.factory,
          registry: TESTNET_RECORD.contracts.registry,
        },
      },
    ).robinhood;
    const bounded = createEvmVaultAdapter({
      config: { ...config, router: deploymentAddresses(TESTNET_RECORD).router },
      rpc: createEvmRpc(w.rpcUrl),
      assets: deploymentAssets(TESTNET_RECORD),
      pools: deploymentPools(TESTNET_RECORD),
      limits: { ...deploymentLimits(TESTNET_RECORD), priceBoundBps: 200 },
      trade: 'live',
      autoFollow: true,
    });
    const entry: ChainEntry = {
      chain: 'robinhood',
      mode: 'live',
      provenance: 'sandbox',
      source: 'a local copy of the test network, held to a 2% bound',
      config,
      adapter: bounded as ChainAdapter,
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
    const legOf = (s: Awaited<ReturnType<typeof planWithdraw>>['steps'][number], seq: number) =>
      ({
        id: `leg-${seq}`,
        kind: s.kind,
        chain: 'robinhood',
        trades: s.trades ?? [],
        expected: s.expected ?? [],
        ...(s.withdrawals ? { withdrawals: s.withdrawals } : {}),
      }) as Leg;

    // The feed 1.5% above the pool: inside the bound, and the feed's floor above 1% under the quote.
    await moveFeedOnly(w, tsla, 150);
    const plan = await planWithdraw(request, { principal, chains });
    expect(plan.warnings).toEqual([]);
    const [sale, out] = plan.steps;
    const figure = sale?.expected?.[0];
    if (!sale || !out || !figure) throw new Error('no sale');
    expect(BigInt(figure.minOutRaw)).toBeGreaterThan((BigInt(figure.outRaw) * 9_900n) / 10_000n);
    // built at the minimum the order stated, which the builder accepts, and it lands
    const swap = await buildWithdraw(request, legOf(sale, 0), entry, vault.owner, undefined);
    expect(swap.preview.minimums[0]?.minOutRaw).toBe(figure.minOutRaw);
    await land(swap);
    await land(await buildWithdraw(request, legOf(out, 1), entry, vault.owner, undefined));

    // The feed 3% above the pool: past the bound, the sale is not made, and the person is told.
    await moveFeedOnly(w, tsla, 300);
    // The vault holds no cash now, so with its one holding unsold there is nothing to pay out, and the
    // refusal names the holding.
    const far = await planWithdraw(request, { principal, chains }).catch((e: unknown) => e);
    expect(far).toBeInstanceOf(Refusal);
    expect((far as Refusal).body().details?.issues).toEqual([`NOT_SOLD:${tsla}`]);
    expect((far as Refusal).body().fix).toMatch(/tokens themselves/);
  });
});
