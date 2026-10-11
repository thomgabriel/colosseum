// The asset universe of Robinhood Chain from its reads (PLAN-ASSETS AS.3, gate ASSET-UNIVERSE). No I/O,
// no clock: `robinhoodList` takes what assets-read.ts read (or its frozen copy under fixtures/) and the
// repository's own files, and gives the list `pnpm risk:assets robinhood` writes. What is read, derived
// and decided here is said in STATED, which goes in the file.
import {
  addressKey,
  type CallReply,
  type CodeContext,
  type CodeScan,
  decodeAbiText,
  evmAuthorities,
  evmExtensions,
  evmStandard,
  type IdentityRead,
  type RegimeParams,
  type RowContext,
  tokenAnswers,
  tokenBasics,
  universeList,
  universeRow,
  unreadVerdicts,
  WATCHED_SELECTORS,
} from '@colosseum/risk';
import {
  IN_TRACKED_ROW,
  type TrackedOracle,
  type UniverseAsset,
  type UniverseList,
  type UniverseRead,
  type UniverseVerdicts,
} from '@colosseum/schemas';
import { CLASS_BY_UNDERLYING } from '../risk/universe/list';
import { fundRow, type MatchContext, matchToken, parseDirectory, readFeeds } from './feeds';

export const ASSETS_METHOD = 'assets-list-0.1';
/** The chain's gas coin has no contract; the list writes it at the address wallets use for it. */
export const NATIVE_ADDRESS = `0x${'e'.repeat(40)}`;
/** Uniswap v4 and DexScreener write the native coin as the zero address. */
export const NATIVE_IN_POOLS = `0x${'0'.repeat(40)}`;
export const NATIVE_ID = 'robinhood:eth';

// ───────────────────────────── what is read ─────────────────────────────

/** One row of the issuer's registry, cut to the fields the list reads. */
export type RegistryRowCut = {
  id: string | null;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenDecimals: number | null;
  isin: string | null;
  status: string | null;
  currentMultiplier: string | null;
  deployments: Array<{ chainId: number | null; contractAddress: string | null }>;
};

/** One DexScreener pair, cut to its names and addresses. */
export type DexPairCut = {
  pairAddress: string;
  dexId: string;
  labels: string[];
  base: { address: string; symbol: string; name: string };
  quote: { address: string; symbol: string; name: string };
};
export type DexQuery = {
  kind: 'search' | 'token_pairs';
  /** The search text, or the token address. */
  query: string;
  url: string;
  at: string;
  ok: boolean;
  error: string | null;
  /** Indexes into `pairs`, of the pairs on Robinhood Chain the answer held. */
  pairs: number[];
};

export type Phase = {
  at: string;
  durationMs: number;
  calls: number;
  httpRequests: number;
  errors: number;
};

/** Everything the list is built from that is read from outside the repository. Frozen whole by --freeze. */
export type AssetReads = {
  chain: 'robinhood';
  chainId: number;
  rpcLabel: string;
  registry: Phase & { url: string; assets: number; rows: RegistryRowCut[] };
  directory: Phase & { url: string; entries: unknown[] };
  dexscreener: Phase & { queries: DexQuery[]; pairs: DexPairCut[] };
  /** Every read on chain, at one block. */
  onchain: {
    block: number;
    /** Unix seconds of the block. */
    blockTime: number;
    multicall3: string;
    positionManager: string;
    /** WETH9() of the v4 position manager. */
    weth9: CallReply;
    /** Every address asked TOKEN_CALLS, with its answers and its three EIP-1967 slots. */
    tokens: Array<{
      address: string;
      replies: CallReply[];
      slots: { implementation: string; admin: string; beacon: string };
    }>;
    beacons: Array<{ address: string; implementation: CallReply; owner: CallReply }>;
    /** The EIP-1967 slots of each clone's target: its own storage, read to say what it is. */
    cloneTargets: Array<{
      address: string;
      slots: { implementation: string; admin: string; beacon: string };
    }>;
    /** getFacet(selector) of each token whose running code is a facet router, for FACET_QUERIES. */
    facets: Array<{ token: string; selector: string; reply: CallReply }>;
    /** The code of every token, implementation and clone target, scanned (scanCode), with its SHA-256. */
    code: Array<{ address: string; sha256: string } & CodeScan>;
    /** Requests the RPC's Cloudflare answered with a challenge, each asked again after a wait. */
    challenged: number;
    /** The answers to feedCalls(the directory's feeds), in order. */
    feeds: CallReply[];
    /** The selectors the code was scanned for (WATCHED_SELECTORS when read). */
    watched: string[];
    phases: { calls: Phase; slots: Phase; code: Phase; feeds: Phase };
  };
};

/** The discovery file of RU.2 cut to what the pool counts read: pools grouped by token, other side and source. */
export type DiscoveryCut = {
  file: string;
  fetchedAt: string;
  /** [the stock token, the other side where it is an address the list read (else null), confirmed on chain, pools]. */
  groups: Array<[string, string | null, boolean, number]>;
};

/** The repository's files the list reads. */
export type AssetFiles = {
  verdicts: UniverseVerdicts;
  verdictsPath: string;
  tracked: { path: string; cut: string; assets: Array<{ id: string; address: string }> };
  shelf: { path: string; rows: Array<{ asset: { id: string; address: string; symbol: string } }> };
  deploy: {
    path: string;
    cash: { symbol: string };
    assets: Array<{ symbol: string; modelOf?: string }>;
  };
  content: { path: string; symbols: string[] };
  /** The mainnet deploy config: the cash token it names. */
  mainnetConfig: { path: string; cashToken: string };
  legTypes: {
    path: string;
    rows: Record<string, { types: string[]; source: string; readAt: string }>;
  };
  /** The screening note and its input list: every full address written in them is a name to read. */
  notes: Array<{ path: string; text: string }>;
  discovery: DiscoveryCut;
  regime: RegimeParams;
  calendarPath: string;
  /** Where the reads of this list are frozen (fixtures/risk-evm/assets/). */
  frozenPath: string;
};

// ───────────────────────────── names ─────────────────────────────

const lower = (a: string) => a.toLowerCase();
const isAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Every full address written in the screening note, its input list and its shelf fixture. */
export function noteAddresses(notes: AssetFiles['notes']): string[] {
  const found = new Set<string>();
  for (const n of notes)
    for (const m of n.text.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) found.add(lower(m[0]));
  return [...found].sort();
}

/**
 * The names of the product's classes a DexScreener token may carry: the prompt's names for both chains
 * (docs/risk/PROMPT-BUILD-ASSETS.md section 5.2), with every base asset of Chainlink's directory and every
 * symbol of the issuer's registry added by `classNames`. A symbol holding USD or EUR is one too.
 */
export const PROMPT_NAMES = [
  'ETH',
  'WETH',
  'STETH',
  'WSTETH',
  'WEETH',
  'EETH',
  'RETH',
  'CBETH',
  'BTC',
  'WBTC',
  'CBBTC',
  'ZBTC',
  'TBTC',
  'LBTC',
  'SOL',
  'PAXG',
  'XAUT',
  'GOLD',
  'GLDX',
  'MGLO',
  'JUP',
  'RAY',
  'JTO',
  'PYTH',
  'KMNO',
  'BUIDL',
  'OUSG',
  'BENJI',
  'USTB',
  'USYC',
  'VBILL',
  'WTGXX',
  'ACRED',
  'PRIME',
  'AUTO',
];

/** The base of a directory feed's name ("WEETH / EETH Exchange Rate" → WEETH), upper case. */
function feedBase(name: string): string | null {
  const m = /^(?:Robinhood\s+|RH)?([A-Za-z0-9.]+)\s*(?:\/|-)/.exec(name.trim());
  return m ? (m[1] as string).toUpperCase() : null;
}

export function classNames(registrySymbols: string[], directoryNames: string[]): Set<string> {
  return new Set([
    ...PROMPT_NAMES,
    ...registrySymbols.map((s) => s.toUpperCase()),
    ...directoryNames.flatMap((n) => feedBase(n) ?? []),
  ]);
}

/** True when a symbol names one of the product's classes (`classNames`, or USD or EUR in it). */
export const namesAClass = (symbol: string, names: Set<string>) =>
  /USD|EUR/i.test(symbol) || names.has(symbol.toUpperCase());

/** The terms DexScreener is searched with, each as "robinhood <term>": the class names, the registry's aside. */
export const searchTerms = (directoryNames: string[]) =>
  [...classNames([], directoryNames), 'USD', 'EUR'].sort();

/** The issuer registry's tokens on the chain, keyed on the lower-case address. */
export function registryTokens(reads: AssetReads) {
  const out = new Map<string, { row: RegistryRowCut; address: string }>();
  const skipped: Array<{ symbol: string; reason: string }> = [];
  for (const row of reads.registry.rows) {
    const here = row.deployments.filter((d) => d.chainId === reads.chainId);
    const symbol = row.tokenSymbol ?? '?';
    if (here.length === 0) skipped.push({ symbol, reason: 'no_deployment_on_this_chain' });
    for (const d of here) {
      if (!isAddress(d.contractAddress)) skipped.push({ symbol, reason: 'not_an_address' });
      else if (out.has(lower(d.contractAddress)))
        skipped.push({ symbol, reason: 'address_listed_twice' });
      else out.set(lower(d.contractAddress), { row, address: d.contractAddress });
    }
  }
  return { tokens: out, skipped };
}

/** Every token DexScreener named, keyed on the lower-case address, with the symbol and name it gave. */
export function dexNames(reads: AssetReads) {
  const out = new Map<string, { symbol: string; name: string }>();
  for (const p of reads.dexscreener.pairs)
    for (const t of [p.base, p.quote])
      if (isAddress(t.address) && !out.has(lower(t.address)))
        out.set(lower(t.address), { symbol: t.symbol, name: t.name });
  return out;
}

/**
 * The DexScreener names read on chain: those whose symbol names one of the product's classes, and those
 * the verdict table has a verdict for. Other names (memecoins, launch tokens) are counted and not read.
 */
export function dexToRead(
  reads: Pick<AssetReads, 'dexscreener'>,
  names: Set<string>,
  verdictAddresses: Iterable<string>,
): string[] {
  const withVerdict = new Set([...verdictAddresses].map(lower));
  return [...dexNames(reads as AssetReads).entries()]
    .filter(([a, v]) => namesAClass(v.symbol, names) || withVerdict.has(a))
    .map(([a]) => a);
}

/** The addresses to read on chain: every listing's names but the native coin's pool spelling. */
export function addressesToRead(args: {
  registry: string[];
  notes: string[];
  dex: string[];
  weth9: string | null;
}): string[] {
  const all = new Set(
    [...args.registry, ...args.notes, ...args.dex, ...(args.weth9 ? [args.weth9] : [])].map(lower),
  );
  all.delete(NATIVE_IN_POOLS);
  all.delete(NATIVE_ADDRESS);
  return [...all].sort();
}

// ───────────────────────────── pools ─────────────────────────────

const STOCK_SOURCE = 'pools with a stock token of the issuer registry';

/** The discovery file cut to what the counts read; `keep` is every address the list read. */
export function cutDiscovery(
  file: string,
  discovery: {
    fetchedAt: string;
    pools: Array<{ token: string; other: string; sources: string[] }>;
  },
  keep: Iterable<string>,
): DiscoveryCut {
  const kept = new Set([...keep].map(lower));
  kept.add(NATIVE_IN_POOLS);
  const groups = new Map<string, [string, string | null, boolean, number]>();
  for (const p of discovery.pools) {
    const token = lower(p.token);
    const other = kept.has(lower(p.other)) ? lower(p.other) : null;
    const confirmed = p.sources.some((s) => s !== 'dexscreener');
    const key = `${token} ${other} ${confirmed}`;
    const g = groups.get(key) ?? [token, other, confirmed, 0];
    g[3]++;
    groups.set(key, g);
  }
  return {
    file,
    fetchedAt: discovery.fetchedAt,
    groups: [...groups.values()].sort((a, b) =>
      `${a[0]}${a[1]}${a[2]}` < `${b[0]}${b[1]}${b[2]}` ? -1 : 1,
    ),
  };
}

/**
 * How many pools are known for a token. A pool with a stock token of the registry on one side is counted
 * from the discovery file (RU.2): confirmed when a chain source names it (the v3 factory's events or
 * getPool, the v4 pool manager's Initialize events), unconfirmed when only DexScreener does. A pool with
 * no stock token is counted from DexScreener's answers of this run, unconfirmed.
 */
export function poolCount(args: {
  address: string;
  aliases: string[];
  discovery: DiscoveryCut;
  dex: DexPairCut[];
  registry: Set<string>;
}): { confirmed: number; unconfirmed: number } {
  const me = new Set([args.address, ...args.aliases].map(lower));
  let confirmed = 0;
  let unconfirmed = 0;
  for (const [token, other, chain, n] of args.discovery.groups)
    if (me.has(token) || (other !== null && me.has(other))) {
      if (chain) confirmed += n;
      else unconfirmed += n;
    }
  const pairs = new Set<string>();
  for (const p of args.dex) {
    const sides = [lower(p.base.address), lower(p.quote.address)];
    if (sides.some((s) => me.has(s)) && !sides.some((s) => args.registry.has(s)))
      pairs.add(lower(p.pairAddress));
  }
  return { confirmed, unconfirmed: unconfirmed + pairs.size };
}

// ───────────────────────────── the list ─────────────────────────────

/** `robinhood:<slug>` from a symbol: lower case, every run of other characters one dash. */
export const slugOf = (symbol: string) =>
  symbol
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'token';

const day = (iso: string) => iso.slice(0, 10);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export const STATED = {
  rows: "One row per token, keyed on its address in lower case: every token of the issuer's registry on the chain, the chain's gas coin, and each token another listing named that a verdict or a rule of scripts/risk/assets/robinhood.verdicts.json decides. A token is never a row on a listing's word alone: its decimals() and symbol() must answer on chain.",
  enumeration:
    "Names come from four reads, in this order: the issuer's registry (every row, not only the cut); Chainlink's directory (its feeds, and the names of the assets they price); the screening note of the dollar and yield tokens (docs/vault/research/yield-shelf/robinhood.md with its input list and its shelf fixture: every full address written there), with WETH9() of the Uniswap v4 position manager; DexScreener (searched as 'robinhood <name>' for every class name, then the pairs of each address the note names and of each name a search gave that names a class). Every address any of them named is read on chain.",
  classNames:
    "A DexScreener name names one of the product's classes when its symbol holds USD or EUR, or is, in upper case, a name of PROMPT_NAMES in scripts/risk-evm/assets-list.ts (the prompt's names for both chains), a base asset of Chainlink's directory or a symbol of the issuer's registry. Such names are read on chain, with any other the verdict table names; every one of them, and every token the screening note names, must be decided by a verdict or a rule, or the build stops. Other names are neither read nor enumerated: memecoins and launch tokens are not (DA6).",
  rules:
    "A rule matches a token when every key of its `match` holds for it: `listing`, a listing that named it (issuer_registry, screening_note, position_manager_weth9, dexscreener); `classTable`, CLASS_BY_UNDERLYING of scripts/risk/universe/list.ts at the registry's symbol (SPY and QQQ etf, GLD gold, SLV and USO commodity, SGOV dollar_yield) and stock for every other symbol of the registry; `symbolOf`, issuer_registry for a token outside the registry whose symbol is a registry token's. The registry's tokens match issuer-registry and the class rule of their underlying; a token named after a stock of the registry and not in it matches not-the-issuers-stock-token.",
  derived:
    "For a registry token the builder derives: underlying, the registry's symbol; status, listed for a tracked stock of scripts/risk/universe/robinhood.json (and the model of a deploy record's token) and candidate with 'outside the 80% cut' for every other (DA16); leg types, from packages/engine/src/personal/leg-types.ts at the symbol for a dollar-yield token, none for the others; and a source naming the registry row. Rules and a token's own verdict are applied over these.",
  listed:
    "listed = on today's shelf: a tracked stock (tracked_stock), or a token a deploy record names (deploy_record): the model of an asset of deployments/robinhood-testnet.json by its modelOf, matched to the registry token of that symbol, or the cash token contracts/script/config/4663.json names by address (cashToken). No structurer registry row is on Robinhood Chain.",
  ids: "id: the tracked list's id, else the shelf fixture's (packages/engine/src/personal/fixtures/shelves/robinhood-yield.json), else robinhood:eth for the gas coin, else robinhood:<slug of the symbol>. A slug several rows share goes to the one of them that is not excluded where there is exactly one; every other row with it, and a row whose slug an earlier rule took, gets the first six hex digits of its address after a dash.",
  identity:
    "symbol, name and decimals are what the contract answered at the block of `read.height` (name null where name() gives no text). The registry's own symbol, name, decimals, status, ISIN and multiplier are kept beside them in `issuerRegistry`, as the registry wrote them; nothing is applied. listingTags names the listings that named the token (issuer_registry, screening_note, position_manager_weth9, dexscreener).",
  standard:
    'erc4626 where asset() answers a non-zero address and convertToAssets(1e18) answers one word; erc20 for every other token; native for the gas coin.',
  extensions:
    "proxy: true where the EIP-1967 implementation slot holds an address, or the beacon slot does and the beacon's implementation() answers one; implementation is that address. false where the three slots are zero and the code has no DELEGATECALL, or the code is an EIP-1167 clone whose target has none (it cannot be upgraded). Null where the code delegates without a slot, or a clone's target delegates (its own slots are read and named). pausable and blacklist: true where a selector of CODE_SELECTORS (packages/risk/src/assets/evm.ts, listed in scripts/risk/assets/README.md) is pushed by the code that runs (the proxy and its implementation, or a clone's target), or where that code is a facet router (it pushes getFacet(bytes4)) whose getFacet(<selector>) names a facet that pushes it; null where none is found and the code that runs has a DELEGATECALL, or a code was not read (code_may_run_elsewhere); false only where none is found in code that does not delegate.",
  authorities:
    'owner: owner() (no_owner_function where it reverts, none where it answers the zero address). admin: behind a beacon, owner() of the beacon, which is who may change the code of every proxy of it; else the EIP-1967 admin slot. An empty admin slot is none only on a token that is not a proxy; on a proxy it is uups_upgrade_in_implementation where the implementation pushes upgradeTo, upgradeToAndCall or proxiableUUID, else admin_slot_empty_on_proxy, and admin_slot_empty_code_delegates on code that delegates without a slot; owner() and defaultAdmin() of the token are named in the read. Who a role-based contract (AccessControl) lets act is not read.',
  oracle:
    "A Chainlink feed of the directory, tied to a token and confirmed on chain at the block by the rule of the oracle map (scripts/risk-evm/feeds.ts matchToken: the name and the contract's description() must read as a US dollar price of the symbol, letters as written; decimals() as the directory says; a positive answer not after the block). The twins check is over the rows not excluded; an excluded row gets no feed (excluded_row). A feed names an asset, not an address: it is not tied to a token whose issuer no verdict or rule names (issuer_not_confirmed). Where the directory names the symbol in another case only, the reason says so (feed_named_in_other_case_not_tied). A tracked stock's oracle is in its tracked row. prices is what the directory says the feed prices (token_with_multiplier for a primaryTokenizedPrice product, token_from_pools for dex_state_price), else null. No answer of a feed is stored.",
  pools:
    "pools.confirmed and pools.unconfirmed: see poolCount. A pool with a stock token of the issuer registry is counted from the discovery file of RU.2 (confirmed by the v3 factory or the v4 pool manager, unconfirmed when only DexScreener named it: the venues that are not Uniswap v3 or v4 are not read, D4, BYREAL-D4); a pool with none is counted from this run's DexScreener answers, unconfirmed. The gas coin is the zero address in pools. no_known_pool where neither knows one. A tracked stock's pools are in its tracked row.",
  noFigures:
    'Nothing in a row is a price, a TVL, a supply or a yield. The registry multiplier is its text, applied to nothing.',
};

export type Built = { list: UniverseList; lines: string[] };

/** The list of Robinhood Chain from its reads and the repository's files. Throws, naming the token, on any gap. */
export function robinhoodList(reads: AssetReads, files: AssetFiles): Built {
  const lines: string[] = [];
  const verdicts = files.verdicts;
  const { tokens: registry, skipped } = registryTokens(reads);
  const notes = noteAddresses(files.notes);
  const dex = dexNames(reads);
  const weth9 =
    reads.onchain.weth9.success && reads.onchain.weth9.data.length === 66
      ? `0x${reads.onchain.weth9.data.slice(26)}`.toLowerCase()
      : null;
  const asked = new Map(reads.onchain.tokens.map((t) => [lower(t.address), t]));
  const directory = parseDirectory(reads.directory.entries);
  const names = classNames(
    [...registry.values()].map((r) => r.row.tokenSymbol ?? ''),
    directory.feeds.map((f) => f.name),
  );
  const wanted = addressesToRead({
    registry: [...registry.keys()],
    notes,
    dex: dexToRead(
      reads,
      names,
      verdicts.verdicts.map((v) => v.address),
    ),
    weth9,
  });
  const notAsked = wanted.filter((a) => !asked.has(a));
  if (notAsked.length > 0)
    throw new Error(`the reads did not ask ${notAsked.length} named addresses: ${notAsked[0]}`);

  // no verdict stands for an address no listing named
  const unread = unreadVerdicts(verdicts, [...asked.keys(), NATIVE_ADDRESS]);
  if (unread.length > 0)
    throw new Error(
      `verdicts for addresses no read named: ${unread.map((v) => `${v.symbol} ${v.address}`).join(', ')}`,
    );
  const verdictOfAddress = new Map(verdicts.verdicts.map((v) => [lower(v.address), v]));

  const codeOf = new Map(reads.onchain.code.map((c) => [lower(c.address), c]));
  const beaconOf = new Map(reads.onchain.beacons.map((b) => [lower(b.address), b]));
  const cloneSlotsOf = new Map(reads.onchain.cloneTargets.map((c) => [lower(c.address), c.slots]));
  // a scan reduced to other selectors than the code's of today is refused, not read as absent
  if (JSON.stringify(reads.onchain.watched) !== JSON.stringify(WATCHED_SELECTORS))
    throw new Error(
      'the code was scanned for other selectors than WATCHED_SELECTORS: read the chain again',
    );
  const at = iso(reads.onchain.blockTime);
  const block = reads.onchain.block;

  // what each listing named
  const namedBy = (a: string): string[] =>
    [
      registry.has(a) ? 'issuer_registry' : null,
      notes.includes(a) ? 'screening_note' : null,
      a === weth9 ? 'position_manager_weth9' : null,
      dex.has(a) ? 'dexscreener' : null,
    ].filter((x): x is string => x !== null);

  // identity of every address asked
  type Read = { address: string; identity: IdentityRead; symbol: string };
  const tokensRead: Read[] = [];
  const notTokens: Array<{ address: string; reason: string; by: string[] }> = [];
  for (const a of wanted) {
    const t = asked.get(a) as AssetReads['onchain']['tokens'][number];
    const answers = tokenAnswers(t.replies);
    const basics = tokenBasics(answers);
    if (!basics.ok) {
      notTokens.push({ address: a, reason: basics.reason, by: namedBy(a) });
      continue;
    }
    const own = codeOf.get(a);
    if (!own) throw new Error(`${basics.symbol} ${a}: its code was not read`);
    const beaconSlot = t.slots.beacon;
    const beaconAddress =
      beaconSlot && /^0x0{24}[0-9a-f]{40}$/i.test(beaconSlot) && !/^0x0+$/.test(beaconSlot)
        ? `0x${beaconSlot.slice(26)}`.toLowerCase()
        : null;
    const b = beaconAddress ? (beaconOf.get(beaconAddress) ?? null) : null;
    const routes = reads.onchain.facets.filter((f) => f.token === a);
    const ctx: CodeContext = {
      slots: t.slots,
      own,
      codeAt: (x: string) => codeOf.get(lower(x)) ?? null,
      beacon: b ? { implementation: b.implementation, owner: b.owner } : null,
      cloneTargetSlots: own.minimalProxyTarget
        ? (cloneSlotsOf.get(own.minimalProxyTarget) ?? null)
        : null,
      facets:
        routes.length > 0 ? Object.fromEntries(routes.map((f) => [f.selector, f.reply])) : null,
    };
    const reg = registry.get(a)?.row ?? null;
    tokensRead.push({
      address: a,
      symbol: basics.symbol,
      identity: {
        address: a,
        symbol: basics.symbol,
        name: basics.name,
        nameReason: basics.name === null ? 'no_text_from_name' : null,
        decimals: basics.decimals,
        standard: evmStandard(answers.asset, answers.convertToAssets),
        standardNote: null,
        extensions: evmExtensions(ctx),
        extensionsReason: null,
        authorities: evmAuthorities({
          owner: answers.owner,
          defaultAdmin: answers.defaultAdmin,
          code: ctx,
        }),
        authoritiesReason: null,
        read: {
          method: 'eth_call by Multicall3, eth_getStorageAt and eth_getCode',
          at,
          height: block,
          symbolFrom: 'erc20',
        },
        listingTags: namedBy(a),
        issuerRegistry: reg
          ? {
              symbol: reg.tokenSymbol ?? basics.symbol,
              name: reg.tokenName,
              decimals: reg.tokenDecimals,
              status: reg.status,
              isin: reg.isin,
              multiplier: reg.currentMultiplier,
            }
          : null,
      },
    });
  }
  const regMissing = [...registry.keys()].filter((a) => !tokensRead.some((t) => t.address === a));
  if (regMissing.length > 0)
    throw new Error(`registry tokens that do not answer as tokens: ${regMissing.join(', ')}`);
  for (const n of notTokens) {
    const v = verdictOfAddress.get(n.address);
    if (v) throw new Error(`${v.symbol} ${n.address} has a verdict and does not answer as a token`);
  }
  if (weth9 === null || !tokensRead.some((t) => t.address === weth9))
    throw new Error('WETH9() of the position manager gave no token');

  // the facts a rule's match is read against
  const registrySymbols = new Set([...registry.values()].map((r) => r.row.tokenSymbol ?? ''));
  const classTableOf = (a: string): string | null => {
    const reg = registry.get(a)?.row;
    if (!reg) return null;
    return (CLASS_BY_UNDERLYING[reg.tokenSymbol ?? ''] as string | undefined) ?? 'stock';
  };
  const factsOf = (t: { address: string; symbol: string }): Record<string, Set<string>> => ({
    listing: new Set(namedBy(t.address)),
    classTable: new Set(
      classTableOf(t.address) === null ? [] : [classTableOf(t.address) as string],
    ),
    symbolOf: new Set(
      !registry.has(t.address) && registrySymbols.has(t.symbol) ? ['issuer_registry'] : [],
    ),
  });
  const rulesOf = (t: { address: string; symbol: string }): string[] => {
    const facts = factsOf(t);
    return verdicts.rules
      .filter((r) =>
        Object.entries(r.match).every(([k, v]) => {
          const known = facts[k];
          if (!known) throw new Error(`rule ${r.name}: the builder reads no match key ${k}`);
          return known.has(v);
        }),
      )
      .map((r) => r.name);
  };
  const decided = (t: { address: string; symbol: string }) =>
    verdictOfAddress.has(t.address) || rulesOf(t).length > 0;
  /** The issuer (or the chain, for its own coin) a token's own verdict or its last matching rule names; null where none does. */
  const issuer0 = (t: { address: string; symbol: string }): string | null => {
    const matched = new Set(rulesOf(t));
    const v = verdictOfAddress.get(t.address);
    const layer =
      v ??
      verdicts.rules.filter((r) => matched.has(r.name) && r.fields.issuerKind !== undefined).at(-1)
        ?.fields;
    if (!layer) return null;
    return layer.issuer ?? (layer.issuerKind === 'chain_native' ? 'chain_native' : null);
  };
  /** The status a token's own verdict or its last matching rule gives, before the builder derives one. */
  const status0 = (t: { address: string; symbol: string }) => {
    const matched = new Set(rulesOf(t));
    return (
      verdictOfAddress.get(t.address)?.status ??
      verdicts.rules.filter((r) => matched.has(r.name) && r.fields.status).at(-1)?.fields.status ??
      (registry.has(t.address) ? 'candidate' : null)
    );
  };

  // which tokens are rows: the registry's, and the others a verdict or a rule decides; the ones that must be
  const mustHave = tokensRead.filter(
    (t) =>
      !registry.has(t.address) &&
      (notes.includes(t.address) ||
        t.address === weth9 ||
        namesAClass(t.symbol, names) ||
        namesAClass(dex.get(t.address)?.symbol ?? '', names)),
  );
  const noVerdict = mustHave.filter((t) => !decided(t));
  if (noVerdict.length > 0)
    throw new Error(
      `tokens a listing names in the product's classes with no verdict in ${files.verdictsPath}:\n${noVerdict
        .map((t) => `  ${t.symbol} ${t.address} (${namedBy(t.address).join(', ')})`)
        .join('\n')}`,
    );
  const rowsRead = tokensRead.filter((t) => registry.has(t.address) || decided(t));
  const notEnumerated = tokensRead.filter((t) => !registry.has(t.address) && !decided(t));

  // the gas coin
  const nativeVerdict = verdictOfAddress.get(NATIVE_ADDRESS);
  if (!nativeVerdict) throw new Error(`the gas coin ${NATIVE_ADDRESS} has no verdict`);
  const native: Read = {
    address: NATIVE_ADDRESS,
    symbol: nativeVerdict.symbol,
    identity: {
      address: NATIVE_ADDRESS,
      symbol: nativeVerdict.symbol,
      name: null,
      nameReason: 'native_coin_has_no_contract',
      decimals: 18,
      standard: 'native',
      standardNote:
        "the chain's gas coin: no contract answers for it; its symbol is the verdict's and its 18 decimals the EVM's",
      extensions: null,
      extensionsReason: 'native_coin_has_no_contract',
      authorities: null,
      authoritiesReason: 'native_coin_has_no_contract',
      read: {
        method: 'none: the gas coin has no contract',
        at,
        height: block,
        symbolFrom: 'native',
      },
      listingTags: ['screening_note', ...(dex.has(NATIVE_IN_POOLS) ? ['dexscreener'] : [])],
      issuerRegistry: null,
    },
  };
  const all = [...rowsRead, native];

  // ids
  const trackedById = new Map(files.tracked.assets.map((t) => [lower(t.address), t.id]));
  const shelfById = new Map(files.shelf.rows.map((r) => [lower(r.asset.address), r.asset.id]));
  const ids = new Map<string, string>();
  for (const t of all) {
    const fixed =
      trackedById.get(t.address) ??
      shelfById.get(t.address) ??
      (t.address === NATIVE_ADDRESS ? NATIVE_ID : null);
    if (fixed) ids.set(t.address, fixed);
  }
  const taken = new Set(ids.values());
  const byAddress = new Map(all.map((t) => [t.address, t]));
  const bySlug = new Map<string, string[]>();
  for (const t of all.filter((x) => !ids.has(x.address))) {
    const id = `robinhood:${slugOf(t.symbol)}`;
    bySlug.set(id, [...(bySlug.get(id) ?? []), t.address]);
  }
  for (const [id, addresses] of bySlug) {
    // a slug rows share goes to the one of them that is not excluded, where there is exactly one
    const kept = addresses.filter((a) => status0(byAddress.get(a) as Read) !== 'excluded');
    const owner =
      !taken.has(id) && (addresses.length === 1 || kept.length === 1)
        ? (kept[0] ?? addresses[0])
        : null;
    for (const a of addresses) ids.set(a, a === owner ? id : `${id}-${a.slice(2, 8)}`);
  }

  // listed
  // listed by a deploy record: the model of a test-network asset (its modelOf), or the cash token the
  // mainnet deploy config names by address
  const models = new Map<string, string>(
    files.deploy.assets.flatMap((x) => (x.modelOf ? [[x.modelOf, x.symbol] as const] : [])),
  );
  const cashToken = files.mainnetConfig.cashToken.toLowerCase();
  const deployModel = (t: Read): string | null => {
    if (t.address === cashToken) return `the cash token (cashToken) of ${files.mainnetConfig.path}`;
    const test = models.get(t.symbol);
    if (!test || !registry.has(t.address)) return null;
    return `the model of ${test} in ${files.deploy.path}`;
  };

  // oracles: Chainlink's directory, confirmed at the block
  const onchainFeeds = readFeeds(directory.feeds, reads.onchain.feeds);
  const notExcluded = all.filter((t) => status0(t) !== 'excluded');
  const feedSource = `${reads.directory.url}, then description(), decimals(), latestRoundData() and aggregator() of each proxy by eth_call at block ${block} on Robinhood Chain (chain ${reads.chainId}) through ${reads.rpcLabel}`;
  const matchCtx: MatchContext = {
    registry: notExcluded.map((t) => ({ address: t.address, symbol: t.symbol })),
    feeds: directory.feeds,
    onchain: onchainFeeds,
    blockTime: reads.onchain.blockTime,
    regime: files.regime,
    source: feedSource,
  };
  const oracleOf = (t: Read): Pick<RowContext, 'oracle' | 'oracleReason'> => {
    if (status0(t) === 'excluded') return { oracle: null, oracleReason: 'excluded_row' };
    const r = matchToken({ address: t.address, symbol: t.symbol }, false, matchCtx);
    if (!r.feed) {
      // a feed whose name reads as this symbol in another case is said, and not tied (letters as written)
      const otherCase = directory.feeds.some((f) => {
        const m = /^(?:Robinhood\s+|RH)?(\S+?)\s*(?:\/|-)\s*USD$/i.exec(f.name.trim());
        return m && m[1] !== t.symbol && (m[1] as string).toUpperCase() === t.symbol.toUpperCase();
      });
      return {
        oracle: null,
        oracleReason:
          r.reason === 'no_feed' && otherCase
            ? 'feed_named_in_other_case_not_tied'
            : (r.reason ?? 'no_feed'),
      };
    }
    // a feed names an asset, not an address: it is not tied to a token whose issuer is not confirmed
    if (issuer0(t) === null) return { oracle: null, oracleReason: 'issuer_not_confirmed' };
    const f = fundRow(r, null);
    const oracle: TrackedOracle = {
      kind: 'chainlink',
      ref: lower(r.feed.address),
      account: null,
      twapRef: null,
      description: r.feed.description,
      decimals: r.feed.decimals,
      prices: f.prices,
      pricesReason: f.prices === null ? 'not_stated_in_directory' : null,
      source: r.source,
      fetchedAt: r.fetchedAt,
      method: r.method,
      provenance: 'live',
    };
    return { oracle, oracleReason: null };
  };

  const registrySet = new Set(registry.keys());
  const discoveryNote = `${files.discovery.file} (${STOCK_SOURCE}, ${day(files.discovery.fetchedAt)}) and DexScreener's pairs of ${day(reads.dexscreener.at)} (pools with none)`;
  const dateOf = day(reads.registry.at);
  const stamp = {
    source: `${reads.registry.url}, ${reads.directory.url} and DexScreener's search and token pairs, then the tokens by eth_call through Multicall3, eth_getStorageAt and eth_getCode at block ${block} on Robinhood Chain (chain ${reads.chainId}) through ${reads.rpcLabel}`,
    fetchedAt: at,
    method: ASSETS_METHOD,
    provenance: 'live' as const,
  };

  const rows: UniverseAsset[] = [];
  for (const t of all) {
    const reg = registry.get(t.address)?.row ?? null;
    const id = ids.get(t.address) as string;
    const tracked = trackedById.has(t.address);
    const model = deployModel(t);
    const listedIn: RowContext['listedIn'] = [
      ...(model ? (['deploy_record'] as const) : []),
      ...(tracked ? (['tracked_stock'] as const) : []),
    ];
    const classTable = classTableOf(t.address);
    const rules = rulesOf(t);
    let derived: Parameters<typeof universeRow>[2]['derived'];
    if (reg) {
      const symbol = reg.tokenSymbol ?? t.symbol;
      const leg = classTable === 'dollar_yield' ? files.legTypes.rows[symbol] : undefined;
      const reason = tracked
        ? `a tracked stock of ${files.tracked.path} (gate UNIVERSE)${model ? `, and ${model}` : ''}`
        : `outside the 80% cut (DA16): a stock token of the issuer's registry that ${files.tracked.cut} does not name`;
      derived = {
        underlying: symbol,
        underlyingReason: null,
        status: listedIn.length > 0 ? 'listed' : 'candidate',
        statusReason: reason,
        legTypes:
          classTable !== 'dollar_yield'
            ? null
            : leg
              ? leg.types.map((type) => ({
                  type: type as 'rate' | 'credit' | 'basis' | 'market_deposit',
                  source: `${leg.source} (${files.legTypes.path})`,
                  readOn: leg.readAt,
                }))
              : null,
        legTypesReason:
          classTable === 'dollar_yield' && !leg ? `no row for ${symbol} in leg-types.ts` : null,
        sources: [
          {
            url: reads.registry.url,
            title: `Robinhood's stock token registry: ${reg.tokenName ?? symbol}, ISIN ${reg.isin ?? 'none given'}`,
            readOn: dateOf,
          },
        ],
      };
    }
    const pools = tracked
      ? null
      : poolCount({
          address: t.address,
          aliases: t.address === NATIVE_ADDRESS ? [NATIVE_IN_POOLS] : [],
          discovery: files.discovery,
          dex: reads.dexscreener.pairs,
          registry: registrySet,
        });
    const total = pools ? pools.confirmed + pools.unconfirmed : 0;
    const context: RowContext = {
      id,
      ...(tracked ? { oracle: null, oracleReason: IN_TRACKED_ROW } : oracleOf(t)),
      unverifiedOracles: [],
      listedIn,
      pools: pools && total > 0 ? { ...pools, file: discoveryNote } : null,
      poolsReason: tracked ? IN_TRACKED_ROW : total > 0 ? null : 'no_known_pool',
      tracked: tracked ? { list: files.tracked.path, id } : null,
      attributes:
        reg && files.content.symbols.includes(reg.tokenSymbol ?? '')
          ? { file: files.content.path, symbol: reg.tokenSymbol as string }
          : null,
    };
    rows.push(
      universeRow('robinhood', verdicts, { identity: t.identity, context, rules, derived }, stamp),
    );
  }

  // the reads, each with its calls and time
  const o = reads.onchain;
  const readRows: UniverseRead[] = [
    {
      name: 'issuer_registry',
      what: `GET ${reads.registry.url}`,
      at: reads.registry.at,
      calls: reads.registry.calls,
      durationMs: reads.registry.durationMs,
      rows: reads.registry.rows.length,
      errors: reads.registry.errors,
    },
    {
      name: 'chainlink_directory',
      what: `GET ${reads.directory.url}`,
      at: reads.directory.at,
      calls: reads.directory.calls,
      durationMs: reads.directory.durationMs,
      rows: directory.feeds.length,
      errors: reads.directory.errors,
    },
    {
      name: 'dexscreener',
      what: `GET https://api.dexscreener.com/latest/dex/search?q=robinhood%20<name> (${reads.dexscreener.queries.filter((q) => q.kind === 'search').length}) and /token-pairs/v1/robinhood/<token> (${reads.dexscreener.queries.filter((q) => q.kind === 'token_pairs').length}); rows are the distinct pairs on the chain`,
      at: reads.dexscreener.at,
      calls: reads.dexscreener.calls,
      durationMs: reads.dexscreener.durationMs,
      rows: reads.dexscreener.pairs.length,
      errors: reads.dexscreener.errors,
    },
    {
      name: 'token_calls',
      what: `eth_call of Multicall3 ${o.multicall3} at block ${block}: WETH9() of the v4 position manager, then decimals(), symbol(), name(), asset(), convertToAssets(1e18), owner() and defaultAdmin() of every address named, implementation() and owner() of each beacon, getFacet(<selector>) of each facet router for the pause and blacklist selectors, and eth_getCode of each facet it names; rows are the addresses asked`,
      at: o.phases.calls.at,
      calls: o.phases.calls.calls,
      durationMs: o.phases.calls.durationMs,
      rows: o.tokens.length,
      errors: o.phases.calls.errors,
    },
    {
      name: 'proxy_slots',
      what: `eth_getStorageAt of the EIP-1967 implementation, admin and beacon slots of every address named and of each clone's target, at block ${block}`,
      at: o.phases.slots.at,
      calls: o.phases.slots.calls,
      durationMs: o.phases.slots.durationMs,
      rows: o.tokens.length,
      errors: o.phases.slots.errors,
    },
    {
      name: 'code',
      what: `eth_getCode of every address named, every implementation and every clone's target, at block ${block}; rows are the codes read, with the facets read beside the router's calls`,
      at: o.phases.code.at,
      calls: o.phases.code.calls,
      durationMs: o.phases.code.durationMs,
      rows: o.code.length,
      errors: o.phases.code.errors,
    },
    {
      name: 'chainlink_feeds',
      what: `eth_call of Multicall3 at block ${block}: description(), decimals(), latestRoundData() and aggregator() of each proxy of the directory, latestRoundData() of its aggregator`,
      at: o.phases.feeds.at,
      calls: o.phases.feeds.calls,
      durationMs: o.phases.feeds.durationMs,
      rows: directory.feeds.length,
      errors: o.phases.feeds.errors,
    },
  ];

  const list = universeList({
    chain: 'robinhood',
    rows,
    reads: readRows,
    inputs: {
      registry: reads.registry.url,
      directory: reads.directory.url,
      dexscreener: 'https://api.dexscreener.com',
      discovery: files.discovery.file,
      tracked: files.tracked.path,
      shelf: files.shelf.path,
      deploy: files.deploy.path,
      mainnetConfig: files.mainnetConfig.path,
      content: files.content.path,
      legTypes: files.legTypes.path,
      notes: files.notes.map((n) => n.path).join(', '),
      verdicts: files.verdictsPath,
      calendar: files.calendarPath,
      frozen: files.frozenPath,
    },
    stated: STATED,
    stamp,
  });

  // what the run says in words
  const disagree = tokensRead
    .filter((t) => t.identity.issuerRegistry)
    .filter(
      (t) =>
        t.identity.issuerRegistry?.symbol !== t.symbol ||
        t.identity.issuerRegistry?.decimals !== t.identity.decimals,
    )
    .map((t) => `${t.identity.issuerRegistry?.symbol} ${t.address}`);
  const classMatched = [...dex.entries()].filter(([, v]) => namesAClass(v.symbol, names)).length;
  lines.push(
    `the RPC answered ${reads.onchain.challenged ?? 0} requests with a Cloudflare challenge; each was asked again after a wait`,
    `issuer registry: ${reads.registry.assets} rows, ${registry.size} tokens on chain ${reads.chainId}${skipped.length ? `, ${skipped.length} left out (${skipped.map((s) => `${s.symbol}: ${s.reason}`).join('; ')})` : ''}`,
    `chain and registry: symbol and decimals agree for ${registry.size - disagree.length} of the ${registry.size} tokens${disagree.length ? ` (differ: ${disagree.join(', ')})` : ''}`,
    `screening note: ${notes.length} addresses written; ${notes.filter((a) => tokensRead.some((t) => t.address === a)).length} answer as tokens`,
    `DexScreener: ${reads.dexscreener.pairs.length} pairs, ${dex.size} tokens named, ${classMatched} with a class name; ${notEnumerated.length} tokens read and not enumerated (no verdict, no class name)`,
    `not a token (${notTokens.length}): ${notTokens.map((n) => `${n.address} ${n.reason} (${n.by.join(', ')})`).join('; ') || 'none'}`,
    `Chainlink: ${directory.feeds.length} feeds; tied to a row here: ${
      rows
        .filter((r) => r.oracle)
        .map((r) => `${r.symbol} ${r.oracle?.description}`)
        .join(', ') || 'none'
    }`,
  );
  return { list, lines };
}

/** What --freeze writes beside the list, and the test reads. */
export type FrozenReads = { reads: AssetReads; discovery: DiscoveryCut };

/** The names of the run, for the scratch folder: every token read, with its symbol and whether it is a row. */
export function namesTable(reads: AssetReads, files: AssetFiles, list: UniverseList | null) {
  const dex = dexNames(reads);
  const rows = new Map((list?.assets ?? []).map((a) => [addressKey('robinhood', a.address), a]));
  return reads.onchain.tokens.map((t) => {
    const a = tokenAnswers(t.replies);
    const row = rows.get(lower(t.address));
    return {
      address: lower(t.address),
      symbol: a.symbol.success ? decodeAbiText(a.symbol.data) : null,
      name: a.name.success ? decodeAbiText(a.name.data) : null,
      dexscreener: dex.get(lower(t.address)) ?? null,
      row: row ? { id: row.id, category: row.category, status: row.status } : null,
      verdict: files.verdicts.verdicts.some((v) => lower(v.address) === lower(t.address)),
    };
  });
}
