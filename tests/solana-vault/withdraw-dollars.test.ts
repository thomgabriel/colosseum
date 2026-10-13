import { vaultAddress } from '@colosseum/chain-solana/vault';
import { BuiltTx, type ChainAdapter, type Leg, type Principal, stampTx } from '@colosseum/schemas';
import {
  approvedSteps,
  type DeploymentFile,
  deploymentsOf,
  type GuardDeployment,
  GuardRefusal,
  guardTransaction,
} from '@colosseum/sdk';
import { lamports } from '@solana/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../apps/api/src/orders/chains';
import { buildWithdraw, planWithdraw } from '../../apps/api/src/orders/withdraw';
import { withFile } from '../../packages/sdk/test/deployments';
import { priceAccountBytes } from './admin';
import {
  buildContractWorld,
  type ContractWorld,
  id,
  newKey,
  priceEntries,
  shelfOf,
} from './contract-world';
import {
  BASKET_PROGRAM,
  createSvmNode,
  MOCK_ROUTER_PROGRAM,
  PROGRAMS_BUILT,
  type SvmNode,
} from './svm-node';

// A withdrawal in dollars (gate WITHDRAW-DOLLARS) on the Solana adapter, in LiteSVM with the built
// programs: auto-follow off first, then each holding sold for the cash token by `owner_swap`, one a
// step, then the cash out by `withdraw`, to the owner's own token account. Every step is built by the
// API's own planner and builder and held by the guard to the review's terms before it is signed. No
// instruction of the program is new: it is the owner's swap and the owner's withdrawal.

vi.mock(
  '../../packages/sdk/src/guard/generated/deployment-files',
  () => import('../../packages/sdk/test/deployments'),
);

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe.skipIf(!PROGRAMS_BUILT)('a withdrawal in dollars on Solana, in LiteSVM', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let node: SvmNode;
  let w: ContractWorld;
  let deployment: GuardDeployment;

  beforeAll(async () => {
    const deployer = await newKey();
    const start = BigInt(Math.floor(Date.now() / 1000));
    node = await createSvmNode(deployer.address, start);
    node.svm.airdrop(deployer.address, lamports(1_000_000_000_000n));
    const priceAccount = (await newKey()).address;
    const writePrices = (at: bigint, header = true) => {
      const data = priceAccountBytes(priceEntries(0), at, node.svm.getClock().slot, header);
      node.svm.setAccount({
        address: priceAccount,
        data,
        executable: false,
        lamports: lamports(node.svm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: MOCK_ROUTER_PROGRAM,
        space: BigInt(data.length),
      });
    };
    writePrices(start, false);
    w = await buildContractWorld(
      {
        rpc: node.rpc,
        land: async (tx) => {
          const landed = node.land(tx);
          return { signature: landed.signature, failed: landed.err !== null, logs: landed.logs };
        },
        advance: async (seconds) => {
          node.advance(seconds);
        },
        now: async () => node.now(),
        refreshPrices: writePrices,
      },
      {
        deployer,
        priceAccount,
        pendingVersion: false,
        network: 'local',
        notBefore: new Date().toISOString(),
      },
    );
    const file: DeploymentFile = {
      format: 'guard-deployment/1',
      network: 'local',
      chains: {
        solana: {
          family: 'solana',
          program: BASKET_PROGRAM,
          router: MOCK_ROUTER_PROGRAM,
          cash: id('cash'),
          assets: Object.fromEntries(
            Object.entries(w.mints).map(([name, m]) => [
              id(name),
              {
                mint: m.address,
                tokenProgram: m.tokenProgram === TOKEN ? 'token' : 'token-2022',
                decimals: shelfOf()[name]?.decimals ?? -1,
              },
            ]),
          ),
        },
      },
    };
    const loaded = withFile(file, () => deploymentsOf('local')).solana;
    if (!loaded) throw new Error('the world has no deployment');
    deployment = loaded;
  }, 180_000);

  it('switches auto-follow off, sells every holding for cash a step each, then withdraws the cash to the owner', async () => {
    const owner = w.keys.owner.address;
    const cash = id('cash');
    // The world's first vault: it follows a shared portfolio with auto-follow on, and holds three
    // assets and cash.
    const address = await vaultAddress(BASKET_PROGRAM, owner, 1n);
    const vault = await w.adapter.getVault(address);
    if (!vault) throw new Error('no vault');
    expect(vault.autoFollow).toBe(true);
    const held = vault.positions.filter((p) => BigInt(p.raw) > 0n);
    expect(held.length).toBe(3);

    const entry: ChainEntry = {
      chain: 'solana',
      mode: 'live',
      provenance: 'sandbox',
      source: 'LiteSVM',
      config: w.config,
      adapter: w.adapter as ChainAdapter,
    };
    const chains = { get: () => entry } as unknown as ChainRegistry;
    const principal: Principal = {
      kind: 'user',
      userId: 'did:test:owner',
      wallets: [{ family: 'solana', address: owner, kind: 'external' }],
      ip: '127.0.0.1',
    };
    const request = { type: 'withdraw' as const, vaults: [vault.address], sellToCash: true };
    const plan = await planWithdraw(request, { principal, chains });
    expect(plan.warnings).toEqual([]);
    expect(plan.steps.map((s) => s.kind)).toEqual([
      'set_auto_follow',
      'swap',
      'swap',
      'swap',
      'withdraw',
    ]);
    const sales = plan.steps.filter((s) => s.kind === 'swap');
    expect(sales.flatMap((s) => s.trades ?? [])).toEqual(
      held.map((p) => ({ sell: p.asset, buy: cash, amountInRaw: p.raw })),
    );
    const minimums = sales
      .flatMap((s) => s.expected ?? [])
      .reduce((n, e) => n + BigInt(e.minOutRaw), 0n);
    const least = BigInt(vault.cash.raw) + minimums;
    expect(plan.steps.at(-1)?.withdrawals).toMatchObject([
      { asset: cash, amountRaw: null, heldRaw: vault.cash.raw, leastRaw: least.toString() },
    ]);

    const legs = plan.steps.map(
      (s, seq) =>
        ({
          id: `leg-${seq}`,
          orderId: 'order',
          chain: 'solana',
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
    const steps = approvedSteps(
      { id: 'order', owner: { solana: owner }, legs },
      {
        basketId: '1',
        autoFollow: false,
        dollars: {
          cashRaw: vault.cash.raw,
          sales: held.map((p) => ({ asset: p.asset, amountRaw: p.raw })),
        },
      },
      deployment,
    );
    const walletCash = async () =>
      BigInt((await w.adapter.getWalletHoldings(owner)).find((h) => h.asset === cash)?.raw ?? '0');
    const before = await walletCash();

    for (const [i, leg] of legs.entries()) {
      const step = steps[i];
      if (!step) throw new Error('no approved step');
      const tx = BuiltTx.parse(await buildWithdraw(request, leg, entry, owner, undefined));
      const stamped = stampTx(tx, { legId: leg.id, attemptId: `${leg.id}-a` });
      guardTransaction({ step, tx: stamped, deployment, consents: [] });
      if (leg.kind === 'withdraw') {
        // The same bytes held to a step that pays more than they do are refused.
        const more = {
          ...step,
          withdrawals: [{ asset: cash, amountRaw: null, minRaw: (10n ** 15n).toString() }],
        };
        expect(() =>
          guardTransaction({
            step: more as typeof step,
            tx: stamped,
            deployment,
            consents: [],
          }),
        ).toThrow(GuardRefusal);
      }
      await w.must(tx);
    }

    const after = await w.adapter.getVault(address);
    expect(after?.autoFollow).toBe(false);
    expect(after?.cash.raw).toBe('0');
    expect((after?.positions ?? []).every((p) => p.raw === '0')).toBe(true);
    expect((await walletCash()) - before).toBeGreaterThanOrEqual(least);
  });
});
