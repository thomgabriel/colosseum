import type { BasketAsset, VaultAgentResult, VaultState } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { type EvalScore, type EvalSet, evalCounts, scoreAnswer } from '../testing/lookup-eval';
import { type ModelScript, scriptedModel } from '../testing/lookup-script';
import { fixtureLookups, OFFLINE_DB } from '../testing/lookups';
import { createAnthropicVaultAgentModel } from '../vault-agent-model';
import evalSet from './lookup-eval.json';
import { createRelaxedGoalAgent } from './relaxed-goal-agent';
import {
  type GoalAgentContext,
  replyToVaultConversation,
  type VaultAgentContext,
} from './vault-agent';

// The eval set of the conversations' lookups (lookup-eval.json, API-AGENT-LOOKUPS-2), offline: each
// question through its conversation with the model replaying its recorded reply (MOCK: hand-written,
// each lookup round and the final JSON) and the reader of slice 1 over its fixtures. Every expected
// family is served with its pin, nothing forbidden is served, and no answer fails.

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class Timeout extends Error {}
  class APIError extends Error {}
  return {
    default: class {
      static APIConnectionTimeoutError = Timeout;
      static APIError = APIError;
      messages = { create: sdk.create };
    },
  };
});

const set = evalSet as unknown as EvalSet;
const shelf = launchShelf().assets;
const at = '2026-10-06T06:00:00.000Z';
const assetsOf = (chain: 'solana' | 'robinhood') => shelf.filter((a) => a.chain === chain);
const evidenceOf = (assets: BasketAsset[]) =>
  assets.map((asset) => ({
    id: `catalog:${asset.id}`,
    assetId: asset.id,
    source: 'offline catalog fixture',
    method: 'listed assets',
    fetchedAt: at,
    provenance: 'live' as const,
  }));
const goalContext = (chain: 'solana' | 'robinhood') =>
  ({
    person: 'eval-person',
    kind: 'new_goal',
    chain,
    state: null,
    assets: assetsOf(chain),
    evidence: evidenceOf(assetsOf(chain)),
    currentGoals: [],
    stockAttributes: null,
    liquidity: [],
    unknowns: [],
    caps: {},
  }) as unknown as GoalAgentContext;
/** A vault on each chain holding its Nvidia token and cash, opened for a plan to grow. */
const vaultContext = (chain: 'solana' | 'robinhood'): VaultAgentContext => {
  const assets = assetsOf(chain);
  const cash = assets.find((a) => a.cls === 'cash') as BasketAsset;
  const held = chain === 'solana' ? 'solana:nvdax' : 'robinhood:nvda';
  const state: VaultState = {
    chain,
    address: cash.address,
    owner: cash.address,
    basketId: '1',
    keeper: cash.address,
    recipeOnchainId: null,
    acceptedVersion: 0,
    autoFollow: false,
    cash: { asset: cash.id, raw: '1000000000', display: '1000', multiplier: '1' },
    positions: [
      {
        asset: held,
        raw: '10000000',
        display: '10',
        multiplier: '1',
        targetBps: 5000,
        lastKeeperAt: null,
      },
    ],
    lossUsedBps: 0,
    observedAt: at,
    pending: null,
  };
  return {
    person: 'eval-owner',
    state,
    assets,
    currentGoals: [{ goal: 'grow', objective: 'Grow with stocks' }],
    evidence: evidenceOf(assets),
    stockAttributes: null,
    liquidity: [],
    unknowns: [],
  };
};
const lookups = { service: fixtureLookups(), db: OFFLINE_DB };

async function answer(question: EvalSet['questions'][number]): Promise<VaultAgentResult> {
  const script: ModelScript = {
    lookups: question.recorded.lookups,
    final: question.recorded.final,
  };
  const model = scriptedModel(script);
  const request = {
    version: 1 as const,
    language: 'en' as const,
    messageId: question.id,
    messages: question.messages,
  };
  if (question.conversation === 'goal') {
    const agent = createRelaxedGoalAgent({
      apiKey: 'offline-placeholder',
      log: () => {},
      create: model.create,
    });
    return agent.reply(request, goalContext(question.chain), lookups);
  }
  sdk.create.mockImplementation(model.create);
  return replyToVaultConversation(
    request,
    vaultContext(question.chain),
    createAnthropicVaultAgentModel({
      apiKey: 'offline-placeholder',
      model: 'configured-fixture-model',
      timeoutMs: 6000,
      quota: { reserve: () => null },
    }),
    lookups,
  );
}

describe('the eval scoring', () => {
  const q = set.questions.find(
    (x) => x.id === 'vault-sol-share-typed',
  ) as EvalSet['questions'][number];
  const fact = {
    id: 'pool:solana:nvdax:1:tvl',
    assetId: 'solana:nvdax',
    text: '$3,627,618.88',
    value: 3_627_618.88,
    unit: 'USD',
    source: 'fixture',
    method: 'fixture',
    fetchedAt: at,
    provenance: 'live' as const,
    staleAgeSec: null,
  };
  const reply = (message: string, weights?: [string, number][]) => ({
    message,
    question: null,
    figures: { prose: { message, question: null, proposal: null }, facts: [fact] },
    proposal: weights
      ? ({ allocations: weights.map(([assetId, weightBps]) => ({ assetId, weightBps })) } as never)
      : null,
  });
  it('fails what it must: a failure, a missing family, a typed number, a verdict, a forecast, a promise, a share off a figure', () => {
    expect(scoreAnswer(q, null).problems).toEqual(['failed']);
    expect(scoreAnswer(q, { ...reply('Nothing.'), figures: undefined }).problems).toEqual([
      'no pool figure served with its pin',
    ]);
    const said = (message: string) => scoreAnswer(q, reply(message)).problems;
    expect(said('NVDAx holds $3,627,618.88 and about $3.6m.')).toEqual(['typed_number']);
    expect(said('NVDAx holds $3,627,618.88, deeper than TSLAx.')).toEqual(['verdict']);
    expect(said('NVDAx holds $3,627,618.88 and will keep growing.')).toEqual(['forecast']);
    expect(said('NVDAx holds $3,627,618.88, so it is safe.')).toEqual(['promise']);
    expect(
      scoreAnswer(
        q,
        reply('NVDAx holds $3,627,618.88.', [
          ['solana:nvdax', 6517],
          ['solana:tslax', 3483],
        ]),
      ).problems,
    ).toEqual(['share_from_figure']);
    expect(
      scoreAnswer(
        q,
        reply('NVDAx holds $3,627,618.88.', [
          ['solana:nvdax', 6000],
          ['solana:tslax', 4000],
        ]),
      ).problems,
    ).toEqual([]);
  });

  it("takes any of a family's alternatives, and none outside them", () => {
    const deeper = { ...q, expect: { families: ['pool|capacity|exit'] } };
    const capacity = { ...fact, id: 'capacity:solana:nvdax' };
    const served = (one: typeof fact) => ({
      ...reply('NVDAx can sell $3,627,618.88.'),
      figures: { prose: { message: '', question: null, proposal: null }, facts: [one] },
    });
    expect(scoreAnswer(deeper, served(capacity)).problems).toEqual([]);
    expect(scoreAnswer(deeper, served(fact)).problems).toEqual([]);
    expect(scoreAnswer(deeper, served({ ...fact, id: 'vol:solana:nvdax' })).problems).toEqual([
      'no pool|capacity|exit figure served with its pin',
    ]);
  });
});

describe('the eval set of the lookups, offline (recorded replies, MOCK)', () => {
  it('has at least 24 questions on Solana and Robinhood Chain, in both conversations', () => {
    expect(set.questions.length).toBeGreaterThanOrEqual(24);
    for (const chain of ['solana', 'robinhood'])
      for (const conversation of ['goal', 'vault'])
        expect(
          set.questions.some((q) => q.chain === chain && q.conversation === conversation),
        ).toBe(true);
    expect(new Set(set.questions.map((q) => q.id)).size).toBe(set.questions.length);
    for (const q of set.questions) {
      expect(q.recorded.mock).toBe(true);
      // every asset a recorded lookup names is a real catalog id (some on purpose not of this chain)
      for (const round of q.recorded.lookups)
        for (const call of round)
          expect([
            q.id,
            shelf.some((a) => a.id === call.input.assetId) || call.input.assetId,
          ]).toEqual([q.id, call.input.assetId === 'solana:bonk' ? 'solana:bonk' : true]);
    }
  });

  it('serves every expected family with its pin, nothing forbidden, and fails none', async () => {
    const scores: EvalScore[] = [];
    for (const question of set.questions) {
      const result = await answer(question);
      scores.push(scoreAnswer(question, result.kind === 'reply' ? result.reply : null));
    }
    const counts = evalCounts(scores);
    // counts only: never a reply
    console.info('lookup eval (offline, MOCK replies):', JSON.stringify(counts));
    expect(scores.filter((s) => s.failed || s.problems.length)).toEqual([]);
    expect(counts.failed).toBe(0);
    expect(counts.passed).toBe(set.questions.length);
  });
});
