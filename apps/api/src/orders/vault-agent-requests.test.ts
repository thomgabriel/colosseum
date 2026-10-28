import { VaultAgentReply, type VaultState } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { VAULT_AGENT_SYSTEM, type VaultAgentModel } from '../vault-agent-model';
import { replyToVaultConversation, type VaultAgentContext } from './vault-agent';

// Which stocks the person asked for, read from their own words (gate ANY-COMPOSITION). Offline model
// replies are fixtures. No model, node, database, order builder, or allocator is called.
const shelf = launchShelf();
const assets = shelf.assets.filter((asset) => asset.chain === 'solana');
const cash = assets.find((asset) => asset.cls === 'cash');
const stock = assets.find((asset) => asset.cls === 'stock');
const reserves = assets.filter((asset) => asset.cls === 'dollar_yield');
const reserve = reserves[0];
const otherReserve = reserves[1];
if (!cash || !stock || !reserve || !otherReserve)
  throw new Error('Incomplete offline catalog fixture');
const now = '2026-10-07T20:00:00.000Z';
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
      asset: stock.id,
      raw: '10000000',
      display: '10',
      multiplier: '1',
      targetBps: 2000,
      lastKeeperAt: null,
    },
  ],
  lossUsedBps: 0,
  observedAt: now,
  pending: null,
};
const context: VaultAgentContext = {
  person: 'owner-fixture',
  state,
  assets,
  currentGoals: [{ goal: 'grow', objective: 'Keep a liquid cushion while seeking growth' }],
  evidence: [stock, reserve, otherReserve].map((asset) => ({
    id: `catalog:${asset.id}`,
    assetId: asset.id,
    source: 'offline catalog',
    method: 'listed assets',
    fetchedAt: now,
    provenance: 'mock',
  })),
  stockAttributes: null,
  liquidity: [],
  unknowns: ['Measured exit cost is unavailable for this preview.'],
};
const proposal = () => ({
  message: 'Here is a possible direction for your vault. This is a preview for discussion.',
  question: null,
  proposal: {
    objective: 'Seek growth while keeping a liquid cushion',
    summary: 'Increase exposure to the named stock and retain a reserve.',
    allocations: [
      {
        assetId: stock.id,
        why: 'This expresses your stated stock preference.',
        evidenceIds: [`catalog:${stock.id}`],
      },
      {
        assetId: reserve.id,
        why: 'This reserve diversifies the proposed holdings.',
        evidenceIds: [`catalog:${reserve.id}`],
      },
      {
        assetId: otherReserve.id,
        why: 'This retains exposure outside the named stock.',
        evidenceIds: [`catalog:${otherReserve.id}`],
      },
    ],
    stated: [],
    tradeoffs: ['Stock concentration can increase losses.'],
    unknowns: ['The future price path is unknown.'],
  },
});
const fake = (reply: unknown): VaultAgentModel => ({ read: vi.fn(async () => ({ reply })) });

const symbol = (ticker: string) => {
  const asset = assets.find((candidate) => candidate.underlying === ticker);
  if (!asset) throw new Error(`No ${ticker} in the offline catalog`);
  return asset.id;
};
const STOCKS = 'every listed stock';
type Turn = string | ['app' | 'person', string];
async function read(
  goal: 'income' | 'protect',
  turns: Turn[],
  language: 'en' | 'pt' = 'en',
  extra: Partial<VaultAgentContext> = {},
) {
  const model = fake(proposal());
  const messages = turns.map((turn) =>
    Array.isArray(turn) ? { who: turn[0], text: turn[1] } : { who: 'person' as const, text: turn },
  );
  const out = await replyToVaultConversation(
    { version: 1, language, messageId: 'turn', messages },
    { ...context, currentGoals: [{ goal }], ...extra },
    model,
  );
  const sent = vi.mocked(model.read).mock.calls[0]?.[1];
  return { out, requested: sent?.requestedOutsideGoal ?? [] };
}
const stocks = assets
  .filter((asset) => asset.cls === 'stock' || asset.cls === 'etf')
  .map((asset) => asset.id);

describe('a refusal, a question, a withdrawal or an everyday word is not a request', () => {
  it.each<['income' | 'protect', Turn[], ('en' | 'pt')?, string[]?]>([
    ['protect', ['I want AAPL, not TSLA.'], 'en', ['AAPL']],
    ['protect', ['I want no stocks.']],
    ['protect', ['I want everything except stocks.']],
    ['protect', ['Quero tudo menos ações.'], 'pt'],
    ['protect', ['I want to avoid stocks, they scare me.']],
    ['protect', ['I want something safe; stocks are too risky for me.']],
    ['protect', ['Quero algo seguro, ações são arriscadas demais.'], 'pt'],
    ['protect', ['Keep stocks out of it.']],
    ['protect', ['I want to sell my TSLA.']],
    [
      'protect',
      [
        'I want AAPL in it.',
        ['app', 'Added.'],
        'Actually, scratch that. No AAPL, just safe things.',
      ],
    ],
    ['protect', ['I want stocks.', ['app', 'Noted.'], 'No TSLA though.'], 'en', [STOCKS, '-TSLA']],
    ['protect', ['Why did you add AAPL?']],
    ['protect', ['Is it smart to buy TSLA right now?']],
    ['protect', ['The preview suggests to hold TSLA; why?']],
    ['income', ['Quero renda mensal para a minha meta de aposentadoria.'], 'pt'],
    ['protect', ['Quero proteger o dinheiro da minha meta.'], 'pt'],
    ['income', ['I want my income needs met every month.']],
    ['protect', ['I want to hold a coin that never loses value.']],
    ['protect', ['I want to pump up my emergency savings.']],
    ['income', ['Quero renda, sem ações.'], 'pt'],
    ['protect', ['I want at most 5% stocks.']],
    ['protect', ['"I want TSLA", my brother told me.']],
    ['protect', ['I want to know more about TSLA.']],
    ['protect', ['I want to understand AAPL first.']],
    ['protect', ['Quero saber mais sobre a TSLA.'], 'pt'],
    ['protect', ['I want to compare AAPL and TSLA.']],
    ['protect', ['I want to see what AAPL would look like.']],
    ['protect', ['I want something like AAPL but safer.']],
    ['protect', ['I want my savings safe from TSLA-style crashes.']],
    ['protect', ['Quero investir como a TSLA investe em inovação.'], 'pt'],
    ['protect', ['Quero ações, mas só se for seguro.'], 'pt'],
  ])('%s: %j', async (goal, turns, language = 'en', expected = []) => {
    const { out, requested } = await read(goal, turns, language);
    const want = expected.includes(STOCKS)
      ? stocks.filter(
          (id) =>
            !expected.some((ticker) => ticker.startsWith('-') && id === symbol(ticker.slice(1))),
        )
      : expected.map(symbol);
    expect(requested).toEqual(want);
    // The fixture's model adds a stock the person did not name: left out, and said, unless they asked
    // for stocks.
    if (!requested.includes(symbol('NVDA'))) {
      if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
      expect(out.reply.proposal?.allocations.map((line) => line.assetId)).not.toContain(
        symbol('NVDA'),
      );
      expect(
        out.reply.weightNotes.find((note) => note.code === 'pick_outside_goal')?.assetIds,
      ).toContain(symbol('NVDA'));
      expect(out.repair?.failed).toBe('allocation_ineligible');
    }
  });
});

describe('a plain request for a stock counts', () => {
  it.each<[Turn[], 'en' | 'pt', string[]]>([
    [["I'd like some AAPL."], 'en', ['AAPL']],
    [['Gostaria de ter AAPL.'], 'pt', ['AAPL']],
    [['I understand the risk, add AAPL.'], 'en', ['AAPL']],
    [['Pode colocar AAPL?'], 'pt', ['AAPL']],
    [['Can you add AAPL?'], 'en', ['AAPL']],
    [['Quero AAPL, não me importo com o risco.'], 'pt', ['AAPL']],
    [['Quero colocar mais no AAPL.'], 'pt', ['AAPL']],
    [['Add AAPLx.'], 'en', ['AAPL']],
    [['I want no stocks, just AAPL.'], 'en', ['AAPL']],
    [['I want NVDA.'], 'en', ['NVDA']],
    [['Coloca ações também.'], 'pt', [STOCKS]],
    [['No stocks.', ['app', 'Understood.'], 'Actually I want stocks after all.'], 'en', [STOCKS]],
  ])('%j', async (turns, language, expected) => {
    const { out, requested } = await read('protect', turns, language);
    expect(requested).toEqual(expected.includes(STOCKS) ? stocks : expected.map(symbol));
    if (requested.includes(symbol('NVDA')))
      expect(out.kind === 'reply' && out.reply.warnings).toEqual([
        {
          code: 'outside_goal_requested',
          assetId: symbol('NVDA'),
          evidenceId: `catalog:${symbol('NVDA')}`,
        },
      ]);
  });

  it('misses rather than invents: a condition, a "without" or a company name it was not given', async () => {
    for (const turn of [
      'Add AAPL even if it is outside the goal.',
      'Add AAPL without touching the rest.',
      'I want some Apple.',
    ])
      expect((await read('protect', [turn])).requested).toEqual([]);
    // The model is told to ask the person to confirm instead.
    expect(VAULT_AGENT_SYSTEM).toContain('do not propose it: ask in question');
  });

  it('reads company names without case and skips the ones that are everyday words', async () => {
    const stockAttributes = {
      stocks: [
        { symbol: 'AAPLx', company: 'Apple Inc.' },
        { symbol: 'METAx', company: 'Meta Platforms, Inc.' },
      ],
    } as unknown as VaultAgentContext['stockAttributes'];
    expect(
      (await read('protect', ['I want some apple.'], 'en', { stockAttributes })).requested,
    ).toEqual([symbol('AAPL')]);
    expect(
      (await read('protect', ['Quero bater a minha Meta.'], 'pt', { stockAttributes })).requested,
    ).toEqual([]);
    expect(
      (await read('protect', ['I want Meta Platforms.'], 'en', { stockAttributes })).requested,
    ).toEqual([symbol('META')]);
  });

  it('keeps every class but stocks refused outside the goal, asked for or not', async () => {
    for (const turn of ['Put some SOL in.', 'I want some crypto too.', 'I want SOL.'])
      expect((await read('protect', [turn])).requested).toEqual([]);
  });
});

describe("a stated share reads tickers as written, so the person's shares drive only what they named", () => {
  it('sets no limit on METAx from "my meta", and one from META or Meta Platforms', async () => {
    const stockAttributes = {
      stocks: [{ symbol: 'METAx', company: 'Meta Platforms, Inc.' }],
    } as unknown as VaultAgentContext['stockAttributes'];
    const limits = async (text: string, language: 'en' | 'pt' = 'en') => {
      const model = fake(proposal());
      await replyToVaultConversation(
        { version: 1, language, messageId: 'turn', messages: [{ who: 'person', text }] },
        { ...context, stockAttributes },
        model,
      );
      return vi.mocked(model.read).mock.calls[0]?.[1].allocationConstraints;
    };
    expect(await limits('I want 10% for my meta.')).toEqual([]);
    expect(await limits('Quero 10% na minha meta de aposentadoria.', 'pt')).toEqual([]);
    for (const said of ['10% META', '10% Meta Platforms', '10% Meta'])
      expect(await limits(`I want ${said}.`)).toEqual([
        { assetIds: [symbol('META')], minWeightBps: 1000, maxWeightBps: 1000, personQuote: said },
      ]);
    // Beside a number too, the everyday word is not the ticker.
    expect(await limits('Quero colocar 10% na meta de aposentadoria.', 'pt')).toEqual([]);
    expect(await limits('I want 10% in meta.')).toEqual([]);
  });
});

// Gate ANY-COMPOSITION: the weights follow only the shares the person's words hold. The model reports
// each with the person's quote; the server checks the quote, its number, that it is not a return, and
// the assets it names. Cases from the second review of #189.
describe("the person's stated shares, as their words hold them", () => {
  const pick = (ticker: string) => ({
    assetId: symbol(ticker),
    why: 'The person named it.',
    evidenceIds: [`catalog:${symbol(ticker)}`],
  });
  const evidence = assets.map((asset) => ({
    id: `catalog:${asset.id}`,
    assetId: asset.id,
    source: 'offline catalog',
    method: 'listed assets',
    fetchedAt: now,
    provenance: 'mock' as const,
  }));
  const shareOf = (
    tickers: string[],
    kind: 'exact' | 'min' | 'max',
    bps: number,
    quote: string,
  ) => ({ assetIds: tickers.map(symbol), kind, bps, quote });
  async function served(
    turns: Turn[],
    tickers: string[],
    stated: ReturnType<typeof shareOf>[],
    language: 'en' | 'pt' = 'en',
    extra: Partial<VaultAgentContext> = {},
  ) {
    const value = proposal();
    value.proposal.allocations = tickers.map(pick);
    (value.proposal as { stated: unknown[] }).stated = stated;
    const messages = turns.map((turn) =>
      Array.isArray(turn)
        ? { who: turn[0], text: turn[1] }
        : { who: 'person' as const, text: turn },
    );
    const out = await replyToVaultConversation(
      { version: 1, language, messageId: 'turn', messages },
      { ...context, evidence, ...extra },
      fake(value),
    );
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    return {
      weights: out.reply.proposal?.allocations.map((line) => line.weightBps),
      notes: out.reply.weightNotes,
      repair: out.repair,
      reply: out.reply,
    };
  }
  const three = ['AAPL', 'TSLA', 'GLD'];

  it.each<[string, ReturnType<typeof shareOf>[], ('en' | 'pt')?]>([
    ['I want 10% a year, mostly stocks.', [shareOf(['AAPL', 'TSLA'], 'min', 1000, '10% a year')]],
    [
      'Quero render 10% ao ano com ouro.',
      [shareOf(['GLD'], 'exact', 1000, 'render 10% ao ano com ouro')],
      'pt',
    ],
    [
      'I want 8% a year with some TSLA.',
      [shareOf(['TSLA'], 'exact', 800, '8% a year with some TSLA')],
    ],
    [
      'I want TSLA to grow 20% a year.',
      [shareOf(['TSLA'], 'exact', 2000, 'TSLA to grow 20% a year')],
    ],
    [
      'I want to lose at most 10% with TSLA.',
      [shareOf(['TSLA'], 'max', 1000, 'lose at most 10% with TSLA')],
    ],
  ])('sets no weight from a return or a loss: %s', async (text, stated, language = 'en') => {
    const out = await served([text], three, stated, language);
    expect(out.weights).toEqual([3334, 3333, 3333]);
    // Refused once, with the reason, then ignored: the repair sent the same share again.
    expect(out.repair).toBeUndefined();
    expect(out.notes[0]).toEqual({ code: 'equal_split', assetIds: three.map(symbol) });
  });

  it('says that "mostly stocks" was not applied, rather than splitting in silence', async () => {
    const out = await served(['I want 10% a year, mostly stocks.'], three, []);
    expect(out.weights).toEqual([3334, 3333, 3333]);
    expect(out.notes).toEqual([
      { code: 'equal_split', assetIds: three.map(symbol) },
      { code: 'share_unread', assetIds: [], quote: 'mostly stocks' },
    ]);
    expect(out.repair).toBeUndefined();
    // A preference with no number reported as a share is refused for its number.
    const mostly = await served(
      ['I want mostly TSLA.'],
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'min', 7000, 'mostly TSLA')],
    );
    expect(mostly.weights).toEqual([5000, 5000]);
    expect(mostly.notes).toContainEqual({
      code: 'share_unread',
      assetIds: [],
      quote: 'I want mostly TSLA',
    });
  });

  it.each<[string, string[], ReturnType<typeof shareOf>[], number[], ('en' | 'pt')?]>([
    [
      'I want 70/30 TSLA and NVDA.',
      ['TSLA', 'NVDA'],
      [
        shareOf(['TSLA'], 'exact', 7000, '70/30 TSLA and NVDA'),
        shareOf(['NVDA'], 'exact', 3000, '70/30 TSLA and NVDA'),
      ],
      [7000, 3000],
    ],
    [
      'I want 70% tsla.',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70% tsla')],
      [7000, 3000],
    ],
    [
      '70% em TSLA',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70% em TSLA')],
      [7000, 3000],
      'pt',
    ],
    [
      'Put 70 percent in TSLA.',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70 percent in TSLA')],
      [7000, 3000],
    ],
    [
      'Quero 70 por cento em TSLA.',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70 por cento em TSLA')],
      [7000, 3000],
      'pt',
    ],
    [
      'I want half in AAPL.',
      ['AAPL', 'GLD', 'TSLA'],
      [shareOf(['AAPL'], 'exact', 5000, 'half in AAPL')],
      [5000, 2500, 2500],
    ],
    ['I want 50% SOL.', ['SOL', 'GLD'], [shareOf(['SOL'], 'exact', 5000, '50% SOL')], [5000, 5000]],
    [
      'I want at least 30% gold.',
      three,
      [shareOf(['GLD'], 'min', 3000, 'at least 30% gold')],
      [3334, 3333, 3333],
    ],
    [
      'I want at least 40% gold.',
      three,
      [shareOf(['GLD'], 'min', 4000, 'at least 40% gold')],
      [3000, 3000, 4000],
    ],
  ])(
    'follows a share the words hold: %s',
    async (text, tickers, stated, weights, language = 'en') => {
      const out = await served([text], tickers, stated, language);
      expect(out.weights).toEqual(weights);
      expect(out.repair).toBeUndefined();
      expect(out.notes.filter((note) => note.code === 'share_unread')).toEqual([]);
    },
  );

  it('reads company names in a quote: "metade em Apple", "70% Tesla", "70% Meta"', async () => {
    const stockAttributes = {
      stocks: [
        { symbol: 'AAPLx', company: 'Apple Inc.' },
        { symbol: 'TSLAx', company: 'Tesla, Inc.' },
        { symbol: 'METAx', company: 'Meta Platforms, Inc.' },
      ],
    } as unknown as VaultAgentContext['stockAttributes'];
    const apple = await served(
      ['Quero metade em Apple.'],
      ['AAPL', 'GLD'],
      [shareOf(['AAPL'], 'exact', 5000, 'metade em Apple')],
      'pt',
      { stockAttributes },
    );
    expect(apple.weights).toEqual([5000, 5000]);
    expect(apple.notes).toEqual([
      { code: 'stated', assetIds: [symbol('AAPL')], quote: 'metade em Apple' },
      { code: 'equal_split', assetIds: [symbol('GLD')] },
    ]);
    for (const [name, ticker] of [
      ['Tesla', 'TSLA'],
      ['Meta', 'META'],
    ] as const) {
      const out = await served(
        [`I want 70% ${name}.`],
        [ticker, 'GLD'],
        [shareOf([ticker], 'exact', 7000, `70% ${name}`)],
        'en',
        { stockAttributes },
      );
      expect(out.weights).toEqual([7000, 3000]);
    }
  });

  it('gives the same weights whatever order the shares come in', async () => {
    const text = 'I want at least 20% AAPL and 60% NVDA.';
    const stated = [
      shareOf(['AAPL'], 'min', 2000, 'at least 20% AAPL'),
      shareOf(['NVDA'], 'exact', 6000, '60% NVDA'),
    ];
    const picks = ['AAPL', 'NVDA', 'TSLA', 'GLD'];
    const forward = await served([text], picks, stated);
    const backward = await served([text], picks, [...stated].reverse());
    expect(forward.weights).toEqual([2000, 6000, 1000, 1000]);
    expect(backward.weights).toEqual(forward.weights);
  });

  it('never scales or drops in silence', async () => {
    const twice = [
      shareOf(['TSLA'], 'exact', 6000, '60% TSLA'),
      shareOf(['NVDA'], 'exact', 6000, '60% NVDA'),
    ];
    const scaled = await served(['I want 60% TSLA and 60% NVDA.'], ['TSLA', 'NVDA'], twice);
    expect(scaled.weights).toEqual([5000, 5000]);
    expect(scaled.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA')], quote: '60% TSLA' },
      { code: 'stated', assetIds: [symbol('NVDA')], quote: '60% NVDA' },
      { code: 'scaled', assetIds: [symbol('TSLA'), symbol('NVDA')] },
    ]);
    // Over three picks the two shares cannot both hold: the person is asked, with the quote.
    const value = proposal();
    value.proposal.allocations = ['TSLA', 'NVDA', 'GLD'].map(pick);
    (value.proposal as { stated: unknown[] }).stated = twice;
    const asked = await replyToVaultConversation(
      {
        version: 1,
        language: 'en',
        messageId: 'turn',
        messages: [{ who: 'person', text: 'I want 60% TSLA and 60% NVDA.' }],
      },
      { ...context, evidence },
      fake(value),
    );
    expect(asked).toMatchObject({
      kind: 'reply',
      reply: { proposal: null, weightNotes: [{ code: 'share_unmet', quote: '60% NVDA' }] },
    });
    const dropped = await served(
      ['I want 99.99% TSLA.'],
      ['TSLA', 'NVDA', 'AAPL'],
      [shareOf(['TSLA'], 'exact', 9999, '99.99% TSLA')],
    );
    expect(dropped.weights).toEqual([9999, 1]);
    expect(dropped.notes).toContainEqual({ code: 'pick_dropped', assetIds: [symbol('AAPL')] });
  });

  it('holds a share to the person: their message, their number, their assets, the latest word', async () => {
    const cases: Array<[Turn[], ReturnType<typeof shareOf>[]]> = [
      // Not in any person message (an app message does not count).
      [
        [['app', 'Shall I put 70% TSLA?'], 'Yes please.'],
        [shareOf(['TSLA'], 'exact', 7000, '70% TSLA')],
      ],
    ];
    for (const [turns, stated] of cases) {
      const out = await served(turns, ['TSLA', 'NVDA'], stated);
      expect(out.weights).toEqual([5000, 5000]);
      expect(out.repair).toBeUndefined();
    }
    // A number or an asset the person's words do not hold: the model's report is refused once, and
    // the weights are the person's own 70% TSLA either way.
    for (const stated of [
      [shareOf(['TSLA'], 'exact', 9000, '70% TSLA')],
      [shareOf(['NVDA'], 'exact', 7000, '70% TSLA')],
    ]) {
      const out = await served(['I want 70% TSLA.'], ['TSLA', 'NVDA'], stated);
      expect(out.weights).toEqual([7000, 3000]);
      expect(out.repair).toBeUndefined();
      expect(out.notes[0]).toEqual({
        code: 'stated',
        assetIds: [symbol('TSLA')],
        quote: '70% TSLA',
      });
    }
    // A later share on the same asset replaces the earlier one.
    const later = await served(
      ['I want 70% TSLA.', ['app', 'Noted.'], 'Make it 50% TSLA.'],
      ['TSLA', 'NVDA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70% TSLA'), shareOf(['TSLA'], 'exact', 5000, '50% TSLA')],
    );
    expect(later.weights).toEqual([5000, 2500, 2500]);
    expect(later.notes[0]).toEqual({
      code: 'stated',
      assetIds: [symbol('TSLA')],
      quote: '50% TSLA',
    });
  });

  // Third review of #189: the server reads the number and its asset itself, so nothing the model
  // reports in `stated` can set, move or swap a weight. Picks are TSLA, NVDA, GLD unless noted.
  const equal = [3334, 3333, 3333];
  const tng = ['TSLA', 'NVDA', 'GLD'];
  const unreadOf = (out: Awaited<ReturnType<typeof served>>) =>
    out.notes.filter((note) => note.code === 'share_unread').map((note) => note.quote);

  it.each<[string, string[], ReturnType<typeof shareOf>[], number[], (string | null)?]>([
    [
      "I don't want 70% TSLA, keep it small.",
      tng,
      [shareOf(['TSLA'], 'exact', 7000, '70% TSLA')],
      equal,
      "I don't want 70% TSLA",
    ],
    [
      'Never put 70% in TSLA.',
      tng,
      [shareOf(['TSLA'], 'exact', 7000, '70% in TSLA')],
      equal,
      'Never put 70% in TSLA',
    ],
    [
      'I want 70% TSLA and 30% NVDA.',
      ['TSLA', 'NVDA'],
      [
        shareOf(['NVDA'], 'exact', 7000, 'I want 70% TSLA and 30% NVDA.'),
        shareOf(['TSLA'], 'exact', 3000, 'I want 70% TSLA and 30% NVDA.'),
      ],
      [7000, 3000],
    ],
    [
      'I want 70/30 TSLA and NVDA.',
      ['TSLA', 'NVDA'],
      [
        shareOf(['NVDA'], 'exact', 7000, '70/30 TSLA and NVDA'),
        shareOf(['TSLA'], 'exact', 3000, '70/30 TSLA and NVDA'),
      ],
      [7000, 3000],
    ],
    [
      'I want 70% TSLA, rest in gold.',
      tng,
      [shareOf(['GLD'], 'exact', 7000, '70% TSLA, rest in gold')],
      [7000, 1500, 1500],
      // The rest went to NVDA and gold equally, not to gold: said back (fourth review).
      'rest in gold',
    ],
    ['I want 15% TSLA.', tng, [shareOf(['TSLA'], 'exact', 500, '5% TSLA')], [1500, 4250, 4250]],
    ['I want 10% TSLA.', tng, [shareOf(['TSLA'], 'max', 0, '0% TSLA')], [1000, 4500, 4500]],
    ['I want at most 70% TSLA.', tng, [shareOf(['TSLA'], 'min', 7000, 'at most 70% TSLA')], equal],
    ['I want at least 40% stocks.', tng, [shareOf(['TSLA'], 'exact', 4000, '40% stocks')], equal],
  ])(
    "serves the person's share, not what the model reports: %s",
    async (text, tickers, stated, weights, unread = null) => {
      const out = await served([text], tickers, stated);
      expect(out.weights).toEqual(weights);
      // The misreport sets nothing and costs no second call: the same reply as with no report at all.
      expect(out.repair).toBeUndefined();
      const silent = await served([text], tickers, []);
      expect(silent.repair).toBeUndefined();
      expect([silent.weights, silent.notes]).toEqual([out.weights, out.notes]);
      expect(unreadOf(out)).toEqual(unread ? [unread] : []);
    },
  );

  it('says whose words each applied share came from, with its bound', async () => {
    const most = await served(['I want at most 70% TSLA.'], tng, []);
    expect(most.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA')], quote: 'at most 70% TSLA' },
      { code: 'equal_split', assetIds: [symbol('NVDA'), symbol('GLD')] },
    ]);
    const least = await served(['I want at least 40% stocks.'], tng, []);
    expect(least.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA'), symbol('NVDA')], quote: 'at least 40% stocks' },
      { code: 'equal_split', assetIds: [symbol('GLD')] },
    ]);
    const capped = await served(['I want at most 10% TSLA.'], tng, []);
    expect(capped.weights).toEqual([1000, 4500, 4500]);
    const swapped = await served(['I want 70/30 TSLA and NVDA.'], ['TSLA', 'NVDA'], []);
    expect(swapped.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA')], quote: '70/30 TSLA and NVDA' },
      { code: 'stated', assetIds: [symbol('NVDA')], quote: '70/30 TSLA and NVDA' },
    ]);
  });

  it.each<[string, string, string, ('en' | 'pt')?]>([
    ['I want to earn 10% with TSLA.', 'TSLA', '10% with TSLA'],
    ['I want 10% upside in gold.', 'GLD', '10% upside in gold'],
    ['I want 10% APY on gold.', 'GLD', '10% APY on gold'],
    ['I want a 4% dividend from TSLA.', 'TSLA', 'a 4% dividend from TSLA'],
    ['TSLA fell 30%.', 'TSLA', 'TSLA fell 30%'],
    ['I accept a 2% fee on TSLA.', 'TSLA', 'a 2% fee on TSLA'],
    ['TSLA up 20%.', 'TSLA', 'TSLA up 20%'],
    ['Quero que o ouro renda 10%.', 'GLD', 'o ouro renda 10%', 'pt'],
    ['Quero 10% de rentabilidade no ouro.', 'GLD', '10% de rentabilidade no ouro', 'pt'],
    ['Quero que TSLA valorize 20%.', 'TSLA', 'TSLA valorize 20%', 'pt'],
    ['Quero 90% do CDI com ouro.', 'GLD', '90% do CDI com ouro', 'pt'],
  ])(
    'sets no weight from a return, a price move or a fee, and says so: %s',
    async (text, ticker, quote, language = 'en') => {
      const figure = Number(/(\d+)%/u.exec(quote)?.[1]) * 100;
      const out = await served([text], tng, [shareOf([ticker], 'exact', figure, quote)], language);
      expect(out.weights).toEqual(equal);
      expect(out.repair).toBeUndefined();
      expect(out.notes).toEqual([
        { code: 'equal_split', assetIds: tng.map(symbol) },
        { code: 'share_unread', assetIds: [], quote: text.replace(/\.$/u, '') },
      ]);
    },
  );

  it.each<[string, ('en' | 'pt')?]>([
    ['I want 60% TSLA for growth.'],
    ['I want 30% gold to limit losses.'],
    ['Quero 60% em TSLA para crescer.', 'pt'],
  ])(
    'says back a share it leaves unapplied for a return or loss word: %s',
    async (text, language = 'en') => {
      const out = await served([text], tng, [], language);
      expect(out.weights).toEqual(equal);
      expect(out.repair).toBeUndefined();
      expect(out.notes).toEqual([
        { code: 'equal_split', assetIds: tng.map(symbol) },
        { code: 'share_unread', assetIds: [], quote: text.replace(/\.$/u, '') },
      ]);
    },
  );

  it.each<[string, number[], ('en' | 'pt')?]>([
    ['TSLA 70%.', [7000, 1500, 1500]],
    ['I want TSLA at 70% and the rest spread out.', [7000, 1500, 1500]],
    ['TSLA: 50%, NVDA: 30%, GLD: 20%', [5000, 3000, 2000]],
    ['TSLA 50% NVDA 30%', [5000, 3000, 2000]],
    ['Put 70% of my portfolio in TSLA.', [7000, 1500, 1500]],
    ['Quero 70% no TSLA.', [7000, 1500, 1500], 'pt'],
    ['Quero 70% da carteira em TSLA.', [7000, 1500, 1500], 'pt'],
    ['I want 12,5% TSLA.', [1250, 4375, 4375]],
    ['I want 0,5% TSLA.', [50, 4975, 4975]],
    ['I want no more than 10% TSLA.', [1000, 4500, 4500]],
    ['I want less than 10% TSLA.', [1000, 4500, 4500]],
    ['Quero mais de 50% em TSLA.', [5000, 2500, 2500], 'pt'],
    ["I don't want NVDA to dominate, but I want 70% TSLA.", [7000, 1500, 1500]],
  ])('reads the fixed patterns: %s', async (text, weights, language = 'en') => {
    const out = await served([text], tng, [], language);
    expect(out.weights).toEqual(weights);
    expect(unreadOf(out)).toEqual([]);
  });

  it.each<[string, string[], ('en' | 'pt')?]>([
    ['I want $70 in TSLA.', []],
    ['I want TSLA in 70 days.', []],
    ['I want 60/30 TSLA and NVDA.', ['I want 60/30 TSLA and NVDA']],
    ['I want 40% in TSLA and NVDA.', ['I want 40% in TSLA and NVDA']],
    ['I want between 20% and 30% TSLA.', ['I want between 20% and 30% TSLA']],
    ['TSLA 70% NVDA', ['TSLA 70% NVDA']],
    ['Should I put 70% in TSLA?', ['Should I put 70% in TSLA']],
    ['If it is safe, I want 70% TSLA.', ['I want 70% TSLA']],
    ['My friend said I want 70% TSLA.', ['My friend said I want 70% TSLA']],
    ['"I want 70% TSLA"', ['"I want 70% TSLA"']],
    ['I want 70% TSLA, not NVDA.', ['I want 70% TSLA']],
    ['Não quero 70% em TSLA.', ['Não quero 70% em TSLA'], 'pt'],
    ['Quero tudo menos 70% em TSLA.', ['Quero tudo menos 70% em TSLA'], 'pt'],
    ['I want half.', ['I want half']],
  ])(
    'sets nothing from what the patterns do not hold, and says so: %s',
    async (text, unread, language = 'en') => {
      const out = await served([text], tng, [], language);
      expect(out.weights).toEqual(equal);
      expect(unreadOf(out)).toEqual(unread);
    },
  );

  it('reads an app message, or a share stitched across two messages, as no share', async () => {
    const app = await served([['app', 'Shall I put 70% in TSLA?'], 'Yes, do that.'], tng, [
      shareOf(['TSLA'], 'exact', 7000, '70% in TSLA'),
    ]);
    expect(app.weights).toEqual(equal);
    const stitched = await served(['I want 70%', 'TSLA and gold please.'], tng, [
      shareOf(['TSLA'], 'exact', 7000, '70% TSLA'),
    ]);
    expect(stitched.weights).toEqual(equal);
  });

  it("withdraws a share on the person's word, and keeps it until then", async () => {
    const first = 'I want 70% TSLA.';
    // A later turn that says nothing about the share leaves it standing, whatever the model reports.
    const kept = await served([first, ['app', 'Noted.'], 'Add gold too.'], tng, []);
    expect(kept.weights).toEqual([7000, 1500, 1500]);
    expect(kept.notes[0]).toEqual({
      code: 'stated',
      assetIds: [symbol('TSLA')],
      quote: '70% TSLA',
    });
    // Only the exact forms withdraw it, and the reply says what was withdrawn.
    for (const [next, language] of [
      ['Forget TSLA.', 'en'],
      ['Drop the TSLA share.', 'en'],
      ['Drop that limit.', 'en'],
      ['Just split it equally.', 'en'],
      ['Esqueça TSLA.', 'pt'],
      ['Divida em partes iguais.', 'pt'],
    ] as const) {
      const out = await served([first, ['app', 'Noted.'], next], ['NVDA', 'GLD'], [], language);
      expect(out.weights, next).toEqual([5000, 5000]);
      expect(out.notes, next).toEqual([
        { code: 'equal_split', assetIds: [symbol('NVDA'), symbol('GLD')] },
        { code: 'share_withdrawn', assetIds: [symbol('TSLA')], quote: '70% TSLA' },
      ]);
    }
    // A refusal that names the asset withdraws nothing: with TSLA no longer picked, the share cannot
    // be met and the person is asked about it.
    for (const [next, language] of [
      ['No more TSLA, just NVDA and GLD.', 'en'],
      ["Actually I don't want 70% TSLA.", 'en'],
      ['Não quero mais TSLA.', 'pt'],
    ] as const) {
      const out = await served([first, ['app', 'Noted.'], next], ['NVDA', 'GLD'], [], language);
      expect(out.reply.proposal, next).toBeNull();
      expect(out.notes, next).toEqual([
        { code: 'share_unmet', assetIds: [symbol('TSLA')], quote: '70% TSLA' },
      ]);
    }
    // A return sentence or a question about the asset withdraws nothing.
    for (const next of ['I hope TSLA does not lose 20%.', 'Is TSLA not too risky?']) {
      const out = await served([first, ['app', 'Noted.'], next], tng, []);
      expect(out.weights, next).toEqual([7000, 1500, 1500]);
    }
    // A class share and an asset share stand together, in one message or two.
    const together = await served(['I want 50% TSLA and at least 80% stocks.'], tng, []);
    expect(together.weights).toEqual([5000, 3000, 2000]);
    const both = await served([first, 'I want at most 20% stocks.'], tng, []);
    expect(both.reply.proposal).toBeNull();
    expect(both.notes.map((note) => note.code)).toEqual(['share_unmet']);
    // A floor and a ceiling on one asset stand together; a ceiling under the floor replaces it.
    const band = await served(['I want at least 20% TSLA and at most 40% TSLA.'], tng, []);
    expect(band.notes.filter((note) => note.code === 'stated').map((note) => note.quote)).toEqual([
      'at least 20% TSLA',
      'at most 40% TSLA',
    ]);
    const lowered = await served(
      ['I want at least 60% TSLA.', 'I want at most 40% TSLA.'],
      tng,
      [],
    );
    expect(lowered.weights).toEqual(equal);
    expect(lowered.notes[0]).toMatchObject({ code: 'stated', quote: 'at most 40% TSLA' });
  });

  // Fourth review of #189: the default is not to apply. A share is set only by a plain ask, withdrawn
  // only by an exact form, and anything else that reads as a share is said back.
  const noted = ['app', 'Noted.'] as ['app', string];
  it.each<[string, ('en' | 'pt')?]>([
    ['Split the rest evenly between NVDA and gold.'],
    ['Split the rest evenly.'],
    ['Divida o resto igualmente.', 'pt'],
    ['O resto em partes iguais.', 'pt'],
    ["Don't change the split."],
    ["Don't change the percentages, they are fine."],
    ['Não mude a divisão.', 'pt'],
    ['Remove NVDA and keep TSLA.'],
    ['Tira NVDA e mantém TSLA.', 'pt'],
    ["Don't touch TSLA, just add gold."],
    ['Não mexa em TSLA, só adicione ouro.', 'pt'],
    ['Never sell my TSLA.'],
    ['TSLA is not negotiable.'],
    ['No more changes.'],
    ['I want no limits on gold.'],
  ])('keeps 70% TSLA after: %s', async (next, language = 'en') => {
    const first = language === 'pt' ? 'Quero 70% em TSLA.' : 'I want 70% TSLA.';
    for (const turns of [[first, noted, next], [`${first} ${next}`]]) {
      const out = await served(turns, tng, [], language);
      expect(out.weights).toEqual([7000, 1500, 1500]);
      expect(out.notes.map((note) => note.code)).toEqual(['stated', 'equal_split']);
    }
  });

  it('withdraws by the exact forms only, each with a note', async () => {
    // A broader later share does not remove a narrower earlier one.
    const overall = await served(
      ['I want 70% TSLA.', noted, 'And at least 90% stocks overall.'],
      tng,
      [],
    );
    expect(overall.weights).toEqual([7000, 2000, 1000]);
    expect(overall.notes.map((note) => note.quote)).toEqual([
      '70% TSLA',
      'at least 90% stocks',
      undefined,
    ]);
    const geral = await served(
      ['Quero 70% em TSLA.', noted, 'E pelo menos 90% em ações no total.'],
      tng,
      [],
      'pt',
    );
    expect(geral.weights).toEqual([7000, 2000, 1000]);
    // Refusing one stock does not withdraw a share on all stocks.
    const four = ['NVDA', 'GLD', 'USD', 'SOL'];
    const one = await served(['I want at least 40% stocks.', noted, 'No TSLA please.'], four, []);
    expect(one.weights).toEqual([4000, 2000, 2000, 2000]);
    // "Drop the minimum" drops the minimum, not the last share stated.
    const mix = ['TSLA', 'GLD', 'USD', 'SOL'];
    for (const [first, next, language, quote] of [
      [
        'I want at least 40% stocks and at most 10% gold.',
        'Drop the minimum.',
        'en',
        'at least 40% stocks',
      ],
      [
        'Quero pelo menos 40% em ações e no máximo 10% em ouro.',
        'Tira o mínimo.',
        'pt',
        'pelo menos 40% em ações',
      ],
    ] as const) {
      const before = await served([first], mix, [], language);
      expect(before.weights).toEqual([4000, 1000, 2500, 2500]);
      const out = await served([first, noted, next], mix, [], language);
      expect(out.weights).toEqual([3000, 1000, 3000, 3000]);
      expect(out.notes.at(-1)).toMatchObject({ code: 'share_withdrawn', quote });
      expect(out.notes.filter((note) => note.code === 'stated')).toHaveLength(1);
    }
    // With two shares standing, "that limit" is neither: both stand and the words are said back.
    const two = await served(['I want 70% TSLA and 20% NVDA.', noted, 'Drop that limit.'], tng, []);
    expect(two.weights).toEqual([7000, 2000, 1000]);
    expect(unreadOf(two)).toEqual(['Drop that limit']);
    const cleared = await served(
      ['I want 70% TSLA and 20% NVDA.', noted, 'Split it equally.'],
      tng,
      [],
    );
    expect(cleared.weights).toEqual(equal);
    expect(cleared.notes.filter((note) => note.code === 'share_withdrawn')).toEqual([
      { code: 'share_withdrawn', assetIds: [symbol('TSLA')], quote: '70% TSLA' },
      { code: 'share_withdrawn', assetIds: [symbol('NVDA')], quote: '20% NVDA' },
    ]);
    // Forgetting an asset leaves a class share that covers it.
    const cls = await served(['I want at least 40% stocks.', noted, 'Forget TSLA.'], four, []);
    expect(cls.weights).toEqual([4000, 2000, 2000, 2000]);
  });

  it.each<[string, string, ('en' | 'pt')?]>([
    // Rejected or hypothetical.
    ['70% TSLA is too risky for me.', '70% TSLA is too risky for me'],
    ['70% TSLA is too high.', '70% TSLA is too high'],
    ['70% TSLA would be crazy.', '70% TSLA would be crazy'],
    ['70% TSLA scares me.', '70% TSLA scares me'],
    ['I hate the idea of 70% TSLA.', 'I hate the idea of 70% TSLA'],
    ['Anything but 70% TSLA.', 'Anything but 70% TSLA'],
    ['Hypothetically, 70% in TSLA.', '70% in TSLA'],
    ['Lower than 70% TSLA.', 'Lower than 70% TSLA'],
    ['I want less TSLA, 70% TSLA is a lot.', '70% TSLA is a lot'],
    ['I want 70% TSLA, I mean NVDA.', 'I want 70% TSLA'],
    ['70% em TSLA é muito arriscado.', '70% em TSLA é muito arriscado', 'pt'],
    ['70% em TSLA seria loucura.', '70% em TSLA seria loucura', 'pt'],
    ['70% em TSLA me assusta.', '70% em TSLA me assusta', 'pt'],
    ['Tenho medo de 70% em TSLA.', 'Tenho medo de 70% em TSLA', 'pt'],
    ['Talvez 70% em TSLA.', 'Talvez 70% em TSLA', 'pt'],
    // The app's draft, said back.
    ['You gave me 70% TSLA. That is wrong.', 'You gave me 70% TSLA'],
    ['You gave me 70% TSLA, why?', 'You gave me 70% TSLA'],
    ['The 70% TSLA you proposed is wrong.', 'The 70% TSLA you proposed is wrong'],
    ['I asked for 30% TSLA, you gave 70% TSLA.', 'you gave 70% TSLA'],
    ['TSLA at 70% is fine but NVDA 30% is wrong.', 'TSLA at 70% is fine but NVDA 30% is wrong'],
    ['Você colocou 70% em TSLA, está errado.', 'Você colocou 70% em TSLA', 'pt'],
    // A past result or a fact.
    ['I lost 30% in TSLA last year, so keep it small.', 'I lost 30% in TSLA last year'],
    ["I'm down 30% in TSLA.", "I'm down 30% in TSLA"],
    ["I'm up 20% in TSLA.", "I'm up 20% in TSLA"],
    ['I made 20% in TSLA and want to keep going.', 'I made 20% in TSLA and want to keep going'],
    ['I think TSLA is 30% overvalued.', 'I think TSLA is 30% overvalued'],
    ['TSLA is 50% off its high.', 'TSLA is 50% off its high'],
    ['TSLA is 5% of the S&P.', 'TSLA is 5% of the S&P'],
    [
      'My old portfolio was 70% TSLA and I got burned.',
      'My old portfolio was 70% TSLA and I got burned',
    ],
    ['Right now I hold 70% TSLA elsewhere.', 'Right now I hold 70% TSLA elsewhere'],
    ['My wife wants 70% TSLA, I am unsure.', 'My wife wants 70% TSLA'],
    ['I pay 15% in cash taxes.', 'I pay 15% in cash taxes'],
    ['Bitcoin dominance is 60% in crypto.', 'Bitcoin dominance is 60% in crypto'],
    ['Perdi 30% em TSLA ano passado.', 'Perdi 30% em TSLA ano passado', 'pt'],
    ['Ganhei 20% em TSLA.', 'Ganhei 20% em TSLA', 'pt'],
    ['TSLA perdeu 30%.', 'TSLA perdeu 30%', 'pt'],
    ['TSLA rendeu 20%.', 'TSLA rendeu 20%', 'pt'],
    ['Minha carteira antiga tinha 70% em TSLA.', 'Minha carteira antiga tinha 70% em TSLA', 'pt'],
    // A change is not a level.
    ['Increase TSLA 10%.', 'Increase TSLA 10%'],
    ['Increase TSLA to 80%.', 'Increase TSLA to 80%'],
    ['Cut TSLA to half.', 'Cut TSLA to half'],
    ['Reduce TSLA from 70% to 50%.', 'Reduce TSLA from 70% to 50%'],
    ['Move TSLA from 70% to 50%.', 'Move TSLA from 70% to 50%'],
    ['Change 70% TSLA to 50% NVDA.', 'Change 70% TSLA to 50% NVDA'],
    ['I want double the TSLA.', 'I want double the TSLA'],
    ['Aumente TSLA em 10%.', 'Aumente TSLA em 10%', 'pt'],
    ['Reduza TSLA em 10%.', 'Reduza TSLA em 10%', 'pt'],
    ['Reduz TSLA a metade.', 'Reduz TSLA a metade', 'pt'],
    ['Quero diminuir TSLA de 70% para 50%.', 'Quero diminuir TSLA de 70% para 50%', 'pt'],
    ['Quero o dobro de TSLA.', 'Quero o dobro de TSLA', 'pt'],
    // A share with no percent sign that is no list coming to 100, a fraction or a whole: noticed,
    // not read. A list that comes to 100 is read (below).
    ['I want 70 TSLA and 20 NVDA.', 'I want 70 TSLA and 20 NVDA'],
    // tokens, not shares, though they come to 100 (the review of #325)
    ['I want 70 TSLA and 30 NVDA.', 'I want 70 TSLA and 30 NVDA'],
    ['TSLA at 70, NVDA at 30.', 'TSLA at 70'],
    ['TSLA 70, NVDA 20.', 'TSLA 70'],
    ['I want 70-30 TSLA and NVDA.', 'I want 70-30 TSLA and NVDA'],
    ['I want 70:30 TSLA and NVDA.', 'I want 70:30 TSLA and NVDA'],
    ['seventy percent TSLA', 'seventy percent TSLA'],
    ['I want 0.7 TSLA.', 'I want 0.7 TSLA'],
    ['I want 7000 bps TSLA.', 'I want 7000 bps TSLA'],
    ['I want a third in TSLA.', 'I want a third in TSLA'],
    ['I want two thirds TSLA.', 'I want two thirds TSLA'],
    ['I want a quarter in gold.', 'I want a quarter in gold'],
    ['I want 60% stocks (40% TSLA).', 'I want 60% stocks (40% TSLA)'],
    ['I want TSLA (70%) and NVDA (30%).', 'I want TSLA (70%) and NVDA (30%)'],
    ['I want 70% TSLA and 30% in NVDA and GLD.', 'I want 70% TSLA and 30% in NVDA and GLD'],
    [
      'I want 70% of what I have in stocks to be TSLA.',
      'I want 70% of what I have in stocks to be TSLA',
    ],
    ['I want $500 and 70% of the rest in TSLA.', 'I want $500 and 70% of the rest in TSLA'],
    ['Quero 70 em TSLA e 20 em NVDA.', 'Quero 70 em TSLA e 20 em NVDA', 'pt'],
    ['Quero setenta por cento em TSLA.', 'Quero setenta por cento em TSLA', 'pt'],
    ['Quero um terço em TSLA.', 'Quero um terço em TSLA', 'pt'],
    ['Quero dois terços em TSLA.', 'Quero dois terços em TSLA', 'pt'],
    ['Quero tudo em TSLA.', 'Quero tudo em TSLA', 'pt'],
  ])('applies nothing and says it back: %s', async (text, quote, language = 'en') => {
    const out = await served([text], tng, [], language);
    expect(out.weights).toEqual(equal);
    expect(out.notes[0]).toEqual({ code: 'equal_split', assetIds: tng.map(symbol) });
    expect(unreadOf(out)).toContain(quote);
    // And it withdraws nothing: an earlier share stands.
    const after = await served(
      [language === 'pt' ? 'Quero 20% em ouro.' : 'I want 20% gold.', noted, text],
      tng,
      [],
      language,
    );
    expect(after.weights).toEqual([4000, 4000, 2000]);
    expect(unreadOf(after)).toContain(quote);
  });

  // Until Oct 9 "All in TSLA." was a row of the table above: said back as unread, with an equal split.
  // That was the refusal Rodrigo met on the hosted app ("all in tGOOGLx"). The whole vault in one name
  // is an exact share of all of it, and the shares stated before it are withdrawn and said.
  // Until Oct 15 these were rows of the table above: Thom's "SPY 50, AAPL 15, … GOOGL 2.5." in the
  // vault chat was said back as "a bare number beside each name". A list of names whose bare numbers
  // come to 100 is the shares it names.
  it.each<[string, ('en' | 'pt')?]>([
    ['I want 70 in TSLA and 30 in NVDA.'],
    ['TSLA 70, NVDA 30.'],
    ['Quero 70 em TSLA e 30 em NVDA.', 'pt'],
  ])('reads a list of bare numbers that come to 100 as its shares: %s', async (text, language) => {
    const out = await served([text], ['TSLA', 'NVDA'], [], language);
    expect(out.weights).toEqual([7000, 3000]);
    expect(unreadOf(out)).toEqual([]);
  });

  it('reads Thom’s list as he wrote it in the vault chat, with no percent sign (Oct 15)', async () => {
    const seven = ['SPY', 'AAPL', 'NVDA', 'META', 'TSLA', 'MSFT', 'GOOGL'];
    const out = await served(
      ['SPY 50, AAPL 15, NVDA 15, META 10, TSLA 5, MSFT 2.5, GOOGL 2.5'],
      seven,
      [],
    );
    expect(out.weights).toEqual([5000, 1500, 1500, 1000, 500, 250, 250]);
    expect(unreadOf(out)).toEqual([]);
    expect(out.notes).not.toContainEqual(expect.objectContaining({ code: 'equal_split' }));
    // the same list a step short of 100 is said back, and the split stays equal
    const short = await served(
      ['SPY 50, AAPL 15, NVDA 15, META 10, TSLA 5, MSFT 2.5, GOOGL 2'],
      seven,
      [],
    );
    expect(short.notes[0]).toEqual({ code: 'equal_split', assetIds: seven.map(symbol) });
    expect(unreadOf(short).length).toBeGreaterThan(0);
  });

  it('reads "All in TSLA." as the whole vault in TSLA, in place of the shares before it', async () => {
    const out = await served(['All in TSLA.'], tng, []);
    expect(out.weights).toEqual([10_000]);
    expect(out.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA')], quote: 'All in TSLA' },
      { code: 'pick_dropped', assetIds: [symbol('NVDA')] },
      { code: 'pick_dropped', assetIds: [symbol('GLD')] },
    ]);
    const after = await served(['I want 20% gold.', noted, 'All in TSLA.'], tng, []);
    expect(after.weights).toEqual([10_000]);
    expect(after.notes).toContainEqual({
      code: 'share_withdrawn',
      assetIds: assets.filter((asset) => asset.cls === 'gold').map((asset) => asset.id),
      quote: '20% gold',
    });
    // Portuguese is not read yet: said back, as before.
    const pt = await served(['Quero tudo em TSLA.'], tng, [], 'pt');
    expect(unreadOf(pt)).toContain('Quero tudo em TSLA');
  });

  // Fifth review of #189: what stands before the first share is matched start to end, so an asking
  // verb with another subject, a second verb, a tense or a mood before the number is no ask.
  it.each<[string, ('en' | 'pt')?]>([
    ['You put 70% in TSLA.'],
    ['The app put 70% in TSLA.'],
    ['The model wants 70% TSLA.'],
    ['Last time I put 70% in TSLA.'],
    ['I regret that I put 70% in TSLA.'],
    ['I used to want 70% TSLA.'],
    ['I was going to put 70% in TSLA.'],
    ["I'm scared to put 70% in TSLA."],
    ['It would be crazy to put 70% in TSLA.'],
    ["I'd hate to put 70% in TSLA."],
    ['Only a fool would put 70% in TSLA.'],
    ['I am nervous to invest 70% in TSLA.'],
    ['People who buy 70% TSLA.'],
    ['My wife wants to put 70% in TSLA.'],
    ['My brother told me to buy 70% TSLA.'],
    ['Everyone tells me to put 70% in TSLA.'],
    ['Maybe put 70% in TSLA.'],
    ['I want you to explain 70% TSLA.'],
    ['I want anything other than 70% TSLA.'],
    ['I want to move away from 70% TSLA.'],
    ['I want to reduce 70% TSLA.'],
    ['I want to lower 70% TSLA.'],
    ['I want to change 70% TSLA.'],
    ['I want to think about 70% TSLA.'],
    ['I want to exit 70% TSLA.'],
    ['I want to sell 70% TSLA.'],
    ['I want to trim 70% TSLA.'],
    ['I want to go below 70% TSLA.'],
    ['I want more than just 70% TSLA.'],
    ['I want 70% TSLA or 50% TSLA.'],
    ['I want 10% more TSLA.'],
    ['I want 2x more TSLA than NVDA.'],
    ['Drop gold to 5%.'],
    ['Remove 30% NVDA.'],
    ['Você colocou 70% em TSLA.', 'pt'],
    ['Tenho medo de colocar 70% em TSLA.', 'pt'],
    ['Seria loucura colocar 70% em TSLA.', 'pt'],
    ['Minha esposa quer colocar 70% em TSLA.', 'pt'],
    ['Meu irmão mandou comprar 70% em TSLA.', 'pt'],
    ['O app quis colocar 70% em TSLA.', 'pt'],
    ['Da última vez coloquei 70% em TSLA.', 'pt'],
    ['Talvez colocar 70% em TSLA.', 'pt'],
    ['Quero reduzir 70% em TSLA.', 'pt'],
    ['Quero sair de 70% em TSLA.', 'pt'],
    ['Quero trocar 70% em TSLA.', 'pt'],
    ['Quero pensar em colocar 70% em TSLA.', 'pt'],
  ])('reads no ask in: %s', async (text, language = 'en') => {
    const out = await served([text], tng, [], language);
    expect(out.weights).toEqual(equal);
    expect(out.notes).toEqual([
      { code: 'equal_split', assetIds: tng.map(symbol) },
      { code: 'share_unread', assetIds: [], quote: text.replace(/\.$/u, '') },
    ]);
  });

  it.each<[string, number[], ('en' | 'pt')?]>([
    ['I want 70% TSLA.', [7000, 1500, 1500]],
    ['I want to put 70% in TSLA.', [7000, 1500, 1500]],
    ["I'd like 70% TSLA.", [7000, 1500, 1500]],
    ['Put 70% in TSLA and 30% in NVDA.', [7000, 3000]],
    ['Put TSLA 70%, NVDA 30%.', [7000, 3000]],
    ['Please allocate 70% to TSLA.', [7000, 1500, 1500]],
    ['Make it 70% TSLA.', [7000, 1500, 1500]],
    ['70% TSLA, 30% NVDA', [7000, 3000]],
    ['ok 70% TSLA', [7000, 1500, 1500]],
    ['so 70% TSLA then', [3334, 3333, 3333]],
    ['quero 70% em TSLA', [7000, 1500, 1500], 'pt'],
    ['Quero colocar 70% em TSLA.', [7000, 1500, 1500], 'pt'],
    ['Queria 70% em TSLA.', [7000, 1500, 1500], 'pt'],
    ['Coloca 70% em TSLA por favor.', [7000, 1500, 1500], 'pt'],
    ['Quero 70% em TSLA e 30% em NVDA.', [7000, 3000], 'pt'],
  ])('still reads the plain ask: %s', async (text, weights, language = 'en') => {
    const out = await served([text], tng, [], language);
    expect(out.weights).toEqual(weights);
    // "then" after the share is not part of a plain ask: unread, and quoted.
    expect(unreadOf(out)).toEqual(weights[0] === 3334 ? [text] : []);
  });

  it('quotes the number in a sentence that opens like a withdrawal, and withdraws nothing', async () => {
    for (const next of [
      'Drop TSLA to 10%.',
      'Remove 30% NVDA.',
      'Drop gold to 5%.',
      'Forget the 70% TSLA.',
    ]) {
      const out = await served(['I want 70% TSLA.', noted, next], tng, []);
      expect(out.weights, next).toEqual([7000, 1500, 1500]);
      expect(
        out.notes.map((note) => note.code),
        next,
      ).toEqual(['stated', 'equal_split', 'share_unread']);
      expect(unreadOf(out), next).toEqual([next.replace(/\.$/u, '')]);
    }
  });

  it.each<[string, number[], ('en' | 'pt')?]>([
    ['I want 70% TSLA,30% NVDA.', [7000, 3000]],
    ['TSLA 70%,NVDA 30%', [7000, 3000]],
    ['I want 70% TSLA.30% NVDA.', [7000, 3000]],
    ['TSLA: 70%; NVDA: 30%', [7000, 3000]],
    ['Quero 70% em TSLA,30% em NVDA.', [7000, 3000], 'pt'],
    ['Quero 70% TSLA, 30% NVDA.', [7000, 3000], 'pt'],
    ['Quero 12,5% em TSLA.', [1250, 4375, 4375], 'pt'],
    ['70 % TSLA', [7000, 1500, 1500]],
    ['70pct TSLA', [7000, 1500, 1500]],
    ['TSLA=70%', [7000, 1500, 1500]],
    ['70% TSLAx', [7000, 1500, 1500]],
    ['I want 70 per cent TSLA.', [7000, 1500, 1500]],
    ['Please put 70% in TSLA.', [7000, 1500, 1500]],
    ['Ok, 70% TSLA and 30% NVDA please', [7000, 3000]],
    ['Quero 70% no ouro.', [1500, 1500, 7000], 'pt'],
  ])('reads a plain ask whatever its punctuation: %s', async (text, weights, language = 'en') => {
    const out = await served([text], tng, [], language);
    expect(out.weights).toEqual(weights);
    expect(unreadOf(out)).toEqual([]);
    // Two exact shares over three picks leave nothing for the third, and say so.
    if (weights.length === 2)
      expect(out.notes).toContainEqual({ code: 'pick_dropped', assetIds: [symbol('GLD')] });
  });

  it('says back where the rest should go unless it went there', async () => {
    const mostly = await served(['I want 70% TSLA and mostly gold for the rest.'], tng, []);
    expect(mostly.weights).toEqual([7000, 1500, 1500]);
    expect(unreadOf(mostly)).toEqual(['mostly gold for the rest']);
    const gold = await served(['I want 70% TSLA, rest in gold.'], tng, []);
    expect(unreadOf(gold)).toEqual(['rest in gold']);
    // With gold the only other pick, the rest is in gold: nothing to say.
    const went = await served(['I want 70% TSLA, rest in gold.'], ['TSLA', 'GLD'], []);
    expect(went.weights).toEqual([7000, 3000]);
    expect(went.notes.map((note) => note.code)).toEqual(['stated', 'equal_split']);
    const spread = await served(
      ['I want 70% TSLA.', noted, 'Split the rest evenly between NVDA and gold.'],
      tng,
      [],
    );
    expect(unreadOf(spread)).toEqual([]);
    const other = await served(
      ['I want 70% TSLA.', noted, 'Split the rest evenly between NVDA and AAPL.'],
      tng,
      [],
    );
    expect(unreadOf(other)).toEqual(['Split the rest evenly between NVDA and AAPL']);
    // A number of its own in the sentence that no asset holds: none of the sentence is applied.
    const loose = await served(['I want 70% TSLA, 20% NVDA and the rest, 10%, safe.'], tng, []);
    expect(loose.weights).toEqual(equal);
    expect(unreadOf(loose)).toEqual(['I want 70% TSLA', '20% NVDA and the rest', '10%']);
  });

  // ANY-COMPOSITION as amended Oct 28 (Thom: "this doesn't seem like a good chat experience"): a share
  // the model reports in `stated` holds when its quote is the person's own words, word for word, and
  // holds the number (or "all") beside the asset's name. The real messages that were refused and told
  // to rephrase, then what is still refused.
  describe('a share the model quotes from the person, checked word for word', () => {
    const stockAttributes = {
      stocks: [
        { symbol: 'TSLAx', company: 'Tesla, Inc.' },
        { symbol: 'NVDAx', company: 'NVIDIA Corporation' },
      ],
    } as unknown as VaultAgentContext['stockAttributes'];
    const stated = (out: Awaited<ReturnType<typeof served>>) =>
      out.notes.filter((note) => note.code === 'stated');

    it('"TSLAx 10%, as an exact target. Put the other 10% in cash." sets both shares', async () => {
      const text = 'TSLAx 10%, as an exact target. Put the other 10% in cash.';
      for (const quotes of [
        ['TSLAx 10%', 'Put the other 10% in cash'],
        // the whole message as the quote of each: the number nearest each name is its own
        [text, text],
      ]) {
        const out = await served(
          [text],
          ['TSLA', 'USD', 'GLD'],
          [
            shareOf(['TSLA'], 'exact', 1000, quotes[0] as string),
            shareOf(['USD'], 'exact', 1000, quotes[1] as string),
          ],
        );
        expect(out.weights).toEqual([1000, 1000, 8000]);
        expect(out.repair).toBeUndefined();
        expect(stated(out).map((note) => note.assetIds)).toEqual([
          [symbol('TSLA')],
          [symbol('USD')],
        ]);
        // what the reader alone left unread is applied now, so it is not said back
        expect(unreadOf(out)).toEqual([]);
      }
      // Without the model's report the reader alone sets nothing, as before.
      expect((await served([text], ['TSLA', 'USD', 'GLD'], [])).weights).toEqual(equal);
    });

    it('"move 10% from Tesla into cash" sets no share: the model drafts it, the review sets it', async () => {
      // The orchestrator, Oct 28, after /review-pr on #359: a move re-applied on every later turn and
      // overrode later shares, so relative changes are no share at all.
      const text = 'Less Tesla, more cash: move 10% from Tesla into cash';
      const tsla = symbol('TSLA');
      const nvda = symbol('NVDA');
      const position = (asset: string, targetBps: number) => ({
        asset,
        raw: '10000000',
        display: '10',
        multiplier: '1',
        targetBps,
        lastKeeperAt: null,
      });
      const vault = { ...state, positions: [position(tsla, 3000), position(nvda, 2000)] };
      const extra = { stockAttributes, state: vault };
      for (const turns of [
        [text],
        // a later turn, the move still in the history and still reported
        [text, ['app', 'Drafted: less Tesla, more cash.'], 'Great. Why is gold not in there?'],
      ] as Turn[][]) {
        const out = await served(
          turns,
          ['TSLA', 'NVDA', 'USD'],
          [shareOf(['TSLA'], 'exact', 2000, text), shareOf(['USD'], 'exact', 6000, text)],
          'en',
          extra,
        );
        expect(out.weights).toEqual([3334, 3333, 3333]);
        expect(stated(out)).toEqual([]);
        expect(out.repair).toBeUndefined();
      }
    });

    it("reads a quote from the latest message only: an earlier one is the reader's alone", async () => {
      const said = 'TSLAx 10%, as an exact target.';
      const now = await served(
        [said],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
      );
      expect(now.weights).toEqual([1000, 9000]);
      const later = await served(
        [said, noted, 'Also add gold.'],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
      );
      expect(later.weights).toEqual([5000, 5000]);
    });

    it('"i wanto to goo all in in telsa" drafts Tesla alone; no typo is read as a name', async () => {
      const text = 'i wanto to goo all in in telsa';
      const out = await served(
        [text],
        ['TSLA'],
        [shareOf(['TSLA'], 'exact', 10_000, 'all in in telsa')],
        'en',
        { stockAttributes },
      );
      // The draft holds what the person asked for; nothing is said back as unread.
      expect(out.weights).toEqual([10_000]);
      expect(out.repair).toBeUndefined();
      expect(unreadOf(out)).toEqual([]);
      // Beside another pick the misspelt name sets no share: the split stays equal.
      const two = await served(
        [text],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 10_000, 'all in in telsa')],
        'en',
        { stockAttributes },
      );
      expect(two.weights).toEqual([5000, 5000]);
      // Spelt as the catalog names it, "all in" after an asking lead is the whole vault.
      const spelt = await served(
        ['So I want to go all in on Tesla.'],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 10_000, 'all in on Tesla')],
        'en',
        { stockAttributes },
      );
      expect(spelt.weights).toEqual([10_000]);
      expect(spelt.notes).toContainEqual({ code: 'pick_dropped', assetIds: [symbol('GLD')] });
    });

    it.each<[string, string, ReturnType<typeof shareOf>[]]>([
      // not word for word
      [
        'a quote that is not verbatim',
        'TSLAx 10%, as an exact target.',
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx at 10%')],
      ],
      // another number than the words hold
      [
        'another number',
        'TSLAx 10%, as an exact target.',
        [shareOf(['TSLA'], 'exact', 2000, 'TSLAx 10%')],
      ],
      // another bound than the words hold
      [
        'another bound',
        'TSLAx 10%, as an exact target.',
        [shareOf(['TSLA'], 'min', 1000, 'TSLAx 10%')],
      ],
      // the number beside another asset
      [
        'a number nearer another name',
        'TSLAx 70% as an exact target, and NVDAx 30% as one too.',
        [
          shareOf(
            ['NVDA'],
            'exact',
            7000,
            'TSLAx 70% as an exact target, and NVDAx 30% as one too',
          ),
        ],
      ],
      // an asset the quote does not name
      [
        'an asset not named',
        'TSLAx 10%, as an exact target.',
        [shareOf(['GLD'], 'exact', 1000, 'TSLAx 10%')],
      ],
      // a class, not one asset
      [
        'a class',
        'Stocks 40%, as an exact target.',
        [shareOf(['TSLA', 'NVDA'], 'exact', 4000, 'Stocks 40%')],
      ],
      // a question, a price move, someone else's words, the past
      [
        'a question',
        'TSLAx 10%, as an exact target?',
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
      ],
      [
        'a price move',
        'TSLAx jumped 10% today.',
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx jumped 10%')],
      ],
      [
        'someone else',
        'You put TSLAx 10% last time.',
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
      ],
      [
        'a refusal',
        'Not TSLAx 10%, keep it small.',
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
      ],
      // from the review of this change: each was applied before it was held to more
      [
        'a number cut out of a longer one',
        'I want 15% Tesla.',
        [shareOf(['TSLA'], 'exact', 500, '5% Tesla')],
      ],
      [
        'a worry',
        "I'm scared to put 70% in Tesla.",
        [shareOf(['TSLA'], 'exact', 7000, '70% in Tesla')],
      ],
      [
        'a holding elsewhere',
        'My 401k is 60% Nvidia.',
        [shareOf(['NVDA'], 'exact', 6000, '60% Nvidia')],
      ],
      [
        'a relative change',
        'Add 10% to Tesla.',
        [shareOf(['TSLA'], 'exact', 1000, '10% to Tesla')],
      ],
      [
        'another move',
        'Move another 10% from Tesla to Nvidia.',
        [shareOf(['TSLA'], 'exact', 1000, '10% from Tesla')],
      ],
      [
        'everything out of a name',
        'Get everything out of Tesla.',
        [shareOf(['TSLA'], 'exact', 10_000, 'everything out of Tesla')],
      ],
      [
        'one number over two names',
        'Put 40% in Tesla and Nvidia.',
        [shareOf(['TSLA'], 'exact', 4000, '40% in Tesla')],
      ],
      [
        'a bound left out of the quote',
        'Make it at least 20% Tesla, as a floor.',
        [shareOf(['TSLA'], 'exact', 2000, '20% Tesla')],
      ],
      // the second look at it
      [
        'a bound a word away',
        'At most around 20% Tesla.',
        [shareOf(['TSLA'], 'exact', 2000, '20% Tesla')],
      ],
      [
        'a bound after',
        'Up to roughly 20% Tesla please.',
        [shareOf(['TSLA'], 'exact', 2000, '20% Tesla')],
      ],
      [
        'a condition on a price',
        'Put 30% in Tesla when it dips below 200.',
        [shareOf(['TSLA'], 'exact', 3000, '30% in Tesla')],
      ],
      [
        'a later time',
        'Put 30% in Tesla next year.',
        [shareOf(['TSLA'], 'exact', 3000, '30% in Tesla')],
      ],
      [
        'the past',
        'I put 30% in Tesla yesterday.',
        [shareOf(['TSLA'], 'exact', 3000, '30% in Tesla')],
      ],
      [
        'someone else',
        'Put 30% in Tesla for my brother.',
        [shareOf(['TSLA'], 'exact', 3000, '30% in Tesla')],
      ],
      ['a maybe', 'Maybe 30% in Tesla.', [shareOf(['TSLA'], 'exact', 3000, '30% in Tesla')]],
      [
        'one number over a choice',
        'Put 30% in Tesla, or Nvidia.',
        [shareOf(['TSLA'], 'exact', 3000, '30% in Tesla')],
      ],
      [
        'a move on a condition',
        'Move 10% from Tesla to Nvidia when Tesla hits 300.',
        [shareOf(['TSLA'], 'exact', 1000, 'Move 10% from Tesla to Nvidia')],
      ],
      [
        'a move out of worry',
        "I'm worried, so move 10% from Tesla to Nvidia next month.",
        [shareOf(['TSLA'], 'exact', 1000, 'move 10% from Tesla to Nvidia')],
      ],
    ])('refuses %s: the report sets nothing', async (_case, text, report) => {
      const picks = ['TSLA', 'NVDA', 'GLD'];
      const out = await served([text], picks, report, 'en', { stockAttributes });
      // the same weights as with no report at all: what the server's own reader reads, if anything
      // ("I want 15% Tesla" is 15%, never the model's 5%), else an equal split
      const alone = await served([text], picks, [], 'en', { stockAttributes });
      expect(out.weights).toEqual(alone.weights);
      expect(stated(out)).toEqual(stated(alone));
      expect(out.repair).toBeUndefined();
    });

    // From /review-pr on #359: words that are no plain request set nothing, whatever the model reports.
    it.each<[string, string, number, ('en' | 'pt')?]>([
      ['Tesla 50% would be crazy.', 'Tesla 50%', 5000],
      ['50% Tesla feels wrong to me.', '50% Tesla', 5000],
      ['Honestly 50% Tesla sounds insane.', '50% Tesla', 5000],
      ['I hate the idea of 50% Tesla.', '50% Tesla', 5000],
      ['Compared to 50% Tesla, this is fine.', '50% Tesla', 5000],
      ['Undo the 50% Tesla.', '50% Tesla', 5000],
      ['Revert 50% Tesla.', '50% Tesla', 5000],
      ['Go from 50% Tesla to equal weights.', '50% Tesla', 5000],
      ['Reduce from 50% Tesla to 20% Tesla.', '50% Tesla', 5000],
      ['Down from 50% Tesla, please.', '50% Tesla', 5000],
      ['Tesla 50%, lol no.', 'Tesla 50%', 5000],
      ['Ugh, 50% Tesla.', '50% Tesla', 5000],
      ['Halving 50% Tesla.', '50% Tesla', 5000],
      ['Not sure about 50% Tesla.', '50% Tesla', 5000],
      ['Unsure about 50% Tesla.', '50% Tesla', 5000],
      ['Tesla 50% scares me.', 'Tesla 50%', 5000],
      ['Tesla 50% is too much.', 'Tesla 50%', 5000],
      ['50% Tesla seems too much.', '50% Tesla', 5000],
      ['Quero 50% em Tesla, ou não.', '50% em Tesla', 5000, 'pt'],
      ['Compare 50% Tesla.', '50% Tesla', 5000],
      ['Simulate 50% Tesla.', '50% Tesla', 5000],
      ['Show me 50% Tesla.', '50% Tesla', 5000],
      ['Hypothetically, 50% Tesla.', '50% Tesla', 5000],
      ['Tesla 50% vs Nvidia 50%.', 'Tesla 50%', 5000],
      ['Tesla 50% then sell it all.', 'Tesla 50%', 5000],
      ['Max Tesla, 50%.', 'Tesla, 50%', 5000],
      ['Tesla up to 50%.', 'Tesla up to 50%', 5000],
      ['Tesla capped at 50%.', 'Tesla capped at 50%', 5000],
      ['Tesla no higher than 50%.', 'Tesla no higher than 50%', 5000],
      ['Tesla 50% or less.', 'Tesla 50%', 5000],
      ['Tesla 50% or more.', 'Tesla 50%', 5000],
      ['Tesla 50% at most.', 'Tesla 50%', 5000],
      ['Tesla 50% max.', 'Tesla 50%', 5000],
      ['Tesla 50% tops.', 'Tesla 50%', 5000],
      ['Tesla 50% minimum.', 'Tesla 50%', 5000],
      ['Tesla 50%-ish.', 'Tesla 50%', 5000],
      ['Tesla roughly 50%.', 'Tesla roughly 50%', 5000],
      ['Tesla around 50%.', 'Tesla around 50%', 5000],
      ['Tesla 50% of the stock part.', 'Tesla 50%', 5000],
      ['Tesla 50% of my stocks.', 'Tesla 50%', 5000],
      ['Half my stocks in Tesla.', 'Half my stocks in Tesla', 5000],
      ['50% of the remainder in Tesla.', '50% of the remainder in Tesla', 5000],
      ['Tesla 50% of what Nvidia gets.', 'Tesla 50%', 5000],
      ['Tesla gets half of Nvidia.', 'Tesla gets half', 5000],
      ['Tesla 5%, no 50%.', 'Tesla 5%', 500],
      ['Tesla 50% wait no.', 'Tesla 50%', 5000],
      ['Tesla 50%, gold 50% - joking.', 'Tesla 50%', 5000],
    ])('sets nothing from "%s"', async (text, quote, bps, language = 'en') => {
      const picks = ['TSLA', 'NVDA', 'GLD'];
      const out = await served([text], picks, [shareOf(['TSLA'], 'exact', bps, quote)], language, {
        stockAttributes,
      });
      const alone = await served([text], picks, [], language, { stockAttributes });
      expect(out.weights).toEqual(alone.weights);
    });

    // Only the quote check applies these (the reader alone splits equally), over three picks so an
    // equal split cannot pass for them.
    it.each<[string, string[], ReturnType<typeof shareOf>[], number[]]>([
      [
        'TSLAx 10%, as an exact target.',
        ['TSLA', 'NVDA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
        [1000, 4500, 4500],
      ],
      [
        'So I want to go all in on Tesla.',
        ['TSLA', 'NVDA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 10_000, 'all in on Tesla')],
        [10_000],
      ],
      [
        'Put the other 10% in cash.',
        ['USD', 'NVDA', 'GLD'],
        [shareOf(['USD'], 'exact', 1000, 'Put the other 10% in cash')],
        [1000, 4500, 4500],
      ],
      [
        'TSLAx 10%, as an exact target. Put the other 10% in cash.',
        ['TSLA', 'USD', 'NVDA'],
        [
          shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%'),
          shareOf(['USD'], 'exact', 1000, 'Put the other 10% in cash'),
        ],
        [1000, 1000, 8000],
      ],
    ])('applies what only the quote check reads: "%s"', async (text, picks, report, weights) => {
      const alone = await served([text], picks, [], 'en', { stockAttributes });
      expect(alone.weights).toEqual(picks.length === 3 ? [3334, 3333, 3333] : alone.weights);
      const out = await served([text], picks, report, 'en', { stockAttributes });
      expect(out.weights).toEqual(weights);
    });

    // Re-review of #359: a later sentence of the same message takes the share back, so a quoted share
    // applies only when every sentence of the latest message is a share or a courtesy.
    it.each([
      ['All in on Tesla. Kidding.', 'All in on Tesla', 10_000],
      ['I want to go all in on Tesla. Just kidding.', 'all in on Tesla', 10_000],
      ['Go all in on Tesla. Or not.', 'all in on Tesla', 10_000],
      ['Put everything in Tesla. Joking.', 'everything in Tesla', 10_000],
      ['My brother told me this. Go all in on Tesla.', 'all in on Tesla', 10_000],
      ['All in on Tesla. That is what my brother did last year.', 'All in on Tesla', 10_000],
      ['All in on Tesla. Would that be crazy?', 'All in on Tesla', 10_000],
      ['All in on Tesla. No.', 'All in on Tesla', 10_000],
      ['Tesla 50% now. That is way too much.', 'Tesla 50%', 5000],
      ['Tesla 50% now. Too much.', 'Tesla 50%', 5000],
      ['Tesla 50% overall. I hate it.', 'Tesla 50%', 5000],
      ['Tesla 50% in my portfolio. Too risky?', 'Tesla 50%', 5000],
      ['Tesla 50% in total. Nope.', 'Tesla 50%', 5000],
      ['Tesla 10% now. Just kidding.', 'Tesla 10%', 1000],
      ['TSLAx 10%, as an exact target. Never mind.', 'TSLAx 10%', 1000],
      ['Tesla 10%, thanks. Wait, no.', 'Tesla 10%', 1000],
      ['Tesla 50% now? Too much.', 'Tesla 50%', 5000],
      ['Tesla 50% now!', 'Tesla 50%', 5000],
      ['Tesla 50% agora. Demais.', 'Tesla 50%', 5000],
    ] as const)('sets nothing from "%s"', async (text, quote, bps) => {
      const picks = ['TSLA', 'NVDA', 'GLD'];
      const out = await served([text], picks, [shareOf(['TSLA'], 'exact', bps, quote)], 'en', {
        stockAttributes,
      });
      const alone = await served([text], picks, [], 'en', { stockAttributes });
      expect(out.weights).toEqual(alone.weights);
    });

    it('applies a quoted share beside a courtesy sentence', async () => {
      const out = await served(
        ['TSLAx 10%, as an exact target. Thanks.'],
        ['TSLA', 'NVDA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
        'en',
        { stockAttributes },
      );
      expect(out.weights).toEqual([1000, 4500, 4500]);
    });

    it('sets nothing a message itself takes back: "Make Tesla 30%. Actually drop Tesla."', async () => {
      const out = await served(
        ['Make Tesla 30%. Actually drop Tesla.'],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 3000, 'Make Tesla 30%')],
        'en',
        { stockAttributes },
      );
      expect(out.weights).toEqual([5000, 5000]);
    });

    it('takes a quoted share back when a later message withdraws it, as any other', async () => {
      const out = await served(
        ['TSLAx 10%, as an exact target.', noted, 'split it equally'],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
      );
      expect(out.weights).toEqual([5000, 5000]);
      // A later share the reader reads on the same asset replaces it.
      const later = await served(
        ['TSLAx 10%, as an exact target.', noted, 'I want 30% TSLA.'],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 1000, 'TSLAx 10%')],
      );
      expect(later.weights).toEqual([3000, 7000]);
    });

    it('says back words the model reports that set nothing, where the draft does not meet them', async () => {
      const text = 'Put about a tenth in TSLAx.';
      const out = await served(
        [text],
        ['TSLA', 'GLD'],
        [shareOf(['TSLA'], 'exact', 1000, 'about a tenth in TSLAx')],
      );
      expect(out.weights).toEqual([5000, 5000]);
      expect(unreadOf(out)).toContain('about a tenth in TSLAx');
    });
  });
});

describe('the reply schema ties warnings to the proposal', () => {
  it('refuses a warning without a proposal, or on an asset or source the proposal lacks', () => {
    const warning = {
      code: 'outside_goal_requested' as const,
      assetId: stock.id,
      evidenceId: `catalog:${stock.id}`,
    };
    const base = { version: 1, messageId: 'turn', message: 'Hi.', question: null, weightNotes: [] };
    expect(VaultAgentReply.safeParse({ ...base, proposal: null, warnings: [] }).success).toBe(true);
    expect(
      VaultAgentReply.safeParse({ ...base, proposal: null, warnings: [warning] }).success,
    ).toBe(false);
    const withProposal = {
      ...base,
      proposal: {
        ...(({ stated, ...rest }) => rest)(proposal().proposal),
        allocations: proposal().proposal.allocations.map((line, i) => ({
          ...line,
          symbol: 'X',
          weightBps: [3334, 3333, 3333][i] ?? 0,
        })),
        sources: context.evidence,
      },
    };
    expect(VaultAgentReply.safeParse({ ...withProposal, warnings: [warning] }).success).toBe(true);
    expect(
      VaultAgentReply.safeParse({
        ...withProposal,
        warnings: [{ ...warning, evidenceId: `liquidity:${stock.id}` }],
      }).success,
    ).toBe(false);
    expect(
      VaultAgentReply.safeParse({ ...withProposal, warnings: [{ ...warning, assetId: cash.id }] })
        .success,
    ).toBe(false);
  });
});
