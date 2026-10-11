import {
  type IdentityRead,
  type RowContext,
  universeList,
  universeRow,
  unreadVerdicts,
  verdictOf,
} from '@colosseum/risk';
import { UniverseVerdicts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ASSETS AS.2 and AS.3: a row is its identity read on chain, its context from the chain's own files
// and its verdict, rules first and the token's own verdict last (packages/risk/src/assets/universe.ts).
// The addresses are the real public mints of the tokens named; nothing here is a reading.

const STAMP = {
  source: 'a test',
  fetchedAt: '2026-10-10T12:00:00.000Z',
  method: 'assets-list-0.1',
  provenance: 'fixture' as const,
};
const SRC = (readOn: string) => [{ url: 'https://example.org/source', title: 'a source', readOn }];
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const PAXG = '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW';

const identity = (address: string, symbol: string): IdentityRead => ({
  address,
  symbol,
  name: symbol,
  nameReason: null,
  decimals: 8,
  standard: 'token2022',
  standardNote: null,
  extensions: { family: 'solana', names: ['permanentDelegate'] },
  extensionsReason: null,
  authorities: {
    mint: { holder: null, reason: 'none', read: 'mint.mintAuthority' },
    freeze: { holder: null, reason: 'none', read: 'mint.freezeAuthority' },
    permanentDelegate: { holder: null, reason: 'none', read: 'extension permanentDelegate' },
  },
  authoritiesReason: null,
  read: {
    method: 'getMultipleAccounts',
    at: STAMP.fetchedAt,
    height: 1,
    symbolFrom: 'token_metadata_extension',
  },
  listingTags: ['verified', 'xstocks'],
  issuerRegistry: null,
});
const context = (id: string, over: Partial<RowContext> = {}): RowContext => ({
  id,
  oracle: null,
  oracleReason: 'no_scope_entry',
  unverifiedOracles: [],
  listedIn: [],
  pools: { confirmed: 2, unconfirmed: 0, file: 'data/risk/registry.json' },
  poolsReason: null,
  tracked: null,
  attributes: null,
  ...over,
});

const verdicts = UniverseVerdicts.parse({
  chain: 'solana',
  reviewedOn: '2026-10-10',
  note: 'a test table',
  rules: [
    {
      name: 'xstocks',
      match: { jupiterTag: 'xstocks' },
      fields: {
        category: 'tokenized_stock',
        status: 'candidate',
        statusReason: 'outside the 80% cut',
        verdictSource: null,
        issuer: 'Backed Finance',
        issuerReason: null,
        issuerKind: 'tokenization_issuer',
        currency: null,
        legTypes: null,
        legTypesReason: null,
        yieldMechanism: 'none',
        yieldMechanismReason: null,
        access: 'front_end_geo_blocked',
        accessReason: null,
        mintRedeem: null,
        mintRedeemReason: 'not_read',
        unverified: ['the issuer of every token the tag names'],
      },
      sources: SRC('2026-10-09'),
    },
  ],
  verdicts: [
    {
      address: PAXG,
      symbol: 'PAXG',
      category: 'tokenized_gold',
      status: 'candidate',
      statusReason: 'gate GOLD-PAXG',
      verdictSource: null,
      issuer: 'Paxos',
      issuerReason: null,
      issuerKind: 'stablecoin_issuer',
      underlying: 'PAXG',
      underlyingReason: null,
      currency: null,
      legTypes: null,
      legTypesReason: null,
      yieldMechanism: 'none',
      yieldMechanismReason: null,
      access: 'open',
      accessReason: null,
      mintRedeem: null,
      mintRedeemReason: 'not_read',
      sources: SRC('2026-10-10'),
      unverified: [],
    },
  ],
});

describe('the verdict of a token', () => {
  it('takes what was derived, then each rule, then its own verdict, and keeps every source', () => {
    const v = verdictOf(verdicts, {
      identity: identity(NVDAX, 'NVDAx'),
      rules: ['xstocks'],
      derived: { underlying: 'NVDA', underlyingReason: null, sources: SRC('2026-10-10') },
    });
    expect(v.category).toBe('tokenized_stock');
    expect(v.underlying).toBe('NVDA');
    expect(v.decidedBy).toEqual(['derived', 'rule:xstocks']);
    expect(v.sources.map((s) => s.readOn)).toEqual(['2026-10-10', '2026-10-09']);
  });

  it("lets a token's own verdict win over a rule", () => {
    const v = verdictOf(verdicts, { identity: identity(PAXG, 'PAXG'), rules: ['xstocks'] });
    expect(v.category).toBe('tokenized_gold');
    expect(v.decidedBy).toEqual(['rule:xstocks', 'verdict']);
  });

  it('applies the rules it matches in the table order, each once, whatever order they are named in', () => {
    const two = UniverseVerdicts.parse({
      ...verdicts,
      rules: [
        verdicts.rules[0],
        {
          name: 'held',
          match: { jupiterTag: 'prestocks' },
          fields: { status: 'held_out' },
          sources: SRC('2026-10-10'),
        },
      ],
    });
    const derived = { underlying: 'NVDA', underlyingReason: null };
    for (const rules of [
      ['xstocks', 'held'],
      ['held', 'xstocks'],
      ['held', 'xstocks', 'held'],
    ]) {
      const v = verdictOf(two, { identity: identity(NVDAX, 'NVDAx'), rules, derived });
      expect(v.status).toBe('held_out');
      expect(v.decidedBy).toEqual(['derived', 'rule:xstocks', 'rule:held']);
    }
  });

  it('names the token and the fields no verdict sets', () => {
    expect(() =>
      verdictOf(verdicts, { identity: identity(NVDAX, 'NVDAx'), rules: ['xstocks'] }),
    ).toThrow(
      'NVDAx Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: no verdict sets underlying, underlyingReason',
    );
    expect(() =>
      verdictOf(verdicts, { identity: identity(NVDAX, 'NVDAx'), rules: ['lst'] }),
    ).toThrow('rule lst is not in the table');
  });

  it('refuses a verdict whose symbol is not what the chain answers', () => {
    expect(() => verdictOf(verdicts, { identity: identity(PAXG, 'XAUT'), rules: [] })).toThrow(
      'the verdict names PAXG, the chain answers XAUT',
    );
  });

  it('finds the verdicts of addresses the reads never saw', () => {
    expect(unreadVerdicts(verdicts, [NVDAX]).map((v) => v.symbol)).toEqual(['PAXG']);
    expect(unreadVerdicts(verdicts, [NVDAX, PAXG])).toEqual([]);
  });
});

describe('a row and a list', () => {
  it('takes its class from its category, validates, and sorts and counts the list', () => {
    const nvdax = universeRow(
      'solana',
      verdicts,
      {
        identity: identity(NVDAX, 'NVDAx'),
        context: context('solana:nvdax'),
        rules: ['xstocks'],
        derived: { underlying: 'NVDA', underlyingReason: null },
      },
      STAMP,
    );
    const paxg = universeRow(
      'solana',
      verdicts,
      { identity: identity(PAXG, 'PAXG'), context: context('solana:paxg'), rules: [] },
      STAMP,
    );
    expect(nvdax.cls).toBe('stock');
    expect(nvdax.decidedBy).toEqual(['derived', 'rule:xstocks']);
    expect(paxg.cls).toBe('gold');
    const list = universeList({
      chain: 'solana',
      rows: [nvdax, paxg],
      reads: [
        {
          name: 'jupiter',
          what: 'GET',
          at: STAMP.fetchedAt,
          calls: 1,
          durationMs: 5,
          rows: 2,
          errors: 0,
        },
      ],
      inputs: { verdicts: 'scripts/risk/assets/solana.verdicts.json' },
      stated: { scope: 'a test' },
      stamp: STAMP,
    });
    expect(list.assets.map((a) => a.symbol)).toEqual(['PAXG', 'NVDAx']);
    expect(list.counts.byClass).toEqual({ gold: 1, stock: 1 });
    expect(list.counts.nulls.oracle).toEqual({ no_scope_entry: 2 });
  });

  it('refuses a row the schema refuses, saying which token and why', () => {
    expect(() =>
      universeRow(
        'solana',
        verdicts,
        {
          identity: identity(PAXG, 'PAXG'),
          context: context('solana:paxg', { listedIn: ['deploy_record'] }),
          rules: [],
        },
        STAMP,
      ),
    ).toThrow(
      `PAXG ${PAXG}: listedIn: a listed row says where it is listed, and no other row does`,
    );
  });
});
