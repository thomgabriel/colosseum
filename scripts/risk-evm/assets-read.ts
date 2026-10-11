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
  classNames,
  type DexPairCut,
  type DexQuery,
  dexNames,
  dexToRead,
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

export type Listings = Pick<AssetReads, 'registry' | 'directory' | 'dexscreener'>;

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
  return { registry, directory, dexscreener };
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
      dex: dexToRead(reads0, names, input.verdictAddresses),
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
