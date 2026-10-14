import type {
  VaultAgentModelReply,
  VaultAgentRequest,
  VaultAgentResult,
  VaultState,
} from '@colosseum/schemas';
import { VaultAgentReply } from '@colosseum/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import { LOOKUP_TOOLS, type LookupBase } from './orders/lookup-loop';
import {
  FIGURE_CUT,
  type GoalAgentContext,
  replyToVaultConversation,
  type VaultAgentContext,
} from './orders/vault-agent';
import { type ModelScript, scriptedModel, toolResults } from './testing/lookup-script';
import { fixtureLookups, OFFLINE_DB } from './testing/lookups';
import {
  createAnthropicVaultAgentModel,
  VAULT_AGENT_SYSTEM,
  type VaultAgentModel,
} from './vault-agent-model';

// The lookups in a vault's own conversation (FIGURES-BY-REFERENCE as amended 2026-10-14, ledger
// API-AGENT-LOOKUPS-2): the real model client with the SDK stubbed and its replies scripted (MOCK,
// testing/lookup-script.ts), the reader of slice 1 over its fixtures. Nothing leaves the machine.

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

type Quota = () => 'model_budget_spent' | 'model_person_budget_spent' | null;
const catalog = launchShelf().assets.filter((asset) => asset.chain === 'solana');
const NVDA = 'solana:nvdax';
const cash = catalog.find((asset) => asset.cls === 'cash');
if (!cash) throw new Error('no cash fixture');
const observedAt = '2026-10-06T06:00:00.000Z';
const state: VaultState = {
  chain: 'solana',
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
      asset: NVDA,
      raw: '10000000',
      display: '10',
      multiplier: '1',
      targetBps: 5000,
      lastKeeperAt: null,
    },
  ],
  lossUsedBps: 0,
  observedAt,
  pending: null,
};
const context: VaultAgentContext = {
  person: 'owner-fixture',
  state,
  assets: catalog,
  currentGoals: [{ goal: 'grow', objective: 'Grow with stocks' }],
  evidence: catalog.map((asset) => ({
    id: `catalog:${asset.id}`,
    assetId: asset.id,
    source: 'offline catalog fixture',
    method: 'listed assets',
    fetchedAt: observedAt,
    provenance: 'live' as const,
  })),
  stockAttributes: null,
  liquidity: [],
  unknowns: [],
};
const turn = (text: string): VaultAgentRequest => ({
  version: 1,
  language: 'en',
  messageId: 'offline-turn',
  messages: [{ who: 'person', text }],
});
const ref = (id: string) => `{{fact:${id}}}`;
const said = (message: string): VaultAgentModelReply => ({
  message,
  question: null,
  proposal: null,
});
const week = { name: 'asset_price_history', input: { assetId: NVDA, window: '7d' } };
const base = (over: Partial<LookupBase> = {}): LookupBase => ({
  service: fixtureLookups(),
  db: OFFLINE_DB,
  ...over,
});
function model(reserve: Quota = () => null): VaultAgentModel {
  return createAnthropicVaultAgentModel({
    apiKey: 'offline-placeholder',
    model: 'configured-fixture-model',
    timeoutMs: 6000,
    quota: { reserve },
  });
}
async function ask(
  script: ModelScript,
  text = 'how did my Nvidia move this week?',
  over: { ctx?: VaultAgentContext | GoalAgentContext; lookups?: LookupBase | null } = {},
  reserve?: Quota,
) {
  const scripted = scriptedModel(script);
  sdk.create.mockImplementation(scripted.create);
  const lookups = over.lookups === undefined ? base() : over.lookups;
  const result = await replyToVaultConversation(
    turn(text),
    over.ctx ?? context,
    model(reserve),
    ...(lookups ? [lookups] : []),
  );
  return { result, calls: scripted.calls, responses: scripted.responses };
}
const served = (result: VaultAgentResult) => {
  if (result.kind !== 'reply') throw new Error(`no reply: ${JSON.stringify(result)}`);
  expect(VaultAgentReply.safeParse(result.reply).success).toBe(true);
  return result.reply;
};
const MOVED = `Nvidia's price changed by ${ref(`bars:${NVDA}:7d:change`)} over the last week, and its latest closing price was ${ref(`bars:${NVDA}:7d:close`)}.`;

beforeEach(() => {
  sdk.create.mockReset();
});

describe("a vault's own conversation looks up the data we hold", () => {
  it('serves a looked-up figure by reference with its pin', async () => {
    const { result, calls, responses } = await ask({ lookups: [[week]], final: said(MOVED) });
    const reply = served(result);
    expect(reply.message).toBe(
      "Nvidia's price changed by 4.32% over the last week, and its latest closing price was $240.51.",
    );
    expect(reply.figures?.facts.find((f) => f.id === `bars:${NVDA}:7d:change`)).toMatchObject({
      text: '4.32%',
      unit: 'fraction',
      provenance: 'live',
      source: expect.stringMatching(/\S/u),
      method: expect.stringMatching(/\S/u),
    });
    expect(result.kind === 'reply' && result.lookups).toMatchObject({ rounds: 1, calls: 1 });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.tools === LOOKUP_TOOLS)).toBe(true);
    expect(calls[0]?.tool_choice).toBeUndefined();
    // the assistant's turn exactly as it came, then one user message with every result
    expect(calls[1]?.messages[1]).toEqual({ role: 'assistant', content: responses[0]?.content });
    expect(calls[1]?.messages[1]?.content).toBe(responses[0]?.content);
    expect(toolResults(calls[1])).toHaveLength(1);
  });

  it('serves the volume on the entry side', async () => {
    const message = `Over the last week ${ref(`bars:${NVDA}:7d:buyvol`)} of NVDAx traded on the entry side.`;
    const { result } = await ask({ lookups: [[week]], final: said(message) });
    expect(served(result).message).toBe(
      'Over the last week $51,163,435.96 of NVDAx traded on the entry side.',
    );
  });

  it('gives the new-goal conversation no tools: it states no figure', async () => {
    const goal: GoalAgentContext = {
      ...context,
      kind: 'new_goal',
      chain: 'solana',
      state: null,
    } as unknown as GoalAgentContext;
    const { calls } = await ask({ lookups: [[week]], final: said('Tell me more.') }, 'hi', {
      ctx: goal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('tools');
    // nor does the conversation hand a model the lookups for a new goal
    const read = vi.fn(async () => ({ reply: said('Tell me more.') }));
    await replyToVaultConversation(turn('hi'), goal, { read }, base());
    expect(read.mock.calls[0]).toHaveLength(2);
  });

  it('repairs with the attempt as it was and no lookup, then cuts what still cannot be served', async () => {
    const bad = said(
      `Nvidia's latest closing price was ${ref(`bars:${NVDA}:30d:close`)}. It trades on several pools.`,
    );
    const { result, calls } = await ask({ lookups: [[week]], final: bad });
    expect(served(result).message).toBe(`It trades on several pools.\n${FIGURE_CUT.en}`);
    expect(calls).toHaveLength(3);
    const repair = calls[2];
    expect(repair?.tool_choice).toEqual({ type: 'none' });
    expect(repair?.tools).toBe(LOOKUP_TOOLS);
    expect(repair?.messages.slice(0, 3)).toEqual(calls[1]?.messages);
    expect(String(repair?.messages.at(-1)?.content)).toMatch(/^The server could not accept/u);
    expect(result.kind === 'reply' && result.repair).toMatchObject({
      failed: 'figure_reference',
      outcome: 'prose_figure_trimmed',
    });
  });

  it('cuts a looked-up figure said as a return or compared, and a typed copy of one', async () => {
    for (const message of [
      `Nvidia returned ${ref(`bars:${NVDA}:7d:change`)} over the last week.`,
      `Nvidia's latest closing price was ${ref(`bars:${NVDA}:7d:close`)} times two.`,
      `Nvidia's price will change by ${ref(`bars:${NVDA}:7d:change`)} again next week.`,
      "Nvidia's latest closing price was $240.51.",
    ]) {
      const { result } = await ask({
        lookups: [[week]],
        final: said(`${message} It trades on several pools.`),
      });
      expect([message, served(result).message]).toEqual([
        message,
        `It trades on several pools.\n${FIGURE_CUT.en}`,
      ]);
      expect(served(result).figures).toBeUndefined();
    }
  });

  it('reserves the quota before each paid call; a denial fails the reply as a budget failure', async () => {
    let n = 0;
    const reserve = vi.fn<Quota>(() => (n++ === 0 ? null : 'model_budget_spent'));
    const { result, calls } = await ask(
      { lookups: [[week]], final: said(MOVED) },
      undefined,
      {},
      reserve,
    );
    expect(result).toEqual({ kind: 'failure', reason: 'budget', detail: 'model_budget_spent' });
    expect(calls).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('never reads a looked-up figure as a share: the person sets them, the server weighs', async () => {
    const tesla = catalog.find((a) => a.underlying === 'TSLA');
    if (!tesla) throw new Error('no tesla');
    const draft: VaultAgentModelReply = {
      message: `Nvidia's largest pool holds ${ref(`pool:${NVDA}:1:tvl`)}.`,
      question: null,
      proposal: {
        objective: 'Hold Nvidia and Tesla',
        summary: 'Nvidia and Tesla, as asked.',
        allocations: [
          { assetId: NVDA, why: 'The stock you named.', evidenceIds: [`catalog:${NVDA}`] },
          {
            assetId: tesla.id,
            why: 'The other stock you named.',
            evidenceIds: [`catalog:${tesla.id}`],
          },
        ],
        // a share the model read off a figure: the server did not read it in the person's words
        stated: [{ assetIds: [NVDA], kind: 'exact', bps: 6500, quote: 'NVDAx and TSLAx' }],
        tradeoffs: [],
        unknowns: [],
      },
    };
    const { result } = await ask(
      { lookups: [[{ name: 'asset_pools', input: { assetId: NVDA } }]], final: draft },
      'Nvidia and Tesla please, and how deep are the Nvidia pools?',
    );
    const reply = served(result);
    expect(reply.proposal?.allocations.map((l) => [l.assetId, l.weightBps])).toEqual([
      [NVDA, 5000],
      [tesla.id, 5000],
    ]);
    // the looked-up figure is no pick's evidence: only the context's are
    expect(reply.proposal?.sources.map((s) => s.id).some((id) => id.startsWith('pool:'))).toBe(
      false,
    );
  });

  it('the model itself sends no tools for a new goal, even when handed the lookups', async () => {
    const scripted = scriptedModel({ lookups: [[week]], final: said('Tell me more.') });
    sdk.create.mockImplementation(scripted.create);
    const prompt = {
      version: 1,
      kind: 'new_goal',
      chain: 'solana',
      language: 'en',
      messages: [{ who: 'person', text: 'hi' }],
      catalog: [],
      stockAttributes: null,
      evidence: [],
      analytics: null,
    } as unknown as Parameters<VaultAgentModel['read']>[1];
    const read = await model().read('owner-fixture', prompt, undefined, {
      ...base(),
      chain: 'solana',
      catalog,
    });
    expect(read).toEqual({ reply: said('Tell me more.') });
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]).not.toHaveProperty('tools');
  });

  it('works as before with no lookups on the server: no tools, the old repair', async () => {
    const { calls } = await ask({ final: said('Tell me more.') }, 'hi', { lookups: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('tools');
  });

  it('tells the model when to look up, in the system text every request shares', () => {
    expect(VAULT_AGENT_SYSTEM).toContain('LOOKUPS');
    expect(VAULT_AGENT_SYSTEM).toMatch(/when kind is new_goal you have no lookups/u);
    expect(VAULT_AGENT_SYSTEM).toMatch(/At most three rounds/u);
    expect(VAULT_AGENT_SYSTEM).toMatch(/never a share, a weight or a limit/u);
  });
});
