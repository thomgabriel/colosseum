import { randomUUID } from 'node:crypto';
import { familyIdOf } from '@colosseum/basket';
import {
  createEvmVaultAdapter,
  deploymentLimits,
  deploymentPools,
  deploymentAssets as evmAssets,
} from '@colosseum/chain-evm/vault';
import { mockAddress } from '@colosseum/chain-mock';
import {
  createSolanaVaultAdapter,
  deploymentAssets as solanaAssets,
} from '@colosseum/chain-solana/vault';
import { proposals, users } from '@colosseum/db';
import {
  type BasketProposal,
  type ChainAdapter,
  ChainError,
  type ChainId,
  OrderDetail,
  PortfolioResponse,
  parseChainConfigs,
  type Reason,
  VaultResponse,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { evmDeployment, solanaDeployment } from '../../deployments';
import type { ChainEntry, ChainRegistry } from '../../orders/chains';
import { chainOf, orderFlow } from '../../testing/flow';
import {
  type HomeChain,
  type Person,
  type PersonKind,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import { heightOrNull, VAULT_HEIGHT_MS, VAULT_KEPT_MS } from './vault';

// The public vault page's read (WEB-4): any vault by its chain and address, for anybody, as its chain
// has it now, with the chain's height it was read at and why each holding is there.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: { solana: string; robinhood: string };
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('test');
  data = await testDb();
  undo.push(() => data.cleanUp());
  plans = {
    solana: await data.storePlan(planFixture('solana')),
    robinhood: await data.storePlan(planFixture('robinhood')),
  };
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db, wrap: heights }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/**
 * The height a chain's adapter says, where a test puts another in place of the mock's own clock: a
 * function, or null for an adapter that has none. A chain not named here keeps its adapter as it is.
 */
let heightOn: Partial<Record<ChainId, ChainAdapter['height'] | null>> = {};
/** The height of a read itself, where a test gives the adapter one (Solana's `context.slot`). */
let readOn: Partial<Record<ChainId, NonNullable<ChainAdapter['heightOfRead']>>> = {};
/** Called as a chain's adapter starts a vault's read. */
let onRead: Partial<Record<ChainId, () => void>> = {};
afterEach(() => {
  heightOn = {};
  readOn = {};
  onRead = {};
});
const heights = (inner: ChainRegistry): ChainRegistry => {
  const dress = (e: ChainEntry): ChainEntry => {
    if (!(e.chain in heightOn) && !(e.chain in readOn) && !(e.chain in onRead)) return e;
    const { height: _, ...adapter } = e.adapter;
    const height = e.chain in heightOn ? heightOn[e.chain] : e.adapter.height?.bind(e.adapter);
    const heightOfRead = readOn[e.chain];
    const started = onRead[e.chain];
    const getVault: ChainAdapter['getVault'] = (address) => {
      started?.();
      return e.adapter.getVault(address);
    };
    return {
      ...e,
      adapter: {
        ...adapter,
        getVault,
        ...(height ? { height } : {}),
        ...(heightOfRead ? { heightOfRead } : {}),
      },
    };
  };
  return { ...inner, get: (c) => dress(inner.get(c)), active: () => inner.active().map(dress) };
};

const { get, post, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});

describe('a vault, read by anybody', () => {
  it('answers the vault as the owner reads it, with no sign-in', async () => {
    const owner = data.track(await person(issuer, 'solana'));
    await fund(owner);
    await settleAll(owner, await order(owner, { amountUsd: 100 }));
    const mine = PortfolioResponse.parse((await get(owner, '/v1/portfolio')).json());
    const vault = mine.chains[0]?.vaults[0];
    if (!vault) throw new Error('no vault');
    const res = await get(null, `/v1/vaults/solana/${vault.address}`);
    expect(res.statusCode, res.body).toBe(200);
    const read = VaultResponse.parse(res.json());
    expect([read.chain, read.provenance, read.vault.owner]).toEqual([
      'solana',
      'mock',
      owner.solana,
    ]);
    expect(read.vault.positions.map((p) => [p.asset, p.targetBps])).toEqual(
      vault.positions.map((p) => [p.asset, p.targetBps]),
    );
    expect(read.vault.valueUsd).toBe(vault.valueUsd);
    expect(read.prices.every((p) => p.provenance === 'mock')).toBe(true);
  });

  it('keeps an answer for a few seconds per address, so asking again does not read the chain again', async () => {
    const owner = data.track(await person(issuer, 'solana'));
    await fund(owner);
    await settleAll(owner, await order(owner, { amountUsd: 100 }));
    const mine = PortfolioResponse.parse((await get(owner, '/v1/portfolio')).json());
    const address = mine.chains[0]?.vaults[0]?.address;
    if (!address) throw new Error('no vault');
    const reads = vi.spyOn(registry.get('solana').adapter, 'getVault');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const first = (await get(null, `/v1/vaults/solana/${address}`)).json();
      const again = await get(null, `/v1/vaults/solana/${address}`);
      expect([again.statusCode, reads.mock.calls.length]).toEqual([200, 1]);
      expect(again.json()).toEqual(first);
      // Past the time it is kept, the chain is read again.
      vi.setSystemTime(Date.now() + VAULT_KEPT_MS);
      expect((await get(null, `/v1/vaults/solana/${address}`)).statusCode).toBe(200);
      expect(reads.mock.calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
      reads.mockRestore();
    }
  });

  it('answers 404 where there is no vault, and 400 for an address of the other family or chain', async () => {
    expect(
      (await get(null, `/v1/vaults/solana/${mockAddress('solana', 'no vault here')}`)).statusCode,
    ).toBe(404);
    expect((await get(null, `/v1/vaults/solana/0x${'1'.repeat(40)}`)).statusCode).toBe(400);
    expect((await get(null, '/v1/vaults/nowhere/abc')).statusCode).toBe(400);
  });
});

const someone = async (kind: PersonKind = 'solana') => data.track(await person(issuer, kind));

/** The vault a person's one buy opened, as their portfolio has it. */
async function vaultOf(who: Person) {
  const mine = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json());
  const vault = mine.chains.flatMap((c) => c.vaults)[0];
  if (!vault) throw new Error('no vault');
  return vault;
}

/** A person with one vault, opened by a buy of the stored plan `proposalId` (the chain's default plan when left out). */
async function withVault(kind: HomeChain, proposalId?: string) {
  const who = await someone(kind);
  await fund(who);
  await settleAll(who, await order(who, { amountUsd: 100, ...(proposalId ? { proposalId } : {}) }));
  return { who, vault: await vaultOf(who) };
}

/** The route's answer, read by the contract's schema. */
async function read(who: Person | null, chain: ChainId, address: string) {
  const res = await get(who, `/v1/vaults/${chain}/${address}`);
  expect(res.statusCode, res.body).toBe(200);
  return VaultResponse.parse(res.json());
}

describe('the chain height a vault was read at', () => {
  it.each<HomeChain>(['solana', 'robinhood'])(
    'on the mock %s: the mock’s own second, asked beside the read',
    async (chain) => {
      const { vault } = await withVault(chain);
      const mock = registry.get(chain).mock;
      if (!mock) throw new Error('the chain is not the mock');
      const before = mock.now();
      const answer = await read(null, chain, vault.address);
      const after = registry.get(chain).mock?.now() ?? Number.NaN;
      const height = Number(answer.blockOrSlot);
      expect(answer.blockOrSlot).toMatch(/^\d+$/);
      expect(height).toBeGreaterThanOrEqual(before);
      expect(height).toBeLessThanOrEqual(after);
    },
  );

  it('on Solana: the slot the read of the vault’s account was answered at, and no height asked', async () => {
    const { vault } = await withVault('solana');
    const height = vi.fn(async () => 1n);
    heightOn.solana = height;
    readOn.solana = (state) => (state.address === vault.address ? 412_345_678n : undefined);
    const answer = await read(null, 'solana', vault.address);
    expect(answer.blockOrSlot).toBe('412345678');
    expect(height).not.toHaveBeenCalled();
  });

  it('never waits on the height before the read: the two are asked together', async () => {
    const { vault } = await withVault('solana');
    // a height the node gives only once the vault's read has started: asked first and waited on,
    // it would never come, and the answer would have none
    let give: (height: bigint) => void = () => {};
    heightOn.solana = () =>
      new Promise<bigint>((resolve) => {
        give = resolve;
      });
    onRead.solana = () => setTimeout(() => give(5n), 0);
    const answer = await read(null, 'solana', vault.address);
    expect(answer.blockOrSlot).toBe('5');
  });

  it('where the adapter cannot say the height of its read: the slot the Solana adapter asks of its node, at confirmed', async () => {
    const { record, env, contracts } = solanaDeployment({});
    if (!record) throw new Error('deployments/ has no Solana test network record');
    const asked: unknown[] = [];
    // A node that answers the one call a height needs.
    const rpc = {
      getSlot: (config: unknown) => {
        asked.push(config);
        return { send: async () => 412_345_678n };
      },
    };
    const solana = createSolanaVaultAdapter({
      config: parseChainConfigs(env, contracts).solana,
      rpc: rpc as never,
      assets: solanaAssets(record),
    });
    const { vault } = await withVault('solana');
    heightOn.solana = solana.height;
    const answer = await read(null, 'solana', vault.address);
    expect(answer.blockOrSlot).toBe('412345678');
    expect(asked).toEqual([{ commitment: 'confirmed' }]);
  });

  it('on Robinhood Chain: the block number the EVM adapter asks of its node', async () => {
    const { record, contracts } = evmDeployment('robinhood', {});
    if (!record) throw new Error('deployments/ has no Robinhood Chain test network record');
    const rpc = { getBlockNumber: vi.fn(async () => 9_876_543n) };
    const evm = createEvmVaultAdapter({
      config: parseChainConfigs({}, contracts).robinhood,
      rpc: rpc as never,
      assets: evmAssets(record),
      pools: deploymentPools(record),
      limits: deploymentLimits(record),
    });
    const { vault } = await withVault('robinhood');
    heightOn.robinhood = evm.height;
    const answer = await read(null, 'robinhood', vault.address);
    expect(answer.blockOrSlot).toBe('9876543');
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it('is null, and the vault is still answered, where the height fails or the adapter has none', async () => {
    const { vault } = await withVault('solana');
    heightOn.solana = async () => {
      throw new ChainError('Unavailable', 'the node did not answer getSlot');
    };
    const failed = await read(null, 'solana', vault.address);
    expect(failed.blockOrSlot).toBeNull();
    expect(failed.vault.address).toBe(vault.address);
    expect(failed.vault.valueUsd).toBe(vault.valueUsd);

    const other = await withVault('solana');
    heightOn.solana = null;
    expect((await read(null, 'solana', other.vault.address)).blockOrSlot).toBeNull();
  });

  it('is kept with the answer it labels: asked again within the time, the same height, from no new read', async () => {
    const { vault } = await withVault('solana');
    let asked = 0;
    heightOn.solana = async () => {
      asked += 1;
      return BigInt(1000 + asked);
    };
    const first = await read(null, 'solana', vault.address);
    const again = await read(null, 'solana', vault.address);
    expect([first.blockOrSlot, again.blockOrSlot, asked]).toEqual(['1001', '1001', 1]);
  });

  it('gives up on a chain that does not say it in time, and on one that fails after', async () => {
    vi.useFakeTimers();
    try {
      const hung = heightOrNull({ height: () => new Promise<bigint>(() => {}) });
      await vi.advanceTimersByTimeAsync(VAULT_HEIGHT_MS);
      await expect(hung).resolves.toBeNull();
      let fail: (e: Error) => void = () => {};
      const late = heightOrNull({
        height: () =>
          new Promise<bigint>((_, reject) => {
            fail = reject;
          }),
      });
      await vi.advanceTimersByTimeAsync(VAULT_HEIGHT_MS);
      await expect(late).resolves.toBeNull();
      // Failing after the wait is no unhandled rejection: the answer is already given.
      fail(new Error('too late'));
      await expect(heightOrNull({ height: async () => 7n })).resolves.toBe('7');
      await expect(heightOrNull({})).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A reason as the engine writes one: a rule and its sentence. */
const reason = (rule: string, text: string): Reason => ({ rule, inputs: [], params: {}, text });

/** A stored plan with these reasons on its lines, by the asset's slug. */
function withReasons(
  fixture: BasketProposal,
  reasons: Record<string, Reason[]>,
  origin?: BasketProposal['origin'],
): BasketProposal {
  return {
    ...fixture,
    lines: fixture.lines.map((l) => ({
      ...l,
      reasons: reasons[l.assetId.split(':')[1] ?? ''] ?? [],
    })),
    ...(origin ? { origin, flags: [...fixture.flags, `origin:${origin}`] } : {}),
  };
}

/** A plan that is this person's own: its row names their user row, as the app stores one. */
async function ownPlan(who: Person, fixture: BasketProposal) {
  const id = await data.storePlan(fixture);
  await data.db.insert(users).values({ privyId: who.sub }).onConflictDoNothing();
  const [user] = await data.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.privyId, who.sub));
  if (!user) throw new Error('the person has no user row');
  await data.db.update(proposals).set({ userId: user.id }).where(eq(proposals.id, id));
  return id;
}

/** Each holding's `why`, by asset, cash first. */
const whys = (answer: VaultResponse) =>
  Object.fromEntries([
    [answer.vault.cash.asset, answer.vault.cash.why ?? null],
    ...answer.vault.positions.map((p) => [p.asset, p.why ?? null]),
  ]);

describe('why each holding is in the vault', () => {
  it('a vault that follows a shared portfolio: the asset’s kind, from the portfolio, to anybody', async () => {
    const creator = await someone();
    const slug = `t-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    data.trackFamily(familyIdOf(slug));
    const letters = slug.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a').slice(2, 14);
    await fund(creator);
    const published = await post(creator, '/v1/orders', {
      type: 'publish',
      creator: { solana: creator.solana },
      family: slug,
      name: `Test ${letters}`,
      copy: 'Three test tokens.',
      recipes: [
        {
          chain: 'solana',
          components: [
            { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
            { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
            { kind: 'asset', asset: 'solana:gold', weightBps: 3000 },
          ],
        },
      ],
    });
    expect(published.statusCode, published.body).toBe(200);
    await settleAll(creator, OrderDetail.parse(published.json()));

    const who = await someone();
    await fund(who);
    const placed = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 100,
      family: slug,
    });
    expect(placed.statusCode, placed.body).toBe(200);
    await settleAll(who, OrderDetail.parse(placed.json()));
    const vault = await vaultOf(who);
    expect(vault.recipeOnchainId).not.toBeNull();

    const expected = {
      'solana:usdc': null,
      'solana:spy': { source: 'portfolio', cls: 'etf' },
      'solana:nvda': { source: 'portfolio', cls: 'stock' },
      'solana:gold': { source: 'portfolio', cls: 'gold' },
    };
    // The portfolio is public: a visitor and the owner are answered the same.
    expect(whys(await read(null, 'solana', vault.address))).toEqual(expected);
    expect(whys(await read(who, 'solana', vault.address))).toEqual(expected);
  });

  it('a vault opened for the engine’s plan: the reason that decided each line, to the owner alone', async () => {
    const who = await someone();
    const plan = await ownPlan(
      who,
      withReasons(planFixture('solana', { spy: 5000, nvda: 3000 }), {
        spy: [
          reason('SLEEVE', 'Growth starts at 80% of the plan.'),
          reason('ASSET_CAP', 'No more than 50% of the plan in one token.'),
        ],
        usdc: [
          reason('SLEEVE', 'Cash starts at 10% of the plan.'),
          reason('UNPLACED', '$200 stays in cash: no token has room for it.'),
        ],
      }),
    );
    await fund(who);
    await settleAll(who, await order(who, { amountUsd: 100, proposalId: plan }));
    const vault = await vaultOf(who);
    expect(vault.recipeOnchainId).toBeNull();

    // Asked first by a visitor, so the owner's answer is the kept one with their part added.
    const visitor = await read(null, 'solana', vault.address);
    const owner = await read(who, 'solana', vault.address);
    expect(whys(owner)).toEqual({
      'solana:usdc': { source: 'plan', text: '$200 stays in cash: no token has room for it.' },
      'solana:spy': { source: 'plan', text: 'No more than 50% of the plan in one token.' },
      // A line the engine gave no reason has none.
      'solana:nvda': null,
    });
    // What a plan says is its maker's: a visitor, before or after, and another person signed in
    // are answered no reason from it.
    const nothing = { 'solana:usdc': null, 'solana:spy': null, 'solana:nvda': null };
    expect(whys(visitor)).toEqual(nothing);
    expect(whys(await read(null, 'solana', vault.address))).toEqual(nothing);
    expect(whys(await read(await someone(), 'solana', vault.address))).toEqual(nothing);
    expect(owner.vault.number).toBe(1);
  });

  it('a vault opened for the person’s own mix: their stored choice, as the owner’s', async () => {
    const who = await someone('robinhood');
    const plan = await ownPlan(
      who,
      withReasons(
        planFixture('robinhood', { spy: 6000, tsla: 4000 }),
        {
          spy: [
            reason('MIX_FROM_PERSON', 'You chose 60% for SPY.'),
            reason('EXIT_CEILING', 'Selling SPY at this size costs more than 1%.'),
          ],
          tsla: [reason('MIX_FROM_MODEL', 'TSLA at 40%: proposed in your conversation.')],
        },
        'person',
      ),
    );
    await fund(who);
    await settleAll(who, await order(who, { amountUsd: 100, proposalId: plan }));
    const vault = await vaultOf(who);
    expect(chainOf(who)).toBe('robinhood');
    expect(whys(await read(who, 'robinhood', vault.address))).toEqual({
      // Nothing is kept in cash: its target is 0, and it is given no reason.
      'robinhood:usdc': null,
      'robinhood:spy': { source: 'owner', text: 'You chose 60% for SPY.' },
      'robinhood:tsla': { source: 'owner', text: 'TSLA at 40%: proposed in your conversation.' },
    });
    expect(whys(await read(null, 'robinhood', vault.address))).toEqual({
      'robinhood:usdc': null,
      'robinhood:spy': null,
      'robinhood:tsla': null,
    });
  });

  it('a line whose target is no longer the plan’s has no reason from the plan', async () => {
    const who = await someone();
    const fixture = withReasons(planFixture('solana', { spy: 5000, nvda: 5000 }), {
      spy: [reason('ASSET_CAP', 'No more than 50% of the plan in one token.')],
      nvda: [reason('ASSET_CAP', 'No more than 50% of the plan in one token.')],
    });
    const plan = await ownPlan(who, fixture);
    await fund(who);
    await settleAll(who, await order(who, { amountUsd: 100, proposalId: plan }));
    const vault = await vaultOf(who);
    // The plan now says another weight for SPY than the vault holds: its reason no longer stands.
    const changed = {
      ...fixture,
      lines: fixture.lines.map((l) =>
        l.assetId === 'solana:spy'
          ? { ...l, weightBps: 4000 }
          : l.assetId === 'solana:nvda'
            ? { ...l, weightBps: 6000 }
            : l,
      ),
      recipes: fixture.recipes.map((r) => ({
        ...r,
        components: [
          { kind: 'asset' as const, asset: 'solana:spy', weightBps: 4000 },
          { kind: 'asset' as const, asset: 'solana:nvda', weightBps: 5000 },
        ],
      })),
    };
    await data.db.update(proposals).set({ proposal: changed }).where(eq(proposals.id, plan));
    expect(whys(await read(who, 'solana', vault.address))).toEqual({
      'solana:usdc': null,
      'solana:spy': null,
      'solana:nvda': { source: 'plan', text: 'No more than 50% of the plan in one token.' },
    });
  });

  it('a vault opened for a plan that names no person: no reason to anybody', async () => {
    // The chain's default plan here is stored with no person: holding its id does not read it back.
    const { who, vault } = await withVault('solana');
    const answer = await read(who, 'solana', vault.address);
    expect(answer.vault.positions.every((p) => p.why === null)).toBe(true);
    expect(answer.vault.cash.why).toBeNull();
  });
});
