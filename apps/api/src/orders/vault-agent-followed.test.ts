import type { BasketAsset, Price, Recipe, VaultState } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { VAULT_AGENT_SYSTEM, type VaultAgentModel } from '../vault-agent-model';
import {
  buildVaultAgentContext,
  REBALANCE_ACTION,
  replyToVaultConversation,
  vaultNotionalUsd,
} from './vault-agent';

// Thom, Oct 13, on the hosted app (Solana devnet): a vault on an income plan that follows a shared
// portfolio holding gold. The conversation did not know what the vault follows, refused the vault's
// own gold target, could not answer "bring my holdings to my targets", and on a bare "yes" drafted
// "all in tGOOGLx" from fourteen turns before. His turns are replayed here against a scripted model:
// what is under test is what the server reads, hands over and serves. No model is called.

const now = '2026-10-13T17:00:00.000Z';
const RECIPE = '6KfwMDq3hXyZ8RrT5uVw2pLmN9cJkAgBSY6';
const SHOWN = '6KfwMD…AgBSY6';

function world(options: { follows?: boolean; goldTarget?: boolean } = {}) {
  const follows = options.follows ?? true;
  const goldTarget = options.goldTarget ?? true;
  const shelf = launchShelf();
  const assets: BasketAsset[] = shelf.assets
    .filter((asset) => asset.chain === 'solana')
    .map((asset) =>
      asset.cls === 'cash'
        ? asset
        : { ...asset, symbol: `t${asset.symbol}`, provenance: 'sandbox' as const },
    );
  const by = (id: string) => {
    const asset = assets.find((candidate) => candidate.id === id);
    if (!asset) throw new Error(`No ${id}`);
    return asset;
  };
  const cash = by('solana:usdc');
  const jl = by('solana:jlusdc');
  const syrup = by('solana:syrupusdc');
  const gold = by('solana:gldx');
  const googl = by('solana:googlx');
  const sol = by('solana:sol');
  const held = (asset: BasketAsset, display: string, targetBps: number) => ({
    asset: asset.id,
    raw: String(Math.round(Number(display) * 10 ** asset.decimals)),
    display,
    multiplier: '1',
    targetBps,
    lastKeeperAt: null,
  });
  const state: VaultState = {
    chain: 'solana',
    address: '3Nty2GwQpVhXk5rJmZ8sLd4cTnB7yFuCTx745',
    owner: '7BCNCpR2mWq8vLx3dKjHs5tYzN4gFuPD27d5',
    basketId: '1',
    keeper: cash.address,
    recipeOnchainId: follows ? RECIPE : null,
    acceptedVersion: follows ? 1 : 0,
    autoFollow: false,
    cash: { asset: cash.id, raw: '20050000000', display: '20050', multiplier: '1' },
    positions: [
      held(jl, '37702.63444', 5000),
      held(syrup, '16888.138676', 3000),
      ...(goldTarget ? [held(gold, '0', 2000)] : []),
    ],
    lossUsedBps: 0,
    observedAt: now,
    pending: null,
  };
  const price = (asset: BasketAsset, usdPerToken: string): Price => ({
    asset: asset.id,
    usdPerToken,
    source: 'offline oracle',
    method: 'fixture',
    fetchedAt: now,
    provenance: 'sandbox',
    ageSeconds: 1,
    maxAgeSeconds: 600,
    market: 'open',
  });
  // The chain gives no price row for cash, as on the hosted app: the page shows a dash there.
  const prices = [price(jl, '1.06'), price(syrup, '1.19'), price(gold, '4153.51')];
  const recipe: Recipe = {
    schemaVersion: 1,
    familyId: 'a'.repeat(64),
    chain: 'solana',
    onchainId: RECIPE,
    creator: '9AuthorPk4mWq8vLx3dKjHs5tYzN4gFuQq11',
    kind: 'community',
    version: 1,
    effectiveAt: 0,
    components: [
      { kind: 'asset', asset: jl.id, weightBps: 5000 },
      { kind: 'asset', asset: syrup.id, weightBps: 3000 },
      { kind: 'asset', asset: gold.id, weightBps: 2000 },
    ],
    metaHash: 'b'.repeat(64),
    maxFeeBps: 0,
    flags: 0,
  };
  type Input = Parameters<typeof buildVaultAgentContext>[0];
  const context = buildVaultAgentContext({
    state,
    prices,
    person: 'owner-fixture',
    entry: {
      chain: 'solana',
      source: 'offline adapter',
      provenance: 'sandbox',
      config: { name: 'Solana', networkName: 'devnet' },
      adapter: { capabilities: { autoFollow: false } },
    } as unknown as Input['entry'],
    prepared: { shelf: { ...shelf, assets }, figures: {} },
    currentGoals: [{ goal: 'income', risk: 'low' }],
    keeperEnabled: false,
    ...(follows
      ? {
          followed: {
            recipe: { active: recipe, pending: null },
            family: { name: 'Steady Dollar', slug: 'steady-dollar' },
            readAt: now,
          },
        }
      : {}),
  });
  const pick = (asset: BasketAsset) => ({
    assetId: asset.id,
    why: 'It is part of what you asked for.',
    evidenceIds: [`catalog:${asset.id}`],
  });
  const drafting = (...picked: BasketAsset[]) => ({
    message: 'Here is a draft for your vault. Nothing changes until you review and confirm it.',
    question: null,
    proposal: {
      objective: 'Hold what you asked for',
      summary: 'The draft holds the assets named.',
      allocations: picked.map(pick),
      stated: [],
      tradeoffs: ['Each of these can lose value.'],
      unknowns: [],
    },
  });
  const talking = (message: string, question: string | null = null) => ({
    message,
    question,
    proposal: null,
  });
  type Turn = string | ['app', string];
  async function reply(turns: Turn[], answer: unknown) {
    const model: VaultAgentModel = { read: vi.fn(async () => ({ reply: answer })) };
    const out = await replyToVaultConversation(
      {
        version: 1,
        language: 'en',
        messageId: 'turn',
        messages: turns.map((turn) =>
          Array.isArray(turn)
            ? { who: turn[0], text: turn[1] }
            : { who: 'person' as const, text: turn },
        ),
      },
      context,
      model,
    );
    const calls = vi.mocked(model.read).mock.calls;
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    return {
      out,
      reply: out.reply,
      calls: calls.length,
      prompt: calls[0]?.[1],
      repairs: calls.slice(1).map((call) => call[2]?.problems.join(' ') ?? ''),
      lines: out.reply.proposal?.allocations.map((line) => line.assetId) ?? null,
    };
  }
  return {
    assets,
    cash,
    jl,
    syrup,
    gold,
    googl,
    sol,
    state,
    prices,
    context,
    drafting,
    talking,
    reply,
  };
}

// His conversation, as the server is sent it: the person's words verbatim, the app's shortened.
const REFUSED =
  'Your vault is on an income plan with low risk, and a plan with this goal cannot hold stock tokens like tGOOGLx.';
const upTo12: Array<string | ['app', string]> = [
  "I want to consider a change to my vault's targets.",
  ['app', 'Happy to look at a change. Do you want to change the weights, or add another asset?'],
  'i like google',
  ['app', `${REFUSED} Do you want to hold tGOOGLx anyway, or stay with the income tokens?`],
  'yes',
  ['app', `${REFUSED} Do you want to keep the income tokens, or look at a different goal?`],
  'i want it to become 100% google bro',
  ['app', `${REFUSED} Do you want to keep the income tokens, or set up a growth draft?`],
  'yeah alphabet',
  ['app', `${REFUSED} Do you want a separate growth draft, or keep the income tokens?`],
  'all in tGOOGLx',
  ['app', `${REFUSED} Would you like a separate growth draft, or keep the income tokens?`],
];
const upTo20: Array<string | ['app', string]> = [
  ...upTo12,
  'how are the liquidity depth for those assets',
  ['app', 'Exit depth is not measured for these tokens on this network.'],
  'is the vault aligned with its strategy?',
  ['app', 'It is not fully aligned with its stated targets.'],
  'its because im following another vault right',
  ['app', 'You are following another vault. Shall we look at which tokens it holds?'],
  'yeah i want it',
  ['app', 'Can you tell me which tokens that other vault holds?'],
];
const upTo24: Array<string | ['app', string]> = [
  ...upTo20,
  `i want to be the same as ${SHOWN}`,
  ['app', 'Which tokens does that recipe hold, and what share does each one have?'],
  'jlUSDC (Jupiter Lend) 37,702.63444 $1.06 50% 50%, on target\nsyrupUSDC (Maple) 16,888.138676 $1.19 30% 25%\nPAXG 0 $4,153.51 20% 0%',
  [
    'app',
    'Thanks for sharing the recipe. Do you want a draft that follows the recipe without the gold part, or do you want to keep the current targets?',
  ],
];

describe('the facts the server hands the model about a vault that follows a shared portfolio', () => {
  const w = world();

  it('says what the vault follows, with its lines and weights as sourced figures', async () => {
    const out = await w.reply(['what does my vault follow?'], w.talking('It follows a portfolio.'));
    const facts = out.prompt?.facts;
    expect(facts?.follows).toMatchObject({
      portfolioId: SHOWN,
      name: 'Steady Dollar',
      acceptedVersion: 'version 1',
      newerVersion: false,
      lines: [
        { assetId: w.jl.id, name: 'jlUSDC', weight: `recipe:${w.jl.id}:weight` },
        { assetId: w.syrup.id, name: 'syrupUSDC', weight: `recipe:${w.syrup.id}:weight` },
        { assetId: w.gold.id, name: 'GLDx', weight: `recipe:${w.gold.id}:weight` },
      ],
    });
    expect(facts?.targets.origin).toBe('followed_portfolio');
    // Each weight is a figure of the server's, with the read it came from (FIGURES-BY-REFERENCE).
    const weight = w.context.evidence.find((row) => row.id === `recipe:${w.gold.id}:weight`);
    expect(weight).toMatchObject({
      assetId: w.gold.id,
      value: 0.2,
      unit: 'fraction',
      source: 'offline adapter',
      fetchedAt: now,
      provenance: 'sandbox',
    });
    expect(weight?.method).toMatch(/version 1/u);
    expect(out.prompt?.evidence.map((row) => row.id)).toContain(`recipe:${w.jl.id}:weight`);
  });

  it('says where auto-follow and the keeper stand on this server, and the chain facts', async () => {
    const out = await w.reply(['is auto-follow on?'], w.talking('It is off.'));
    const facts = out.prompt?.facts;
    expect(facts?.autoFollow).toEqual({
      onThisVault: false,
      offeredOnThisServer: false,
      keeperRunsOnThisServer: false,
    });
    expect(facts?.chain).toMatchObject({
      network: 'Solana devnet',
      provenance: 'sandbox',
      readAt: 'Oct 13 2026 17:00 UTC',
      vault: '3Nty2G…CTx745',
      owner: '7BCNCp…PD27d5',
    });
  });

  it('gives the gap of each holding and the target of cash as figures', () => {
    const value = (id: string) => w.context.evidence.find((row) => row.id === id)?.value;
    expect(value(`holding:${w.cash.id}:target`)).toBe(0);
    expect(value(`holding:${w.gold.id}:gap`)).toBe(-0.2);
    expect(value(`holding:${w.cash.id}:gap`)).toBeCloseTo(0.2503, 4);
  });

  it('lets the model say the portfolio by its name, its id as shown and its version', async () => {
    const out = await w.reply(
      ['what do i follow'],
      w.talking(
        `Your vault follows Steady Dollar (${SHOWN}), version 1, read on Oct 13 2026 17:00 UTC.`,
      ),
    );
    expect(out.calls).toBe(1);
    expect(out.reply.message).toContain(SHOWN);
  });

  it('still refuses a number of the model’s own beside them', async () => {
    const out = await replyToVaultConversation(
      {
        version: 1,
        language: 'en',
        messageId: 'turn',
        messages: [{ who: 'person', text: 'what do i follow' }],
      },
      w.context,
      {
        read: vi.fn(async () => ({
          reply: w.talking('Your vault follows Steady Dollar, version 1, and gold is 20% of it.'),
        })),
      },
    );
    expect(out).toMatchObject({ kind: 'failure', detail: 'prose_figure' });
  });

  it('tells the model what the facts are and never to ask for them', () => {
    expect(VAULT_AGENT_SYSTEM).toMatch(/facts\.follows/u);
    expect(VAULT_AGENT_SYSTEM).toMatch(/never ask the person/iu);
    expect(VAULT_AGENT_SYSTEM).toMatch(/rebalance/iu);
    expect(VAULT_AGENT_SYSTEM).toMatch(/alreadySaid/u);
  });

  it('says nothing of a portfolio for a vault that follows none', async () => {
    const own = world({ follows: false });
    const out = await own.reply(['hello there'], own.talking('Hello.'));
    expect(out.prompt?.facts?.follows).toBeNull();
    expect(out.prompt?.facts?.targets.origin).toBe('vault_own');
  });
});

describe('a target the vault already has is not outside its plan', () => {
  const w = world();

  it('keeps the followed gold target out of what the goal bars, and says the state once', async () => {
    const out = await w.reply(['what can i hold'], w.talking('Here is what it holds.'));
    expect(out.prompt?.eligibilityGoal).toBe('income');
    expect(out.prompt?.outsideGoal).not.toContain(w.gold.id);
    expect(out.prompt?.outsideGoal).toContain(w.googl.id);
    expect(out.prompt?.facts?.targets.outsideGoalAlreadyHeld).toEqual([w.gold.id]);
  });

  it('serves a draft that keeps the gold target', async () => {
    const out = await w.reply(['make my three assets equal'], w.drafting(w.jl, w.syrup, w.gold));
    expect(out.lines).toEqual([w.jl.id, w.syrup.id, w.gold.id]);
    expect(out.reply.weightNotes.map((note) => note.code)).not.toContain('pick_outside_goal');
    expect(out.calls).toBe(1);
  });

  it('keeps a stock the vault already targets, with nobody asking for it again', async () => {
    const context = {
      ...w.context,
      state: {
        ...w.state,
        positions: [
          ...w.state.positions.slice(0, 2),
          { ...(w.state.positions[2] as VaultState['positions'][number]), asset: w.googl.id },
        ],
      },
    };
    const model: VaultAgentModel = {
      read: vi.fn(async () => ({ reply: w.drafting(w.jl, w.googl) })),
    };
    const out = await replyToVaultConversation(
      {
        version: 1,
        language: 'en',
        messageId: 'turn',
        messages: [{ who: 'person', text: 'make my assets equal' }],
      },
      context,
      model,
    );
    if (out.kind !== 'reply') throw new Error('refused');
    expect(out.reply.proposal?.allocations.map((line) => line.assetId)).toEqual([
      w.jl.id,
      w.googl.id,
    ]);
    expect(out.reply.weightNotes.map((note) => note.code)).not.toContain('pick_outside_goal');
  });

  it('still leaves out a new gold target on an income vault that has none', async () => {
    const plain = world({ follows: false, goldTarget: false });
    const out = await plain.reply(['make it safer'], plain.drafting(plain.jl, plain.gold));
    expect(out.lines).toEqual([plain.jl.id]);
    expect(out.reply.weightNotes).toContainEqual({
      code: 'pick_outside_goal',
      assetIds: [plain.gold.id],
    });
  });

  it('still leaves out a stock or a crypto token the model adds on its own', async () => {
    const out = await w.reply(['make my assets equal'], w.drafting(w.jl, w.gold, w.googl, w.sol));
    expect(out.lines).toEqual([w.jl.id, w.gold.id]);
    expect(out.reply.weightNotes).toContainEqual({
      code: 'pick_outside_goal',
      assetIds: [w.googl.id, w.sol.id],
    });
  });
});

describe('"bring my holdings to my targets" is its own kind of request', () => {
  const w = world();
  const asks = [
    `i want to be the same as ${SHOWN}`,
    'i want to reblance to follow exactly the planned bro!',
    'bro i want to change the curent holdings to match the targets. because current they are different',
    'rebalance',
    'Bring my holdings to my targets',
    'match the targets please',
    'quero rebalancear',
  ];

  it.each(asks)('answers "%s" from the facts, with no draft and no refusal', async (ask) => {
    const out = await w.reply([...upTo24.slice(0, 20), ask], w.drafting(w.jl, w.syrup));
    // The server's own reply: the model is not asked, and nothing is drafted.
    expect(out.calls).toBe(0);
    expect(out.reply.proposal).toBeNull();
    expect(out.reply.question).toBeNull();
    const said = out.reply.message;
    expect(said).not.toMatch(/cannot hold|can't hold|income plan cannot|which .*tokens/iu);
    // The gap of every holding, each figure the server's, by reference.
    expect(said).toMatch(/jlUSDC: 49\.89% of the vault, target 50%/u);
    expect(said).toMatch(/syrupUSDC: 25\.08% of the vault, target 30%/u);
    expect(said).toMatch(/GLDx: 0% of the vault, target 20%/u);
    expect(said).toMatch(/Cash: 25\.03% of the vault, target 0%/u);
    expect(said).toContain(`“${REBALANCE_ACTION.en}”`);
    expect(said).toContain('Steady Dollar');
    const ids = out.reply.figures?.facts.map((fact) => fact.id) ?? [];
    expect(ids).toContain(`holding:${w.gold.id}:target`);
    expect(ids).toContain(`holding:${w.cash.id}:share`);
    for (const fact of out.reply.figures?.facts ?? [])
      expect(fact).toMatchObject({ source: expect.any(String), fetchedAt: expect.any(String) });
  });

  it('says once that the goal would not admit the gold target as a new one, and goes on', async () => {
    const out = await w.reply(['rebalance'], w.talking('unused'));
    expect(out.reply.message).toMatch(/GLDx is already a target of this vault/u);
    const again = await w.reply(
      ['rebalance', ['app', out.reply.message], 'rebalance please'],
      w.talking('unused'),
    );
    expect(again.reply.message).not.toMatch(/already a target of this vault/u);
    expect(again.reply.message).toMatch(/GLDx: 0% of the vault, target 20%/u);
  });

  it.each([
    'should i rebalance?',
    'what is a rebalance',
    "don't rebalance anything",
    'rebalance to 70% tGOOGLx',
    'rebalance into tGOOGLx',
    'is the vault aligned with its strategy?',
    'I want to change my targets',
    'i want to follow a different strategy',
    'rebalance into another portfolio',
  ])('leaves "%s" to the model', async (text) => {
    const out = await w.reply([text], w.talking('Here is what I can tell you.'));
    expect(out.calls).toBeGreaterThan(0);
  });

  it('leaves it to the model on a vault with no targets', async () => {
    const empty = world({ follows: false });
    const context = { ...empty.context, state: { ...empty.state, positions: [] } };
    const model: VaultAgentModel = {
      read: vi.fn(async () => ({ reply: empty.talking('This vault has no targets yet.') })),
    };
    await replyToVaultConversation(
      {
        version: 1,
        language: 'en',
        messageId: 'turn',
        messages: [{ who: 'person', text: 'rebalance' }],
      },
      context,
      model,
    );
    expect(model.read).toHaveBeenCalled();
  });

  it('answers in Portuguese with the page’s word for the action', async () => {
    const out = await replyToVaultConversation(
      {
        version: 1,
        language: 'pt',
        messageId: 'turn',
        messages: [{ who: 'person', text: 'quero rebalancear' }],
      },
      w.context,
      { read: vi.fn() },
    );
    if (out.kind !== 'reply') throw new Error('refused');
    expect(out.reply.message).toContain(`“${REBALANCE_ACTION.pt}”`);
    expect(out.reply.message).toMatch(/jlUSDC: 49,89% do cofre, alvo 50%/u);
  });
});

describe('a request the conversation left behind is not revived', () => {
  const w = world();

  it('hands the model the standing "all in tGOOGLx" only while it is the subject', async () => {
    const at12 = await w.reply(upTo12.slice(0, 11), w.drafting(w.googl));
    expect(at12.prompt?.requestedOutsideGoal).toEqual([w.googl.id]);
    expect(at12.lines).toEqual([w.googl.id]);
    // Turn 13 is a question about something else: the request is no longer asked for.
    const at13 = await w.reply(upTo20.slice(0, 13), w.drafting(w.googl));
    expect(at13.prompt?.requestedOutsideGoal).toEqual([]);
    expect(at13.prompt?.allocationConstraints).toEqual([]);
    expect(at13.lines).toBeNull();
  });

  it('drafts nothing on the bare "yes" of turn 25, and asks which', async () => {
    const out = await w.reply([...upTo24, 'yes'], w.drafting(w.googl));
    expect(out.prompt?.requestedOutsideGoal).toEqual([]);
    expect(out.prompt?.facts?.latest).toBe('ambiguous_confirmation');
    expect(out.reply.proposal).toBeNull();
    expect(JSON.stringify(out.reply)).not.toMatch(/GOOGL|Alphabet/u);
    expect(out.reply.question).toMatch(/\?$/u);
    expect(out.repairs[0]).toMatch(/confirm/iu);
    expect(out.out.repair?.failed).toBe('confirmation_ambiguous');
  });

  it('serves the model’s own asking when it drafts nothing', async () => {
    const out = await w.reply(
      [...upTo24, 'yes'],
      w.talking('That could answer either choice.', 'Without the gold part, or as it is now?'),
    );
    expect(out.calls).toBe(1);
    expect(out.reply.message).toBe('That could answer either choice.');
  });

  it('drafts nothing on a bare "yes" even with the request still standing', async () => {
    const out = await w.reply([...upTo12, 'yes'], w.drafting(w.googl));
    expect(out.reply.proposal).toBeNull();
  });

  it('reads "yes" as an answer when one plain question was asked', async () => {
    const out = await w.reply(
      ['all in tGOOGLx', ['app', 'Shall I draft the whole vault in GOOGLx?'], 'yes'],
      w.drafting(w.googl),
    );
    expect(out.prompt?.facts?.latest).toBeNull();
    expect(out.lines).toEqual([w.googl.id]);
  });

  it('does not bring it back after the talk moved to rebalancing (turns 28 to 32)', async () => {
    const turns = [
      ...upTo24,
      'yes',
      ['app', 'Which did you mean?'] as ['app', string],
      'i want to reblance to follow exactly the planned bro!',
      ['app', 'Use Rebalance on this page.'] as ['app', string],
      'bro we changed the goal',
    ];
    const out = await w.reply(turns, w.drafting(w.googl));
    expect(out.prompt?.requestedOutsideGoal).toEqual([]);
    expect(out.prompt?.allocationConstraints).toEqual([]);
    expect(out.lines).toBeNull();
    expect(out.reply.weightNotes).toContainEqual({
      code: 'pick_outside_goal',
      assetIds: [w.googl.id],
    });
  });

  it('keeps a request through a question about that stock, and through a refinement', async () => {
    const asked = await w.reply(
      ['all in tGOOGLx', ['app', 'Drafted.'], 'is tGOOGLx risky?'],
      w.talking('It can lose value quickly.'),
    );
    expect(asked.prompt?.requestedOutsideGoal).toEqual([w.googl.id]);
    const refined = await w.reply(
      ['I want tGOOGLx', ['app', 'Drafted.'], 'add tjlUSDC too'],
      w.drafting(w.googl, w.jl),
    );
    expect(refined.lines).toEqual([w.googl.id, w.jl.id]);
  });
});

describe('what was said is not said again', () => {
  const w = world();

  it('drops a closing question that the reply before it already asked, word for word', async () => {
    const question = 'Would you like a separate growth draft, or keep the income tokens?';
    const out = await w.reply(
      [...upTo12, 'hmm let me think'],
      w.talking('Take your time.', question),
    );
    expect(out.reply.message).toBe('Take your time.');
    expect(out.reply.question).toBeNull();
  });

  it('drops a sentence the reply before it already said, and keeps the rest', async () => {
    const out = await w.reply(
      [...upTo12, 'hmm let me think'],
      w.talking(`${REFUSED} Take your time with it.`, 'What would you like to look at?'),
    );
    expect(out.reply.message).toBe('Take your time with it.');
    expect(out.reply.question).toBe('What would you like to look at?');
  });

  it('keeps a reply that is only what was said before: it is never left empty', async () => {
    const out = await w.reply([...upTo12, 'hmm let me think'], w.talking(REFUSED));
    expect(out.reply.message).toBe(REFUSED);
  });

  it('tells the model what earlier replies already told the person', async () => {
    const out = await w.reply([...upTo12, 'hmm let me think'], w.talking('Take your time.'));
    expect(out.prompt?.facts?.alreadySaid).toContain('goal_rule');
    const fresh = await w.reply(['hello there'], w.talking('Hello.'));
    expect(fresh.prompt?.facts?.alreadySaid).toEqual([]);
  });
});

describe('one valuation of the vault', () => {
  const w = world();

  it('values cash at one dollar where the chain gives it no price', () => {
    expect(vaultNotionalUsd(w.state, w.prices)).toBeCloseTo(80_111.68, 1);
    expect(w.context.unknowns.join(' ')).not.toMatch(/full vault value is unknown/u);
    expect(w.context.evidence.find((row) => row.id === 'vault:value')?.value).toBeCloseTo(
      80_111.68,
      1,
    );
  });

  it('is unknown only when a holding that is held has no price', () => {
    expect(vaultNotionalUsd(w.state, w.prices.slice(0, 1))).toBeNull();
    // A target with nothing held needs no price to be worth nothing.
    expect(vaultNotionalUsd(w.state, w.prices.slice(0, 2))).toBeCloseTo(80_111.68, 1);
  });

  it('lists what Bearing does not measure beside the asset, by the id it would have', () => {
    type Input = Parameters<typeof buildVaultAgentContext>[0];
    const built = buildVaultAgentContext({
      state: w.state,
      prices: w.prices,
      person: 'owner-fixture',
      entry: { source: 'offline adapter', provenance: 'sandbox' } as unknown as Input['entry'],
      prepared: { shelf: { ...launchShelf(), assets: w.assets }, figures: {} },
      analytics: {
        sizeUsd: 80_000,
        basis: 'vault',
        tau: 0.01,
        assets: [
          {
            assetId: w.jl.id,
            modelledOn: null,
            figures: [
              { metric: 'lp_top1', value: null, reason: 'not_collected' },
              {
                metric: 'volatility',
                value: 0.02,
                unit: 'fraction',
                source: 'offline sheet',
                method: 'fixture',
                fetchedAt: now,
                provenance: 'sandbox',
              },
            ],
          },
        ],
      },
    });
    expect(built.analytics?.notMeasured).toEqual({ [w.jl.id]: [`lp:${w.jl.id}:top1`] });
  });
});
