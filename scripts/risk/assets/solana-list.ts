import {
  type RowContext,
  solanaIdentity,
  universeList,
  universeRow,
  unreadVerdicts,
} from '@colosseum/risk';
import {
  type AssetClass,
  IN_TRACKED_ROW,
  Provenance,
  type TrackedOracle,
  type UniverseAsset,
  type UniverseCategory,
  type UniverseList,
  type UniverseRead,
  UniverseVerdict,
  type UniverseVerdicts,
} from '@colosseum/schemas';
import { z } from 'zod';
import { CLASS_BY_UNDERLYING } from '../universe/list';

// The Solana asset universe from its reads (PLAN-ASSETS AS.2, gate ASSET-UNIVERSE). No I/O, no clock, no
// chain call: `solana.ts` makes the reads and saves them, and the test rebuilds the committed list from
// the same reads frozen under fixtures/risk/assets/. What is derived here, and how a rule's `match` is
// read, is said in the list's `stated` and in scripts/risk/assets/README.md.

export const ASSETS_METHOD = 'assets-list-0.1';
export const VERDICTS_FILE = 'scripts/risk/assets/solana.verdicts.json';
export const ISSUER_MINTS_FILE = 'scripts/risk/assets/solana.issuer-mints.json';
export const LEFT_OUT_FILE = 'scripts/risk/assets/solana.left-out.json';

/**
 * The selection of crypto tokens (Rodrigo, 2026-10-11): every token of Jupiter's verified list that is
 * tagged `major` or `strict`, or that traded at least this much on Jupiter in the 24 hours before the
 * read. The volume picks a token and is not kept: the saved row holds `selected` only.
 */
export const SELECTION_FLOOR_USD = 50_000;

/**
 * CoinGecko's categories the calls are made from (Rodrigo's rule, 2026-10-11, the same for both chains).
 * A token in any meme category is not a row; a token is a protocol's (governance) only when CoinGecko
 * files it in one of the protocol categories, or its own project page names the protocol it governs.
 * "AI", "DeFi" or "launched on" an ecosystem alone admits nothing; Launchpad is the launchpad platforms'
 * own tokens, not the tokens launched on them.
 */
/**
 * CoinGecko's meme categories: every category whose name says Meme (an ecosystem's category aside) or
 * Themed, as CoinGecko's category list named them on 2026-10-11 (37).
 */
export const MEME_CATEGORIES = [
  '4chan-themed',
  'ai-meme-coins',
  'anime-themed-coins',
  'base-meme-coins',
  'bitcoin-meme',
  'cat-themed-coins',
  'celebrity-themed-coins',
  'chinese-meme',
  'christmas-themed',
  'commodities-meme',
  'country-themed-meme-coins',
  'desci-meme',
  'dog-themed-coins',
  'duck-themed-coins',
  'emoji-themed',
  'four-meme-tokenized-stocks-4stock',
  'frog-themed-coins',
  'gmci-meme-index',
  'ip-meme',
  'mascot-themed',
  'meme-token',
  'memecoin-nfts',
  'memorial-themed',
  'moltbook-and-openclaw-themed',
  'parody-meme-coins',
  'robinhood-chain-meme',
  'solana-meme-coins',
  'sticker-themed-coin',
  'stock-market-themed',
  'sui-meme',
  'tiktok-meme',
  'ton-meme-coins',
  'tron-meme',
  'wall-street-bets-themed-coins',
  'wojak-themed',
  'zodiac-themed',
  'zoo-themed',
] as const;
/**
 * The protocol categories (Rodrigo's list): DEX, Lending/Borrowing, Perpetuals, Derivatives, Oracle,
 * Bridge, Infrastructure, Liquid Staking, Yield Aggregator; Launchpad only for a launchpad platform's own
 * token (LAUNCHPAD_PLATFORMS).
 */
export const PROTOCOL_CATEGORIES = [
  'decentralized-exchange',
  'lending-borrowing',
  'decentralized-perpetuals',
  'decentralized-derivatives',
  'oracle',
  'bridge-governance-tokens',
  'infrastructure',
  'liquid-staking-governance-tokens',
  'yield-aggregator',
  'launchpad',
] as const;

/** Why a selected token is not a row, as the reviewed table solana.left-out.json says it. */
export const LeftOutReason = z.enum([
  'memecoin',
  'no_protocol_category_and_no_project_page',
  'project_not_confirmed',
  'no_source_names_the_mint',
  'stock_token_no_rule_takes',
  'not_of_a_class_of_the_product',
]);
export const LeftOut = z.strictObject({
  chain: z.literal('solana'),
  reviewedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().min(1),
  tokens: z.array(
    z.strictObject({
      address: z.string().min(32),
      symbol: z.string().min(1),
      reason: LeftOutReason,
      /** Where the reason was read: a CoinGecko coin page, the project's page, or the reads themselves. */
      source: z.string().min(1),
    }),
  ),
});
export type LeftOut = z.infer<typeof LeftOut>;

/** The name of a run's saved reads, from the time the run started: solana-reads-YYYYMMDDTHHMMZ.json. */
export const readsFileName = (startedAt: string) =>
  `solana-reads-${startedAt.slice(0, 16).replace(/[-:]/g, '')}Z.json`;

const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Jupiter's verified list, each row cut to what the list reads: no price, supply, holder or liquidity figure. */
export type JupiterRow = {
  id: string;
  symbol: string;
  tags: string[];
  /**
   * Jupiter's own 24 h volume at the read (stats24h buy plus sell, dollars), the figure the crypto
   * selection is decided on. Frozen with the reads so the test re-derives the pick; never on a row.
   */
  volume24hUsd: number;
};

/** The crypto selection (SELECTION_FLOOR_USD): tagged major or strict, or the floor's volume or more. */
export const isSelected = (t: JupiterRow) =>
  t.tags.some((g) => g === 'major' || g === 'strict') || t.volume24hUsd >= SELECTION_FLOOR_USD;
/** An account as getMultipleAccounts answered it, its bytes in base64; null where there is none. */
export type B64Account = { owner: string; data: string } | null;
export type ChainRead = { slot: number; at: string; account: B64Account };

/** A row of risk_lending_pools, cut to the tokens it names and the Scope chain its reserve prices with. */
export type LendingRow = {
  account: string;
  venue: string;
  marketName: string | null;
  role: string;
  mint: string;
  symbol: string;
  debtMint: string | null;
  debtSymbol: string | null;
  scope: { feed: string; price: number[]; twap: number[] } | null;
  fetchedAt: string;
  provenance: string;
};

/** An issuer page named in solana.issuer-mints.json, as the command found it. */
export type IssuerPage = {
  symbol: string;
  address: string;
  url: string;
  title: string;
  readOn: string;
  /** The page answered 200. */
  answered: boolean;
  /** Its HTML holds the address as written. A page that renders by script may not. */
  namesAddress: boolean;
};

/** Sources other than Jupiter's list that name an address. */
export type NamedBy =
  | 'lending_db'
  | 'research_note'
  | 'shelf_fixture'
  | 'launch_shelf_seed'
  | 'structurer_registry'
  | 'tracked_list'
  | 'scope_table'
  | 'issuer_page';

export type SolanaRepoInputs = {
  tracked: { file: string; rows: Array<{ id: string; symbol: string; address: string }> };
  shelf: {
    file: string;
    rows: Array<{ id: string; symbol: string; address: string; verdict: string; source: string }>;
  };
  deploy: { file: string; rows: Array<{ id: string; modelOf: string }> };
  structurer: { file: string; rows: Array<{ id: string; symbol: string; mint: string }> };
  scope: {
    file: string;
    source: string;
    fetchedAt: string;
    method: string;
    provenance: 'live' | 'fixture' | 'mock' | 'sandbox';
    priceAccount: string;
    rows: Array<{
      symbol: string;
      mint: string;
      priceIndex: number;
      twapIndex: number;
      source?: string;
      fetchedAt?: string;
      method?: string;
    }>;
  };
  content: { file: string; symbols: string[] };
  seed: { file: string; rows: Array<{ symbol: string; address: string; pyth: string | null }> };
  note: { file: string; addresses: string[] };
  legTypes: {
    file: string;
    rows: Record<string, { types: string[]; source: string; readAt: string }>;
  };
};

/** Everything the list is built from. `solana.ts` writes it; the fixture is the same object, gzipped. */
export type SolanaReads = {
  chain: 'solana';
  provenance: 'live';
  startedAt: string;
  finishedAt: string;
  inputs: Record<string, string>;
  reads: UniverseRead[];
  jupiter: JupiterRow[];
  /** Address to the sources other than Jupiter's list that name it. */
  named: Record<string, NamedBy[]>;
  /** Every candidate's mint account. */
  mints: Record<string, ChainRead>;
  /** The Metaplex metadata account of each mint that holds no metadata of its own, by mint. */
  metaplex: Record<string, ChainRead & { pda: string }>;
  lending: LendingRow[];
  registry: { file: string; fetchedAt: string; pools: Record<string, number> };
  llama: {
    stablecoins: Array<{ symbol: string; name: string; peg: string }>;
    protocols: Array<{ name: string; category: string }>;
  };
  issuerPages: IssuerPage[];
  /** CoinGecko's coin list, cut to the coin it names for each mint the list reads or selects. */
  coingecko: { what: string; byMint: Record<string, { id: string; symbol: string; name: string }> };
  /** The members of CoinGecko's meme and protocol categories (coingecko-categories.ts), by category id. */
  categories: CategoryMembers;
  /** The ids of the list committed before this run, by address: an id once committed stays with its address. */
  previousIds: { file: string; byAddress: Record<string, string> };
  repo: SolanaRepoInputs;
};

export type CategoryMembers = {
  what: string;
  at: string;
  calls: number;
  durationMs: number;
  errors: number;
  categories: Record<string, { members: string[]; pages: number; complete: boolean }>;
  /** The names of every CoinGecko category, sorted. */
  categoryNames?: string[];
};

/**
 * A launchpad platform's own token: CoinGecko keeps a category of the tokens launched on a platform
 * named after it ("Pons Launchpad"), and the platform's token is named as the platform. A token
 * launched on a pad is in the pad's category and is not the pad's own token.
 */
export function isLaunchpadPlatform(
  name: string | null | undefined,
  categoryNames: readonly string[],
) {
  const first = (name ?? '').toLowerCase().split(/[^a-z0-9]+/)[0] ?? '';
  return first !== '' && categoryNames.some((c) => c.toLowerCase() === `${first} launchpad`);
}

/**
 * A project's own page: an https page whose host is no listing, aggregator, directory or explorer, and not a
 * file of this repository. Only such a page admits a token as governance outside a protocol category.
 */
const NOT_OWN_HOSTS =
  /(^|\.)(coingecko\.com|jup\.ag|dexscreener\.com|defillama\.com|llama\.fi|chain\.link|vercel\.app|geckoterminal\.com|solscan\.io|solana\.fm|explorer\.solana\.com|birdeye\.so|github\.com)$/;
export function isOwnPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !NOT_OWN_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** What CoinGecko's categories say of a coin: a meme, a protocol's token, both, or neither. */
export function categoryCall(members: CategoryMembers, coin: { id: string; name?: string | null }) {
  const inAny = (ids: readonly string[]) =>
    ids.filter((c) => members.categories[c]?.members.includes(coin.id));
  const protocol = inAny(PROTOCOL_CATEGORIES).filter(
    (c) => c !== 'launchpad' || isLaunchpadPlatform(coin.name, members.categoryNames ?? []),
  );
  return { meme: inAny(MEME_CATEGORIES), protocol };
}

// ---------- how a rule's `match` is read ----------

/**
 * The keys a rule's `match` may hold; a token matches when every key holds. A key not here stops the
 * run, so a misspelt rule never matches nothing silently.
 *   jupiterTag         Jupiter's verified list carries the tag for the token
 *   minter             the mint authority read on chain is this address
 *   freezeAuthority    the freeze authority read on chain is this address
 *   permanentDelegate  the permanent delegate read on chain is this address
 *   program            the token program read on chain: spl or token2022
 *   nameEndsWith       the name the chain answers ends with this text
 *   nameKind           what the name method (`kindOfName`) reads in a stock issuer's token's name
 *   listedIn           the token is on today's shelf that way (structurer_registry, deploy_record,
 *                      tracked_stock), or `any` / `none`
 */
export const MATCH_KEYS = [
  'jupiterTag',
  'minter',
  'freezeAuthority',
  'permanentDelegate',
  'program',
  'nameEndsWith',
  'nameKind',
  'listedIn',
] as const;

export type Facts = {
  tags: ReadonlySet<string>;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  permanentDelegate: string | null;
  program: string;
  name: string | null;
  /** `none` for a token no stock issuer's rule takes. */
  nameKind: NameKind | 'none';
  listedIn: readonly string[];
};

/** Every key of every rule's match is one the builder reads. */
export function checkMatchKeys(verdicts: UniverseVerdicts) {
  for (const r of verdicts.rules)
    for (const k of Object.keys(r.match))
      if (!(MATCH_KEYS as readonly string[]).includes(k))
        throw new Error(
          `rule ${r.name}: match key ${k}; the Solana builder reads ${MATCH_KEYS.join(', ')}`,
        );
}

export function ruleMatches(match: Record<string, string>, f: Facts): boolean {
  for (const [key, want] of Object.entries(match)) {
    if (key === 'jupiterTag' && !f.tags.has(want)) return false;
    if (key === 'minter' && f.mintAuthority !== want) return false;
    if (key === 'freezeAuthority' && f.freezeAuthority !== want) return false;
    if (key === 'permanentDelegate' && f.permanentDelegate !== want) return false;
    if (key === 'program' && f.program !== want) return false;
    if (key === 'nameEndsWith' && !(f.name ?? '').endsWith(want)) return false;
    if (key === 'nameKind' && f.nameKind !== want) return false;
    if (key === 'listedIn') {
      const ok =
        want === 'any'
          ? f.listedIn.length > 0
          : want === 'none'
            ? f.listedIn.length === 0
            : f.listedIn.includes(want);
      if (!ok) return false;
    }
  }
  return true;
}

/** The Jupiter tags any rule asks for: a token carrying one is read on chain, then matched in full. */
const ruleTags = (verdicts: UniverseVerdicts) =>
  new Set(verdicts.rules.map((r) => r.match.jupiterTag).filter((t): t is string => !!t));

/** The addresses read on chain: Jupiter's rows a rule's tag or a verdict picks, and every other named address. */
export function candidates(
  jupiter: readonly JupiterRow[],
  named: Readonly<Record<string, readonly string[]>>,
  verdicts: UniverseVerdicts,
): string[] {
  const tags = ruleTags(verdicts);
  const own = new Set(verdicts.verdicts.map((v) => v.address));
  const out = new Set([...Object.keys(named), ...own]);
  for (const t of jupiter) if (t.tags.some((g) => tags.has(g))) out.add(t.id);
  return [...out].sort();
}

// ---------- what the builder derives, by a stated method ----------

/** The suffix each stock issuer adds to the ticker in its token's symbol, by the rule's name. */
export const SYMBOL_SUFFIX: Record<string, string> = {
  xstocks: 'x',
  'ondo-global-markets': 'on',
  'backpack-securities': '',
};

/**
 * What a stock issuer's token is, read from the name the chain answers (a stated method, `kindOfName`):
 *   stock           no fund word in the name
 *   equity_etf      a fund of shares
 *   gold_fund       a fund of gold (not of gold miners)
 *   commodity_fund  a fund of silver, platinum, palladium, oil, gas or a commodity index
 *   treasury_fund   a fund of Treasuries, T-bills or government bonds
 *   bond_fund       another fund of bonds, loans or income
 *   crypto_fund     a fund of bitcoin, ether or another crypto asset
 *   leveraged_etf   a fund that multiplies or inverts its index
 * The tracked list's class table (CLASS_BY_UNDERLYING, DU7) wins where it names the ticker.
 */
export type NameKind =
  | 'stock'
  | 'equity_etf'
  | 'gold_fund'
  | 'commodity_fund'
  | 'treasury_fund'
  | 'bond_fund'
  | 'crypto_fund'
  | 'leveraged_etf';

/** Sponsors that are fund brands only, never a listed company of the same name. */
const FUND_SPONSOR =
  /\b(?:iShares|SPDR|Vanguard|ProShares|Direxion|GraniteShares|Leverage Shares|Volatility Shares|abrdn|Global X|VanEck|Roundhill|KraneShares|Sprott|First Trust|Defiance|Breakwave)\b/;
const FUND_WORD = /\b(?:ETF|ETN|Fund|Index)\b/;
/** An index named in a fund's name; MSCI alone is MSCI Inc., the company. */
const INDEX_NAME = /\b(?:S&P 500|SP500|Russell \d+|EURO STOXX|MSCI (?!xStock\b)\w+)/;
const LEVERAGE =
  /\b\d+(?:\.\d+)?x\b|\b(?:Bull|Bear|UltraPro|Leveraged|Inverse)\b|\bProShares (?:Ultra|Short)\b/i;
const CRYPTO = /\b(?:Bitcoin|Ethereum|Ether|Solana|Crypto)\b/;
const NOT_THE_METAL =
  /\b(?:Miners?|Mining|Services|Exploration|Production|Producers|Shipping|Tanker)\b/;
const GOLD = /\bGold\b/;
const COMMODITY =
  /\b(?:Silver|Platinum|Palladium|Precious Metals|Oil|Brent|Natural Gas|Commodity|Cmd|Copper Index)\b/;
const TREASURY = /\b(?:Treasury|T-Bill|Government|TIPS)\b/;
const BOND =
  /\b(?:Bond|Income|Yield|CLO|Loan|Credit|Securitized|Aggregate|Corporate|Duration|Total Return)\b/;

const CATEGORY_OF_CLASS: Partial<Record<AssetClass, NameKind>> = {
  etf: 'equity_etf',
  gold: 'gold_fund',
  commodity: 'commodity_fund',
  dollar_yield: 'treasury_fund',
};

export function kindOfName(name: string, ticker: string): NameKind {
  const cls = CLASS_BY_UNDERLYING[ticker];
  const tabled = cls ? CATEGORY_OF_CLASS[cls] : undefined;
  if (tabled) return tabled;
  if (!(FUND_WORD.test(name) || FUND_SPONSOR.test(name) || INDEX_NAME.test(name))) return 'stock';
  if (LEVERAGE.test(name)) return 'leveraged_etf';
  if (CRYPTO.test(name)) return 'crypto_fund';
  if (GOLD.test(name) && !NOT_THE_METAL.test(name)) return 'gold_fund';
  if (COMMODITY.test(name) && !NOT_THE_METAL.test(name)) return 'commodity_fund';
  if (TREASURY.test(name)) return 'treasury_fund';
  if (BOND.test(name) && !/\bEquity\b/.test(name)) return 'bond_fund';
  return 'equity_etf';
}

export const CATEGORY_OF_KIND: Record<NameKind, UniverseCategory> = {
  stock: 'tokenized_stock',
  equity_etf: 'tokenized_etf',
  gold_fund: 'tokenized_gold',
  commodity_fund: 'tokenized_commodity',
  treasury_fund: 'treasury_fund_open',
  bond_fund: 'tokenized_etf',
  crypto_fund: 'tokenized_etf',
  leveraged_etf: 'tokenized_etf',
};

type VerdictFields = Omit<UniverseVerdict, 'address' | 'symbol'>;

/** The ticker in a stock issuer's symbol: the symbol less the issuer's suffix, or '' where the suffix is missing. */
function tickerOf(symbol: string, issuerRule: string): string {
  const suffix = SYMBOL_SUFFIX[issuerRule] ?? '';
  return suffix === '' ? symbol : symbol.endsWith(suffix) ? symbol.slice(0, -suffix.length) : '';
}

/** The fields the builder derives for a stock issuer's token: its underlying, category and leg types. */
function derivedFor(ticker: string, kind: NameKind): Partial<VerdictFields> {
  return {
    underlying: ticker.length > 0 ? ticker : null,
    underlyingReason: ticker.length > 0 ? null : 'symbol_without_the_issuer_suffix',
    category: CATEGORY_OF_KIND[kind],
    legTypes: null,
    legTypesReason: kind === 'treasury_fund' ? 'not_screened_on_solana' : null,
  };
}

// ---------- context from the chain's own files ----------

/** A symbol as an id slug: lower case, `+` as plus and `*` as star (the shelf's solana:usd-star), the rest dashes. */
const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/\+/g, '-plus-')
    .replace(/\*/g, '-star-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'token';

const fromB64 = (a: NonNullable<B64Account>) => ({
  owner: a.owner,
  data: Uint8Array.from(Buffer.from(a.data, 'base64')),
});

/** A lending row's provenance as it holds it; one that is not a provenance stops the run. */
function provenanceOf(r: LendingRow): Provenance {
  const p = Provenance.safeParse(r.provenance);
  if (!p.success) throw new Error(`lending row ${r.account}: provenance ${r.provenance}`);
  return p.data;
}

/** The verdict fields a row needs from some layer, and those the builder derives for a stock issuer's token. */
const REQUIRED_KEYS = Object.keys(UniverseVerdict.shape).filter(
  (k) => !['address', 'symbol', 'sources', 'unverified'].includes(k),
);
const DERIVED_KEYS = ['underlying', 'underlyingReason', 'category', 'legTypes', 'legTypesReason'];

function scopeOracle(
  reads: SolanaReads,
  mint: string,
): { oracle: TrackedOracle | null; reason: string | null } {
  const s = reads.repo.scope;
  const row = s.rows.find((r) => r.mint === mint);
  if (row)
    return {
      oracle: {
        kind: 'scope',
        ref: String(row.priceIndex),
        account: s.priceAccount,
        twapRef: String(row.twapIndex),
        description: null,
        decimals: null,
        prices: null,
        pricesReason: 'not_reported_by_the_scope_table',
        source: `${s.file}: ${row.source ?? s.source}`,
        fetchedAt: row.fetchedAt ?? s.fetchedAt,
        method: row.method ?? s.method,
        provenance: s.provenance,
      },
      reason: null,
    };
  // a Kamino reserve of the lending import that prices this token names its Scope chain
  const kamino = reads.lending.filter((l) => l.venue === 'kamino' && l.mint === mint);
  if (kamino.length === 0) return { oracle: null, reason: 'scope_not_read' };
  const reserves = kamino.filter((l) => l.scope);
  if (reserves.length === 0) return { oracle: null, reason: 'no_scope_entry' };
  const chains = new Set(
    reserves.map((l) => JSON.stringify([l.scope?.feed, l.scope?.price, l.scope?.twap])),
  );
  if (chains.size > 1)
    return { oracle: null, reason: 'kamino_reserves_name_different_scope_chains' };
  const r = reserves[0] as LendingRow & { scope: NonNullable<LendingRow['scope']> };
  if (r.scope.price.length !== 1) return { oracle: null, reason: 'scope_chain_of_several_entries' };
  const twap = r.scope.twap.length === 1 ? r.scope.twap[0] : undefined;
  return {
    oracle: {
      kind: 'scope',
      ref: String(r.scope.price[0]),
      account: r.scope.feed,
      twapRef: twap === undefined ? null : String(twap),
      description: null,
      decimals: null,
      prices: null,
      pricesReason: 'not_reported_by_the_reserve',
      source: `risk_lending_pools (the lending import): Kamino reserve ${r.account}${r.marketName ? ` (${r.marketName})` : ''}, oracles.scopePriceChain and scopeTwapChain`,
      fetchedAt: r.fetchedAt,
      method: 'kamino_reserve_decode',
      provenance: provenanceOf(r),
    },
    reason: null,
  };
}

// ---------- the list ----------

export type Built = { list: UniverseList; lines: string[] };
type Identity = ReturnType<typeof solanaIdentity>;

const countBy = <T>(xs: readonly T[], key: (x: T) => string) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[key(x)] = (m[key(x)] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(m).sort(([ka, a], [kb, b]) => b - a || (ka < kb ? -1 : ka > kb ? 1 : 0)),
  );
};
const top = (m: Record<string, number>) =>
  Object.entries(m)
    .map(([k, v]) => `${k} (${v})`)
    .join(', ');

export function solanaList(
  reads: SolanaReads,
  verdicts: UniverseVerdicts,
  leftOut: LeftOut,
): Built {
  if (verdicts.chain !== 'solana') throw new Error(`the verdicts are those of ${verdicts.chain}`);
  checkMatchKeys(verdicts);
  const jup = new Map(reads.jupiter.map((t) => [t.id, t]));
  const verdictOf = new Map(verdicts.verdicts.map((v) => [v.address, v.symbol]));
  const want = candidates(reads.jupiter, reads.named, verdicts);

  // identity, read on chain
  const identities = new Map<string, Identity>();
  const notMints: Record<string, string[]> = {};
  for (const address of want) {
    const m = reads.mints[address];
    if (!m) {
      // a verdict's address the reads never asked for is unread, and refused below
      if (verdicts.verdicts.some((v) => v.address === address)) continue;
      throw new Error(`${address} is a candidate the reads never asked the chain for`);
    }
    const account = m.account;
    const why = !account
      ? 'no_account'
      : account.owner === SPL || account.owner === T22
        ? null
        : 'not_a_token_mint';
    if (why !== null || !account) {
      const k = why ?? 'no_account';
      notMints[k] = [...(notMints[k] ?? []), address];
      continue;
    }
    const meta = reads.metaplex[address];
    const row = jup.get(address);
    const shelf = reads.repo.shelf.rows.find((r) => r.address === address);
    identities.set(
      address,
      solanaIdentity({
        address,
        mint: fromB64(account),
        slot: m.slot,
        at: m.at,
        metaplex: meta?.account ? fromB64(meta.account) : null,
        listing: row
          ? { symbol: row.symbol, name: null }
          : shelf
            ? { symbol: shelf.symbol, name: null }
            : verdictOf.has(address)
              ? { symbol: verdictOf.get(address) as string, name: null }
              : null,
        listingTags: row ? row.tags : [],
      }),
    );
  }
  const unread = unreadVerdicts(verdicts, identities.keys());
  if (unread.length > 0)
    throw new Error(
      `verdicts for addresses no read saw as a mint: ${unread.map((v) => `${v.symbol} ${v.address}`).join(', ')}`,
    );

  // the shelf of today
  const repo = reads.repo;
  const structurerMints = new Set(repo.structurer.rows.map((r) => r.mint));
  const tracked = new Map(repo.tracked.rows.map((r) => [r.address, r]));
  const deployOf = new Map<string, string[]>();
  for (const d of repo.deploy.rows) {
    const hits = [...identities.values()].filter(
      (i) => i.symbol === d.modelOf && (reads.named[i.address]?.length ?? 0) > 0,
    );
    if (hits.length !== 1)
      throw new Error(
        `deploy record ${d.id} models ${d.modelOf}: ${hits.length} named mints answer that symbol`,
      );
    const a = (hits[0] as Identity).address;
    deployOf.set(a, [...(deployOf.get(a) ?? []), d.id]);
  }
  const listedOf = (address: string): UniverseAsset['listedIn'] => {
    const out: UniverseAsset['listedIn'] = [];
    if (structurerMints.has(address)) out.push('structurer_registry');
    if (deployOf.has(address)) out.push('deploy_record');
    if (tracked.has(address)) out.push('tracked_stock');
    return out;
  };

  // which rules each read token matches. A stock issuer's rule (SYMBOL_SUFFIX) is matched first, so the
  // name method can read the token's ticker and kind; then every rule is matched with that kind. A token
  // Jupiter tags deprecated is not enumerated, nor one whose rules leave a verdict field unset.
  const issuerRules = verdicts.rules.filter((r) => r.name in SYMBOL_SUFFIX);
  const matched = new Map<string, string[]>();
  const kindOf = new Map<string, { ticker: string; kind: NameKind }>();
  const own = new Set(verdicts.verdicts.map((v) => v.address));
  const deprecated: string[] = [];
  const incomplete: Array<{ address: string; rules: string[]; missing: string[] }> = [];
  const memeByRule: Array<{ address: string; symbol: string; coin: string; rules: string[] }> = [];
  for (const [address, id] of identities) {
    const tags = new Set(jup.get(address)?.tags ?? []);
    const base: Facts = {
      tags,
      mintAuthority: id.decoded.mintAuthority,
      freezeAuthority: id.decoded.freezeAuthority,
      permanentDelegate: id.authorities.permanentDelegate.holder,
      program: id.standard,
      name: id.name,
      nameKind: 'none',
      listedIn: listedOf(address),
    };
    const issuer = issuerRules.find((r) => ruleMatches(r.match, base));
    let facts = base;
    if (issuer) {
      const ticker = tickerOf(id.symbol, issuer.name);
      const kind = kindOfName(id.name ?? '', ticker);
      kindOf.set(address, { ticker, kind });
      facts = { ...base, nameKind: kind };
    }
    if (tags.has('deprecated') && !own.has(address)) {
      deprecated.push(address);
      continue;
    }
    const rules = verdicts.rules.filter((r) => ruleMatches(r.match, facts)).map((r) => r.name);
    if (rules.length === 0 && !own.has(address)) continue;
    // a token CoinGecko files as a meme is not a row, whatever rule takes it (a verdict's is refused below)
    const coin = reads.coingecko.byMint[address];
    if (!own.has(address) && coin && categoryCall(reads.categories, coin).meme.length > 0) {
      if (listedOf(address).length > 0)
        throw new Error(
          `${id.symbol} ${address}: listed, and CoinGecko files ${coin.id} as a meme`,
        );
      memeByRule.push({ address, symbol: id.symbol, coin: coin.id, rules });
      continue;
    }
    if (!own.has(address)) {
      const set = new Set<string>(issuer ? DERIVED_KEYS : []);
      for (const r of verdicts.rules)
        if (rules.includes(r.name)) for (const k of Object.keys(r.fields)) set.add(k);
      const missing = REQUIRED_KEYS.filter((k) => !set.has(k));
      if (missing.length > 0) {
        incomplete.push({ address, rules, missing });
        continue;
      }
    }
    matched.set(address, rules);
  }

  // ids: the tracked list's, the shelf fixture's, the previous committed list's (an id once committed
  // stays with its address), else solana:<slug of the symbol>, made unique
  const fixedId = new Map<string, string>();
  for (const r of repo.tracked.rows) fixedId.set(r.address, r.id);
  for (const r of repo.shelf.rows) if (!fixedId.has(r.address)) fixedId.set(r.address, r.id);
  const used = new Set(fixedId.values());
  for (const [a, id] of Object.entries(reads.previousIds.byAddress))
    if (matched.has(a) && !fixedId.has(a) && !used.has(id)) fixedId.set(a, id);
  // a committed id stays reserved for its address even while that address is not a row
  const taken = new Set([
    ...[...matched.keys()].map((a) => fixedId.get(a)).filter((x): x is string => !!x),
    ...Object.values(reads.previousIds.byAddress),
  ]);
  const bySlug = new Map<string, string[]>();
  for (const a of matched.keys()) {
    if (fixedId.has(a)) continue;
    const slug = `solana:${slugOf((identities.get(a) as Identity).symbol)}`;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), a]);
  }
  const idOf = new Map(fixedId);
  for (const [slug, addrs] of bySlug) {
    // a new row on a free slug keeps it; of several, only a listed one does (USDC, not a bridged USDC)
    const shelved = addrs.filter((a) => listedOf(a).length > 0);
    const keeper = taken.has(slug)
      ? undefined
      : addrs.length === 1
        ? addrs[0]
        : shelved.length === 1
          ? shelved[0]
          : undefined;
    for (const a of addrs)
      idOf.set(a, a === keeper ? slug : `${slug}-${a.slice(0, 6).toLowerCase()}`);
  }

  // the rows
  const pyth = new Map(
    repo.seed.rows.filter((r) => r.pyth).map((r) => [r.address, r.pyth as string]),
  );
  const content = new Set(repo.content.symbols);
  const stamp = {
    source: `Solana mainnet getMultipleAccounts and the listings of list.reads; ${VERDICTS_FILE}`,
    fetchedAt: reads.startedAt,
    method: ASSETS_METHOD,
    provenance: reads.provenance,
  };
  const rows: UniverseAsset[] = [];
  for (const [address, rules] of matched) {
    const id = identities.get(address) as Identity;
    const { decoded: _d, metadataUri: _u, updateAuthority: _a, ...identity } = id;
    const listedIn = listedOf(address);
    const t = tracked.get(address);
    const { oracle, reason } = t
      ? { oracle: null, reason: IN_TRACKED_ROW }
      : scopeOracle(reads, address);
    const poolCount = reads.registry.pools[address] ?? 0;
    const rowId = idOf.get(address) as string;
    if (t && t.id !== rowId) throw new Error(`${address}: the tracked id ${t.id} was not kept`);
    const context: RowContext = {
      id: rowId,
      oracle,
      oracleReason: reason,
      unverifiedOracles: pyth.has(address)
        ? [{ kind: 'pyth', ref: pyth.get(address) as string, source: repo.seed.file }]
        : [],
      listedIn,
      pools:
        t || poolCount === 0
          ? null
          : { confirmed: poolCount, unconfirmed: 0, file: reads.registry.file },
      poolsReason: t ? IN_TRACKED_ROW : poolCount === 0 ? 'no_registered_pool' : null,
      tracked: t ? { list: repo.tracked.file, id: t.id } : null,
      attributes:
        rules.includes('xstocks') && content.has(identity.symbol)
          ? { file: repo.content.file, symbol: identity.symbol }
          : null,
    };
    // an issuer page that did not answer, or answered without the address, is said on the row; so is a
    // CoinGecko coin a verdict cites that CoinGecko's list does not name for this mint
    const own_ = verdicts.verdicts.find((v) => v.address === address);
    const cgCited = (own_?.sources ?? [])
      .map((x) => x.url.match(/^https:\/\/www\.coingecko\.com\/en\/coins\/([a-z0-9-]+)$/)?.[1])
      .filter((x): x is string => !!x);
    const pageNotes = [
      ...reads.issuerPages
        .filter((p) => p.address === address && !(p.answered && p.namesAddress))
        .map((p) =>
          p.answered
            ? `the mint on ${p.url}: the page answered without it when the command fetched it`
            : `the mint on ${p.url}: the page did not answer when the command fetched it`,
        ),
      ...cgCited
        .filter((cg) => reads.coingecko.byMint[address]?.id !== cg)
        .map((cg) => `the mint on CoinGecko: its coin list does not name it for ${cg}`),
    ];
    const k = kindOf.get(address);
    const fromRules = k ? derivedFor(k.ticker, k.kind) : undefined;
    const derived =
      fromRules || pageNotes.length > 0 ? { ...fromRules, unverified: pageNotes } : undefined;
    const row = universeRow(
      'solana',
      verdicts,
      { identity, context, rules, ...(derived ? { derived } : {}) },
      stamp,
    );
    checkLegTypes(row, repo);
    rows.push(row);
  }

  // every token the crypto selection picks is a row, or the reviewed table says why not
  const rowSet = new Set(rows.map((r) => r.address));
  const leftOf = new Map(leftOut.tokens.map((t) => [t.address, t]));
  for (const t of leftOut.tokens)
    if (rowSet.has(t.address))
      throw new Error(`${t.symbol} ${t.address} is a row and is in ${LEFT_OUT_FILE}`);
  // a row CoinGecko files as a meme is refused; a left-out token CoinGecko files as a protocol's is
  // refused unless its reason is one the categories do not decide
  const coinOf = (a: string) => reads.coingecko.byMint[a];
  for (const r of rows) {
    const cg = coinOf(r.address);
    const ownPage = r.sources.some((x) => isOwnPage(x.url));
    if (!cg) {
      if (r.category === 'governance' && !ownPage)
        throw new Error(
          `${r.symbol} ${r.address}: governance, and neither CoinGecko nor a project page of its own names it`,
        );
      continue;
    }
    const call = categoryCall(reads.categories, cg);
    if (call.meme.length > 0)
      throw new Error(
        `${r.symbol} ${r.address}: CoinGecko files ${cg.id} in ${call.meme.join(', ')}`,
      );
    if (r.category === 'governance' && call.protocol.length === 0 && !ownPage)
      throw new Error(
        `${r.symbol} ${r.address}: ${cg.id} is in no protocol category and no project page names its protocol`,
      );
  }
  for (const t of leftOut.tokens) {
    const cg = coinOf(t.address);
    if (!cg) continue;
    const call = categoryCall(reads.categories, cg);
    // the meme call is CoinGecko's: a token left out as a memecoin is in one of its meme categories
    if (t.reason === 'memecoin' && call.meme.length === 0)
      throw new Error(
        `${t.symbol} ${t.address}: left out as a memecoin, and CoinGecko files ${cg.id} in no meme category`,
      );
  }
  const selection = reads.jupiter
    .filter((t) => isSelected(t) && !rowSet.has(t.id))
    .map((t) => {
      const cg = coinOf(t.id);
      const call = cg ? categoryCall(reads.categories, cg) : null;
      return {
        t,
        reason:
          leftOf.get(t.id)?.reason ??
          (call && call.meme.length > 0
            ? 'coingecko_files_it_as_a_meme'
            : !cg
              ? 'no_source_names_the_mint'
              : 'not_reviewed'),
      };
    });
  const selectedIds = new Set(reads.jupiter.filter(isSelected).map((t) => t.id));
  const unfinished = Object.entries(reads.categories.categories)
    .filter(([, c]) => !c.complete)
    .map(([k]) => k);
  const staleLeftOut = leftOut.tokens.filter((t) => !selectedIds.has(t.address));
  // the rows of the committed list that are not rows on this run, each with why
  const memeSet = new Set(memeByRule.map((m) => m.address));
  const leftSince = Object.entries(reads.previousIds.byAddress)
    .filter(([a]) => !rowSet.has(a))
    .map(([a, id]) => ({
      id,
      reason:
        leftOf.get(a)?.reason ??
        (memeSet.has(a) ? 'coingecko_files_it_as_a_meme' : 'no_rule_or_verdict_takes_it_this_run'),
    }));

  const list = universeList({
    chain: 'solana',
    rows,
    reads: reads.reads,
    inputs: {
      ...reads.inputs,
      verdicts: VERDICTS_FILE,
      reads: `data/assets/solana/${readsFileName(reads.startedAt)}, frozen as fixtures/risk/assets/${readsFileName(reads.startedAt)}.gz`,
    },
    stated: {
      ...stated(reads, verdicts, identities, matched, notMints, rows, {
        deprecated,
        incomplete,
        kindOf,
      }),
      crypto: `The crypto selection: every token of Jupiter's verified list tagged major or strict, or traded at least fifty thousand dollars on Jupiter in the twenty-four hours before the read (its stats24h buy and sell volume, frozen with the reads to re-derive the pick, and on no row). ${selectedIds.size} tokens are picked; ${selectedIds.size - selection.length} are rows. The rest are not rows: ${top(countBy(selection, (x) => x.reason))}. The meme and protocol calls come from CoinGecko's categories, frozen with the reads (${reads.categories.what}): a token in any meme category (${MEME_CATEGORIES.join(', ')}) is not a row, whatever Jupiter tags it; a token is governance only when CoinGecko files it in a protocol category (${PROTOCOL_CATEGORIES.join(', ')}; launchpad for a launchpad platform's own token) or its own project page, cited on the row, names the protocol it governs. A Jupiter meme or launchpad tag alone, or an AI, DeFi or ecosystem category alone, neither admits nor excludes. A token that CoinGecko files in neither, or that its coin list does not name, is in ${LEFT_OUT_FILE} with where that was read; one picked and in no table is counted not_reviewed and is not a row. A new row's mint is named by CoinGecko's coin list or an issuer's page and read on chain like every other row.${memeByRule.length > 0 ? ` Taken by a rule and not rows, as CoinGecko files them as memes: ${memeByRule.map((m) => `${m.symbol} (${m.coin}; ${m.rules.join(', ')})`).join(', ')}.` : ''}${unfinished.length > 0 ? ` Categories whose member list the read left incomplete: ${unfinished.join(', ')}.` : ''}${staleLeftOut.length > 0 ? ` ${staleLeftOut.length} entries of ${LEFT_OUT_FILE} were not picked this run.` : ''}`,
      later: `The list is written from one run; a later run decides again. Of the rows of ${reads.previousIds.file}, ${leftSince.length} are not rows on this run: ${top(countBy(leftSince, (x) => x.reason))}. ${leftSince.map((x) => `${x.id} (${x.reason})`).join(', ') || 'none'}.`,
    },
    stamp,
  });
  return { list, lines: lines(list, verdicts, identities, matched) };
}

/** A dollar-yield row whose leg types the engine's table also holds must hold the same types. */
function checkLegTypes(row: UniverseAsset, repo: SolanaRepoInputs) {
  if (row.cls !== 'dollar_yield' || !row.legTypes) return;
  const shelfSymbol = repo.shelf.rows.find((r) => r.address === row.address)?.symbol;
  const engine = repo.legTypes.rows[shelfSymbol ?? row.symbol] ?? repo.legTypes.rows[row.symbol];
  if (!engine) return;
  const a = row.legTypes
    .map((l) => l.type)
    .sort()
    .join(',');
  const b = [...engine.types].sort().join(',');
  if (a !== b)
    throw new Error(
      `${row.symbol}: the verdict's leg types (${a}) are not ${repo.legTypes.file}'s (${b})`,
    );
}

// ---------- what the list states ----------

/** The facts a stock rule rests on: how many of its tokens share each program, authority and metadata host. */
export function issuerFacts(identities: Map<string, Identity>, addrs: readonly string[]) {
  const ids = addrs.map((a) => identities.get(a) as Identity);
  const host = (u: string | null) => {
    if (!u) return 'none';
    try {
      return new URL(u).host;
    } catch {
      return 'not_a_url';
    }
  };
  return {
    rows: ids.length,
    program: countBy(ids, (i) => i.standard),
    mintAuthority: countBy(ids, (i) => i.decoded.mintAuthority ?? 'none'),
    freezeAuthority: countBy(ids, (i) => i.decoded.freezeAuthority ?? 'none'),
    permanentDelegate: countBy(ids, (i) => i.authorities.permanentDelegate.holder ?? 'none'),
    metadataUpdateAuthority: countBy(ids, (i) => i.updateAuthority ?? 'none'),
    metadataHost: countBy(ids, (i) => host(i.metadataUri)),
    extensions: countBy(ids, (i) => [...i.extensions.names].sort().join('+')),
    defaultAccountState: countBy(ids, (i) => i.decoded.defaultAccountState ?? 'no_extension'),
    paused: countBy(ids, (i) => String(i.decoded.paused ?? 'no_extension')),
    transferHookProgram: countBy(ids, (i) =>
      i.decoded.transferHookProgram === undefined
        ? 'no_extension'
        : (i.decoded.transferHookProgram ?? 'none'),
    ),
  };
}

/** The names the prompt (5.2) asks the list to cover; none is a fact until its mint is read. */
export const PROMPT_NAMES = [
  'PAXG',
  'GLDx',
  'USDC',
  'USDT',
  'PYUSD',
  'USDG',
  'FDUSD',
  'USDe',
  'sUSDe',
  'EURC',
  'AUSD',
  'USD1',
  'USDS',
  'sUSDS',
  'USDY',
  'OUSG',
  'BUIDL',
  'BENJI',
  'USTB',
  'USYC',
  'VBILL',
  'WTGXX',
  'ACRED',
  'kUSDC',
  'syrupUSDC',
  'jlUSDC',
  'PST',
  'PRIME',
  'AUTO',
  'wYLDS',
  'ONyc',
  'USD*',
  'eUSX',
  'oTFY',
  'SOL',
  'JitoSOL',
  'mSOL',
  'bSOL',
  'jupSOL',
  'INF',
  'bbSOL',
  'cbBTC',
  'wBTC',
  'zBTC',
  'tBTC',
  'WETH',
  'JUP',
  'RAY',
  'JTO',
  'PYTH',
  'KMNO',
];

/** Jupiter tags that name no class of the product. */
const NO_CLASS_TAGS = new Set([
  'verified',
  'token-2022',
  'strict',
  'community',
  'community-assist',
  'moonshot-verified',
  'birdeye-trending',
  'duplicate',
  'defi',
  'infra',
  'internal',
  'major',
]);

function stated(
  reads: SolanaReads,
  verdicts: UniverseVerdicts,
  identities: Map<string, Identity>,
  matched: Map<string, string[]>,
  notMints: Record<string, string[]>,
  rows: readonly UniverseAsset[],
  left_: {
    deprecated: readonly string[];
    incomplete: ReadonlyArray<{ address: string; rules: string[]; missing: string[] }>;
    kindOf: ReadonlyMap<string, { ticker: string; kind: NameKind }>;
  },
): Record<string, string> {
  const rowSet = new Set(rows.map((r) => r.address));
  const jupLeft = reads.jupiter.filter((t) => !rowSet.has(t.id));
  const deprecatedSet = new Set(left_.deprecated);
  const incompleteSet = new Set(left_.incomplete.map((i) => i.address));
  const why = (t: JupiterRow) => {
    const tags = new Set(t.tags);
    if (deprecatedSet.has(t.id)) return 'jupiter_tags_it_deprecated';
    if (incompleteSet.has(t.id)) return 'its_rules_leave_a_verdict_field_unset';
    if (identities.has(t.id) && !matched.has(t.id)) return 'read_and_matched_no_rule_in_full';
    if (tags.has('shift')) return 'shift_leveraged_or_inverse_tracker';
    if (tags.has('tessera')) return 'tessera_pre_ipo_token';
    if (tags.has('meme') || tags.has('launchpad') || tags.has('moonshot'))
      return 'meme_or_launchpad';
    if (t.tags.every((g) => NO_CLASS_TAGS.has(g))) return 'no_class_tag';
    return 'class_tag_but_no_rule_or_verdict';
  };
  const left = countBy(jupLeft, why);
  const examples = (reason: string, n = 40) => {
    const xs = jupLeft.filter((t) => why(t) === reason);
    const shown = xs
      .slice(0, n)
      .map((t) => `${t.symbol} (${t.tags.filter((g) => !NO_CLASS_TAGS.has(g)).join('/')})`)
      .join(', ');
    return xs.length > n ? `${shown}, and ${xs.length - n} more` : shown || 'none';
  };
  const namedLeft = Object.entries(reads.named).filter(
    ([a]) => !rowSet.has(a) && identities.has(a),
  );
  const symbols = new Set(rows.map((r) => r.symbol.toLowerCase()));
  const llamaLeft = reads.llama.stablecoins.filter((s) => !symbols.has(s.symbol.toLowerCase()));
  const byRule = (name: string) => [...matched].filter(([, r]) => r.includes(name)).map(([a]) => a);
  const facts = (name: string) => JSON.stringify(issuerFacts(identities, byRule(name)));
  const pages = reads.issuerPages;
  const repo = reads.repo;
  const notMintText =
    Object.entries(notMints)
      .map(([k, v]) => `${v.length} ${k}`)
      .join(', ') || 'none';
  const ruleCounts = verdicts.rules
    .map((r) => `${r.name} ${byRule(r.name).filter((a) => rowSet.has(a)).length}`)
    .join(', ');
  const classTable = Object.entries(CLASS_BY_UNDERLYING)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const sym = (a: string) => (identities.get(a) as Identity).symbol;
  const kinds = countBy(
    rows.filter((r) => left_.kindOf.has(r.address)),
    (r) => (left_.kindOf.get(r.address) as { kind: NameKind }).kind,
  );
  const kindExamples = (k: NameKind) =>
    rows
      .filter((r) => left_.kindOf.get(r.address)?.kind === k)
      .slice(0, 12)
      .map((r) => r.symbol)
      .join(', ');
  const namedText =
    namedLeft
      .map(([a, by]) => `${(identities.get(a) as Identity).symbol} (${by.join('/')})`)
      .join(', ') || 'none';
  return {
    scope:
      'Every Solana token of the classes of UniverseCategory that a read below names and a rule or a verdict of solana.verdicts.json classifies. A verdict is a decision with its source; this list decides nothing a plan may hold (DA5): the shelf is decided under UNIVERSE.',
    enumeration: `In the prompt's order (5.2): Jupiter's verified list, live, every tag kept (${reads.jupiter.length} tokens); the reserves of risk_lending_pools, their mints and debt mints (${reads.lending.length} rows); the research note ${repo.note.file} (${repo.note.addresses.length} full addresses in it) and its shelf fixture ${repo.shelf.file} (${repo.shelf.rows.length} rows); DefiLlama's stablecoins and its protocols on Solana in the RWA and yield categories, as names only (${reads.llama.stablecoins.length} and ${reads.llama.protocols.length}); the issuers' pages of ${ISSUER_MINTS_FILE} (${pages.length} mints). Also read: the tracked stock list, the structurer's registry, the Scope table and the launch-shelf seed, whose addresses are on today's shelf or carry an oracle. A Jupiter token is read on chain when it carries a tag a rule asks for or has a verdict; every other named address is read. ${identities.size} mints were read; of the other named addresses: ${notMintText} (the note names reserves, markets, programs and authorities beside its mints).`,
    identity:
      "Read on chain for every row by getMultipleAccounts, the slot in read.height: decimals, the token program, the Token-2022 extensions by name in the order the mint holds them, the mint and freeze authorities (null with reason 'none' where the account's option is empty), the permanent delegate (the extension's key; 'none' where the extension is absent or, on a classic SPL mint, where the program has none). Symbol and name from the mint's own tokenMetadata extension, else its Metaplex metadata account (read at its derived address in a second batch), else the listing: Jupiter's row or, for a token Jupiter does not list, the shelf fixture's symbol, else the verdict table's (read.symbolFrom 'listing', name null with 'no_metadata_on_chain').",
    ids: `An id once in a committed list stays with its address (the ids of ${reads.previousIds.file} are kept). Else the tracked list's id for a tracked stock, else the shelf fixture's, else solana:<the symbol the chain answers, lower case, + as plus, * as star, any other run of characters a dash>. Where two new rows meet on one slug, only a listed one keeps it (solana:usdc is Circle's USDC, not a bridged copy) and each other takes a dash and the first six characters of its address, lower case; with none or several listed, every one does.`,
    rules: `A rule's match is read by the builder (scripts/risk/assets/solana-list.ts, MATCH_KEYS), every key holding: jupiterTag, Jupiter carries the tag; minter, freezeAuthority and permanentDelegate, those keys as read on chain; program, spl or token2022; nameEndsWith, the name the chain answers; nameKind, what the name method reads in a stock issuer's token's name; listedIn, on today's shelf that way, or any or none. The stock issuers' rules rest on keys read on chain (one mint authority for xStocks and for Ondo, one freeze authority and permanent delegate for Backpack's tokens), not on Jupiter's tag alone. The lst rule rests on Jupiter's tag alone: no key read on chain is shared by the stake pools, so a token Jupiter mistags would be swept in (stated, not chosen). Rules apply in the table's order and a token's own verdict last (decidedBy). A token Jupiter tags deprecated is not enumerated (${left_.deprecated.map(sym).join(', ') || 'none'}), nor one whose rules leave a verdict field unset (${left_.incomplete.map((i) => `${sym(i.address)}: ${i.missing.join('/')}`).join(', ') || 'none'}). Rows per rule: ${ruleCounts}; with a verdict of their own: ${rows.filter((r) => r.decidedBy.includes('verdict')).length}.`,
    derived: `For a token of a stock issuer's rule (${Object.keys(SYMBOL_SUFFIX).join(', ')}) the builder derives, the lowest layer: underlying, the symbol the chain answers less the issuer's suffix ('x' for xStocks, 'on' for Ondo; Backpack's symbol is the ticker), null with 'symbol_without_the_issuer_suffix' where the suffix is missing; and category, from what the name the chain answers says the token is (kindOfName): the tracked list's class table (CLASS_BY_UNDERLYING in scripts/risk/universe/list.ts, DU7: ${classTable}) where it names the ticker; else no fund word (ETF, ETN, Fund, Index, a fund-only sponsor such as iShares, SPDR or Vanguard, or an index name such as S&P 500 or Russell 2000) is a stock; else a fund, which is leveraged or inverse (a multiple such as 2x or 3x, Bull, Bear, UltraPro, ProShares Ultra or Short), of crypto assets, of gold, of another commodity (miners, services and producers are shares, not the metal), of Treasuries or government bonds, of other bonds or income, or of shares, in that order. A stock and a fund of shares are tokenized_stock and tokenized_etf, gold tokenized_gold, a commodity tokenized_commodity, a Treasury fund treasury_fund_open with no leg type ('not_screened_on_solana'), and a leveraged, crypto or bond fund tokenized_etf; the rules hold out every fund that is not screened. Rows by kind: ${top(kinds)}. A name without a fund word is filed a stock whatever the token is (JPSTx, a short-bond fund, is one): stated, not chosen. Examples: leveraged ${kindExamples('leveraged_etf')}; treasury ${kindExamples('treasury_fund')}; gold ${kindExamples('gold_fund')}; commodity ${kindExamples('commodity_fund')}.`,
    status:
      "listed: on today's shelf, by mint in the structurer's registry (packages/engine/src/assets/registry.ts), as the model of a token of deployments/solana-devnet.json (its modelOf matched to the one named mint that answers that symbol), or a tracked stock of scripts/risk/universe/solana.json; listedIn says which. A tracked stock's row names its tracked row and reads its pools and oracle there. A stock token outside the cut that names the tracked stocks is candidate (gate UNIVERSE, DA16, stated, not chosen); a fund among them that is not screened (a Treasury, bond, crypto, leveraged or inverse fund) is held_out. Dollar yield takes the research note's verdict: add and add with caution candidate, hold held_out, out held_out or excluded by its reason, verdictSource naming the note and section. Permissioned funds held_out (DA4); a token in another currency held_out (USD-ONLY, DA7); crypto candidate (DA6); a token with a maturity or with no class held_out; defunct, exploit-linked or not the asset it claims excluded.",
    shelf:
      "The structurer's kamino-usdc row names the USDC mint (its leg is a deposit made in USDC), so it lists USDC; Kamino's deposit token itself (kUSDC, B8V6…) is a row of its own with the research note's verdict.",
    legTypes: `Only for dollar yield, from the research note, and held to the engine's table (${repo.legTypes.file}) by the shelf fixture's symbol: a row whose types differ stops the run. A token the note types as none of the four (ONyc, USD*) is filed other, with no class and so no leg types, and held out; a dollar-yield token no source types is null with its reason, never a guess.`,
    oracle:
      "A Scope entry where fixtures/solana-vault/scope-indexes.json names the mint, else where a Kamino reserve of risk_lending_pools prices it with a one-entry Scope chain. Null with 'no_scope_entry' where a Kamino reserve of the lending import holds the token and names no Scope chain for it; 'scope_not_read' where no reserve the lending import knows holds it, since the import holds only the xStocks markets and no Scope entry was looked for. A tracked stock's oracle is read in its tracked row. A Pyth feed the launch-shelf seed names is in unverifiedOracles and is never read (DU4).",
    pools: `How many pools of the registry file ${reads.registry.file} (pnpm risk:registry: pools confirmed on chain at build) hold the mint on either side, all counted as confirmed; none: null, 'no_registered_pool'. That registry was built for the stock tokens' pools, so a count there is the pools a token shares with a stock token, not every pool it has.`,
    xstocks: `The ${byRule('xstocks').length} tokens of the xstocks rule, as read on chain: ${facts('xstocks')}.`,
    ondo: `The ${byRule('ondo-global-markets').length} tokens of the ondo-global-markets rule, as read on chain: ${facts('ondo-global-markets')}.`,
    unclassified: `${jupLeft.length} of Jupiter's ${reads.jupiter.length} verified tokens are not rows: ${top(left)}. Memecoins and launchpad tokens are not enumerated (the Oct 1 note: no meme index in the MVP). Shift's tokens are leveraged or inverse trackers and Tessera's pre-IPO tokens whose structure was not read: no category takes them as read. With a class tag and taken by no rule or verdict, for review: ${examples('class_tag_but_no_rule_or_verdict')}. Read and matching no rule in full: ${examples('read_and_matched_no_rule_in_full')}.`,
    namedNotRows: `${namedLeft.length} mints another source names are not rows, no rule or verdict taking them: ${namedText}.`,
    defillama: `DefiLlama names ${reads.llama.stablecoins.length} stablecoins on Solana; ${llamaLeft.length} have no row of the same symbol, their mint read from no listing, issuer page or verdict: ${llamaLeft.map((s) => s.symbol).join(', ')}. Its ${reads.llama.protocols.length} protocols on Solana in the RWA and yield categories are names only and give no mint: ${reads.llama.protocols.map((p) => p.name).join(', ')}.`,
    issuerPages: `${pages.length} mints named by an issuer's page (${ISSUER_MINTS_FILE}); the command fetched each page: ${pages.filter((p) => p.answered && p.namesAddress).length} answered and hold the address in their HTML, ${pages.filter((p) => p.answered && !p.namesAddress).length} answered without it (rendered by script, or printed elsewhere on the site), ${pages.filter((p) => !p.answered).length} did not answer. A row whose page did not hold its address says so in unverified.`,
    names: `Of the prompt's ${PROMPT_NAMES.length} names (the xStocks and the Etherfuse bonds aside), a row of the same symbol, case aside: ${PROMPT_NAMES.filter((n) => symbols.has(n.toLowerCase())).join(', ')}. No row, as no read of this run named a Solana mint for it (no listing, issuer page, research row or lending reserve): ${PROMPT_NAMES.filter((n) => !symbols.has(n.toLowerCase())).join(', ') || 'none'}. sUSDS: the research note found no Solana mint (section 3.1). The permissioned funds without a row were looked for on their issuers' pages and none printing a Solana mint was found.`,
    notEnumerated:
      "BRS, the BRL stablecoin (gate G-NORA, DA17). Memecoins. Base. The deposit tokens of the Kamino reserves the lending import knows, other than the Main Market's kUSDC that the research note names: the import's rows name each reserve's liquidity mint, and no listing names its deposit token. Crypto tokens outside the selection of stated.crypto.",
    figures:
      "No price, TVL, supply, holder count or yield is copied from any read: Jupiter's figures are cut away before the reads are saved, but for its 24 h volume, which decides the crypto selection, is frozen with the reads, and is on no row. Those are observations (AS.4, AS.5).",
    later:
      'The list is written from one run. A token that leaves a listing on a later run is not removed by any rule here.',
  };
}

function lines(
  list: UniverseList,
  verdicts: UniverseVerdicts,
  identities: Map<string, Identity>,
  matched: Map<string, string[]>,
): string[] {
  const rows = new Set(list.assets.map((a) => a.address));
  const out = ['rows per rule (a row may match several):'];
  for (const r of verdicts.rules) {
    const n = [...matched].filter(([a, rs]) => rows.has(a) && rs.includes(r.name)).length;
    out.push(`  ${r.name}: ${n}`);
  }
  out.push(`  own verdict: ${list.assets.filter((a) => a.decidedBy.includes('verdict')).length}`);
  for (const rule of ['xstocks', 'ondo-global-markets']) {
    const f = issuerFacts(
      identities,
      [...matched].filter(([, r]) => r.includes(rule)).map(([a]) => a),
    );
    out.push(
      `${rule}: ${f.rows} tokens; mint authority ${top(f.mintAuthority)}; metadata ${top(f.metadataHost)}`,
    );
  }
  return out;
}
