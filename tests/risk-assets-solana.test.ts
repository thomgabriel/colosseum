import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  decodeMetaplexMetadata,
  decodeMint,
  METAPLEX_METADATA_PROGRAM,
  solanaIdentity,
} from '@colosseum/risk';
import { UniverseList, UniverseVerdicts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import {
  ASSETS_METHOD,
  categoryCall,
  isLaunchpadPlatform,
  isSelected,
  kindOfName,
  LEFT_OUT_FILE,
  LeftOut,
  MATCH_KEYS,
  MEME_CATEGORIES,
  PROTOCOL_CATEGORIES,
  ruleMatches,
  type SolanaReads,
  solanaList,
  VERDICTS_FILE,
} from '../scripts/risk/assets/solana-list';
import { repoInputs } from '../scripts/risk/assets/solana-repo';

// PLAN-ASSETS AS.2 (gate ASSET-UNIVERSE): the Solana asset universe. The reads one run was built from
// are frozen under fixtures/risk/assets/ (pnpm risk:freeze-assets-solana): Jupiter's verified list cut
// to id, symbol and tags, every candidate's mint and Metaplex accounts as base64, the lending import's
// reserves, the registry's pool counts, DefiLlama's names, the issuer pages' answers and the repository
// files the list reads. The test rebuilds the list from them with no network and holds the committed
// list to it, and checks the byte decoders on the real frozen accounts.

const LIST = 'scripts/risk/assets/solana.json';
const committed = () => JSON.parse(readFileSync(LIST, 'utf8'));
const verdicts = () => UniverseVerdicts.parse(JSON.parse(readFileSync(VERDICTS_FILE, 'utf8')));
const leftOut = () => LeftOut.parse(JSON.parse(readFileSync(LEFT_OUT_FILE, 'utf8')));
const fixtureOf = (list: { inputs: Record<string, string> }) => {
  const stamp = list.inputs.reads?.match(/solana-reads-(\d{8}T\d{4}Z)\.json/)?.[1];
  if (!stamp) throw new Error('the committed list names no reads file');
  const file = `fixtures/risk/assets/solana-reads-${stamp}.json.gz`;
  return JSON.parse(gunzipSync(readFileSync(file)).toString()) as SolanaReads;
};
const reads = fixtureOf(committed());
const bytes = (a: string) => {
  const acc = reads.mints[a]?.account;
  if (!acc) throw new Error(`no frozen account for ${a}`);
  return { owner: acc.owner, data: Uint8Array.from(Buffer.from(acc.data, 'base64')) };
};
const meta = (a: string) => {
  const acc = reads.metaplex[a]?.account;
  if (!acc) throw new Error(`no frozen metadata account for ${a}`);
  return { owner: acc.owner, data: Uint8Array.from(Buffer.from(acc.data, 'base64')) };
};

// real public mints, as their issuers name them
const PAXG = '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TESOURO = 'BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p';
const AMZNON = '14Tqdo8V1FhzKsE3W2pFsZCzYPQxxupXRcqw9jv6ondo';
const KUSDC = 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D';
/** BRS, the BRL stablecoin (scripts/lib.ts MINTS.BRS): never a row before gate G-NORA. */
const BRS = 'BRSxQRUaGswjLs7ewcH7uXj3r7SgmfKSSLLXyCKHZtUo';
/** PENGU, a memecoin the launch-shelf seed names: read, and no row. */
const PENGU = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';
/** jjupSOL: Jupiter tags it lst and deprecated. */
const JJUPSOL = 'BgYgFYq4A9a2o5S1QbWkmYVFBh7LBQL8YvugdhieFg38';
/** Kamino Lend's Main Market: an account no read of the list asks for. */
const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

describe('the byte decoders, on frozen mainnet accounts', () => {
  it('reads a Token-2022 mint with its extensions, authorities and own metadata (PAXG)', () => {
    const { owner, data } = bytes(PAXG);
    const m = decodeMint(owner, data);
    expect(m.program).toBe('token2022');
    expect(m.decimals).toBe(6);
    expect(m.extensions).toContain('permanentDelegate');
    expect(m.extensions).toContain('transferFeeConfig');
    expect(m.extensions).toContain('tokenMetadata');
    expect(m.unknownExtensions).toEqual([]);
    expect(m.permanentDelegate).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(m.tokenMetadata).toMatchObject({ mint: PAXG, symbol: 'PAXG', name: 'PAX Gold' });
    expect(m.metadataPointer?.address).toBe(PAXG);
  });

  it("reads an xStock: the issuer's shared mint authority, its metadata in the mint", () => {
    const m = decodeMint(bytes(NVDAX).owner, bytes(NVDAX).data);
    expect(m.mintAuthority).toBe('7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj');
    expect(m.decimals).toBe(8);
    expect(m.extensions).toEqual(
      expect.arrayContaining(['permanentDelegate', 'scaledUiAmountConfig', 'pausableConfig']),
    );
    expect(m.tokenMetadata).toMatchObject({ symbol: 'NVDAx', name: 'NVIDIA xStock' });
  });

  it('reads a classic SPL mint and its Metaplex metadata (USDC)', () => {
    const m = decodeMint(bytes(USDC).owner, bytes(USDC).data);
    expect(m).toMatchObject({
      program: 'spl',
      decimals: 6,
      extensions: [],
      tokenMetadata: undefined,
    });
    expect(m.mintAuthority).not.toBeNull();
    expect(m.permanentDelegate).toBeUndefined();
    const md = meta(USDC);
    expect(md.owner).toBe(METAPLEX_METADATA_PROGRAM);
    expect(decodeMetaplexMetadata(md.owner, md.data)).toMatchObject({ mint: USDC, symbol: 'USDC' });
  });

  it('takes the symbol from Metaplex where a Token-2022 mint points its metadata there (TESOURO)', () => {
    const m = decodeMint(bytes(TESOURO).owner, bytes(TESOURO).data);
    expect(m.extensions).toEqual(['interestBearingConfig', 'metadataPointer']);
    expect(m.tokenMetadata).toBeUndefined();
    expect(m.metadataPointer?.address).toBe(reads.metaplex[TESOURO]?.pda);
    const id = solanaIdentity({
      address: TESOURO,
      mint: bytes(TESOURO),
      slot: 1,
      at: '2026-10-11T00:00:00.000Z',
      metaplex: meta(TESOURO),
      listing: null,
      listingTags: [],
    });
    expect(id.read.symbolFrom).toBe('metaplex');
    expect(id.symbol).toBe('TESOURO');
    expect(id.authorities.freeze).toEqual({
      holder: null,
      reason: 'none',
      read: 'mint.freezeAuthority',
    });
  });

  it('falls back to the listing where the chain holds no metadata (kUSDC), and says so', () => {
    const id = solanaIdentity({
      address: KUSDC,
      mint: bytes(KUSDC),
      slot: 1,
      at: '2026-10-11T00:00:00.000Z',
      metaplex: null,
      listing: { symbol: 'kUSDC', name: null },
      listingTags: [],
    });
    expect(id).toMatchObject({ symbol: 'kUSDC', name: null, nameReason: 'no_metadata_on_chain' });
    expect(id.read.symbolFrom).toBe('listing');
    expect(id.authorities.permanentDelegate.read).toBe(
      'spl-token: the program has no permanent delegate',
    );
    expect(() =>
      solanaIdentity({
        ...{
          address: KUSDC,
          mint: bytes(KUSDC),
          slot: 1,
          at: '2026-10-11T00:00:00.000Z',
          metaplex: null,
          listing: null,
          listingTags: [],
        },
      }),
    ).toThrow('no symbol on chain and no listing');
  });

  it('refuses an account no token program owns, and a metadata account of another program', () => {
    const { data } = bytes(AMZNON);
    expect(() => decodeMint(METAPLEX_METADATA_PROGRAM, data)).toThrow('not a token program');
    expect(() => decodeMetaplexMetadata(bytes(AMZNON).owner, data)).toThrow(
      'not a metadata account',
    );
  });
});

describe('the committed list', () => {
  it('parses, and is the list its frozen reads and the reviewed verdicts give, key for key', () => {
    const file = committed();
    const list = UniverseList.parse(file);
    expect(list.chain).toBe('solana');
    expect(list.method).toBe(ASSETS_METHOD);
    expect(file).toEqual(JSON.parse(JSON.stringify(solanaList(reads, verdicts(), leftOut()).list)));
  });

  it('reads every row on chain at a recorded slot and gives each a source', () => {
    const list = UniverseList.parse(committed());
    for (const a of list.assets) {
      expect(a.read.height).toBe(reads.mints[a.address]?.slot);
      expect(a.sources.length).toBeGreaterThan(0);
      expect(a.provenance).toBe('live');
    }
  });

  it('keeps every tracked stock under its tracked id, listed, with its pools and oracle in its tracked row', () => {
    const list = UniverseList.parse(committed());
    const tracked = list.assets.filter((a) => a.tracked);
    expect(tracked.map((a) => a.id).sort()).toEqual(
      reads.repo.tracked.rows.map((r) => r.id).sort(),
    );
    for (const a of tracked) {
      expect(a.status).toBe('listed');
      expect(a.listedIn).toContain('tracked_stock');
      expect([a.oracle, a.pools]).toEqual([null, null]);
    }
  });

  it('carries no price, TVL, supply, holder or yield figure', () => {
    const forbidden =
      /^(?:usdPrice|price|priceUsd|tvl|tvlUsd|liquidity|mcap|fdv|circSupply|totalSupply|supply|holderCount|apy|apr|yield)$/i;
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    walk(committed().assets);
    walk(reads.jupiter);
    expect([...keys].filter((k) => forbidden.test(k))).toEqual([]);
  });

  it('names a row for every verdict of the table, and leaves BRS and the memecoins out', () => {
    const list = UniverseList.parse(committed());
    const rows = new Set(list.assets.map((a) => a.address));
    expect(verdicts().verdicts.filter((v) => !rows.has(v.address))).toEqual([]);
    expect(list.assets.some((a) => a.address === BRS || /^BRS/i.test(a.symbol))).toBe(false);
    expect(rows.has(JJUPSOL)).toBe(false);
    const memes = new Set(reads.jupiter.filter((t) => t.tags.includes('meme')).map((t) => t.id));
    expect(list.assets.filter((a) => memes.has(a.address)).map((a) => a.symbol)).toEqual([]);
  });

  it('classifies the stock issuers by rules, not typed rows', () => {
    const v = verdicts();
    const list = UniverseList.parse(committed());
    const byRule = (r: string) => list.assets.filter((a) => a.decidedBy.includes(`rule:${r}`));
    expect(byRule('xstocks').length).toBeGreaterThan(1000);
    expect(byRule('ondo-global-markets').length).toBeGreaterThan(400);
    const stockVerdicts = v.verdicts.filter((x) => x.category === 'tokenized_stock');
    expect(stockVerdicts.length).toBeLessThan(10);
  });
});

describe("the frozen copy of the repository's files", () => {
  it('is what the files say now, so a change to any of them asks for the list to be built again', () => {
    // leg-types.ts, the structurer's registry, the tracked list, the deploy record, the Scope table, the
    // shelf fixture, the research note's addresses, the launch-shelf seed and the stocks' attributes
    expect(JSON.parse(JSON.stringify(repoInputs()))).toEqual(reads.repo);
  });
});

describe('the rules and the name method', () => {
  const facts = {
    tags: new Set(['xstocks', 'verified']),
    mintAuthority: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj',
    freezeAuthority: null,
    permanentDelegate: null,
    program: 'token2022',
    name: 'NVIDIA xStock',
    nameKind: 'stock' as const,
    listedIn: [],
  };
  const xstocks = () => {
    const r = verdicts().rules.find((x) => x.name === 'xstocks');
    if (!r) throw new Error('no xstocks rule');
    return r;
  };

  it('take a token by the keys read on chain, not by the tag alone', () => {
    expect(ruleMatches(xstocks().match, facts)).toBe(true);
    expect(ruleMatches(xstocks().match, { ...facts, mintAuthority: KAMINO_MAIN_MARKET })).toBe(
      false,
    );
    const backpack = verdicts().rules.find((x) => x.name === 'backpack-securities');
    expect(Object.keys(backpack?.match ?? {})).toEqual(
      expect.arrayContaining(['freezeAuthority', 'permanentDelegate']),
    );
  });

  it('do not sweep in a token Jupiter tags xstocks whose mint authority is another', () => {
    const tagged: SolanaReads = {
      ...reads,
      jupiter: reads.jupiter.map((t) =>
        t.id === PENGU ? { ...t, tags: [...t.tags, 'xstocks'] } : t,
      ),
    };
    const list = solanaList(tagged, verdicts(), leftOut()).list;
    expect(list.assets.some((a) => a.address === PENGU)).toBe(false);
    expect(list.counts.rows).toBe(committed().counts.rows);
  });

  it("read a fund's kind from its name, the tracked list's class table first", () => {
    const cases: Array<[string, string, string]> = [
      ['ProShares UltraPro Short QQQ xStock', 'SQQQ', 'leveraged_etf'],
      ['Direxion Daily 20 Year Treasury Bull 3X ETF xStock', 'TMF', 'leveraged_etf'],
      ['AB Ultra Short Income ETF (Ondo Tokenized)', 'YEAR', 'bond_fund'],
      ['iShares 0-3 Month Treasury Bond ETF xStock', 'SGOV', 'treasury_fund'],
      ['SPDR Bloomberg 1-3 Month T-Bill ETF (Ondo Tokenized)', 'BIL', 'treasury_fund'],
      ['iShares Gold Trust (Ondo Tokenized)', 'IAU', 'gold_fund'],
      ['VanEck Gold Miners xStock', 'GDX', 'equity_etf'],
      ['United States Oil Fund xStock', 'USO', 'commodity_fund'],
      ['SPDR S&P Oil & Gas Exploration & Production ETF xStock', 'XOP', 'equity_etf'],
      ['iShares Bitcoin Trust (Ondo Tokenized)', 'IBIT', 'crypto_fund'],
      ['Vanguard xStock', 'VTI', 'equity_etf'],
      ['Russell 2000 xStock', 'IWM', 'equity_etf'],
      ['Digital Realty Trust xStock', 'DLR', 'stock'],
      ['Invesco xStock', 'IVZ', 'stock'],
      ['MSCI xStock', 'MSCI', 'stock'],
      ['Webull Corporation Class A Ordinary Shares - Backpack Securities', 'BULL', 'stock'],
    ];
    expect(cases.map(([name, ticker]) => kindOfName(name, ticker))).toEqual(cases.map((c) => c[2]));
  });

  it('hold out every unscreened fund of a stock issuer, with no leg type borrowed', () => {
    const list = UniverseList.parse(committed());
    const issuerRows = list.assets.filter((a) =>
      a.decidedBy.some((d) => /^rule:(?:xstocks|ondo-global-markets|backpack-securities)$/.test(d)),
    );
    const funds = issuerRows.filter((a) => a.category === 'treasury_fund_open');
    expect(funds.map((a) => a.symbol)).toEqual(
      expect.arrayContaining(['SGOVx', 'SGOVon', 'BILon']),
    );
    for (const a of funds)
      expect([a.status, a.legTypes, a.legTypesReason]).toEqual([
        'held_out',
        null,
        'not_screened_on_solana',
      ]);
    for (const s of ['SQQQx', 'TQQQon', 'IBITon', 'HYGon'])
      expect(list.assets.find((a) => a.symbol === s)?.status).toBe('held_out');
  });

  it('leave out a token whose rules set only some verdict fields, and say so', () => {
    const v = verdicts();
    const partial = UniverseVerdicts.parse({
      ...v,
      rules: [
        ...v.rules,
        {
          name: 'partial',
          match: { nameEndsWith: 'Penguins' },
          fields: { status: 'excluded', statusReason: 'a test rule that sets only the status' },
          sources: [{ url: 'https://example.org/test', title: 'a test', readOn: '2026-10-11' }],
        },
      ],
    });
    // PENGU is a meme by CoinGecko and would leave before its rules are read: the test reads it unnamed there
    const { [PENGU]: _pengu, ...byMint } = reads.coingecko.byMint;
    const unnamed = { ...reads, coingecko: { ...reads.coingecko, byMint } };
    const list = solanaList(unnamed, partial, leftOut()).list;
    expect(list.assets.some((a) => a.address === PENGU)).toBe(false);
    expect(list.stated.rules).toContain('PENGU: category');
  });
});

describe('the crypto selection', () => {
  it('reviews every token it picks: a row, or left out with the reason and its source', () => {
    const list = UniverseList.parse(committed());
    expect(list.stated.crypto).not.toMatch(/not_reviewed \(\d/);
    const rows = new Set(list.assets.map((a) => a.address));
    const left = leftOut().tokens;
    expect(left.filter((t) => rows.has(t.address))).toEqual([]);
    const picked = new Set(reads.jupiter.filter(isSelected).map((t) => t.id));
    expect(left.filter((t) => !picked.has(t.address))).toEqual([]);
    expect(left.filter((t) => t.reason === 'memecoin').length).toBeGreaterThan(0);
  });

  it("names each new crypto row's mint on CoinGecko's list, as the reads hold it", () => {
    const list = UniverseList.parse(committed());
    const cg = list.assets.filter((a) =>
      a.sources.some((s) => s.url.startsWith('https://www.coingecko.com/en/coins/')),
    );
    // 68 on 2026-10-12, after the category rule took out the tokens no protocol category holds
    expect(cg.length).toBeGreaterThan(60);
    for (const a of cg) {
      const id = a.sources
        .find((s) => s.url.startsWith('https://www.coingecko.com/en/coins/'))
        ?.url.split('/')
        .pop();
      expect(reads.coingecko.byMint[a.address]?.id).toBe(id);
    }
    const jlp = list.assets.find((a) => a.symbol === 'JLP');
    expect([jlp?.category, jlp?.status, jlp?.statusReason]).toEqual([
      'other',
      'held_out',
      'a fungible share of a perps pool: no class takes it yet',
    ]);
    expect(list.assets.find((a) => a.address === USDC)?.id).toBe('solana:usdc');
  });

  it('keeps every id of the list committed before the run with its address', () => {
    const list = UniverseList.parse(committed());
    const byAddress = new Map(list.assets.map((a) => [a.address, a.id]));
    const moved = Object.entries(reads.previousIds.byAddress)
      .filter(([a, id]) => byAddress.has(a) && byAddress.get(a) !== id)
      .map(([a, id]) => `${id} -> ${byAddress.get(a)}`);
    expect(moved).toEqual([]);
    // the four ids the crypto additions had moved to suffixed ones (review of 9aa2a8d7)
    for (const [id, address] of [
      ['solana:arx', 'Xscms1jQDud7fsxLTKibMVxSTSQz3JFeJ1HDshRkPwc'],
      ['solana:chex', 'Xso4JpBFSzQe6cpGR4yCqgi9x1dkC8BNyJ2gyMe2B5C'],
      ['solana:xsol', 'B5GgNAZQDN8vPrQ15jPrXmJxVtManHLqHogj9B9i4zSs'],
      ['solana:wbtc', '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'],
    ] as const)
      expect(list.assets.find((a) => a.id === id)?.address).toBe(address);
  });

  it("makes the meme and protocol calls from CoinGecko's frozen categories", () => {
    const list = UniverseList.parse(committed());
    const coinOf = (a: string) => reads.coingecko.byMint[a];
    for (const a of list.assets) {
      const cg = coinOf(a.address);
      if (cg) expect(categoryCall(reads.categories, cg).meme).toEqual([]);
    }
    const gov = list.assets.filter((a) => a.category === 'governance' && coinOf(a.address));
    expect(gov.length).toBeGreaterThan(30);
    for (const a of gov) {
      const call = categoryCall(
        reads.categories,
        coinOf(a.address) as { id: string; name: string },
      );
      const ownPage = a.sources.some((s) => !/coingecko\.com|jup\.ag/.test(s.url));
      expect(call.protocol.length > 0 || ownPage).toBe(true);
    }
    // a token CoinGecko files as a meme is not a row, whatever Jupiter tags it
    const memes = leftOut().tokens.filter((t) => t.reason === 'memecoin');
    expect(memes.length).toBeGreaterThan(0);
    for (const c of [...MEME_CATEGORIES, ...PROTOCOL_CATEGORIES])
      expect(reads.categories.categories[c]?.complete).toBe(true);
    // the review's cases: BELIEVE and MADE are in solana-meme-coins; PUMP is a meme and a DEX's, and
    // the meme call wins; bonkSOL is taken by the lst rule and is a meme
    for (const a of [
      'BLVxek8YMXUQhcKmMvrFTrzh5FXg8ec88Crp6otEaCMf',
      'EpXtn6xGoZ4Y45vRjiDUHSCGbBoJD5FaEqZbF98YswH1',
      'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
      'BonK1YhkXEGLZzwtcvRTip3gAL9nCeQD7ppZBLXhtTs',
    ])
      expect(list.assets.some((r) => r.address === a)).toBe(false);
    expect(list.stated.crypto).toContain('bonkSOL (bonk-staked-sol; lst)');
  });

  it('holds Launchpad to a launchpad platform its own token', () => {
    const names = ['Pons Launchpad', 'Meteora Launchpad'];
    expect(isLaunchpadPlatform('Pons', names)).toBe(true);
    expect(isLaunchpadPlatform('StarLaunch', names)).toBe(false);
    const cats = {
      ...reads.categories,
      categoryNames: names,
      categories: { launchpad: { members: ['pons', 'starlaunch'], pages: 1, complete: true } },
    };
    expect(categoryCall(cats, { id: 'pons', name: 'Pons' }).protocol).toEqual(['launchpad']);
    expect(categoryCall(cats, { id: 'starlaunch', name: 'StarLaunch' }).protocol).toEqual([]);
  });

  it('decides UST and LUNA as the review asked', () => {
    const list = UniverseList.parse(committed());
    const at = (a: string) => list.assets.find((r) => r.address === a)?.status;
    expect(at('9vMJfxuKxXBoEa7rM12mYLMwTacLMLDJqHozw96WQL8i')).toBe('excluded');
    expect(at('F6v4wfAdJB8D8p77bMXZgYt8TDKsYxLYxH5AFhUkYx9W')).toBe('held_out');
  });
});

describe('the builder refuses', () => {
  it('a verdict for an address no read saw as a mint', () => {
    const v = verdicts();
    const own = v.verdicts[0];
    if (!own) throw new Error('the table has no verdict');
    const bad = UniverseVerdicts.parse({
      ...v,
      verdicts: [...v.verdicts, { ...own, address: KAMINO_MAIN_MARKET, symbol: 'MARKET' }],
    });
    expect(() => solanaList(reads, bad, leftOut())).toThrow(
      `verdicts for addresses no read saw as a mint: MARKET ${KAMINO_MAIN_MARKET}`,
    );
  });

  it('a rule whose match has a key the builder does not read', () => {
    const v = verdicts();
    const rule = v.rules[0];
    if (!rule) throw new Error('the table has no rule');
    const bad = UniverseVerdicts.parse({
      ...v,
      rules: [{ ...rule, name: 'misspelt', match: { jupitertag: 'xstocks' } }, ...v.rules],
    });
    expect(() => solanaList(reads, bad, leftOut())).toThrow(
      `rule misspelt: match key jupitertag; the Solana builder reads ${MATCH_KEYS.join(', ')}`,
    );
  });
});
