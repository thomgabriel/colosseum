import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@colosseum/db';
import type { BarRow, LendingMarketRow, ObservationRow, PoolBarRow } from '@colosseum/risk';
import type { BasketAsset, VaultAgentSource } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import { createAssetLookups, type LookupReads } from './asset-lookups';
import type { LookupAnswer, LookupFact } from './orders/lookups';
import { MEASURED } from './orders/relaxed-figures';
import { figureResolver } from './orders/vault-figures';

// The asset lookups with their reads handed in: the rows are the fixtures the builders are tested on
// (fixtures/risk/assets/lookups/), so what is tested here is the reading, keeping, waiting, naming and
// labelling around them.
const DIR = join(__dirname, '../../../fixtures/risk/assets/lookups');
const load = <T>(file: string): T => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as T;
const observations = load<{ observations: ObservationRow[] }>(
  'nvdax-observations.json',
).observations;
const bars = load<{ bars: BarRow[] }>('nvdax-bars.json').bars;
const pools = load<{ reading: ObservationRow; poolBars: PoolBarRow[] }>('nvdax-pools.json');
const lending = load<{ markets: LendingMarketRow[] }>('nvdax-lending.json').markets;
const MINT = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';

const db = {} as Db;
const shelf = launchShelf().assets;
const stock = shelf.find((a) => a.chain === 'solana' && a.cls === 'stock') as BasketAsset;
const asset: BasketAsset = { ...stock, id: 'solana:nvdax', symbol: 'NVDAx', address: MINT };
const cash = shelf.find((a) => a.chain === 'solana' && a.cls === 'cash') as BasketAsset;
// Bars that reach the present at this hour, and the lending report's hour.
const NOW = Date.parse('2026-10-06T06:30:00.000Z');

const reads = (over: Partial<LookupReads> = {}): LookupReads => ({
  observations: vi.fn(async () => observations),
  bars: vi.fn(async () => ({ rows: bars, before: null })),
  poolReading: vi.fn(async () => pools.reading),
  poolBars: vi.fn(async () => pools.poolBars),
  lending: vi.fn(async () => lending),
  sheet: vi.fn(async () => null),
  ...over,
});
const make = (r: LookupReads, over: Parameters<typeof createAssetLookups>[0] = {}) =>
  createAssetLookups({ reads: r, twins: async () => [], now: () => NOW, ...over });
const query = { db, chain: 'solana' as const, asset };

describe('the asset lookups', () => {
  it('answers each part with ids of its family and labels that hold no digit', async () => {
    const lookups = make(reads());
    const answers: LookupAnswer[] = [
      await lookups.profile(query),
      await lookups.priceHistory({ ...query, window: '7d' }),
      await lookups.pools(query),
      await lookups.lending(query),
    ];
    const ids = answers.flatMap((a) => [...a.facts, ...a.missing].map((f) => f.id));
    expect(ids).toContain('profile:solana:nvdax:supply_total');
    expect(ids).toContain('bars:solana:nvdax:7d:close');
    expect(ids).toContain('bars:solana:nvdax:7d:change');
    expect(ids).toContain('pool:solana:nvdax:1:tvl');
    expect(ids).toContain('pool:solana:nvdax:5:share');
    expect(ids).not.toContain('pool:solana:nvdax:6:tvl');
    expect(ids).toContain(`lend:solana:nvdax:${lending[0]?.account}:supply`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const answer of answers) {
      expect(answer.modelledOn).toBeNull();
      expect(answer.unread).toBeUndefined();
      for (const item of [...answer.facts, ...answer.missing]) {
        expect([item.id, /\p{N}/u.test(item.label)]).toEqual([item.id, false]);
        expect(item.assetId).toBe('solana:nvdax');
        // the relaxed intake hands the model every family as a measured figure of an asset
        expect(MEASURED.test(item.id)).toBe(true);
      }
    }
    const close = answers[1]?.facts.find((f) => f.id === 'bars:solana:nvdax:7d:close');
    expect(close).toMatchObject({ unit: 'USD', provenance: 'live' });
    // the stale pool reading says its age on every pool figure it gave
    expect(answers[2]?.facts.every((f) => f.id.endsWith(':volume') || f.staleAgeSec)).toBe(true);
  });

  it('keeps a read, and reads it once however many ask', async () => {
    const r = reads();
    const lookups = make(r);
    await Promise.all([lookups.profile(query), lookups.profile(query)]);
    await lookups.profile(query);
    expect(r.observations).toHaveBeenCalledTimes(1);
    // another window is another read
    await lookups.priceHistory({ ...query, window: '24h' });
    await lookups.priceHistory({ ...query, window: '7d' });
    await lookups.priceHistory({ ...query, window: '7d' });
    expect(r.bars).toHaveBeenCalledTimes(2);
  });

  it('answers "reading" past its wait, and the read fills the cache for the next ask', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = reads({
      observations: vi.fn(async () => {
        await gate;
        return observations;
      }),
    });
    const lookups = make(r, { waitMs: 20 });
    expect(await lookups.profile(query)).toEqual({
      facts: [],
      missing: [],
      modelledOn: null,
      unread: 'reading',
    });
    release();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = await lookups.profile({ ...query, waitMs: 20 });
    expect(after.unread).toBeUndefined();
    expect(after.facts.length).toBeGreaterThan(0);
    expect(r.observations).toHaveBeenCalledTimes(1);
  });

  it('answers "failed" when a read fails, and never throws', async () => {
    const lookups = make(
      reads({
        observations: async () => {
          throw new Error('connection reset');
        },
        bars: async () => {
          throw new Error('no answer');
        },
      }),
    );
    await expect(lookups.profile(query)).resolves.toMatchObject({ unread: 'failed', facts: [] });
    await expect(lookups.priceHistory({ ...query, window: '7d' })).resolves.toMatchObject({
      unread: 'failed',
    });
    const broken = make(reads(), {
      twins: async () => {
        throw new Error('twins');
      },
    });
    await expect(broken.lending(query)).resolves.toMatchObject({ unread: 'failed' });
    // a read with no answer is given up after its time limit
    const hung = make(reads({ lending: () => new Promise(() => {}) }), { readMs: 10, waitMs: 100 });
    await expect(hung.lending(query)).resolves.toMatchObject({ unread: 'failed' });
  });

  it("reads a test-network token's mainnet model, labelled sandbox with the model named", async () => {
    const r = reads();
    const devnet: BasketAsset = {
      ...asset,
      id: 'solana:nvdax-dev',
      symbol: 'NVDAd',
      address: 'DevNvdaMint1111111111111111111111111111111',
      provenance: 'sandbox',
    };
    const lookups = make(r, {
      twins: async (_db, assets, provenance) =>
        provenance === 'sandbox'
          ? assets.map((a) => ({ id: a.id, symbol: a.symbol, twinSymbol: 'NVDAx', twinMint: MINT }))
          : [],
    });
    const answer = await lookups.priceHistory({
      db,
      chain: 'solana',
      asset: devnet,
      provenance: 'sandbox',
      window: '24h',
    });
    expect(r.bars).toHaveBeenCalledWith(db, 'solana', MINT, expect.any(Date));
    expect(answer.modelledOn).toBe('NVDAx');
    expect(answer.facts.length).toBeGreaterThan(0);
    for (const fact of answer.facts) {
      expect(fact.id.startsWith('bars:solana:nvdax-dev:24h:')).toBe(true);
      expect(fact.provenance).toBe('sandbox');
      expect(fact.source).toContain(
        'mainnet NVDAx figures applied to the test-network token NVDAd',
      );
    }
  });

  it('labels every fact of a chain on the mock as mock', async () => {
    const answer = await make(reads()).profile({ ...query, provenance: 'mock' });
    expect(answer.facts.length).toBeGreaterThan(0);
    expect(answer.facts.every((f) => f.provenance === 'mock')).toBe(true);
  });

  it('a cash token answers no facts and reads nothing', async () => {
    const r = reads();
    const lookups = make(r);
    for (const answer of [
      await lookups.profile({ ...query, asset: cash }),
      await lookups.pools({ ...query, asset: cash }),
      await lookups.bearing({ ...query, asset: cash }),
    ])
      expect(answer).toEqual({ facts: [], missing: [], modelledOn: null });
    expect(r.observations).not.toHaveBeenCalled();
    expect(r.poolReading).not.toHaveBeenCalled();
  });

  it('reads an EVM token by its address in lower case', async () => {
    const r = reads();
    const evm = shelf.find((a) => a.chain === 'robinhood' && a.cls === 'stock') as BasketAsset;
    const checksummed = { ...evm, address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' };
    await make(r).profile({ db, chain: 'robinhood', asset: checksummed });
    expect(r.observations).toHaveBeenCalledWith(
      db,
      'robinhood',
      '0xabcdef0123456789abcdef0123456789abcdef01',
    );
  });

  it("Bearing's figures keep their ids; no sheet says so", async () => {
    const answer = await make(reads()).bearing(query);
    expect(answer.facts).toEqual([]);
    expect(answer.missing).toEqual([
      expect.objectContaining({ id: 'exit:solana:nvdax:worst', reason: 'not_collected' }),
    ]);
  });
});

describe('a looked-up figure is stated by reference under the resolver’s rules', () => {
  const resolverOf = async () => {
    const lookups = make(reads());
    const facts: LookupFact[] = [
      ...(await lookups.priceHistory({ ...query, window: '7d' })).facts,
      ...(await lookups.pools(query)).facts,
      ...(await lookups.lending(query)).facts,
    ];
    const sources = new Map<string, VaultAgentSource>(facts.map((f) => [f.id, f]));
    return figureResolver({
      enabled: true,
      sources,
      references: { missing: {}, staleAgeSec: {} },
      lowerBound: new Set(),
      language: 'en',
      sentences: (text) => text.match(/[^.!?]+[.!?]*\s*/gu) ?? [text],
      kindRequired: true,
      noComparison: true,
    });
  };
  const id = (part: string) => `{{fact:${part}}}`;

  it('serves each family called what it is', async () => {
    const resolver = await resolverOf();
    const account = lending[0]?.account;
    for (const sentence of [
      `The latest closing price was ${id('bars:solana:nvdax:7d:close')} this week.`,
      `The price change over the last week was ${id('bars:solana:nvdax:7d:change')}, first close to last.`,
      `There were ${id('bars:solana:nvdax:7d:swaps')} swaps on its pools.`,
      `Its largest pool holds ${id('pool:solana:nvdax:1:tvl')} in TVL.`,
      `In the market that takes it as collateral, ${id(`lend:solana:nvdax:${account}:withdrawable`)} is available to withdraw now.`,
      `Its quoted rate is ${id(`lend:solana:nvdax:${account}:supply`)} a year.`,
    ])
      expect([sentence, resolver.unbacked(sentence)]).toEqual([sentence, []]);
  });

  it('cuts a change called a return or a gain, and a figure without its kind', async () => {
    const resolver = await resolverOf();
    expect(
      resolver.unbacked(`The return over the last week was ${id('bars:solana:nvdax:7d:change')}.`),
    ).not.toEqual([]);
    expect(
      resolver.unbacked(`NVDAx gained ${id('bars:solana:nvdax:7d:change')} over the week.`),
    ).not.toEqual([]);
    expect(resolver.unbacked(`It stood at ${id('pool:solana:nvdax:1:share')}.`)).not.toEqual([]);
    expect(
      resolver.unbacked(
        `The change was ${id('bars:solana:nvdax:7d:change')}, more than ${id('bars:solana:nvdax:7d:volume')} in volume.`,
      ),
    ).not.toEqual([]);
  });
});
