import {
  CATEGORY_CLASS,
  UniverseAsset,
  UniverseCategory,
  UniverseLegType,
  UniverseList,
  UniverseVerdicts,
  universeCounts,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { LegType } from '../packages/engine/src/personal/leg-types';

// PLAN-ASSETS ASSET-1: the row of the asset universe and the list of one chain
// (packages/schemas/src/asset-universe.ts). The addresses are the real public ones of the tokens named;
// no row here is a reading of anything.

const STAMP = {
  source: 'a test row',
  fetchedAt: '2026-10-10T12:00:00.000Z',
  method: 'assets-list-0.1',
  provenance: 'fixture' as const,
};
const SRC = [{ url: 'https://paxos.com/paxgold/', title: 'Paxos Gold', readOn: '2026-10-10' }];
const none = (read: string) => ({ holder: null, reason: 'none', read });

/** PAXG on Solana, a candidate gold row. */
const paxg = () => ({
  id: 'solana:paxg',
  chain: 'solana',
  address: '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW',
  symbol: 'PAXG',
  name: 'Paxos Gold',
  nameReason: null,
  decimals: 6,
  standard: 'token2022',
  standardNote: null,
  extensions: {
    family: 'solana',
    names: ['permanentDelegate', 'transferFeeConfig', 'metadataPointer', 'tokenMetadata'],
  },
  extensionsReason: null,
  authorities: {
    mint: {
      holder: 'H1111111111111111111111111111111111111111',
      reason: null,
      read: 'mint.mintAuthority',
    },
    freeze: none('mint.freezeAuthority'),
    permanentDelegate: {
      holder: 'H1111111111111111111111111111111111111111',
      reason: null,
      read: 'extension permanentDelegate',
    },
  },
  authoritiesReason: null,
  read: {
    method: 'getMultipleAccounts',
    at: '2026-10-10T12:00:00.000Z',
    height: 370000000,
    symbolFrom: 'token_metadata_extension',
  },
  listingTags: ['verified'],
  issuerRegistry: null,
  category: 'tokenized_gold',
  status: 'candidate',
  statusReason: 'gate GOLD-PAXG names it the product gold; not on a deploy record',
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
  sources: SRC,
  unverified: [],
  cls: 'gold',
  clsReason: null,
  oracle: null,
  oracleReason: 'not_read',
  unverifiedOracles: [],
  listedIn: [],
  pools: { confirmed: 3, unconfirmed: 0, file: 'data/risk/registry.json' },
  poolsReason: null,
  tracked: null,
  attributes: null,
  ...STAMP,
});

/** NVDA on Robinhood Chain, a tracked stock: its oracle and pools are in its tracked row. */
const nvda = () => ({
  ...paxg(),
  id: 'robinhood:nvda',
  chain: 'robinhood',
  address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  symbol: 'NVDA',
  name: 'NVIDIA',
  decimals: 18,
  standard: 'erc20',
  extensions: {
    family: 'evm',
    proxy: { value: true, reason: null, read: 'eip1967 implementation slot' },
    implementation: '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15',
    pausable: { value: null, reason: 'source_not_verified', read: 'bytecode selectors' },
    blacklist: { value: false, reason: null, read: 'bytecode selectors' },
  },
  authorities: {
    owner: { holder: '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15', reason: null, read: 'owner()' },
    admin: { holder: null, reason: 'no_admin_function', read: 'eip1967 admin slot' },
  },
  read: {
    method: 'multicall3',
    at: '2026-10-10T12:00:00.000Z',
    height: 81164628,
    symbolFrom: 'erc20',
  },
  listingTags: [],
  issuerRegistry: {
    symbol: 'NVDA',
    name: 'NVIDIA',
    decimals: 18,
    status: 'active',
    isin: null,
    multiplier: '1',
  },
  category: 'tokenized_stock',
  status: 'listed',
  statusReason: 'tracked stock (gate UNIVERSE)',
  issuer: 'Robinhood',
  issuerKind: 'broker',
  underlying: 'NVDA',
  cls: 'stock',
  oracle: null,
  oracleReason: 'in_tracked_row',
  listedIn: ['tracked_stock'],
  pools: null,
  poolsReason: 'in_tracked_row',
  tracked: { list: 'scripts/risk/universe/robinhood.json', id: 'robinhood:nvda' },
  attributes: { file: 'content/stocks/robinhood.json', symbol: 'NVDA' },
});

/** USDY on Solana: dollar yield with its leg type. */
const usdy = () => ({
  ...paxg(),
  id: 'solana:usdy',
  address: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6',
  symbol: 'USDY',
  name: 'Ondo US Dollar Yield',
  standard: 'spl',
  extensions: { family: 'solana', names: [] },
  category: 'treasury_fund_open',
  status: 'candidate',
  statusReason: 'research verdict add',
  verdictSource: 'docs/vault/research/yield-shelf/solana.md, section 3, USDY',
  issuer: 'Ondo',
  issuerKind: 'tokenization_issuer',
  underlying: 'USDY',
  cls: 'dollar_yield',
  legTypes: [
    { type: 'rate', source: 'docs/vault/research/yield-shelf/solana.md', readOn: '2026-10-06' },
  ],
  yieldMechanism: 'accruing_price',
});

const issues = (row: unknown) =>
  UniverseAsset.safeParse(row).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

describe('UniverseAsset', () => {
  it('takes a candidate, a tracked stock and a dollar-yield row', () => {
    expect(issues(paxg())).toEqual([]);
    expect(issues(nvda())).toEqual([]);
    expect(issues(usdy())).toEqual([]);
  });

  it('maps every category to a class or to none, and a row takes its category class', () => {
    for (const c of UniverseCategory.options) expect(CATEGORY_CLASS).toHaveProperty(c);
    expect(Object.keys(CATEGORY_CLASS).sort()).toEqual([...UniverseCategory.options].sort());
    expect(issues({ ...paxg(), cls: 'commodity' })).toEqual([
      'cls: the class of tokenized_gold is gold',
    ]);
    const lp = {
      ...paxg(),
      category: 'lp_share',
      cls: null,
      clsReason: 'the vault cannot hold a pool share',
    };
    expect(issues(lp)).toEqual([]);
    expect(issues({ ...lp, clsReason: null })).toContain(
      'clsReason: cls or the reason it is null, never both and never neither',
    );
  });

  it("keeps the engine's four leg types", () => {
    expect([...UniverseLegType.options].sort()).toEqual([...LegType.options].sort());
  });

  it('holds a null to its reason, both ways', () => {
    expect(issues({ ...paxg(), mintRedeemReason: null })).toEqual([
      'mintRedeemReason: mintRedeem or the reason it is null, never both and never neither',
    ]);
    expect(issues({ ...paxg(), name: 'Paxos Gold', nameReason: 'not_read' })).toEqual([
      'nameReason: name or the reason it is null, never both and never neither',
    ]);
    const auth = paxg().authorities;
    expect(
      issues({
        ...paxg(),
        authorities: { ...auth, freeze: { holder: null, reason: null, read: 'x' } },
      }),
    ).toEqual(['authorities.freeze.reason: a holder or the reason there is none']);
  });

  it('gives leg types to dollar yield only, and asks a reason where none was read', () => {
    expect(issues({ ...usdy(), legTypes: null })).toEqual([
      'legTypesReason: a dollar-yield row has its leg types or the reason there are none',
    ]);
    expect(issues({ ...usdy(), legTypes: null, legTypesReason: 'no_reading' })).toEqual([]);
    expect(issues({ ...paxg(), legTypes: usdy().legTypes })).toEqual([
      'legTypes: only a dollar-yield row has leg types',
    ]);
  });

  it('reads the authorities and extensions of the chain the row is on', () => {
    const { permanentDelegate: _, ...two } = paxg().authorities;
    expect(issues({ ...paxg(), authorities: two })).toEqual([
      'authorities.permanentDelegate: the permanentDelegate authority is read',
    ]);
    expect(issues({ ...paxg(), extensions: nvda().extensions })).toEqual([
      "extensions: the extensions are those of the asset's chain",
    ]);
    expect(issues({ ...paxg(), address: nvda().address })).toEqual([
      "address: the address is in the form of the asset's chain",
    ]);
    expect(issues({ ...paxg(), id: 'robinhood:paxg' })).toEqual([
      "id: the id starts with the asset's chain",
    ]);
  });

  it('points a tracked stock at its tracked row and copies none of it', () => {
    expect(issues({ ...nvda(), poolsReason: 'not_read' })).toEqual([
      "poolsReason: a tracked stock's pools are read in its tracked row",
    ]);
    expect(issues({ ...nvda(), tracked: { list: 'x', id: 'robinhood:spy' } })).toEqual([
      'tracked.id: a tracked row keeps its tracked id',
    ]);
  });

  it('says where a listed row is listed, and only a listed one', () => {
    expect(issues({ ...nvda(), listedIn: [] })).toEqual([
      'listedIn: a listed row says where it is listed, and no other row does',
    ]);
    expect(issues({ ...paxg(), listedIn: ['deploy_record'] })).toEqual([
      'listedIn: a listed row says where it is listed, and no other row does',
    ]);
  });

  it('names the currency of a stablecoin of another currency, and never USD', () => {
    const eurc = { ...paxg(), category: 'stablecoin_other', cls: 'cash' };
    expect(issues(eurc)).toEqual(['currency: a stablecoin of another currency names it']);
    expect(issues({ ...eurc, currency: 'EUR' })).toEqual([]);
    expect(issues({ ...eurc, currency: 'USD' })).toEqual(['currency: dollars carry no currency']);
  });

  it('refuses a source that is neither a URL nor a document of this repository', () => {
    expect(
      issues({ ...paxg(), sources: [{ url: 'a blog', title: 't', readOn: '2026-10-10' }] }),
    ).toHaveLength(1);
    expect(issues({ ...paxg(), sources: [] })).toHaveLength(1);
  });
});

describe('UniverseList', () => {
  const list = (assets: unknown[]) => ({
    chain: 'solana',
    ...STAMP,
    inputs: { jupiter: 'tokens/v2 tag verified' },
    reads: [
      {
        name: 'jupiter',
        what: 'GET lite-api.jup.ag',
        at: STAMP.fetchedAt,
        calls: 1,
        durationMs: 1,
        rows: 2,
        errors: 0,
      },
    ],
    counts: universeCounts(UniverseAsset.array().parse(assets)),
    stated: { scope: 'a test' },
    assets,
  });

  it('counts its rows by category, status, class and null reason', () => {
    const l = UniverseList.parse(list([paxg(), usdy()]));
    expect(l.counts).toEqual({
      rows: 2,
      byCategory: { tokenized_gold: 1, treasury_fund_open: 1 },
      byStatus: { candidate: 2 },
      byClass: { dollar_yield: 1, gold: 1 },
      nulls: {
        'authorities.freeze': { none: 2 },
        mintRedeem: { not_read: 2 },
        oracle: { not_read: 2 },
      },
    });
  });

  it('refuses counts that are not those of its rows, a second row for one address, and a row of another chain', () => {
    const l = list([paxg(), usdy()]);
    expect(UniverseList.safeParse({ ...l, counts: { ...l.counts, rows: 3 } }).success).toBe(false);
    const twice = list([paxg(), { ...paxg(), id: 'solana:paxg-2' }]);
    expect(UniverseList.safeParse(twice).error?.issues.map((i) => i.message)).toEqual([
      'one row per token address',
    ]);
    expect(UniverseList.safeParse({ ...list([nvda()]), chain: 'solana' }).success).toBe(false);
  });
});

describe('UniverseVerdicts', () => {
  const { id: _i, chain: _c, ...rest } = usdy();
  const verdict = {
    address: rest.address,
    symbol: rest.symbol,
    category: rest.category,
    status: rest.status,
    statusReason: rest.statusReason,
    verdictSource: rest.verdictSource,
    issuer: rest.issuer,
    issuerReason: null,
    issuerKind: rest.issuerKind,
    underlying: rest.underlying,
    underlyingReason: null,
    currency: null,
    legTypes: rest.legTypes,
    legTypesReason: null,
    yieldMechanism: rest.yieldMechanism,
    yieldMechanismReason: null,
    access: 'open',
    accessReason: null,
    mintRedeem: null,
    mintRedeemReason: 'not_read',
    sources: SRC,
    unverified: [],
  };
  const table = {
    chain: 'solana',
    reviewedOn: '2026-10-10',
    note: 'a test table',
    rules: [
      {
        name: 'xstocks',
        match: { jupiterTag: 'xstocks' },
        fields: { category: 'tokenized_stock' },
        sources: SRC,
      },
    ],
    verdicts: [verdict],
  };

  it('takes one verdict per address and one rule per name', () => {
    expect(UniverseVerdicts.safeParse(table).success).toBe(true);
    expect(UniverseVerdicts.safeParse({ ...table, verdicts: [verdict, verdict] }).success).toBe(
      false,
    );
    expect(
      UniverseVerdicts.safeParse({ ...table, rules: [...table.rules, ...table.rules] }).success,
    ).toBe(false);
  });

  it('holds a rule to the fields a verdict may set', () => {
    const bad = { ...table, rules: [{ ...table.rules[0], fields: { price: 1 } }] };
    expect(UniverseVerdicts.safeParse(bad).success).toBe(false);
  });
});
