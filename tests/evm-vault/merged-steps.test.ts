import {
  type Address,
  BuiltTx,
  type ChainAdapter,
  type ConsentKind,
  type Leg,
  type Principal,
  parseChainConfigs,
  stampTx,
} from '@colosseum/schemas';
import type { ApprovedStep, GuardDeployment, PlanTerms } from '@colosseum/sdk';
import { approvedSteps, deploymentsOf, guardTransaction } from '@colosseum/sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../apps/api/src/orders/chains';
import { buildWithdraw, planWithdraw } from '../../apps/api/src/orders/withdraw';
import {
  ACCOUNTS,
  buildTestnetWorld,
  id,
  TESTNET_RECORD,
  type TestnetWorld,
} from '../../packages/chain-evm/test/testnet-world';

// A step that makes several of the vault's calls in one transaction (gate EVM-MULTICALL-STEPS), on a
// copy of Robinhood Chain's test network: built by the adapter and the order layer's planners, held to
// the guard of packages/sdk with the committed test network deployment, and landed. A buy's eleven
// purchases ride in its deposit; a follow switches auto-follow beside the version it takes; a
// withdrawal, of the tokens or in dollars, switches it off before anything leaves.
//
//   RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run tests/evm-vault/merged-steps.test.ts

const FORK_URL = process.env.RH_TESTNET_FORK_URL;
const PORT = Number(process.env.RH_TESTNET_MERGED_PORT ?? 28_777);
const owner = ACCOUNTS.owner as Address;
const ALL = [
  'tspy',
  'tqqq',
  'tnvda',
  'taapl',
  'tmsft',
  'tgoogl',
  'tamzn',
  'tmeta',
  'ttsla',
  'tgld',
];

describe.skipIf(!FORK_URL)('several of the vault calls in one step, on a copy of 46630', () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 300_000 });
  let started: Promise<TestnetWorld> | undefined;
  const start = () => {
    started ??= buildTestnetWorld(FORK_URL ?? '', PORT);
    return started;
  };
  afterAll(async () => (await started)?.stop());

  const deployment = () => deploymentsOf('testnet').robinhood as GuardDeployment;
  /** Lands what was built, and answers its receipt: it went through. */
  const land = async (w: TestnetWorld, tx: BuiltTx) => {
    const { txId } = await w.send(tx);
    const receipt = await w.client.getTransactionReceipt({ hash: txId as `0x${string}` });
    expect(receipt.status, tx.description).toBe('success');
    // The fork's hashes, for the record of the run: a copy of 46630, never the network itself.
    console.info(
      `fork ${tx.legKind}: ${receipt.transactionHash}, stated ${tx.evm?.gas} gas, used ${receipt.gasUsed} (${tx.description.slice(0, 120)})`,
    );
    return receipt;
  };
  let n = 0;
  /** The guard on a build, as the step the review approved. */
  const guard = (step: Record<string, unknown>, tx: BuiltTx, consents: ConsentKind[] = []) => {
    n += 1;
    const legId = `leg-${n}`;
    return guardTransaction({
      step: { ...step, legId, chain: 'robinhood', owner } as ApprovedStep,
      tx: stampTx(tx, { legId, attemptId: `${legId}-a` }),
      deployment: deployment(),
      consents,
    });
  };
  const tradesOf = (tx: BuiltTx) => tx.preview.minimums.map((m) => ({ ...m }));
  const entryOf = (w: TestnetWorld): ChainEntry => ({
    chain: 'robinhood',
    mode: 'live',
    provenance: 'sandbox',
    source: 'a local copy of the test network',
    config: parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: 'testnet' },
      {
        robinhood: {
          factory: TESTNET_RECORD.contracts.factory,
          registry: TESTNET_RECORD.contracts.registry,
        },
      },
    ).robinhood,
    adapter: w.adapter as ChainAdapter,
  });
  /** The planned steps of a withdrawal as an order's legs. */
  const legsOf = (steps: Awaited<ReturnType<typeof planWithdraw>>['steps']): Leg[] =>
    steps.map(
      (s, seq) =>
        ({
          id: `w-${n}-${seq}`,
          orderId: 'order',
          chain: 'robinhood',
          seq,
          kind: s.kind,
          signer: 'owner',
          description: s.description,
          trades: s.trades ?? [],
          expected: s.expected ?? [],
          ...(s.withdrawals ? { withdrawals: s.withdrawals } : {}),
          ...(s.switchAutoFollow === undefined ? {} : { switchAutoFollow: s.switchAutoFollow }),
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

  it("a buy of ten assets: the deposit and every purchase in one step, under the guard's gas", async () => {
    const w = await start();
    const { adapter } = w;
    for (const s of ALL) await w.movePrice(id(s), 0);
    const per = 5_000_000n;
    const total = (per * BigInt(ALL.length)).toString();
    const targets = ALL.map((s) => ({ asset: id(s), weightBps: 1_000 }));
    const create = await adapter.buildCreateVault({
      owner,
      basketId: '601',
      targets,
      autoFollow: false,
      slippageBps: 100,
    });
    guard(
      {
        kind: 'create_vault',
        basketId: '601',
        targets,
        follow: null,
        autoFollow: false,
        depositRaw: '0',
        trades: [],
      },
      create,
    );
    await land(w, create);
    const approve = await adapter.buildApprove({ owner, basketId: '601', amountRaw: total });
    guard({ kind: 'approve', basketId: '601', amountRaw: total }, approve);
    await land(w, approve);
    const vault = (await adapter.getVaults(owner)).find((v) => v.basketId === '601');
    if (!vault) throw new Error('no vault');
    const deposit = await adapter.buildDeposit({
      vault: vault.address,
      amountRaw: total,
      trades: ALL.map((s) => ({ sell: id('tusdg'), buy: id(s), amountInRaw: per.toString() })),
      slippageBps: 100,
    });
    guard(
      { kind: 'deposit', basketId: '601', amountRaw: total, trades: tradesOf(deposit) },
      deposit,
    );
    const receipt = await land(w, deposit);
    // What the step states and what it used, under the 5 million the guard allows.
    expect(deposit.evm?.gas).toBeLessThan(5_000_000);
    console.info(
      `deposit and ${ALL.length} purchases: stated ${deposit.evm?.gas} gas, used ${receipt.gasUsed}`,
    );
    const after = await adapter.getVault(vault.address);
    for (const s of ALL)
      expect(BigInt(after?.positions.find((p) => p.asset === id(s))?.raw ?? '0')).toBeGreaterThan(
        0n,
      );
  });

  it('a follow switches auto-follow beside the version: off before it, and on after it', async () => {
    const w = await start();
    const { adapter, newAssetVault, manualVault, recipeB } = w;
    const follow = { recipeOnchainId: recipeB, version: 2 };
    // A vault that follows version 1 with auto-follow on, made to follow version 2 with it off.
    const off = await adapter.buildAcceptVersion({
      vault: newAssetVault,
      recipeOnchainId: recipeB,
      expectedVersion: 2,
      switchAutoFollow: false,
    });
    guard({ kind: 'accept_version', basketId: '3', follow, switchAutoFollow: false }, off, [
      'new_asset',
    ]);
    await land(w, off);
    expect((await adapter.getVault(newAssetVault))?.autoFollow).toBe(false);
    expect((await adapter.getVault(newAssetVault))?.acceptedVersion).toBe(2);
    // A vault of its own targets, made to follow version 2 with auto-follow on.
    const on = await adapter.buildAcceptVersion({
      vault: manualVault,
      recipeOnchainId: recipeB,
      expectedVersion: 2,
      switchAutoFollow: true,
    });
    const step = { kind: 'accept_version', basketId: '2', follow, switchAutoFollow: true };
    // The switch on needs its own consent beside the version's.
    expect(() => guard(step, on, ['new_asset'])).toThrow(/consent/);
    guard(step, on, ['new_asset', 'auto_follow_on']);
    await land(w, on);
    const now = await adapter.getVault(manualVault);
    expect([now?.autoFollow, now?.acceptedVersion]).toEqual([true, 2]);
  });

  it('a withdrawal of the tokens switches auto-follow off before they leave, in one step', async () => {
    const w = await start();
    const { adapter, vault } = w;
    const entry = entryOf(w);
    const chains = { get: () => entry } as unknown as ChainRegistry;
    const principal: Principal = {
      kind: 'user',
      userId: 'did:test:owner',
      wallets: [{ family: 'evm', address: owner, kind: 'external' }],
      ip: '127.0.0.1',
    };
    expect((await adapter.getVault(vault))?.autoFollow).toBe(true);
    const request = { type: 'withdraw' as const, vaults: [vault], sellToCash: false };
    const plan = await planWithdraw(request, { principal, chains });
    expect(plan.steps.map((s) => [s.kind, s.switchAutoFollow])).toEqual([['withdraw', false]]);
    const legs = legsOf(plan.steps);
    const terms: PlanTerms = { basketId: '1', autoFollow: false };
    const [step] = approvedSteps({ id: 'order', owner: { evm: owner }, legs }, terms, deployment());
    const [leg] = legs;
    if (!step || !leg) throw new Error('no step');
    const tx = BuiltTx.parse(await buildWithdraw(request, leg, entry, owner, undefined));
    guardTransaction({
      step,
      tx: stampTx(tx, { legId: leg.id, attemptId: 'a' }),
      deployment: deployment(),
      consents: [],
    });
    await land(w, tx);
    const after = await adapter.getVault(vault);
    expect(after?.autoFollow).toBe(false);
    expect(
      [after?.cash.raw, ...(after?.positions.map((p) => p.raw) ?? [])].every((r) => r === '0'),
    ).toBe(true);
  });

  it('a withdrawal in dollars switches auto-follow off before its sales, then takes the cash out', async () => {
    const w = await start();
    const { adapter } = w;
    const entry = entryOf(w);
    const chains = { get: () => entry } as unknown as ChainRegistry;
    const principal: Principal = {
      kind: 'user',
      userId: 'did:test:owner',
      wallets: [{ family: 'evm', address: owner, kind: 'external' }],
      ip: '127.0.0.1',
    };
    const vault = (await adapter.getVaults(owner)).find((v) => v.basketId === '601');
    if (!vault) throw new Error('the buy above opened no vault');
    await land(w, await adapter.buildSetAutoFollow({ vault: vault.address, on: true }));
    for (const s of ALL) await w.movePrice(id(s), 0);
    const request = {
      type: 'withdraw' as const,
      vaults: [vault.address],
      sellToCash: true,
      shareBps: 5_000,
    };
    const plan = await planWithdraw(request, { principal, chains });
    expect(plan.steps.map((s) => [s.kind, s.switchAutoFollow])).toEqual([
      ['swap', false],
      ['withdraw', undefined],
    ]);
    const legs = legsOf(plan.steps);
    const held = (await adapter.getVault(vault.address)) ?? vault;
    const terms: PlanTerms = {
      basketId: '601',
      autoFollow: false,
      dollars: {
        cashRaw: (BigInt(held.cash.raw) / 2n).toString(),
        sales: (plan.steps[0]?.trades ?? []).map((t) => ({
          asset: t.sell,
          amountRaw: t.amountInRaw,
        })),
      },
    };
    const steps = approvedSteps({ id: 'order', owner: { evm: owner }, legs }, terms, deployment());
    for (const leg of legs) {
      const tx = BuiltTx.parse(await buildWithdraw(request, leg, entry, owner, undefined, legs));
      const step = steps.find((s) => s.legId === leg.id);
      if (!step) throw new Error('no approved step');
      guardTransaction({
        step,
        tx: stampTx(tx, { legId: leg.id, attemptId: 'a' }),
        deployment: deployment(),
        consents: [],
      });
      await land(w, tx);
    }
    expect((await adapter.getVault(vault.address))?.autoFollow).toBe(false);
  });

  it("new targets and ten trades toward them in one step, under the guard's gas", async () => {
    const w = await start();
    const { adapter } = w;
    const vault = (await adapter.getVaults(owner)).find((v) => v.basketId === '601');
    if (!vault) throw new Error('the buy above opened no vault');
    for (const s of ALL) await w.movePrice(id(s), 0);
    const now = (await adapter.getVault(vault.address)) ?? vault;
    // All of one stock: nine sales of what it holds, then a dollar of what they bring into tSPY.
    const sales = now.positions
      .filter((p) => p.asset !== id('tspy') && BigInt(p.raw) > 0n)
      .map((p) => ({ sell: p.asset, buy: id('tusdg'), amountInRaw: p.raw }));
    const trades = [...sales, { sell: id('tusdg'), buy: id('tspy'), amountInRaw: '1000000' }];
    expect(trades).toHaveLength(10);
    const targets = [{ asset: id('tspy'), weightBps: 10_000 }];
    const tx = await adapter.buildSetTargets({
      vault: vault.address,
      targets,
      trades,
      slippageBps: 100,
    });
    guard({ kind: 'set_targets', basketId: '601', targets, trades: tradesOf(tx) }, tx);
    await land(w, tx);
    expect(tx.evm?.gas).toBeLessThan(5_000_000);
  });
});
