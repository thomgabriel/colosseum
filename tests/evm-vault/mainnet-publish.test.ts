import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCreatorLimits } from '@colosseum/basket';
import {
  createEvmRpc,
  createEvmVaultAdapter,
  deploymentAddresses,
  deploymentAssets,
  deploymentLimits,
  deploymentPools,
  EvmDeploymentRecord,
  type EvmVaultAdapter,
  indexIdOf,
} from '@colosseum/chain-evm/vault';
import { type BuiltTx, parseChainConfigs, stampTx } from '@colosseum/schemas';
import type { ApprovedStep, GuardDeployment } from '@colosseum/sdk';
import { deploymentsOf, familyIdOf, familyTextHash, guardTransaction } from '@colosseum/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The four shared portfolios of gate PRODUCTS-MAINNET-ONLY, published on a local copy of Robinhood
// Chain mainnet (4663) before Thom publishes them for real. Every address is the deploy record's
// (`deployments/robinhood-mainnet.json`) and the guard's (`packages/sdk/deployments/mainnet.json`), so
// after a redeploy the test reads the new registry and factory as they are written there: each is held to the creator limits the API
// checks (the factory's asset list, read from the copy), built by the EVM adapter as the order builds
// it, passed by the guard with the mainnet deployment the app signs with
// (packages/sdk/deployments/mainnet.json), sent from Thom's address impersonated by anvil, and read
// back from the registry. Nothing is sent to mainnet: anvil forks it and signs for the impersonated
// address on the copy alone.
//
//   RH_MAINNET_FORK_URL=https://rpc.mainnet.chain.robinhood.com pnpm exec vitest run tests/evm-vault/mainnet-publish.test.ts

const FORK_URL = process.env.RH_MAINNET_FORK_URL;
const PORT = Number(process.env.RH_MAINNET_PUBLISH_PORT ?? 28_771);
/** Thom's address on Robinhood Chain, as `contracts/script/config/4663.json` names it. */
const THOM = '0x0a1c3312c808b23d019bf241028f6b5624f4cc98';

const RECORD = EvmDeploymentRecord.parse(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', 'deployments', 'robinhood-mainnet.json'),
      'utf8',
    ),
  ),
);

/** The four, as the gate states them: weights in basis points. */
export const MAINNET_PORTFOLIOS = [
  {
    slug: 'us-stocks-broad',
    name: 'US stocks, broad',
    copy: 'Half the S&P 500, half the largest US companies by name.',
    weights: { spy: 5000, aapl: 1500, nvda: 1500, meta: 1000, tsla: 500, msft: 250, googl: 250 },
  },
  {
    slug: 'large-us-tech',
    name: 'Large US tech',
    copy: 'The biggest US tech names, each at the most its market can carry.',
    weights: { nvda: 2500, aapl: 2500, meta: 2500, tsla: 1500, googl: 500, msft: 500 },
  },
  {
    slug: 's-p-core-a-tilt-to-tech',
    name: 'S&P core, a tilt to tech',
    copy: 'The index at the centre, with three leaders beside it.',
    weights: { spy: 5000, meta: 2000, nvda: 1500, aapl: 1500 },
  },
  {
    slug: 'five-large-caps-even',
    name: 'Five large caps, even',
    copy: 'Five holdings, one fifth each, rebalanced to equal.',
    weights: { spy: 2000, nvda: 2000, aapl: 2000, meta: 2000, tsla: 2000 },
  },
] as const;

async function startAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    'anvil',
    ['--fork-url', forkUrl, '--port', String(port), '--no-priority-fee', '--silent'],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    if (Date.now() > until || child.exitCode !== null) {
      child.kill('SIGTERM');
      throw new Error('anvil did not start');
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe.skipIf(!FORK_URL)('the four mainnet portfolios, published on a copy of 4663', () => {
  vi.setConfig({ hookTimeout: 300_000, testTimeout: 180_000 });
  const rpcUrl = `http://127.0.0.1:${PORT}`;
  let anvil: ChildProcess | undefined;
  let adapter: EvmVaultAdapter;
  /** One JSON-RPC call to the copy. */
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };

  beforeAll(async () => {
    anvil = await startAnvil(FORK_URL ?? '', PORT);
    const { factory } = deploymentAddresses(RECORD);
    const config = parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: 'mainnet' },
      { robinhood: { factory, registry: RECORD.contracts.registry } },
    ).robinhood;
    adapter = createEvmVaultAdapter({
      config: { ...config, router: deploymentAddresses(RECORD).router },
      rpc: createEvmRpc(rpcUrl),
      assets: deploymentAssets(RECORD),
      pools: deploymentPools(RECORD),
      limits: deploymentLimits(RECORD),
      trade: 'live',
      autoFollow: false,
    });
    await rpc('anvil_impersonateAccount', [THOM]);
    await rpc('anvil_setBalance', [THOM, `0x${(10n ** 17n).toString(16)}`]);
  });
  afterAll(async () => {
    await rpc('anvil_stopImpersonatingAccount', [THOM]).catch(() => {});
    anvil?.kill('SIGTERM');
  });

  const deployment = () => {
    const robinhood = deploymentsOf('mainnet').robinhood;
    if (!robinhood) throw new Error('the guard has no Robinhood Chain mainnet');
    return robinhood as GuardDeployment;
  };

  it('signs on the registry the deploy record names, the same one the guard holds steps to', () => {
    expect(String((deployment() as { registry?: string }).registry).toLowerCase()).toBe(
      RECORD.contracts.registry.toLowerCase(),
    );
  });

  it('holds gold and AMZN at the least weight to the ceiling the factory states for them', async () => {
    const assets = await adapter.listAssets();
    for (const asset of ['robinhood:gld', 'robinhood:amzn']) {
      const verdict = checkCreatorLimits(
        null,
        [
          { asset: 'robinhood:spy', weightBps: 5000 },
          { asset: 'robinhood:meta', weightBps: 4800 },
          { asset, weightBps: 200 },
        ],
        { assets, now: 0, lastPublishAt: null, hasPending: false, publishDelay: 0 },
      );
      // Under the least weight on this factory (0.5% on the deploy of Oct 12), it is refused.
      const ceiling = assets.find((a) => a.id === asset)?.maxWeightBps ?? 0;
      expect(verdict.ok, asset).toBe(ceiling >= 200);
      if (!verdict.ok) expect(verdict.code).toBe('WeightAboveCeiling');
    }
  });

  for (const p of MAINNET_PORTFOLIOS)
    it(`publishes "${p.name}": within the limits, passed by the guard, version 1 in effect at once`, async () => {
      const components = Object.entries(p.weights).map(([symbol, weightBps]) => ({
        asset: `robinhood:${symbol}`,
        weightBps,
      }));
      // The creator limits, as the API checks them against the factory's list on the chain.
      const verdict = checkCreatorLimits(null, components, {
        assets: await adapter.listAssets(),
        now: 0,
        lastPublishAt: null,
        hasPending: false,
        publishDelay: 0,
      });
      expect(verdict.ok, verdict.ok ? '' : verdict.detail).toBe(true);

      const familyId = familyIdOf(p.slug);
      const text = { slug: p.slug, name: p.name, copy: p.copy, kind: 'index' as const };
      const tx: BuiltTx = await adapter.buildPublishRecipe({
        creator: THOM,
        recipe: {
          schemaVersion: 1,
          familyId,
          chain: 'robinhood',
          onchainId: null,
          creator: THOM,
          kind: 'community',
          version: 1,
          effectiveAt: 0,
          components: components.map((c) => ({ kind: 'asset' as const, ...c })),
          metaHash: familyTextHash({ familyId, ...text }),
          maxFeeBps: 0,
          flags: 0,
        },
      });
      // The guard holds the bytes to the step the review showed.
      const legId = `publish-${p.slug}`;
      const guarded = guardTransaction({
        step: {
          kind: 'publish',
          basketId: '0',
          action: 'publish',
          familyId,
          components,
          text,
          version: 1,
          legId,
          chain: 'robinhood',
          owner: THOM,
        } as ApprovedStep,
        tx: stampTx(tx, { legId, attemptId: `${legId}-a` }),
        deployment: deployment(),
        consents: ['publish'],
      });
      expect(guarded.tx.messageHash).toBe(tx.messageHash);
      expect(tx.evm?.to?.toLowerCase()).toBe(RECORD.contracts.registry.toLowerCase());

      // Sent on the copy, as Thom, and read back from the registry.
      const hash = await rpc<string>('eth_sendTransaction', [
        {
          from: THOM,
          to: tx.evm?.to,
          data: tx.payload,
          value: '0x0',
          ...(tx.evm?.gas !== undefined ? { gas: `0x${tx.evm.gas.toString(16)}` } : {}),
        },
      ]);
      // anvil mines it at once; its receipt can take a moment to be answered
      type Receipt = { status: string; gasUsed: string };
      let receipt: Receipt | null = null;
      for (let i = 0; i < 50 && !receipt; i += 1) {
        receipt = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
        if (!receipt) await new Promise((r) => setTimeout(r, 200));
      }
      if (!receipt) throw new Error('no receipt on the copy');
      expect(receipt.status).toBe('0x1');
      console.log(`${p.name}: create on the copy, ${BigInt(receipt.gasUsed)} gas`);
      const read = await adapter.getRecipe(indexIdOf(THOM, familyId));
      expect(read.active.creator.toLowerCase()).toBe(THOM);
      expect(read.active.version).toBe(1);
      expect(read.pending).toBeNull();
      expect(
        read.active.components
          .flatMap((c) => (c.kind === 'asset' ? [[c.asset, c.weightBps]] : []))
          .sort(),
      ).toEqual(components.map((c) => [c.asset, c.weightBps]).sort());
    });
});
