// The reads of the Robinhood Chain asset universe (PLAN-ASSETS AS.3): the issuer's registry, Chainlink's
// directory and DexScreener by public GETs, then every address they and the screening note name, read on
// chain at one block through Multicall3, eth_getStorageAt and eth_getCode. Read-only: no transaction, no
// key. Everything goes through the client and the fetch it is given, so a test can hand it recordings.
import { createHash } from 'node:crypto';
import {
  BEACON_CALLS,
  type CallReply,
  type CodeScan,
  codeLayout,
  EIP1967,
  FACET_QUERIES,
  getFacetCall,
  isFacetRouter,
  scanCode,
  slotValue,
  TOKEN_CALLS,
  tokenCallData,
  WATCHED_SELECTORS,
  wordAddress,
} from '@colosseum/risk';
import type { Call } from './abi';
import {
  type AssetReads,
  addressesToRead,
  type CoinCut,
  classNames,
  cryptoSelection,
  cryptoToRead,
  type DexPairCut,
  type DexQuery,
  dexNames,
  dexToRead,
  listedCrypto,
  NATIVE_ADDRESS,
  NATIVE_IN_POOLS,
  namesAClass,
  type Phase,
  type RegistryRowCut,
  registryTokens,
  searchTerms,
} from './assets-list';
import type { ChainConfig } from './config';
import { feedCalls, parseDirectory } from './feeds';
import { multicall } from './multicall';
import type { Rpc } from './rpc';

export type ReadDeps = {
  rpc: Rpc;
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
};

export type ReadInput = {
  chain: ChainConfig;
  registryUrl: string;
  directoryUrl: string;
  rpcLabel: string;
  /** Every full address the screening note and its inputs write. */
  notes: string[];
  /** The addresses the verdict table names: a DexScreener name among them is read on chain. */
  verdictAddresses: string[];
  /** Every address of a committed list of the chain: each is read again, every run (no silent drop). */
  previous?: string[];
  /** How many RPC requests were answered with a challenge so far (the caller's fetch counts them). */
  challenged?: () => number;
  /** Awaited before each attempt at the chain: the caller keeps it out of the collector's minutes. */
  beforeChain?: () => Promise<void>;
  /** Milliseconds between two DexScreener calls. */
  dexSpacingMs?: number;
  log?: (line: string) => void;
};

const DEX = 'https://api.dexscreener.com';
/** eth_getStorageAt and eth_getCode requests sent in one JSON-RPC batch. */
const SLOT_BATCH = 60;
const CODE_BATCH = 20;
/** WETH9() of the Uniswap v4 position manager: the wrapped native coin it unwraps. */
const WETH9 = '0x4aa4a4fc';

const lower = (a: string) => a.toLowerCase();
const isoNow = (deps: ReadDeps) => new Date(deps.now()).toISOString();
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;

/** One registry row cut to the fields the list reads. */
export function cutRegistryRow(a: Record<string, unknown>): RegistryRowCut {
  const deployments = Array.isArray(a.deployments)
    ? (a.deployments as Array<Record<string, unknown>>)
    : [];
  return {
    id: text(a.id),
    tokenSymbol: text(a.tokenSymbol),
    tokenName: text(a.tokenName),
    tokenDecimals: int(a.tokenDecimals),
    isin: text(a.isin),
    status: text(a.status),
    currentMultiplier: text(a.currentMultiplier),
    deployments: deployments.map((d) => ({
      chainId: int(d?.chainId),
      contractAddress: text(d?.contractAddress),
    })),
  };
}

/** One directory entry cut to the fields parseDirectory reads. */
export function cutDirectoryEntry(f: Record<string, unknown>): Record<string, unknown> {
  const docs = (f?.docs ?? {}) as Record<string, unknown>;
  const keep = (o: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    ...keep(f, [
      'name',
      'path',
      'proxyAddress',
      'contractAddress',
      'secondaryProxyAddress',
      'decimals',
      'heartbeat',
      'assetName',
    ]),
    docs: keep(docs, [
      'baseAsset',
      'marketHours',
      'productTypeCode',
      'attributeType',
      'assetClass',
    ]),
  };
}

/** A DexScreener pair cut to its names and addresses; null for another chain's or a malformed one. */
export function cutPair(p: Record<string, unknown>, chainSlug: string): DexPairCut | null {
  if (p?.chainId !== chainSlug) return null;
  const token = (t: unknown) => {
    const o = (t ?? {}) as Record<string, unknown>;
    return {
      address: String(o.address ?? ''),
      symbol: String(o.symbol ?? ''),
      name: String(o.name ?? ''),
    };
  };
  const pairAddress = text(p.pairAddress);
  if (!pairAddress) return null;
  return {
    pairAddress,
    dexId: String(p.dexId ?? ''),
    labels: Array.isArray(p.labels) ? (p.labels as unknown[]).map(String) : [],
    base: token(p.baseToken),
    quote: token(p.quoteToken),
  };
}

async function timed<T>(deps: ReadDeps, fn: () => Promise<T>) {
  const before = deps.rpc.stats();
  const start = deps.now();
  const at = isoNow(deps);
  const value = await fn();
  const after = deps.rpc.stats();
  const phase: Phase = {
    at,
    durationMs: Math.round(deps.now() - start),
    calls: after.rpcCalls - before.rpcCalls,
    httpRequests: after.httpRequests - before.httpRequests,
    errors: 0,
  };
  return { value, phase };
}

export type Listings = Pick<
  AssetReads,
  'registry' | 'directory' | 'dexscreener' | 'coingecko' | 'ccip' | 'volume'
>;

const COINGECKO_LIST = 'https://tokens.coingecko.com/robinhood/all.json';
const COINGECKO_API = 'https://api.coingecko.com/api/v3';
/** CoinGecko's category of the chain's memecoins, and its name as the category list gives it. */
const MEME_CATEGORY = 'robinhood-chain-meme';
const MEME_CATEGORY_NAME = 'Robinhood Chain Meme';
const CCIP_TOKENS = 'https://docs.chain.link/api/ccip/v1/tokens?environment=mainnet';
/** CoinGecko's keyless API: one call every 6 seconds, a minute's wait on a refusal for rate. */
const COINGECKO_SPACING_MS = 6_000;

/** CoinGecko's page of a coin cut to what the list reads. */
export function cutCoin(
  address: string,
  status: number,
  d: Record<string, unknown> | null,
  via: CoinCut['via'] = 'page',
): CoinCut {
  const links = (d?.links ?? {}) as { homepage?: unknown[] };
  const platforms = (d?.platforms ?? {}) as Record<string, unknown>;
  const home = Array.isArray(links.homepage)
    ? links.homepage.find((h) => typeof h === 'string' && h !== '')
    : null;
  return {
    address: address.toLowerCase(),
    status,
    id: text(d?.id),
    symbol: text(d?.symbol),
    name: text(d?.name),
    categories: Array.isArray(d?.categories)
      ? (d.categories as unknown[]).filter((c): c is string => typeof c === 'string')
      : [],
    homepage: typeof home === 'string' ? home : null,
    platformAddress:
      typeof platforms.robinhood === 'string' ? platforms.robinhood.toLowerCase() : null,
    via,
  };
}

/** The public GETs: the registry, the directory, then DexScreener in two rounds. */
export async function readListings(deps: ReadDeps, input: ReadInput) {
  const log = input.log ?? (() => {});
  const getOne = async (url: string) => {
    const start = deps.now();
    const at = isoNow(deps);
    const json = await deps.fetchJson(url);
    return { json, at, durationMs: Math.round(deps.now() - start) };
  };

  const reg = await getOne(input.registryUrl);
  const assets = (reg.json as { assets?: unknown })?.assets;
  if (!Array.isArray(assets)) throw new Error('registry: no list of assets in the answer');
  const registry: AssetReads['registry'] = {
    url: input.registryUrl,
    at: reg.at,
    durationMs: reg.durationMs,
    calls: 1,
    httpRequests: 1,
    errors: 0,
    assets: assets.length,
    rows: (assets as Array<Record<string, unknown>>).map(cutRegistryRow),
  };
  log(`registry: ${assets.length} rows`);

  const dir = await getOne(input.directoryUrl);
  if (!Array.isArray(dir.json)) throw new Error('directory: the answer is not a list of feeds');
  const entries = (dir.json as Array<Record<string, unknown>>).map(cutDirectoryEntry);
  const directory: AssetReads['directory'] = {
    url: input.directoryUrl,
    at: dir.at,
    durationMs: dir.durationMs,
    calls: 1,
    httpRequests: 1,
    errors: 0,
    entries,
  };
  log(`directory: ${entries.length} feeds`);

  // DexScreener: every class name searched, then the pairs of each address worth asking about
  const slug = input.chain.dexscreener;
  const pairs: DexPairCut[] = [];
  const pairIndex = new Map<string, number>();
  const queries: DexQuery[] = [];
  const dexStart = deps.now();
  const dexAt = isoNow(deps);
  let calls = 0;
  let errors = 0;
  const ask = async (kind: DexQuery['kind'], query: string, url: string) => {
    if (calls > 0) await deps.sleep(input.dexSpacingMs ?? 1_100);
    calls++;
    const at = isoNow(deps);
    let json: unknown;
    let error: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        json = await deps.fetchJson(url);
        error = null;
        break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        await deps.sleep(5_000);
      }
    }
    if (error !== null) errors++;
    const raw =
      kind === 'search'
        ? ((json as { pairs?: unknown[] })?.pairs ?? [])
        : ((json as unknown[]) ?? []);
    const found: number[] = [];
    for (const p of Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []) {
      const cut = cutPair(p, slug);
      if (!cut) continue;
      const key = lower(cut.pairAddress);
      let i = pairIndex.get(key);
      if (i === undefined) {
        i = pairs.length;
        pairs.push(cut);
        pairIndex.set(key, i);
      }
      if (!found.includes(i)) found.push(i);
    }
    queries.push({ kind, query, url, at, ok: error === null, error, pairs: found });
  };
  const directoryNames = parseDirectory(entries).feeds.map((f) => f.name);
  for (const term of searchTerms(directoryNames))
    await ask(
      'search',
      term,
      `${DEX}/latest/dex/search?q=${encodeURIComponent(`robinhood ${term}`)}`,
    );
  const reads0 = { chainId: input.chain.chainId, registry } as AssetReads;
  const registrySet = new Set(registryTokens(reads0).tokens.keys());
  const names = classNames(
    registry.rows.map((r) => r.tokenSymbol ?? ''),
    directoryNames,
  );
  const named = dexNames({ dexscreener: { pairs } } as AssetReads);
  const toAsk = new Set<string>(input.notes.map(lower));
  for (const [a, v] of named) if (namesAClass(v.symbol, names)) toAsk.add(a);
  for (const a of [...toAsk]) if (registrySet.has(a) || a === NATIVE_IN_POOLS) toAsk.delete(a);
  for (const a of [...toAsk].sort())
    await ask('token_pairs', a, `${DEX}/token-pairs/v1/${slug}/${a}`);
  const dexscreener: AssetReads['dexscreener'] = {
    at: dexAt,
    durationMs: Math.round(deps.now() - dexStart),
    calls,
    httpRequests: calls,
    errors,
    queries,
    pairs,
  };
  log(`DexScreener: ${calls} calls, ${pairs.length} pairs, ${errors} errors`);

  // the token lists of CoinGecko and of Chainlink CCIP: names and addresses on the chain
  const cgList = await getOne(COINGECKO_LIST);
  const cgTokens = (
    ((cgList.json as { tokens?: unknown[] })?.tokens ?? []) as Array<Record<string, unknown>>
  ).filter((t) => t?.chainId === input.chain.chainId && typeof t.address === 'string');
  const ccipAnswer = await getOne(CCIP_TOKENS);
  const ccipData = ((ccipAnswer.json as { data?: unknown })?.data ?? {}) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const ccipTokens = Object.values(ccipData).flatMap((byChain) => {
    const t = byChain?.[String(input.chain.chainId)];
    return t && typeof t.tokenAddress === 'string'
      ? [
          {
            address: t.tokenAddress.toLowerCase(),
            symbol: String(t.symbol ?? ''),
            name: String(t.name ?? ''),
            decimals: int(t.decimals),
          },
        ]
      : [];
  });
  const ccip: AssetReads['ccip'] = {
    url: CCIP_TOKENS,
    at: ccipAnswer.at,
    durationMs: ccipAnswer.durationMs,
    calls: 1,
    httpRequests: 1,
    errors: 0,
    tokens: ccipTokens.sort((a, b) => (a.address < b.address ? -1 : 1)),
  };

  // the day's DexScreener volume of every listed token, 30 addresses a call
  const registrySet0 = new Set(
    registryTokens({ chainId: input.chain.chainId, registry } as AssetReads).tokens.keys(),
  );
  const listed = listedCrypto(
    {
      coingecko: {
        list: cgTokens.map((t) => ({
          address: String(t.address),
          symbol: String(t.symbol ?? ''),
          name: String(t.name ?? ''),
          decimals: int(t.decimals),
        })),
      },
      ccip,
    } as AssetReads,
    registrySet0,
  );
  const volStart = deps.now();
  const volAt = isoNow(deps);
  const volPairs = new Map<string, AssetReads['volume']['pairs'][number]>();
  let volCalls = 0;
  let volErrors = 0;
  const addresses = [...listed.keys()].sort();
  for (let i = 0; i < addresses.length; i += 30) {
    if (volCalls > 0) await deps.sleep(input.dexSpacingMs ?? 1_100);
    volCalls++;
    let answer: unknown = [];
    try {
      answer = await deps.fetchJson(
        `${DEX}/tokens/v1/${slug}/${addresses.slice(i, i + 30).join(',')}`,
      );
    } catch {
      volErrors++;
    }
    for (const p of Array.isArray(answer) ? (answer as Array<Record<string, unknown>>) : []) {
      const cut = cutPair(p, slug);
      if (!cut) continue;
      const v = (p.volume as { h24?: unknown } | undefined)?.h24;
      volPairs.set(cut.pairAddress.toLowerCase(), {
        pairAddress: cut.pairAddress.toLowerCase(),
        base: cut.base.address.toLowerCase(),
        quote: cut.quote.address.toLowerCase(),
        h24: typeof v === 'number' && Number.isFinite(v) ? v : null,
      });
    }
  }
  const volume: AssetReads['volume'] = {
    at: volAt,
    durationMs: Math.round(deps.now() - volStart),
    calls: volCalls,
    httpRequests: volCalls,
    errors: volErrors,
    pairs: [...volPairs.values()].sort((a, b) => (a.pairAddress < b.pairAddress ? -1 : 1)),
  };
  log(`DexScreener volume: ${volCalls} calls, ${volume.pairs.length} pairs, ${volErrors} errors`);

  // CoinGecko's page of each selected token, slowly
  const cgBase = {
    listUrl: COINGECKO_LIST,
    list: cgTokens
      .map((t) => ({
        address: String(t.address).toLowerCase(),
        symbol: String(t.symbol ?? ''),
        name: String(t.name ?? ''),
        decimals: int(t.decimals),
      }))
      .sort((a, b) => (a.address < b.address ? -1 : 1)),
  };
  const selected = cryptoSelection(
    { coingecko: { ...cgBase, coins: [] } as unknown as AssetReads['coingecko'], ccip, volume },
    registrySet0,
    parseDirectory(entries).feeds.map((f) => f.name),
    registry.rows.map((r) => r.tokenSymbol ?? ''),
  );
  // the page of every selected token, every verdict's and every row of a committed list outside the
  // registry: what CoinGecko says of each decides it the same way, whether or not today's volume selected it
  const lookedUp = new Set([
    ...selected.keys(),
    ...[...input.verdictAddresses, ...(input.previous ?? [])]
      .map(lower)
      .filter((a) => !registrySet0.has(a) && a !== NATIVE_IN_POOLS && a !== NATIVE_ADDRESS),
  ]);
  const coingecko = await readCoinGecko(deps, {
    base: cgBase,
    at: cgList.at,
    durationMs: cgList.durationMs,
    selected: [...lookedUp],
    log,
  });
  return { registry, directory, dexscreener, coingecko, ccip, volume };
}

/**
 * CoinGecko, keyless and slow: its category names, the coins of the chain's memecoin category, every
 * coin's address on the chain, and the page of each selected token outside that category. Pages already
 * read (`cache`, from a run's saved listings) are not asked again.
 */
export async function readCoinGecko(
  deps: ReadDeps,
  args: {
    base: { listUrl: string; list: AssetReads['coingecko']['list'] };
    at: string;
    durationMs: number;
    selected: string[];
    cache?: CoinCut[];
    log?: (line: string) => void;
  },
): Promise<AssetReads['coingecko']> {
  const cgStart = deps.now();
  let cgCalls = 0;
  let cgErrors = 0;
  const cg = async (url: string): Promise<{ status: number; json: unknown }> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await deps.sleep(attempt === 0 ? COINGECKO_SPACING_MS : 60_000);
      cgCalls++;
      try {
        return { status: 200, json: await deps.fetchJson(url) };
      } catch (e) {
        const m = /HTTP (\d{3})/.exec(e instanceof Error ? e.message : '');
        const status = m ? Number(m[1]) : 0;
        if (status !== 429) return { status, json: null };
      }
    }
    return { status: 429, json: null };
  };
  const cats = await cg(`${COINGECKO_API}/coins/categories/list`);
  if (cats.status !== 200) cgErrors++;
  const categoryNames = (Array.isArray(cats.json) ? (cats.json as Array<{ name?: unknown }>) : [])
    .flatMap((c) => (typeof c.name === 'string' ? [c.name] : []))
    .sort();
  const memeIds = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const r = await cg(
      `${COINGECKO_API}/coins/markets?vs_currency=usd&category=${MEME_CATEGORY}&per_page=250&page=${page}`,
    );
    if (r.status !== 200) {
      cgErrors++;
      break;
    }
    const ids = (Array.isArray(r.json) ? (r.json as Array<{ id?: unknown }>) : []).flatMap((c) =>
      typeof c.id === 'string' ? [c.id] : [],
    );
    for (const id of ids) memeIds.add(id);
    if (ids.length < 250) break;
  }
  const idByAddress: Record<string, string> = {};
  const all = await cg(`${COINGECKO_API}/coins/list?include_platform=true`);
  if (all.status !== 200) cgErrors++;
  for (const c of Array.isArray(all.json)
    ? (all.json as Array<{ id?: unknown; platforms?: Record<string, unknown> }>)
    : []) {
    const a = c.platforms?.robinhood;
    if (typeof c.id === 'string' && typeof a === 'string' && a !== '')
      idByAddress[a.toLowerCase()] = c.id;
  }
  const cached = new Map(
    (args.cache ?? []).filter((c) => c.via === 'page').map((c) => [c.address, c]),
  );
  const coins: CoinCut[] = [];
  for (const a of [...args.selected].sort()) {
    const id = idByAddress[a];
    if (id && memeIds.has(id)) {
      coins.push(
        cutCoin(
          a,
          200,
          { id, categories: [MEME_CATEGORY_NAME], platforms: { robinhood: a } },
          'meme_category',
        ),
      );
      continue;
    }
    const hit = cached.get(a);
    if (hit && (hit.status === 200 || hit.status === 404)) {
      coins.push(hit);
      continue;
    }
    const r = await cg(
      `${COINGECKO_API}/coins/robinhood/contract/${a}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
    );
    if (r.status !== 200 && r.status !== 404) cgErrors++;
    coins.push(cutCoin(a, r.status, r.status === 200 ? (r.json as Record<string, unknown>) : null));
    args.log?.(`CoinGecko page ${coins.length} of ${args.selected.length}: ${a} ${r.status}`);
  }
  args.log?.(
    `CoinGecko: ${args.base.list.length} listed, ${args.selected.length} selected, ${cgCalls} calls, ${cgErrors} errors`,
  );
  return {
    ...args.base,
    at: args.at,
    durationMs: args.durationMs + Math.round(deps.now() - cgStart),
    calls: 1 + cgCalls,
    httpRequests: 1 + cgCalls,
    errors: cgErrors,
    categoryNames,
    memeIds: [...memeIds].sort(),
    idByAddress: Object.fromEntries(
      Object.entries(idByAddress).sort(([x], [y]) => (x < y ? -1 : 1)),
    ),
    coins,
  };
}

/** Every read on chain, pinned to one block. Throws on any refusal of the endpoint. */
async function readOnchain(deps: ReadDeps, input: ReadInput, listings: Listings) {
  const { rpc } = deps;
  const m3 = input.chain.multicall3;
  const pm = input.chain.v4?.positionManager;
  if (!pm) throw new Error(`${input.chain.id} has no v4 position manager in config.ts`);
  const head = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
    'latest',
    false,
  ]);
  const tag = head.number;

  const calls = await timed(deps, async () => {
    const [weth9] = await multicall(rpc, m3, [{ target: pm, callData: WETH9 }], tag);
    const weth = weth9?.success ? wordAddress(weth9.data) : null;
    const reads0 = {
      chainId: input.chain.chainId,
      registry: listings.registry,
      dexscreener: listings.dexscreener,
    } as AssetReads;
    const names = classNames(
      listings.registry.rows.map((r) => r.tokenSymbol ?? ''),
      parseDirectory(listings.directory.entries).feeds.map((f) => f.name),
    );
    const addresses = addressesToRead({
      registry: [...registryTokens(reads0).tokens.keys()],
      notes: input.notes,
      dex: [
        ...dexToRead(reads0, names, input.verdictAddresses),
        ...cryptoToRead(
          listings,
          new Set(registryTokens(reads0).tokens.keys()),
          parseDirectory(listings.directory.entries).feeds.map((f) => f.name),
          listings.registry.rows.map((r) => r.tokenSymbol ?? ''),
          input.verdictAddresses,
        ),
        // every verdict's address and every row of a committed list, every run
        ...input.verdictAddresses,
        ...(input.previous ?? []),
      ],
      weth9: weth,
    });
    const data = tokenCallData();
    const tokenCalls: Call[] = addresses.flatMap((a) =>
      data.map((callData) => ({ target: a, callData })),
    );
    const replies = await multicall(rpc, m3, tokenCalls, tag);
    return { weth9: weth9 as CallReply, addresses, replies };
  });
  const { addresses } = calls.value;

  /** The three EIP-1967 slots of each address, 20 addresses a request. */
  const readSlots = async (list: string[]) => {
    const out: Array<{ implementation: string; admin: string; beacon: string }> = [];
    const keys = [EIP1967.implementation, EIP1967.admin, EIP1967.beacon];
    for (let i = 0; i < list.length; i += SLOT_BATCH / 3) {
      const part = list.slice(i, i + SLOT_BATCH / 3);
      const replies = await rpc.batch(
        part.flatMap((a) => keys.map((k) => ({ method: 'eth_getStorageAt', params: [a, k, tag] }))),
      );
      for (const [j, r] of replies.entries())
        if (r.error || typeof r.result !== 'string')
          throw new Error(
            `eth_getStorageAt ${part[Math.floor(j / 3)]}: ${r.error?.message ?? 'no result'}`,
          );
      for (let j = 0; j < part.length; j++)
        out.push({
          implementation: replies[j * 3]?.result as string,
          admin: replies[j * 3 + 1]?.result as string,
          beacon: replies[j * 3 + 2]?.result as string,
        });
    }
    return out;
  };
  const slots = await timed(deps, () => readSlots(addresses));

  // each beacon: the implementation its proxies run, and its owner
  const beaconAddresses = [
    ...new Set(
      slots.value.flatMap((s) => {
        const b = slotValue(s.beacon);
        return b.kind === 'address' ? [b.address] : [];
      }),
    ),
  ].sort();
  const beaconReplies = await timed(deps, () =>
    multicall(
      rpc,
      m3,
      beaconAddresses.flatMap((b) =>
        BEACON_CALLS.map(([, sel]) => ({ target: b, callData: `0x${sel}` })),
      ),
      tag,
    ),
  );
  const beacons = beaconAddresses.map((address, i) => ({
    address,
    implementation: beaconReplies.value[i * 2] as CallReply,
    owner: beaconReplies.value[i * 2 + 1] as CallReply,
  }));

  // the code: every address, every implementation, then every clone's target
  const raw = new Map<string, string>();
  const scans = new Map<string, CodeScan & { sha256: string }>();
  const fetchCode = async (list: string[]) => {
    const todo = list.filter((a) => !scans.has(a));
    for (let i = 0; i < todo.length; i += CODE_BATCH) {
      const part = todo.slice(i, i + CODE_BATCH);
      const replies = await rpc.batch(
        part.map((a) => ({ method: 'eth_getCode', params: [a, tag] })),
      );
      for (const [j, r] of replies.entries()) {
        if (r.error || typeof r.result !== 'string')
          throw new Error(`eth_getCode ${part[j]}: ${r.error?.message ?? 'no result'}`);
        raw.set(part[j] as string, r.result);
        scans.set(part[j] as string, {
          ...scanCode(r.result),
          sha256: createHash('sha256')
            .update(Buffer.from(r.result.slice(2), 'hex'))
            .digest('hex'),
        });
      }
    }
  };
  const code = await timed(deps, async () => {
    const impls = slots.value.flatMap((s) => {
      const v = slotValue(s.implementation);
      return v.kind === 'address' ? [v.address] : [];
    });
    const beaconImpls = beacons.flatMap((b) => {
      const a = b.implementation.success ? wordAddress(b.implementation.data) : null;
      return a ? [a] : [];
    });
    await fetchCode([...new Set([...addresses, ...impls, ...beaconImpls])]);
    const targets = [...scans.values()].flatMap((s) =>
      s.minimalProxyTarget ? [s.minimalProxyTarget] : [],
    );
    await fetchCode([...new Set(targets)]);
  });

  // the slots of each clone's target, which are its own storage and not the clone's
  const targets = [
    ...new Set(
      addresses.flatMap((a) => {
        const t = scans.get(a)?.minimalProxyTarget;
        return t ? [t] : [];
      }),
    ),
  ].sort();
  const targetSlots = await timed(deps, () => readSlots(targets));

  // a facet router's table: getFacet(<selector>) of each token whose running code pushes it
  const beaconOf = new Map(beacons.map((b) => [b.address, b]));
  const routers = addresses.filter((a, i) => {
    const own = scans.get(a);
    if (!own) return false;
    const slotsOf = slots.value[i] as { implementation: string; admin: string; beacon: string };
    const b = slotValue(slotsOf.beacon);
    const beacon = b.kind === 'address' ? beaconOf.get(b.address) : undefined;
    return isFacetRouter(
      codeLayout({
        slots: slotsOf,
        own,
        codeAt: (x) => scans.get(x) ?? null,
        beacon: beacon ? { implementation: beacon.implementation, owner: beacon.owner } : null,
      }),
    );
  });
  const facetCalls = routers.flatMap((a) =>
    FACET_QUERIES.map((sel) => ({ target: a, callData: getFacetCall(sel) })),
  );
  const facetReplies = await timed(deps, async () => {
    const replies = await multicall(rpc, m3, facetCalls, tag);
    const facets = replies.flatMap((r) => {
      const f = r.success ? wordAddress(r.data) : null;
      return f && !/^0x0{40}$/.test(f) ? [f] : [];
    });
    await fetchCode([...new Set(facets)]);
    return replies;
  });
  const facets = routers.flatMap((token, i) =>
    FACET_QUERIES.map((selector, j) => ({
      token,
      selector,
      reply: facetReplies.value[i * FACET_QUERIES.length + j] as CallReply,
    })),
  );

  const feeds = await timed(deps, () =>
    multicall(rpc, m3, feedCalls(parseDirectory(listings.directory.entries).feeds), tag),
  );

  const merge = (a: Phase, b: Phase): Phase => ({
    at: a.at,
    durationMs: a.durationMs + b.durationMs,
    calls: a.calls + b.calls,
    httpRequests: a.httpRequests + b.httpRequests,
    errors: a.errors + b.errors,
  });
  const n = TOKEN_CALLS.length;
  const onchain: AssetReads['onchain'] = {
    block: Number(head.number),
    blockTime: Number(head.timestamp),
    multicall3: m3,
    positionManager: pm,
    weth9: calls.value.weth9,
    tokens: addresses.map((address, i) => ({
      address,
      replies: calls.value.replies.slice(i * n, i * n + n),
      slots: slots.value[i] as { implementation: string; admin: string; beacon: string },
    })),
    beacons,
    cloneTargets: targets.map((address, i) => ({
      address,
      slots: targetSlots.value[i] as { implementation: string; admin: string; beacon: string },
    })),
    facets,
    code: [...scans.entries()]
      .map(([address, s]) => ({ address, ...s }))
      .sort((a, b) => (a.address < b.address ? -1 : 1)),
    watched: [...WATCHED_SELECTORS],
    challenged: input.challenged?.() ?? 0,
    feeds: feeds.value,
    phases: {
      calls: merge(merge(calls.phase, beaconReplies.phase), facetReplies.phase),
      slots: merge(slots.phase, targetSlots.phase),
      code: code.phase,
      feeds: feeds.phase,
    },
  };
  return { onchain, raw };
}

/** Every read the list is built from, and the raw code of each address read (for the code fixture). */
export async function readAssets(
  deps: ReadDeps,
  input: ReadInput & { listings?: Listings; onListings?: (l: Listings) => void },
): Promise<{ reads: AssetReads; code: Map<string, string> }> {
  const listings = input.listings ?? (await readListings(deps, input));
  input.onListings?.(listings);
  // the endpoint keeps a block's state for minutes: a refused read starts the chain part again, on a new block
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await input.beforeChain?.();
      const { onchain, raw } = await readOnchain(deps, input, listings);
      return {
        reads: {
          chain: 'robinhood',
          chainId: input.chain.chainId,
          rpcLabel: input.rpcLabel,
          ...listings,
          onchain,
        },
        code: raw,
      };
    } catch (e) {
      last = e;
      input.log?.(
        `the chain read failed (${e instanceof Error ? e.message : e}); again on a new block`,
      );
      await deps.sleep(30_000);
    }
  }
  throw last;
}
