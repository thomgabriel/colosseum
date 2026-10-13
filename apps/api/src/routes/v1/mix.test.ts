import { mockRecipeId } from '@colosseum/chain-mock';
import type { Db } from '@colosseum/db';
import { PERSONAL_PARAMS } from '@colosseum/engine/personal';
import {
  AcceptGoalMixResponse,
  type Address,
  ApplyVaultMixResponse,
  type BasketProposal,
  type BuiltTx,
  ChainError,
  type IntentRequest,
  type Order,
  OrderError,
  OWNER_REBALANCE_MIN_TRADE_USD,
  OWNER_REBALANCE_SLIPPAGE_BPS,
  parseChainConfigs,
  parseFlags,
  RebalanceQuoteResponse,
  RebalanceVaultResponse,
  type Recipe,
  type VaultState,
} from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureLiquidity } from '../../../../../packages/engine/src/personal/testing';
import { createChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import type { StoredFamily } from '../../orders/families';
import { buildRetarget, planVaultRebalance } from '../../orders/mix';
import { ORDER_POLICY, prepareOrder } from '../../orders/prepare';
import { registerAuth } from '../../plugins/auth';
import { person, testIssuer } from '../../testing/harness';
import { type MixStore, registerMixRoutes } from './mix';

// POST /v1/conversations/{chain}/goal/accept and POST /v1/vaults/{chain}/{address}/targets (gate
// ANY-COMPOSITION). The store is in memory and the database is out of reach: a review writes
// nothing, and a confirmed mix writes one plan or one order.

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(env: Record<string, string> = {}) {
  const issuer = await testIssuer('mix');
  const owner = await person(issuer, 'solana');
  const stranger = await person(issuer, 'solana');
  const evmOnly = await person(issuer, 'robinhood');
  const chains = createChainRegistry(parseFlags(env), parseChainConfigs({}), { seed: 'mix-route' });
  const plans = new Map<string, BasketProposal>();
  const saved: Array<{ order: Order; request: IntentRequest }> = [];
  const families = new Map<string, StoredFamily>();
  const store: MixStore = {
    // As `insertProposal`: the same plan stored again answers the first one's id.
    saveProposal: vi.fn(async (proposal: BasketProposal) => {
      for (const [id, kept] of plans) if (kept.inputsHash === proposal.inputsHash) return id;
      const id = `00000000-0000-4000-8000-${String(plans.size + 1).padStart(12, '0')}`;
      plans.set(id, proposal);
      return id;
    }),
    loadProposal: vi.fn(async (id: string) => plans.get(id) ?? null),
    saveOrder: vi.fn(async (order: Order, request: IntentRequest) => {
      saved.push({ order, request });
    }),
    planOf: vi.fn(async () => ({ goal: 'income' as const, risk: 'low' as const })),
    familyBySlug: vi.fn(async (slug: string) => families.get(slug) ?? null),
  };
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('the database is out of reach in this test');
      },
    },
  ) as Db;
  const app = Fastify();
  cleanup.push(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app, issuer.issuer);
  app.setErrorHandler((error, _req, reply) =>
    error instanceof Refusal
      ? reply.code(error.status).send(error.body())
      : reply.code(400).send({ error: 'invalid request' }),
  );
  registerMixRoutes(
    app,
    { db, chains, now: () => new Date('2026-10-08T12:00:00.000Z') },
    async () => ({
      liquidity: {
        provider: fixtureLiquidity({ 'solana:nvda': 2000 }),
        source: 'fixture exit table',
      },
    }),
    store,
  );
  const post = (url: string, payload: object, who = owner) =>
    app.inject({ method: 'POST', url, headers: who.headers, payload });
  /** The review the person sees, then the confirm of it: its hash, and its warnings accepted. */
  const confirm = async (
    url: string,
    payload: Record<string, unknown>,
    who = owner,
    accept?: (unconfirmed: string[]) => string[],
  ) => {
    const seen = await post(url, { ...payload, confirm: false }, who);
    if (seen.statusCode !== 200) return seen;
    const { review } = seen.json() as { review: { reviewHash: string; unconfirmed: string[] } };
    return post(
      url,
      {
        ...payload,
        confirm: true,
        reviewHash: review.reviewHash,
        acceptedWarnings: accept ? accept(review.unconfirmed) : review.unconfirmed,
      },
      who,
    );
  };
  return { app, chains, owner, stranger, evmOnly, store, plans, saved, families, post, confirm };
}

const ACCEPT = '/v1/conversations/solana/goal/accept';
const goal = (over: object = {}) => ({
  version: 1,
  origin: 'model',
  language: 'en',
  goal: 'grow',
  risk: 'medium',
  amountUsd: 10_000,
  allocations: [
    { assetId: 'solana:usdc', weightBps: 1000 },
    { assetId: 'solana:nvda', weightBps: 4000 },
    { assetId: 'solana:yield', weightBps: 5000 },
  ],
  confirm: false,
  acceptedWarnings: [],
  ...over,
});

describe('POST /v1/conversations/{chain}/goal/accept', () => {
  it('needs a sign-in, and a wallet for the chain', async () => {
    const s = await setup();
    const none = await s.app.inject({ method: 'POST', url: ACCEPT, payload: goal() });
    expect(none.statusCode).toBe(401);
    expect(none.headers['cache-control']).toBe('private, no-store');
    expect((await s.post(ACCEPT, goal(), s.evmOnly)).statusCode).toBe(403);
    expect(s.store.saveProposal).not.toHaveBeenCalled();
  });

  it('answers a review and stores nothing until confirmed with every warning accepted', async () => {
    const s = await setup();
    const review = await s.post(ACCEPT, goal());
    expect(review.statusCode, review.body).toBe(200);
    const body = AcceptGoalMixResponse.parse(review.json());
    expect(body.status).toBe('review');
    expect(body.review.unconfirmed).toEqual(['EXIT_OVER_CAPACITY:solana:nvda']);
    expect(body.review.targets).toEqual([
      { asset: 'solana:nvda', weightBps: 4000 },
      { asset: 'solana:yield', weightBps: 5000 },
    ]);
    // Over its measured exit is a warning, not a refusal: confirmed without accepting it, still a review.
    const unaccepted = AcceptGoalMixResponse.parse(
      (await s.post(ACCEPT, goal({ confirm: true, reviewHash: body.review.reviewHash }))).json(),
    );
    expect(unaccepted.status).toBe('review');
    expect(s.store.saveProposal).not.toHaveBeenCalled();
    const stored = await s.post(
      ACCEPT,
      goal({
        confirm: true,
        reviewHash: body.review.reviewHash,
        acceptedWarnings: ['EXIT_OVER_CAPACITY:solana:nvda'],
      }),
    );
    const done = AcceptGoalMixResponse.parse(stored.json());
    if (done.status !== 'stored') throw new Error(stored.body);
    expect(done.proposal.origin).toBe('model');
    expect(done.proposal.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['solana:usdc', 1000],
      ['solana:nvda', 4000],
      ['solana:yield', 5000],
    ]);
    expect(s.store.saveProposal).toHaveBeenCalledWith(done.proposal, s.owner.sub);
    expect(s.plans.get(done.proposalId)).toEqual(done.proposal);
  });

  it('refuses tampered weights, unlisted assets, cash twice and more than 16 lines', async () => {
    const s = await setup();
    const issues = async (allocations: object[]) => {
      const res = await s.post(ACCEPT, goal({ allocations, confirm: true }));
      expect(res.statusCode, res.body).toBe(422);
      const err = OrderError.parse(res.json());
      expect(err.code).toBe('MIX_NOT_VALID');
      return err.details?.issues;
    };
    expect(
      await issues([
        { assetId: 'solana:nvda', weightBps: 6000 },
        { assetId: 'solana:usdc', weightBps: 4001 },
      ]),
    ).toEqual(['SUM_NOT_10000']);
    expect(
      await issues([
        { assetId: 'robinhood:nvda', weightBps: 5000 },
        { assetId: 'solana:usdc', weightBps: 5000 },
      ]),
    ).toEqual(['NOT_LISTED:robinhood:nvda']);
    expect(
      await issues([
        { assetId: 'solana:usdc', weightBps: 5000 },
        { assetId: 'solana:usdc', weightBps: 5000 },
      ]),
    ).toEqual(['DUPLICATE:solana:usdc']);
    expect(
      await issues(
        Array.from({ length: 17 }, (_, i) => ({
          assetId: `solana:asset-${i}`,
          weightBps: i === 0 ? 2000 : 500,
        })),
      ),
    ).toEqual([
      ...Array.from({ length: 17 }, (_, i) => `NOT_LISTED:solana:asset-${i}`),
      'TOO_MANY_LINES',
    ]);
    // A weight that is not a whole basis point is not even read.
    const half = await s.post(
      ACCEPT,
      goal({
        allocations: [
          { assetId: 'solana:nvda', weightBps: 4999.5 },
          { assetId: 'solana:usdc', weightBps: 5000.5 },
        ],
      }),
    );
    expect(half.statusCode).toBe(400);
    expect(s.store.saveProposal).not.toHaveBeenCalled();
  });

  it('stores stocks in an income plan only once the person accepts the warning', async () => {
    const s = await setup();
    const income = (over: object) =>
      goal({
        goal: 'income',
        amountUsd: 1000,
        allocations: [
          { assetId: 'solana:usdc', weightBps: 2000 },
          { assetId: 'solana:tsla', weightBps: 3000 },
          { assetId: 'solana:yield', weightBps: 5000 },
        ],
        confirm: true,
        ...over,
      });
    const first = AcceptGoalMixResponse.parse((await s.post(ACCEPT, income({}))).json());
    expect(first.status).toBe('review');
    expect(first.review.unconfirmed).toEqual(['NOT_FOR_GOAL:solana:tsla']);
    expect(s.store.saveProposal).not.toHaveBeenCalled();
    const second = AcceptGoalMixResponse.parse(
      (
        await s.post(
          ACCEPT,
          income({
            reviewHash: first.review.reviewHash,
            acceptedWarnings: ['NOT_FOR_GOAL:solana:tsla'],
          }),
        )
      ).json(),
    );
    expect(second.status).toBe('stored');
    if (second.status === 'stored')
      expect(second.proposal.flags).toContain('confirmed:NOT_FOR_GOAL:solana:tsla');
  });

  it("takes no confirm made without the review, or on another review's numbers", async () => {
    const s = await setup();
    // Guessed ids, no review: the review comes back, nothing stored.
    const guessed = AcceptGoalMixResponse.parse(
      (
        await s.post(
          ACCEPT,
          goal({
            amountUsd: 1_000_000,
            confirm: true,
            acceptedWarnings: [
              'EXIT_OVER_CAPACITY:solana:nvda',
              'EXIT_OVER_TIER_CEILING:solana:yield',
            ],
          }),
        )
      ).json(),
    );
    expect(guessed.status).toBe('review');
    // The hash of the $10,000 review does not confirm the same mix at $1,000,000.
    const small = AcceptGoalMixResponse.parse((await s.post(ACCEPT, goal())).json());
    const stale = AcceptGoalMixResponse.parse(
      (
        await s.post(
          ACCEPT,
          goal({
            amountUsd: 1_000_000,
            confirm: true,
            reviewHash: small.review.reviewHash,
            acceptedWarnings: [
              'EXIT_OVER_CAPACITY:solana:nvda',
              'EXIT_OVER_TIER_CEILING:solana:yield',
            ],
          }),
        )
      ).json(),
    );
    expect(stale.status).toBe('review');
    expect(stale.review.reviewHash).not.toBe(small.review.reviewHash);
    expect(s.store.saveProposal).not.toHaveBeenCalled();
  });

  it('answers the plan as first stored when the same mix is confirmed again', async () => {
    const s = await setup();
    const first = AcceptGoalMixResponse.parse((await s.confirm(ACCEPT, goal())).json());
    const again = AcceptGoalMixResponse.parse((await s.confirm(ACCEPT, goal())).json());
    if (first.status !== 'stored' || again.status !== 'stored') throw new Error('not stored');
    expect(again.proposalId).toBe(first.proposalId);
    expect(again.proposal).toEqual(s.plans.get(first.proposalId));
    expect(s.plans.size).toBe(1);
  });

  it('refuses a buy of a stored mix above the amount it was reviewed at', async () => {
    const s = await setup();
    const res = AcceptGoalMixResponse.parse(
      (await s.post(ACCEPT, goal({ amountUsd: 500, confirm: false }))).json(),
    );
    // At $500 the mix carries no warning: stored on the review's hash alone.
    expect(res.review.warnings).toEqual([]);
    const stored = AcceptGoalMixResponse.parse(
      (
        await s.post(
          ACCEPT,
          goal({ amountUsd: 500, confirm: true, reviewHash: res.review.reviewHash }),
        )
      ).json(),
    );
    if (stored.status !== 'stored') throw new Error('not stored');
    const buy = (amountUsd: number) =>
      prepareOrder(
        { type: 'buy', owner: s.owner.owner, amountUsd, proposalId: stored.proposalId },
        {
          principal: {
            kind: 'user',
            userId: s.owner.sub,
            wallets: [{ family: 'solana', address: s.owner.solana }] as never,
            ip: '127.0.0.1',
          },
          chains: s.chains,
          loadProposal: async (id) => s.plans.get(id) ?? null,
          homeChain: async () => 'solana',
          loadFamilies: async () => [],
          now: '2026-10-08T12:00:00.000Z',
        },
      );
    const over = await buy(1_000_000).then(
      () => null,
      (e: unknown) => e,
    );
    expect(over).toBeInstanceOf(Refusal);
    expect((over as Refusal).status).toBe(422);
    expect((over as Refusal).extra.code).toBe('AMOUNT_OVER_REVIEW');
    expect((await buy(500)).order.depositRaw).toBe('500000000');
    expect((await buy(250)).order.depositRaw).toBe('250000000');
  });

  it("refuses gold or crypto in an income plan: only a stock is the person's choice there", async () => {
    const s = await setup();
    const res = await s.post(
      ACCEPT,
      goal({
        goal: 'income',
        amountUsd: 1000,
        allocations: [
          { assetId: 'solana:gold', weightBps: 3000 },
          { assetId: 'solana:tsla', weightBps: 2000 },
          { assetId: 'solana:yield', weightBps: 5000 },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(OrderError.parse(res.json())).toMatchObject({
      code: 'MIX_NOT_VALID',
      details: { issues: ['NOT_FOR_GOAL:solana:gold'] },
    });
  });

  it('binds the review to the goal, risk and term as well as the lines', async () => {
    const s = await setup();
    const hashOf = async (over: object) =>
      AcceptGoalMixResponse.parse((await s.post(ACCEPT, goal(over))).json()).review.reviewHash;
    const base = await hashOf({});
    expect(await hashOf({})).toBe(base);
    expect(await hashOf({ risk: 'high' })).not.toBe(base);
    expect(await hashOf({ horizonMonths: 24 })).not.toBe(base);
    expect(await hashOf({ horizonMonths: 36 })).not.toBe(await hashOf({ horizonMonths: 24 }));
    expect(await hashOf({ goal: 'protect' })).not.toBe(base);
  });

  it('works out from the mix a goal or risk the person did not say, and says which (DEPOSIT-DERIVE)', async () => {
    const s = await setup();
    const review = async (over: object) => {
      const answer = await s.post(ACCEPT, goal(over));
      expect(answer.statusCode, answer.body).toBe(200);
      return AcceptGoalMixResponse.parse(answer.json()).review;
    };
    // 70% dollar yield and 10% in each of two stocks: a plan to grow, within every low cap
    const spread = {
      allocations: [
        { assetId: 'solana:usdc', weightBps: 1000 },
        { assetId: 'solana:nvda', weightBps: 1000 },
        { assetId: 'solana:tsla', weightBps: 1000 },
        { assetId: 'solana:yield', weightBps: 7000 },
      ],
    };
    const unsaid = await review({ ...spread, goal: null, risk: null });
    expect(unsaid).toMatchObject({ goal: 'grow', risk: 'low', fromMix: ['goal', 'risk'] });
    // left out is the same as null, and the review is the one a person who said them would see
    const { goal: _goal, risk: _risk, ...bare } = goal(spread);
    expect((await s.post(ACCEPT, bare)).json().review).toEqual(unsaid);
    expect((await review({ ...spread, goal: 'grow', risk: 'low' })).reviewHash).toBe(
      unsaid.reviewHash,
    );
    // 40% in one stock is past every cap on one stock: the highest risk
    expect(await review({ goal: null, risk: null })).toMatchObject({ goal: 'grow', risk: 'high' });
    // dollar yield and cash alone: a plan to protect, at the lowest risk
    expect(
      await review({
        goal: null,
        risk: null,
        allocations: [
          { assetId: 'solana:usdc', weightBps: 1000 },
          { assetId: 'solana:yield', weightBps: 9000 },
        ],
      }),
    ).toMatchObject({ goal: 'protect', risk: 'low', fromMix: ['goal', 'risk'] });
    // what the person said stands, checked as before: only the rest is worked out
    const income = await review({ ...spread, goal: 'income', risk: null });
    expect(income).toMatchObject({ goal: 'income', risk: 'low', fromMix: ['risk'] });
    expect(income.unconfirmed).toEqual(
      expect.arrayContaining(['NOT_FOR_GOAL:solana:nvda', 'NOT_FOR_GOAL:solana:tsla']),
    );
    expect(unsaid.unconfirmed.filter((id) => id.startsWith('NOT_FOR_GOAL'))).toEqual([]);
    const said = await review({ ...spread, goal: 'grow', risk: 'high' });
    expect(said).toMatchObject({ goal: 'grow', risk: 'high' });
    expect(said.fromMix).toBeUndefined();
    // confirmed, the plan is stored with what was worked out
    const stored = AcceptGoalMixResponse.parse(
      (await s.confirm(ACCEPT, goal({ ...spread, goal: null, risk: null }))).json(),
    );
    if (stored.status !== 'stored') throw new Error('not stored');
    expect(stored.proposal.sheet).toMatchObject({ goal: 'grow', risk: 'low' });
    expect(stored.proposal.flags).toEqual(
      expect.arrayContaining(['from_mix:goal', 'from_mix:risk']),
    );
  });

  it('stores a plan the existing buy turns into legs, unchanged', async () => {
    const s = await setup();
    const res = AcceptGoalMixResponse.parse(
      (
        await s.confirm(
          ACCEPT,
          goal({
            origin: 'person',
            amountUsd: 500,
            allocations: [
              { assetId: 'solana:usdc', weightBps: 1000 },
              { assetId: 'solana:spy', weightBps: 5000 },
              { assetId: 'solana:gold', weightBps: 4000 },
            ],
          }),
        )
      ).json(),
    );
    if (res.status !== 'stored') throw new Error('not stored');
    const { order } = await prepareOrder(
      { type: 'buy', owner: s.owner.owner, amountUsd: 500, proposalId: res.proposalId },
      {
        principal: {
          kind: 'user',
          userId: s.owner.sub,
          wallets: [{ family: 'solana', address: s.owner.solana }] as never,
          ip: '127.0.0.1',
        },
        chains: s.chains,
        loadProposal: async (id) => s.plans.get(id) ?? null,
        homeChain: async () => 'solana',
        loadFamilies: async () => [],
        now: '2026-10-08T12:00:00.000Z',
      },
    );
    expect(order.legs.map((l) => [l.kind, l.trades.map((t) => t.buy)])).toEqual([
      ['create_vault', []],
      ['swap', ['solana:spy']],
      ['swap', ['solana:gold']],
    ]);
    expect(order.depositRaw).toBe('500000000');
  });
});

describe('POST /v1/vaults/{chain}/{address}/targets', () => {
  async function withVault() {
    const s = await setup();
    const entry = s.chains.get('solana');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.owner.solana as Address;
    mock.fund(owner, { gasRaw: '100000000000', assets: { 'solana:usdc': '1000000000' } });
    const send = (tx: BuiltTx) => mock.send(tx);
    await send(
      await entry.adapter.buildCreateVault({
        owner,
        basketId: '9',
        targets: [{ asset: 'solana:spy', weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: '1000000000',
        slippageBps: 100,
      }),
    );
    const [vault] = await entry.adapter.getVaults(owner);
    if (!vault) throw new Error('no vault');
    await send(
      await entry.adapter.buildOwnerSwap({
        vault: vault.address,
        trades: [{ sell: 'solana:usdc', buy: 'solana:spy', amountInRaw: '1000000000' }],
        slippageBps: 100,
      }),
    );
    return { ...s, url: `/v1/vaults/solana/${vault.address}/targets`, address: vault.address };
  }
  const targets = (over: object = {}) => ({
    version: 1,
    origin: 'person',
    language: 'en',
    allocations: [
      { assetId: 'solana:usdc', weightBps: 2000 },
      { assetId: 'solana:spy', weightBps: 5000 },
      { assetId: 'solana:tsla', weightBps: 3000 },
    ],
    confirm: false,
    acceptedWarnings: [],
    ...over,
  });

  it('answers a stranger as a vault that is not there, and reads nothing else', async () => {
    const s = await withVault();
    const res = await s.post(s.url, targets(), s.stranger);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(s.store.planOf).not.toHaveBeenCalled();
  });

  it('reviews against the plan the vault was opened for, and orders the targets once confirmed', async () => {
    const s = await withVault();
    const review = ApplyVaultMixResponse.parse((await s.post(s.url, targets())).json());
    expect(review.status).toBe('review');
    // The vault's plan is an income plan (the store says so): a stock in it is a warning.
    expect(review.review.goal).toBe('income');
    expect(review.review.unconfirmed).toEqual([
      'NOT_FOR_GOAL:solana:spy',
      'NOT_FOR_GOAL:solana:tsla',
    ]);
    expect(review.review.amountUsd).toBeCloseTo(999, 0);
    expect(s.store.saveOrder).not.toHaveBeenCalled();
    const res = await s.post(
      s.url,
      targets({
        confirm: true,
        reviewHash: review.review.reviewHash,
        acceptedWarnings: review.review.unconfirmed,
      }),
    );
    const ordered = ApplyVaultMixResponse.parse(res.json());
    if (ordered.status !== 'ordered') throw new Error(res.body);
    expect(ordered.order.type).toBe('rebalance');
    expect(ordered.order.legs.map((l) => l.kind)).toEqual(['set_targets', 'swap', 'swap']);
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]?.request).toEqual({
      type: 'rebalance',
      vaults: [s.address],
      reason: 'manual',
      targets: [
        { asset: 'solana:spy', weightBps: 5000 },
        { asset: 'solana:tsla', weightBps: 3000 },
      ],
      maxSlippageBps: 100,
    });
  });

  it('orders an EVM vault for the wallet as the sign-in names it, whatever its case', async () => {
    const s = await setup();
    const entry = s.chains.get('robinhood');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.evmOnly.evm as Address;
    mock.fund(owner, {
      gasRaw: '1000000000000000000',
      assets: { 'robinhood:usdc': '1000000000' },
    });
    await mock.send(
      await entry.adapter.buildApprove({ owner, basketId: '11', amountRaw: '1000000000' }),
    );
    await mock.send(
      await entry.adapter.buildCreateVault({
        owner,
        basketId: '11',
        targets: [{ asset: 'robinhood:spy', weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: '1000000000',
        trades: [{ sell: 'robinhood:usdc', buy: 'robinhood:spy', amountInRaw: '1000000000' }],
        slippageBps: 100,
      }),
    );
    const [vault] = await entry.adapter.getVaults(owner);
    if (!vault) throw new Error('no vault');
    const url = `/v1/vaults/robinhood/0x${vault.address.slice(2).toUpperCase()}/targets`;
    const res = await s.confirm(
      url,
      targets({
        allocations: [
          { assetId: 'robinhood:usdc', weightBps: 5000 },
          { assetId: 'robinhood:nvda', weightBps: 5000 },
        ],
      }),
      s.evmOnly,
    );
    const ordered = ApplyVaultMixResponse.parse(res.json());
    if (ordered.status !== 'ordered') throw new Error(res.body);
    // EVM trades ride together: the sale of SPY and the purchase of NVDA are one step.
    expect(ordered.order.legs.map((l) => l.kind)).toEqual(['set_targets', 'swap']);
    expect(ordered.order.owner.evm?.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('orders an EVM vault of one 18-decimal stock into another: an answer that validates, the sale written as a sale', async () => {
    const s = await setup();
    const entry = s.chains.get('robinhood');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.evmOnly.evm as Address;
    mock.fund(owner, { gasRaw: '1000000000000000000', assets: { 'robinhood:usdc': '100000000' } });
    // The new goal's review takes all of one stock, with its warnings.
    const accepted = await s.confirm(
      '/v1/conversations/robinhood/goal/accept',
      goal({
        origin: 'person',
        risk: 'high',
        amountUsd: 100,
        allocations: [{ assetId: 'robinhood:tsla', weightBps: 10_000 }],
      }),
      s.evmOnly,
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(AcceptGoalMixResponse.parse(accepted.json()).status).toBe('stored');
    await mock.send(
      await entry.adapter.buildApprove({ owner, basketId: '13', amountRaw: '100000000' }),
    );
    await mock.send(
      await entry.adapter.buildCreateVault({
        owner,
        basketId: '13',
        targets: [{ asset: 'robinhood:tsla', weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: '100000000',
        trades: [{ sell: 'robinhood:usdc', buy: 'robinhood:tsla', amountInRaw: '100000000' }],
        slippageBps: 100,
      }),
    );
    const [vault] = await entry.adapter.getVaults(owner);
    if (!vault) throw new Error('no vault');
    const res = await s.confirm(
      `/v1/vaults/robinhood/${vault.address}/targets`,
      targets({ allocations: [{ assetId: 'robinhood:nvda', weightBps: 10_000 }] }),
      s.evmOnly,
    );
    expect(res.statusCode, res.body).toBe(200);
    // As it was sent: the response schema passed it, and no figure in it is Infinity or NaN.
    expect(res.body).not.toMatch(/Infinity|NaN/);
    const ordered = ApplyVaultMixResponse.parse(res.json());
    if (ordered.status !== 'ordered') throw new Error(res.body);
    const [, swap] = ordered.order.legs;
    expect(ordered.order.legs.map((l) => l.kind)).toEqual(['set_targets', 'swap']);
    expect(swap?.description).toBe('Sell TSLA for cash, Swap into NVDA');
    expect(swap?.trades[0]).toEqual({
      sell: 'robinhood:tsla',
      buy: 'robinhood:usdc',
      amountInRaw: vault.positions.find((p) => p.asset === 'robinhood:tsla')?.raw,
    });
    expect(swap?.trades[1]).toMatchObject({ sell: 'robinhood:usdc', buy: 'robinhood:nvda' });
    expect(swap?.expected.map((e) => e.inRaw)).toEqual(swap?.trades.map((t) => t.amountInRaw));
    for (const e of swap?.expected ?? []) expect(Number.isFinite(e.costBps)).toBe(true);
  });

  it('refuses a vault worth more than one order may move, with a reason', async () => {
    const s = await setup();
    const entry = s.chains.get('solana');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.owner.solana as Address;
    mock.fund(owner, { gasRaw: '100000000000', assets: { 'solana:usdc': '3000000000000' } });
    await mock.send(
      await entry.adapter.buildCreateVault({
        owner,
        basketId: '12',
        targets: [{ asset: 'solana:spy', weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: '3000000000000',
        slippageBps: 100,
      }),
    );
    const [vault] = await entry.adapter.getVaults(owner);
    if (!vault) throw new Error('no vault');
    const res = await s.post(
      `/v1/vaults/solana/${vault.address}/targets`,
      targets({
        allocations: [
          { assetId: 'solana:usdc', weightBps: 1000 },
          { assetId: 'solana:spy', weightBps: 9000 },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(OrderError.parse(res.json())).toMatchObject({
      code: 'MIX_NOT_VALID',
      details: { issues: ['OVER_ORDER_LIMIT'] },
    });
    expect(s.store.saveOrder).not.toHaveBeenCalled();
  });

  it('refuses all cash for an open vault', async () => {
    const s = await withVault();
    const res = await s.post(
      s.url,
      targets({ allocations: [{ assetId: 'solana:usdc', weightBps: 10_000 }], confirm: true }),
    );
    expect(res.statusCode).toBe(422);
    expect(OrderError.parse(res.json()).details?.issues).toEqual(['ALL_CASH']);
  });
});

describe('POST /v1/vaults/{chain}/{address}/rebalance', () => {
  const FOLLOWED = [
    { asset: 'solana:yield', weightBps: 5000 },
    { asset: 'solana:spy', weightBps: 3000 },
    { asset: 'solana:gold', weightBps: 2000 },
  ];
  /**
   * Thom's vault of Oct 13 on the sample chain's shelf: half in one asset, a quarter in a second, a
   * quarter ($20,050) idle in cash; then it follows a shared portfolio of 50%, 30% and 20% in a third
   * asset, with auto-follow off. Following trades nothing.
   */
  async function followed(opts: { accept?: boolean } = {}) {
    const s = await setup();
    const entry = s.chains.get('solana');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.owner.solana as Address;
    const creator = s.stranger.solana as Address;
    const usd = (dollars: number) => (BigInt(dollars) * 1_000_000n).toString();
    mock.fund(owner, { gasRaw: '100000000000', assets: { 'solana:usdc': usd(80_200) } });
    mock.fund(creator, { gasRaw: '100000000000', assets: {} });
    const send = async (tx: Promise<BuiltTx>) => mock.send(await tx);
    await send(
      entry.adapter.buildCreateVault({
        owner,
        basketId: '21',
        targets: [
          { asset: 'solana:yield', weightBps: 5000 },
          { asset: 'solana:spy', weightBps: 2500 },
        ],
        autoFollow: false,
        depositRaw: usd(80_200),
        slippageBps: 100,
      }),
    );
    const [opened] = await entry.adapter.getVaults(owner);
    if (!opened) throw new Error('no vault');
    const address = opened.address;
    for (const [buy, dollars] of [
      ['solana:yield', 40_100],
      ['solana:spy', 20_050],
    ] as const)
      await send(
        entry.adapter.buildOwnerSwap({
          vault: address,
          trades: [{ sell: 'solana:usdc', buy, amountInRaw: usd(dollars) }],
          slippageBps: 100,
        }),
      );
    const familyId = 'ef'.repeat(32);
    const recipe: Recipe = {
      schemaVersion: 1,
      familyId,
      chain: 'solana',
      onchainId: null,
      creator,
      kind: 'community',
      version: 1,
      effectiveAt: 0,
      components: FOLLOWED.map((t) => ({ kind: 'asset', ...t })),
      metaHash: '00'.repeat(32),
      maxFeeBps: 0,
      flags: 0,
    };
    await send(entry.adapter.buildPublishRecipe({ creator, recipe }));
    const published = { onchainId: mockRecipeId('solana', creator, familyId) };
    s.families.set('half-thirty-twenty', {
      familyId,
      slug: 'half-thirty-twenty',
      nameKey: 'halfthlrtytwenty',
      name: 'Half thirty twenty',
      copy: '',
      kind: 'index',
      creatorUserId: null,
      creatorKind: 'community',
      platform: false,
      recipes: [
        { id: 'r1', chain: 'solana', onchainId: published.onchainId, creator, versions: [] },
      ],
    });
    if (opts.accept !== false)
      await send(
        entry.adapter.buildAcceptVersion({
          vault: address,
          recipeOnchainId: published.onchainId,
          expectedVersion: 1,
        }),
      );
    const read = async (): Promise<VaultState> => {
      const vault = await entry.adapter.getVault(address);
      if (!vault) throw new Error('no vault');
      return vault;
    };
    /** Each share of the vault's value in bps, cash under its own id, at the chain's prices now. */
    const shares = async () => {
      const vault = await read();
      const prices = new Map(
        (await entry.adapter.getPrices(vault.positions.map((p) => p.asset))).map((p) => [
          p.asset,
          Number(p.usdPerToken),
        ]),
      );
      const usdOf = [vault.cash, ...vault.positions].map(
        (h) => [h.asset, Number(h.display) * (prices.get(h.asset) ?? 1)] as const,
      );
      const total = usdOf.reduce((n, [, v]) => n + v, 0);
      return {
        total,
        bps: Object.fromEntries(usdOf.map(([id, v]) => [id, Math.round((v / total) * 10_000)])),
      };
    };
    return {
      ...s,
      entry,
      mock,
      owner,
      address,
      recipeId: published.onchainId,
      read,
      shares,
      url: `/v1/vaults/solana/${address}/rebalance`,
    };
  }

  it('needs the owner: nobody signed in is 401, and a stranger is told there is no such vault', async () => {
    const s = await followed();
    const none = await s.app.inject({ method: 'POST', url: s.url, payload: {} });
    expect(none.statusCode).toBe(401);
    const res = await s.post(s.url, {}, s.stranger);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(s.store.saveOrder).not.toHaveBeenCalled();
  });

  it('orders the trades that bring a vault that just followed 50/30/20 to those targets, and nothing else', async () => {
    const s = await followed();
    // As following left it: the targets are the portfolio's, the holdings the old ones.
    const before = await s.shares();
    expect((await s.read()).recipeOnchainId).toBe(s.recipeId);
    expect(before.bps['solana:usdc']).toBeGreaterThan(2400);
    expect(before.bps['solana:gold']).toBe(0);

    const res = await s.post(s.url, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const ordered = RebalanceVaultResponse.parse(res.json());
    if (ordered.status !== 'ordered') throw new Error(res.body);
    expect(ordered.targets).toEqual(FOLLOWED);
    const { order } = ordered;
    expect(order.type).toBe('rebalance');
    expect(order.status).toBe('open');
    expect(order.owner.solana).toBe(s.owner);
    expect(order.needsConsent).toEqual([]);
    // Swaps only: the targets are not set again, so the vault goes on following.
    expect(order.legs.every((l) => l.kind === 'swap' && l.signer === 'owner')).toBe(true);
    const trades = order.legs.flatMap((l) => l.trades);
    // Nothing is over its target but the cash: every trade spends cash on a target.
    expect(trades.every((t) => t.sell === 'solana:usdc')).toBe(true);
    const spent = Object.fromEntries(trades.map((t) => [t.buy, Number(t.amountInRaw) / 1e6]));
    expect(Object.keys(spent).every((id) => FOLLOWED.some((t) => t.asset === id))).toBe(true);
    // Gold from nothing to 20% of the vault and the second asset from 25% to 30%, less the slippage
    // the order counts on.
    expect(spent['solana:gold']).toBeGreaterThan(before.total * 0.19);
    expect(spent['solana:gold']).toBeLessThanOrEqual(before.total * 0.2);
    expect(spent['solana:spy']).toBeGreaterThan(before.total * 0.04);
    expect(spent['solana:spy']).toBeLessThanOrEqual(before.total * 0.055);
    // Every trade states the least it may give.
    for (const leg of order.legs) {
      expect(leg.expected).toHaveLength(leg.trades.length);
      for (const e of leg.expected) expect(BigInt(e.minOutRaw) > 0n).toBe(true);
    }
    // What a person reads of it says neither "buy" nor "mix" (WORDS-VAULT-DEPOSIT).
    expect(order.summary).toBe('Rebalance your vault on Solana to its targets');
    for (const text of [order.summary, ...order.legs.map((l) => l.description)])
      expect(text).not.toMatch(/\b(buy|mix)\b/i);
    expect(s.saved).toHaveLength(1);
    const request = s.saved[0]?.request;
    expect(request).toEqual({
      type: 'rebalance',
      vaults: [s.address],
      reason: 'manual',
      targets: FOLLOWED,
      maxSlippageBps: 100,
    });
    if (request?.type !== 'rebalance') throw new Error('not a rebalance');

    // Built as the order routes build them and landed: the vault is at its targets and still follows.
    for (const leg of order.legs)
      await s.mock.send(await buildRetarget(request, leg, s.entry, s.owner, undefined, true));
    const after = await s.shares();
    expect(Math.abs((after.bps['solana:yield'] ?? 0) - 5000)).toBeLessThan(100);
    expect(Math.abs((after.bps['solana:spy'] ?? 0) - 3000)).toBeLessThan(100);
    expect(Math.abs((after.bps['solana:gold'] ?? 0) - 2000)).toBeLessThan(100);
    expect(after.bps['solana:usdc']).toBeLessThan(150);
    const vault = await s.read();
    expect(vault.recipeOnchainId).toBe(s.recipeId);
    expect(vault.acceptedVersion).toBe(1);
  });

  it('answers on_target, and stores nothing, once the vault is at its targets', async () => {
    const s = await followed();
    const first = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
    if (first.status !== 'ordered') throw new Error('not ordered');
    const request = s.saved[0]?.request;
    if (request?.type !== 'rebalance') throw new Error('not a rebalance');
    for (const leg of first.order.legs)
      await s.mock.send(await buildRetarget(request, leg, s.entry, s.owner, undefined, true));
    const res = await s.post(s.url, {});
    expect(res.statusCode, res.body).toBe(200);
    const again = RebalanceVaultResponse.parse(res.json());
    expect(again.status).toBe('on_target');
    expect(again.targets).toHaveLength(3);
    expect(again.targets).toEqual(expect.arrayContaining(FOLLOWED));
    expect(s.saved).toHaveLength(1);
  });

  it("refuses to build a step once the vault's targets are no longer the order's", async () => {
    const s = await followed();
    const ordered = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
    if (ordered.status !== 'ordered') throw new Error('not ordered');
    const request = s.saved[0]?.request;
    const [leg] = ordered.order.legs;
    if (request?.type !== 'rebalance' || !leg) throw new Error('not a rebalance');
    await s.mock.send(
      await s.entry.adapter.buildSetTargets({
        vault: s.address,
        targets: [{ asset: 'solana:yield', weightBps: 10_000 }],
      }),
    );
    const built = buildRetarget(request, leg, s.entry, s.owner, undefined, true);
    await expect(built).rejects.toMatchObject({ status: 409 });
    await expect(built).rejects.toThrow(/targets/);
  });

  it('takes no body field but the slippage', async () => {
    const s = await followed();
    const res = await s.post(s.url, { targets: [{ asset: 'solana:tsla', weightBps: 10_000 }] });
    expect(res.statusCode).toBe(400);
    expect(s.store.saveOrder).not.toHaveBeenCalled();
  });

  it('leaves a vault with auto-follow on to the keeper where the chain runs one, and orders it where none runs', async () => {
    const s = await followed();
    await s.mock.send(await s.entry.adapter.buildSetAutoFollow({ vault: s.address, on: true }));
    const res = await s.post(s.url, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(OrderError.parse(res.json()).details).toMatchObject({ issues: ['AUTO_FOLLOW_ON'] });
    expect(s.store.saveOrder).not.toHaveBeenCalled();
    // The hosted API's case: the chain's keeper path is switched off, so nobody else trades the vault.
    const noKeeper = {
      ...s.entry,
      adapter: {
        ...s.entry.adapter,
        capabilities: { ...s.entry.adapter.capabilities, autoFollow: false },
      },
    };
    const { planned } = await planVaultRebalance(noKeeper, await s.read(), {
      slippageBps: 100,
      now: '2026-10-08T12:00:00.000Z',
      owner: s.owner,
    });
    expect(planned?.order.legs.every((l) => l.kind === 'swap')).toBe(true);
    expect(planned?.order.legs.length).toBeGreaterThan(0);
  });

  it('refuses a vault with no target, which has nothing to be brought to', async () => {
    const s = await setup();
    const entry = s.chains.get('solana');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.owner.solana as Address;
    mock.fund(owner, { gasRaw: '100000000000', assets: { 'solana:usdc': '1000000000' } });
    await mock.send(
      await entry.adapter.buildCreateVault({
        owner,
        basketId: '22',
        targets: [],
        autoFollow: false,
        depositRaw: '1000000000',
        slippageBps: 100,
      }),
    );
    const [vault] = await entry.adapter.getVaults(owner);
    if (!vault) throw new Error('no vault');
    const res = await s.post(`/v1/vaults/solana/${vault.address}/rebalance`, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(s.store.saveOrder).not.toHaveBeenCalled();
  });

  describe('/quote', () => {
    it('quotes, before the follow is signed, what following would trade, and stores nothing', async () => {
      const s = await followed({ accept: false });
      // not followed yet: the vault's own targets are the old ones
      expect((await s.read()).recipeOnchainId).toBeNull();
      const res = await s.post(`${s.url}/quote`, { family: 'half-thirty-twenty', version: 1 });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const quote = RebalanceQuoteResponse.parse(res.json());
      expect(quote.status).toBe('quoted');
      expect(quote.provenance).toBe('mock');
      expect(quote.version).toBe(1);
      expect(quote.targets).toEqual(FOLLOWED);
      expect(quote.slippageBps).toBe(100);
      expect(quote.trades.map((t) => [t.sell, t.buy])).toEqual([
        ['solana:usdc', 'solana:gold'],
        ['solana:usdc', 'solana:spy'],
      ]);
      for (const t of quote.trades) {
        expect(BigInt(t.minOutRaw) > 0n && BigInt(t.minOutRaw) <= BigInt(t.expectedOutRaw)).toBe(
          true,
        );
        expect(Number(t.valueUsd)).toBeCloseTo(Number(t.amountInRaw) / 1e6, 2);
      }
      // Before and after, each against its target: cash first.
      const by = Object.fromEntries(quote.holdings.map((h) => [h.asset, h]));
      expect(quote.holdings[0]).toMatchObject({ asset: 'solana:usdc', cash: true, targetBps: 0 });
      expect(by['solana:usdc']?.beforeBps).toBeGreaterThan(2400);
      expect(by['solana:usdc']?.afterBps).toBeLessThan(150);
      expect(by['solana:gold']).toMatchObject({ targetBps: 2000, beforeBps: 0 });
      expect(Math.abs((by['solana:gold']?.afterBps ?? 0) - 2000)).toBeLessThan(60);
      expect(Math.abs((by['solana:spy']?.afterBps ?? 0) - 3000)).toBeLessThan(60);
      expect(Math.abs((by['solana:yield']?.afterBps ?? 0) - 5000)).toBeLessThan(60);
      // The total cost is the trades' quoted costs, in dollars; every price carries its source.
      const cost = quote.trades.reduce((n, t) => n + (Number(t.valueUsd) * t.costBps) / 10_000, 0);
      expect(Number(quote.costUsd)).toBeCloseTo(cost, 1);
      expect(Number(quote.valueUsd)).toBeGreaterThan(79_000);
      for (const id of ['solana:gold', 'solana:spy', 'solana:yield']) {
        const price = quote.prices.find((p) => p.asset === id);
        expect(price?.source && price.fetchedAt && price.method).toBeTruthy();
      }
      expect(quote.quote).toMatchObject({ source: 'chain-mock', provenance: 'mock' });
      expect(quote.quote.method && quote.quote.fetchedAt).toBeTruthy();
      expect(quote.unavailable).toBeNull();
      expect(s.store.saveOrder).not.toHaveBeenCalled();
      // and nothing moved
      expect((await s.read()).recipeOnchainId).toBeNull();
    });

    it("quotes against the vault's own targets where no portfolio is named, as the order then trades", async () => {
      const s = await followed();
      const quote = RebalanceQuoteResponse.parse((await s.post(`${s.url}/quote`, {})).json());
      expect(quote).toMatchObject({ status: 'quoted', version: null });
      const ordered = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
      if (ordered.status !== 'ordered') throw new Error('not ordered');
      expect(quote.trades.map((t) => [t.sell, t.buy, t.amountInRaw, t.minOutRaw])).toEqual(
        ordered.order.legs.flatMap((l) =>
          l.trades.map((t, i) => [t.sell, t.buy, t.amountInRaw, l.expected[i]?.minOutRaw]),
        ),
      );
    });

    it('says which asset cannot be quoted and why, and still answers', async () => {
      const s = await followed({ accept: false });
      s.mock.setPriceAge('solana:gold', 1_000_000);
      const res = await s.post(`${s.url}/quote`, { family: 'half-thirty-twenty' });
      expect(res.statusCode, res.body).toBe(200);
      const quote = RebalanceQuoteResponse.parse(res.json());
      expect(quote.status).toBe('unavailable');
      expect(quote.trades).toEqual([]);
      expect(quote.unavailable?.issues).toEqual(['NO_PRICE:solana:gold']);
      expect(quote.unavailable?.reason).toMatch(/solana:gold/);
      // the holdings as they are, against the targets following would give
      expect(quote.holdings.find((h) => h.asset === 'solana:spy')?.targetBps).toBe(3000);
    });

    it('answers on_target with no trade, a stranger 404, an unknown portfolio 404, a stale version VERSION_CHANGED', async () => {
      const s = await followed();
      expect((await s.post(`${s.url}/quote`, {}, s.stranger)).statusCode).toBe(404);
      expect((await s.post(`${s.url}/quote`, { family: 'nobody' })).statusCode).toBe(404);
      const stale = await s.post(`${s.url}/quote`, { family: 'half-thirty-twenty', version: 2 });
      expect(stale.statusCode).toBe(409);
      expect(OrderError.parse(stale.json()).code).toBe('VERSION_CHANGED');
      const ordered = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
      const request = s.saved[0]?.request;
      if (ordered.status !== 'ordered' || request?.type !== 'rebalance')
        throw new Error('no order');
      for (const leg of ordered.order.legs)
        await s.mock.send(await buildRetarget(request, leg, s.entry, s.owner, undefined, true));
      const quote = RebalanceQuoteResponse.parse((await s.post(`${s.url}/quote`, {})).json());
      expect(quote).toMatchObject({ status: 'on_target', trades: [], costUsd: '0' });
    });
  });

  describe("on EVM, where a quote's minimum carries the feed's floor (priceBoundBps)", () => {
    const priceBoundBps = 200;
    const SPY = 'robinhood:spy';
    /**
     * An EVM vault all in SPY with targets of half SPY, half NVDA: its rebalance sells SPY. The
     * chain's quote of that sale is the pool's, `under` bps below what the feed says it is worth, and
     * its minimum is the feed's floor, `priceBoundBps` under that worth, as the EVM adapter's is.
     */
    async function evmVault(under: number) {
      const s = await setup();
      const entry = s.chains.get('robinhood');
      const mock = entry.mock;
      if (!mock) throw new Error('the test chain is the mock');
      const owner = s.evmOnly.evm as Address;
      mock.fund(owner, {
        gasRaw: '1000000000000000000',
        assets: { 'robinhood:usdc': '1000000000' },
      });
      await mock.send(
        await entry.adapter.buildApprove({ owner, basketId: '31', amountRaw: '1000000000' }),
      );
      await mock.send(
        await entry.adapter.buildCreateVault({
          owner,
          basketId: '31',
          targets: [
            { asset: SPY, weightBps: 5000 },
            { asset: 'robinhood:nvda', weightBps: 5000 },
          ],
          autoFollow: false,
          depositRaw: '1000000000',
          trades: [{ sell: 'robinhood:usdc', buy: SPY, amountInRaw: '1000000000' }],
          slippageBps: 100,
        }),
      );
      const [vault] = await entry.adapter.getVaults(owner);
      if (!vault) throw new Error('no vault');
      const quote = entry.adapter.quote.bind(entry.adapter);
      vi.spyOn(entry.adapter, 'quote').mockImplementation(async (trade, taker) => {
        const q = await quote(trade, taker);
        if (trade.sell !== SPY) return q;
        const worth = BigInt(q.outRaw);
        const out = (worth * BigInt(10_000 - under)) / 10_000n;
        const floor = (worth * BigInt(10_000 - priceBoundBps)) / 10_000n;
        const slipped = (out * 9_900n) / 10_000n;
        return {
          ...q,
          outRaw: out.toString(),
          minOutRaw: (floor > slipped ? floor : slipped).toString(),
          floorRaw: floor.toString(),
        };
      });
      return { ...s, entry, owner, vault, url: `/v1/vaults/robinhood/${vault.address}/rebalance` };
    }

    it("states the feed's floor as the sale's minimum where it is above the slippage, in the order and in the quote", async () => {
      const s = await evmVault(150);
      const res = await s.post(s.url, {}, s.evmOnly);
      expect(res.statusCode, res.body).toBe(200);
      const ordered = RebalanceVaultResponse.parse(res.json());
      if (ordered.status !== 'ordered') throw new Error(res.body);
      const legs = ordered.order.legs;
      const at = legs.flatMap((l) => l.trades.map((t, i) => ({ t, e: l.expected[i] })));
      const sale = at.find(({ t }) => t.sell === SPY);
      if (!sale?.e) throw new Error('no sale');
      const quoted = await s.entry.adapter.quote(sale.t, s.owner);
      // the floor, not the quote less 100 bps, and never over what the pool gives
      expect(sale.e.minOutRaw).toBe(quoted.minOutRaw);
      expect(BigInt(sale.e.minOutRaw) > (BigInt(sale.e.outRaw) * 9_900n) / 10_000n).toBe(true);
      expect(BigInt(sale.e.minOutRaw) <= BigInt(sale.e.outRaw)).toBe(true);
      const quote = RebalanceQuoteResponse.parse(
        (await s.post(`${s.url}/quote`, {}, s.evmOnly)).json(),
      );
      expect(quote.trades.find((t) => t.sell === SPY)?.minOutRaw).toBe(quoted.minOutRaw);
    });

    it("does not order a sale whose pool gives less than the feed's floor, and the quote says which and why", async () => {
      const s = await evmVault(250);
      const res = await s.post(s.url, {}, s.evmOnly);
      expect(res.statusCode, res.body).toBe(409);
      expect(OrderError.parse(res.json()).details?.issues).toEqual([`PRICE_BOUND:${SPY}`]);
      expect(s.store.saveOrder).not.toHaveBeenCalled();
      const quote = RebalanceQuoteResponse.parse(
        (await s.post(`${s.url}/quote`, {}, s.evmOnly)).json(),
      );
      expect(quote.status).toBe('unavailable');
      expect(quote.unavailable?.issues).toEqual([`PRICE_BOUND:${SPY}`]);
      expect(quote.unavailable?.reason).toMatch(/reference price/);
    });
  });

  it('offers a rebalance with the slippage the server makes it with', () => {
    expect(ORDER_POLICY.slippageBps).toBe(OWNER_REBALANCE_SLIPPAGE_BPS);
    // and makes no trade smaller than the smallest line a plan holds
    expect(PERSONAL_PARAMS.minLineUsd).toBe(OWNER_REBALANCE_MIN_TRADE_USD);
  });

  describe('the review of #265', () => {
    const usd = (dollars: number) => BigInt(Math.round(dollars * 1e6)).toString();
    /** A Solana vault with these targets, opened with `cash` dollars and then these purchases. */
    async function solanaVault(
      targets: { asset: string; weightBps: number }[],
      cash: number,
      buys: [string, number][],
    ) {
      const s = await setup();
      const entry = s.chains.get('solana');
      const mock = entry.mock;
      if (!mock) throw new Error('the test chain is the mock');
      const owner = s.owner.solana as Address;
      mock.fund(owner, { gasRaw: '100000000000', assets: { 'solana:usdc': usd(cash) } });
      await mock.send(
        await entry.adapter.buildCreateVault({
          owner,
          basketId: '41',
          targets,
          autoFollow: false,
          depositRaw: usd(cash),
          slippageBps: 100,
        }),
      );
      const [vault] = await entry.adapter.getVaults(owner);
      if (!vault) throw new Error('no vault');
      for (const [buy, dollars] of buys)
        await mock.send(
          await entry.adapter.buildOwnerSwap({
            vault: vault.address,
            trades: [{ sell: 'solana:usdc', buy, amountInRaw: usd(dollars) }],
            slippageBps: 100,
          }),
        );
      const land = async (request: IntentRequest | undefined, order: Order) => {
        if (request?.type !== 'rebalance') throw new Error('not a rebalance');
        for (const leg of order.legs)
          await mock.send(await buildRetarget(request, leg, entry, owner, undefined, true));
      };
      return {
        ...s,
        entry,
        mock,
        owner,
        address: vault.address,
        land,
        url: `/v1/vaults/solana/${vault.address}/rebalance`,
      };
    }

    it('an all-cash vault rebalanced once is on target after: the cash its purchases keep for slippage is not drift', async () => {
      const s = await solanaVault(
        [
          { asset: 'solana:spy', weightBps: 5000 },
          { asset: 'solana:gold', weightBps: 5000 },
        ],
        10_000,
        [],
      );
      const first = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
      if (first.status !== 'ordered') throw new Error('not ordered');
      await s.land(s.saved[0]?.request, first.order);
      const again = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
      expect(again.status).toBe('on_target');
      expect(s.saved).toHaveLength(1);
    });

    it('makes no trade smaller than the smallest line a plan holds', async () => {
      const s = await solanaVault(
        [
          { asset: 'solana:spy', weightBps: 4996 },
          { asset: 'solana:gold', weightBps: 5000 },
          { asset: 'solana:tsla', weightBps: 4 },
        ],
        10_000,
        [
          ['solana:spy', 5_600],
          ['solana:gold', 4_399],
          ['solana:tsla', 1],
        ],
      );
      const ordered = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
      if (ordered.status !== 'ordered') throw new Error('not ordered');
      const trades = ordered.order.legs.flatMap((l) => l.trades);
      expect(trades.map((t) => t.buy)).not.toContain('solana:tsla');
      for (const t of trades)
        if (t.sell === 'solana:usdc') expect(Number(t.amountInRaw) / 1e6).toBeGreaterThanOrEqual(5);
    });

    it('judges one order by what it trades, not by what the vault is worth', async () => {
      const s = await solanaVault(
        [
          { asset: 'solana:spy', weightBps: 5000 },
          { asset: 'solana:gold', weightBps: 5000 },
        ],
        1_200_000,
        [
          ['solana:spy', 600_000],
          ['solana:gold', 580_000],
        ],
      );
      const res = await s.post(s.url, {});
      expect(res.statusCode, res.body).toBe(200);
      const ordered = RebalanceVaultResponse.parse(res.json());
      expect(ordered.status).toBe('ordered');
    });

    it('builds no step once auto-follow is on where a keeper runs, and none that would push an asset past its target', async () => {
      const s = await solanaVault(
        [
          { asset: 'solana:spy', weightBps: 5000 },
          { asset: 'solana:gold', weightBps: 5000 },
        ],
        10_000,
        [],
      );
      // two orders from the same holdings: the second is sized for what the first already did
      const first = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
      const second = RebalanceVaultResponse.parse((await s.post(s.url, {})).json());
      if (first.status !== 'ordered' || second.status !== 'ordered') throw new Error('no order');
      await s.land(s.saved[0]?.request, first.order);
      const request = s.saved[1]?.request;
      const [leg] = second.order.legs;
      if (request?.type !== 'rebalance' || !leg) throw new Error('not a rebalance');
      const past = buildRetarget(request, leg, s.entry, s.owner, undefined, true);
      await expect(past).rejects.toMatchObject({ status: 409 });
      await expect(past).rejects.toThrow(/past its target/);

      const s2 = await solanaVault(
        [
          { asset: 'solana:spy', weightBps: 5000 },
          { asset: 'solana:gold', weightBps: 5000 },
        ],
        10_000,
        [],
      );
      const ordered = RebalanceVaultResponse.parse((await s2.post(s2.url, {})).json());
      const req2 = s2.saved[0]?.request;
      const [leg2] = ordered.status === 'ordered' ? ordered.order.legs : [];
      if (req2?.type !== 'rebalance' || !leg2) throw new Error('not a rebalance');
      await s2.mock.send(
        await s2.entry.adapter.buildSetAutoFollow({ vault: s2.address, on: true }),
      );
      const keeper = buildRetarget(req2, leg2, s2.entry, s2.owner, undefined, true);
      await expect(keeper).rejects.toMatchObject({ status: 409 });
      await expect(keeper).rejects.toThrow(/auto-follow is on/);
    });
  });

  it.each([
    ['TradeOverAssetLimit', 422, false, 'TRADE_TOO_LARGE'],
    ['TradeOverClosedLimit', 409, true, 'TRADE_WAITS_FOR_OPEN'],
  ] as const)(
    "says a trade over the network's limit (%s) by its code: for good where it is the asset's, until the market opens where it is the closed market's",
    async (code, status, retryable, issue) => {
      const s = await setup();
      const entry = s.chains.get('robinhood');
      const mock = entry.mock;
      if (!mock) throw new Error('the test chain is the mock');
      const owner = s.evmOnly.evm as Address;
      mock.fund(owner, {
        gasRaw: '1000000000000000000',
        assets: { 'robinhood:usdc': '1000000000' },
      });
      await mock.send(
        await entry.adapter.buildApprove({ owner, basketId: '32', amountRaw: '1000000000' }),
      );
      await mock.send(
        await entry.adapter.buildCreateVault({
          owner,
          basketId: '32',
          targets: [
            { asset: 'robinhood:spy', weightBps: 5000 },
            { asset: 'robinhood:nvda', weightBps: 5000 },
          ],
          autoFollow: false,
          depositRaw: '1000000000',
          trades: [{ sell: 'robinhood:usdc', buy: 'robinhood:spy', amountInRaw: '1000000000' }],
          slippageBps: 100,
        }),
      );
      const [vault] = await entry.adapter.getVaults(owner);
      if (!vault) throw new Error('no vault');
      const quote = entry.adapter.quote.bind(entry.adapter);
      vi.spyOn(entry.adapter, 'quote').mockImplementation(async (trade, taker) => {
        if (trade.sell === 'robinhood:spy')
          throw new ChainError(
            code,
            "$495.00 of SPY in one go is more than is traded while SPY's market is closed: at most $100.00 at a time. Trade less, or in parts",
          );
        return quote(trade, taker);
      });
      const url = `/v1/vaults/robinhood/${vault.address}/rebalance`;
      const res = await s.post(url, {}, s.evmOnly);
      expect(res.statusCode, res.body).toBe(status);
      expect(OrderError.parse(res.json()).details).toMatchObject({
        retryable,
        issues: [`${issue}:robinhood:spy`],
      });
      expect(s.store.saveOrder).not.toHaveBeenCalled();
      const quoted = RebalanceQuoteResponse.parse(
        (await s.post(`${url}/quote`, {}, s.evmOnly)).json(),
      );
      expect(quoted.status).toBe('unavailable');
      expect(quoted.unavailable?.issues).toEqual([`${issue}:robinhood:spy`]);
    },
  );
});
