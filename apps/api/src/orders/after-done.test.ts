import {
  type BasketSheet,
  type ChainId,
  LeaderboardResponse,
  OrderDetail,
  PortfolioResponse,
  type Provenance,
  YieldObservation,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearingPlanInputs } from '../plan-inputs';
import { PersonalizeResponse } from '../routes/v1/baskets';
import { readVaultsWhenDone } from '../routes/v1/index';
import mockYields from '../testing/fixtures/mock-yields.json';
import { orderFlow } from '../testing/flow';
import { person, type TestIssuer, testApp, testDb, testIssuer } from '../testing/harness';
import { seedSnapshot, seedVault, vaultAddress } from '../testing/portfolio-world';
import { READ_AFTER_MS, readOnDone, type VaultReader, vaultsOfDone } from './after-done';
import type { ChainRegistry } from './chains';
import type { PlanInputs } from './personalize';
import type { StoredOrder } from './store';

// Once an order is done its vault is read at once with the snapshot worker's reader (gate
// SNAPSHOT-IN-API, amended Oct 30), so its value shows without waiting for the next pass. First the
// hook on its own: one order read once, never thrown. Then over HTTP on the mock chains and the real
// database: a buy that opens a vault, and money added to it, each read once they are done, the
// leaderboard showing the value, and a read that fails leaving the order as it was.

vi.setConfig({ testTimeout: 90_000 });

const quiet = { info: () => {}, warn: () => {} };

/** A stored order as far as the hook reads it. */
const done = (over: { id?: string; request: unknown; basketId?: string }): StoredOrder =>
  ({
    order: {
      id: over.id ?? 'order-1',
      owner: { solana: 'Owner1111' },
      basketId: over.basketId,
      legs: [{ chain: 'solana' as ChainId }],
      status: 'done',
    },
    request: over.request,
    attempts: [],
  }) as unknown as StoredOrder;

const chains = {
  get: () => ({ provenance: 'sandbox' as Provenance }),
} as unknown as ChainRegistry;
const noDb = {} as Parameters<typeof vaultsOfDone>[0]['db'];

describe('the vault of a done order, read once', () => {
  it('names the vaults an order acted on, and none for one that acted on no vault of the person', async () => {
    const deps = { db: noDb, chains };
    expect(
      await vaultsOfDone(deps, done({ request: { type: 'withdraw', vaults: ['V1', 'V1'] } })),
    ).toEqual({ chain: 'solana', addresses: ['V1'] });
    expect(
      await vaultsOfDone(deps, done({ request: { type: 'rebalance', vaults: ['V2'] } })),
    ).toEqual({ chain: 'solana', addresses: ['V2'] });
    expect(await vaultsOfDone(deps, done({ request: { type: 'follow', vault: 'V3' } }))).toEqual({
      chain: 'solana',
      addresses: ['V3'],
    });
    expect(
      await vaultsOfDone(
        deps,
        done({ request: { type: 'buy', vault: { chain: 'solana', address: 'V4' } } }),
      ),
    ).toEqual({ chain: 'solana', addresses: ['V4'] });
    expect(await vaultsOfDone(deps, done({ request: { type: 'publish' } }))).toBeNull();
  });

  it('reads an order once however often it is told, after the wait, and under the chain label', async () => {
    vi.useFakeTimers();
    try {
      const asked: unknown[][] = [];
      const reader: VaultReader = {
        reads: () => true,
        read: async (...a) => {
          asked.push(a);
          return { outcome: 'read' };
        },
      };
      const listen = readOnDone({ db: noDb, chains }, () => reader, quiet);
      const order = done({ request: { type: 'withdraw', vaults: ['V1'] } });
      listen(order);
      listen(order);
      expect(asked).toEqual([]);
      await vi.advanceTimersByTimeAsync(READ_AFTER_MS);
      expect(asked).toEqual([['solana', 'sandbox', 'V1']]);
      listen(order);
      await vi.advanceTimersByTimeAsync(READ_AFTER_MS);
      expect(asked).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads nothing where no reader is set, and logs a read that fails without throwing', async () => {
    vi.useFakeTimers();
    try {
      const warned: string[] = [];
      let reader: VaultReader | null = null;
      const listen = readOnDone({ db: noDb, chains }, () => reader, {
        info: () => {},
        warn: (_o, msg) => warned.push(msg ?? ''),
      });
      expect(() =>
        listen(done({ id: 'a', request: { type: 'withdraw', vaults: ['V1'] } })),
      ).not.toThrow();
      await vi.advanceTimersByTimeAsync(READ_AFTER_MS);
      expect(warned).toEqual([]);
      reader = {
        reads: () => true,
        read: async () => {
          throw new Error('Unavailable: the node did not answer');
        },
      };
      listen(done({ id: 'b', request: { type: 'withdraw', vaults: ['V1'] } }));
      await vi.advanceTimersByTimeAsync(READ_AFTER_MS);
      expect(warned).toEqual([
        'the vault of a done order was not read: it is read at the next pass',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks a chain the worker does not read nothing, not even the address of a new vault', async () => {
    vi.useFakeTimers();
    try {
      const getVaults = vi.fn(async () => [{ basketId: '7', address: 'New1' }]);
      const onChain = {
        get: () => ({ provenance: 'sandbox' as Provenance, adapter: { getVaults } }),
      } as unknown as ChainRegistry;
      const read = vi.fn(async () => ({ outcome: 'read' as const }));
      const warned: string[] = [];
      const listen = readOnDone(
        { db: noDb, chains: onChain },
        () => ({ reads: () => false, read }),
        { info: () => {}, warn: (_o, msg) => warned.push(msg ?? '') },
      );
      listen(done({ request: { type: 'buy' }, basketId: '7' }));
      await vi.advanceTimersByTimeAsync(READ_AFTER_MS);
      expect(getVaults).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      // Nothing was tried, so nothing failed: `noDb` would have thrown had the cache been asked.
      expect(warned).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes on to the next vault when one read fails', async () => {
    vi.useFakeTimers();
    try {
      const asked: string[] = [];
      const warned: string[] = [];
      const listen = readOnDone(
        { db: noDb, chains },
        () => ({
          reads: () => true,
          read: async (_c, _p, address) => {
            asked.push(address);
            if (address === 'V1') throw new Error('Unavailable: the node did not answer');
            return { outcome: 'read' };
          },
        }),
        { info: () => {}, warn: (_o, msg) => warned.push(msg ?? '') },
      );
      listen(done({ request: { type: 'withdraw', vaults: ['V1', 'V2'] } }));
      await vi.advanceTimersByTimeAsync(READ_AFTER_MS);
      expect(asked).toEqual(['V1', 'V2']);
      expect(warned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
const logged: string[] = [];
const undo: (() => Promise<unknown>)[] = [];
const withMockYield: PlanInputs = async (q) => ({
  ...(await bearingPlanInputs(q)),
  yields: YieldObservation.array()
    .parse(mockYields)
    .filter((y) => q.assets.some((a) => a.id === y.assetId)),
});

/** What the reader was asked, and whether it fails now. */
const reads: { chain: ChainId; provenance: Provenance; address: string }[] = [];
let failing = false;

beforeAll(async () => {
  issuer = await testIssuer('after-done');
  data = await testDb();
  undo.push(() => data.cleanUp());
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    planInputs: withMockYield,
    logTo: { write: (line) => void logged.push(line) },
  }));
  undo.push(() => app.close());
  // The worker's reader, as the server hands it in: here the mock chain's vault, kept as a row.
  readVaultsWhenDone(app, {
    reads: () => true,
    read: async (chain, provenance, address) => {
      reads.push({ chain, provenance, address });
      if (failing) throw new Error('Unavailable: the node did not answer');
      const vault = await registry.get(chain).adapter.getVault(address);
      if (!vault) return { outcome: 'none' };
      await seedSnapshot(data.db, {
        chain,
        address,
        owner: vault.owner,
        onchainBasketId: vault.basketId,
        observedAt: new Date(),
        valueUsd: 4_321.5,
      });
      return { outcome: 'read' };
    },
  });
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { post, get, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => ({ solana: '', robinhood: '' }),
});

const sheet: BasketSheet = {
  basketType: 'standard',
  goal: 'grow',
  amountUsd: 5_000,
  horizonMonths: 60,
  risk: 'high',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
};

describe('a done order on the mock chain', () => {
  it("finds a new vault's address under this server's label, not a row of the same number under another", async () => {
    const who = data.track(await person(issuer, 'solana'));
    const owner = who.owner.solana;
    if (!owner) throw new Error('no wallet');
    await seedVault(data.db, {
      chain: 'solana',
      owner,
      address: vaultAddress('solana'),
      onchainBasketId: '77',
      provenance: 'sandbox',
    });
    const onChain = {
      get: () => ({
        provenance: 'mock' as Provenance,
        adapter: { getVaults: async () => [{ basketId: '77', address: 'OnThisChain' }] },
      }),
    } as unknown as ChainRegistry;
    const stored = done({ request: { type: 'buy' }, basketId: '77' });
    stored.order.owner = { solana: owner };
    expect(await vaultsOfDone({ db: data.db, chains: onChain }, stored)).toEqual({
      chain: 'solana',
      addresses: ['OnThisChain'],
    });
  });

  it('has its new vault read once, and the leaderboard shows its value; money added is read too', async () => {
    const who = data.track(await person(issuer, 'solana'));
    await fund(who, undefined, 50_000);
    const res = await post(who, '/v1/baskets/personalize', { sheet });
    expect(res.statusCode, res.body).toBe(200);
    const plan = PersonalizeResponse.parse(res.json());
    const bought = await settleAll(
      who,
      await order(who, { amountUsd: 1_000, proposalId: plan.id }),
    );
    expect(bought.status).toBe('done');

    const portfolio = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json());
    const vault = portfolio.chains.find((c) => c.chain === 'solana')?.vaults[0];
    if (!vault) throw new Error('the buy opened no vault');
    await vi.waitFor(
      () => expect(reads.filter((r) => r.address === vault.address)).toHaveLength(1),
      { timeout: READ_AFTER_MS + 5_000 },
    );
    expect(reads.find((r) => r.address === vault.address)).toEqual({
      chain: 'solana',
      provenance: 'mock',
      address: vault.address,
    });

    const board = LeaderboardResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/leaderboard?chain=solana' })).json(),
    );
    expect(board.vaults.find((v) => v.address === vault.address)?.value?.usd).toBe('4321.50');

    // Money added to the vault: read again once that order is done.
    const added = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 200,
      vault: { chain: 'solana', address: vault.address },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect((await settleAll(who, OrderDetail.parse(added.json()))).status).toBe('done');
    await vi.waitFor(
      () => expect(reads.filter((r) => r.address === vault.address)).toHaveLength(2),
      { timeout: READ_AFTER_MS + 5_000 },
    );
  });

  it('stays done when the read fails, and the failure is a warning in the log', async () => {
    failing = true;
    try {
      const who = data.track(await person(issuer, 'solana'));
      await fund(who, undefined, 50_000);
      const plan = PersonalizeResponse.parse(
        (await post(who, '/v1/baskets/personalize', { sheet })).json(),
      );
      const placed = await order(who, { amountUsd: 500, proposalId: plan.id });
      const before = reads.length;
      expect((await settleAll(who, placed)).status).toBe('done');
      await vi.waitFor(() => expect(reads.length).toBe(before + 1), {
        timeout: READ_AFTER_MS + 5_000,
      });
      await vi.waitFor(() =>
        expect(
          logged.some((l) =>
            l.includes('the vault of a done order was not read: it is read at the next pass'),
          ),
        ).toBe(true),
      );
      const again = OrderDetail.parse((await get(who, `/v1/orders/${placed.id}`)).json());
      expect(again.status).toBe('done');
    } finally {
      failing = false;
    }
  });
});
