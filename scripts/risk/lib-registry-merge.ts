// The pool collector's registry with the shelf's pools beside the stock pools (PLAN-ASSETS AS.12, ledger ASSET-3).
// No I/O: registry-merge.ts reads the two files and writes the result.
//
// - The stock registry's pools are kept as they are, tier and all: the merge changes nothing the collector measures
//   today. A pool of the shelf that the stock registry already holds is that registry's (`duplicates`).
// - The shelf's other pools are tiered by the rule of retier.ts (lib-tiers.ts) over the shelf's pools alone, so the
//   shelf's much larger dollars (cbBTC, WETH, JitoSOL...) never push a stock pool from tier A to B. A shelf pool of
//   tier X (dust) is left out of the file, as retier.ts leaves dust out of the collector's copy. A shelf pool on a
//   venue the collector has no reader for (Raydium AMM v4, Meteora DAMM v1 and v2, PumpSwap: lib-venues.ts confirms
//   and the backfill decodes their events, but pools.ts cannot simulate them) is left out too, with its reason.
// - Every pool says which set it is from (`set`): the collector's raw captures and position scans, the Jupiter
//   cross-check, the lending-market snapshot, the split snapshot and the raw-arrays job keep to the stock set
//   (`isStockSetPool`), so the shelf adds pool snapshots and routed asset curves and nothing else.
import { type Tier, type TierRule, tierByShare } from './lib-tiers';

export const REGISTRY_MERGE_METHOD_VERSION = 'registry-merge-0.1';
export const COLLECTOR_VENUES = [
  'raydium_clmm',
  'orca_whirlpool',
  'meteora_dlmm',
  'raydium_cpmm',
] as const;

/** One pool as the collector reads it (pools.ts RegPool), plus what the merge says of it. */
export type CollectorPool = {
  address: string;
  venue: string;
  program: string;
  assetMint: string;
  assetSymbol: string;
  quoteMint: string;
  quoteSymbol: string | null;
  exitPath: string;
  assetIsToken0: number;
  mint0?: string;
  mint1?: string;
  vault0: string;
  vault1: string;
  decimals0: number;
  decimals1: number;
  transferFeeBps0: number;
  transferFeeBps1: number;
  tvlUsd: number;
  tier: string;
  [k: string]: unknown;
};
export type PoolSet = 'stocks' | 'shelf';
export type MergedPool = CollectorPool & { set: PoolSet; tier: 'A' | 'B'; tierReason?: string };

export type RegistryFile = {
  methodVersion?: string;
  fetchedAt?: string;
  pools: CollectorPool[];
  [k: string]: unknown;
};

/** The pools of the stock set: every pool of a registry that is not a merge, and a merge's `stocks` pools. */
export const isStockSetPool = (p: { set?: unknown }): boolean => p.set !== 'shelf';

export type MergedRegistry = {
  methodVersion: string;
  /** The stock registry's: the time its pools' TVLs were read, which the other jobs quote as the registry's age. */
  fetchedAt: string | null;
  mergedAt: string;
  source: string;
  method: string;
  provenance: 'live';
  base: { file: string; methodVersion: string | null; fetchedAt: string | null; pools: number };
  shelf: { file: string; methodVersion: string | null; fetchedAt: string | null; pools: number };
  tierRule: TierRule & { appliedTo: string };
  counts: {
    pools: number;
    stocks: number;
    shelf: number;
    duplicates: number;
    shelfLeftOut: number;
    byTier: Record<string, number>;
    bySetTier: Record<string, number>;
    shelfAssets: number;
    shelfTvlUsd: number;
  };
  pools: MergedPool[];
  /** Shelf pools the stock registry already holds: kept once, as the stock registry has them. */
  duplicates: Array<{ address: string; assetSymbol: string; stockTier: string; shelfTier: string }>;
  /** Shelf pools not in the file, with the reason. */
  shelfLeftOut: Array<{ address: string; assetSymbol: string; reason: string }>;
};

const fail = (m: string): never => {
  throw new Error(`registry merge: ${m}`);
};

/** Every field the collector reads, of the right kind; else the reason. */
export function collectorPoolProblem(p: unknown): string | null {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return 'not an object';
  for (const k of ['address', 'venue', 'program', 'assetMint', 'quoteMint', 'vault0', 'vault1'])
    if (typeof o[k] !== 'string' || o[k] === '') return `${k} missing`;
  if (typeof o.assetSymbol !== 'string') return 'assetSymbol missing';
  if (typeof o.exitPath !== 'string') return 'exitPath missing';
  for (const k of [
    'assetIsToken0',
    'decimals0',
    'decimals1',
    'transferFeeBps0',
    'transferFeeBps1',
    'tvlUsd',
  ])
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) return `${k} is not a number`;
  if (!(COLLECTOR_VENUES as readonly string[]).includes(o.venue as string))
    return `venue ${String(o.venue)} is not one the collector decodes`;
  return null;
}

/** The checks a file must pass before it goes to ~/.colosseum/risk/registry.json. Returns the problems. */
export function checkCollectorRegistry(file: unknown): string[] {
  const pools = (file as { pools?: unknown } | null)?.pools;
  if (!Array.isArray(pools)) return ['no pools array'];
  if (pools.length === 0) return ['no pools'];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, p] of pools.entries()) {
    const why = collectorPoolProblem(p);
    if (why) problems.push(`pool ${i}: ${why}`);
    const o = p as { address?: string; tier?: string; set?: string };
    if (o.tier !== 'A' && o.tier !== 'B') problems.push(`pool ${i}: tier ${o.tier} is not A or B`);
    if (o.set !== undefined && o.set !== 'stocks' && o.set !== 'shelf')
      problems.push(`pool ${i}: set ${o.set} is not stocks or shelf`);
    if (o.address && seen.has(o.address)) problems.push(`pool ${i}: ${o.address} twice`);
    if (o.address) seen.add(o.address);
  }
  return problems;
}

const count = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((m, x) => {
    m[key(x)] = (m[key(x)] ?? 0) + 1;
    return m;
  }, {});

/**
 * The merged registry. `base` is the collector's stock registry (its dust already left out, as retier.ts writes it, or
 * left out here); `shelf` the shelf's registry (shelf-pools-solana.ts). Refuses a base or shelf pool the collector
 * could not read.
 */
export function mergeRegistries(
  base: RegistryFile,
  shelf: RegistryFile,
  opts: { baseFile: string; shelfFile: string; now: Date; rule: TierRule },
): MergedRegistry {
  if (!Array.isArray(base?.pools)) fail('the stock registry has no pools array');
  if (!Array.isArray(shelf?.pools)) fail('the shelf registry has no pools array');
  for (const p of base.pools) {
    const why = collectorPoolProblem(p);
    if (why) fail(`the stock registry's pool ${p?.address ?? '?'}: ${why}`);
  }
  const shelfLeftOut: MergedRegistry['shelfLeftOut'] = [];
  const readable: CollectorPool[] = [];
  for (const p of shelf.pools) {
    const why = collectorPoolProblem(p);
    if (why && (COLLECTOR_VENUES as readonly string[]).includes(p?.venue as string))
      fail(`the shelf registry's pool ${p?.address ?? '?'}: ${why}`);
    if (why)
      shelfLeftOut.push({
        address: p.address,
        assetSymbol: p.assetSymbol,
        reason: `venue ${p.venue}: the pool collector has no reader for it (the backfill fetches it)`,
      });
    else readable.push(p);
  }
  const stocks: MergedPool[] = [];
  const inBase = new Map<string, CollectorPool>();
  for (const p of base.pools) {
    if (p.tier !== 'A' && p.tier !== 'B') continue; // dust: not collected (retier.ts)
    if (inBase.has(p.address)) fail(`the stock registry holds ${p.address} twice`);
    inBase.set(p.address, p);
    stocks.push({ ...p, set: 'stocks', tier: p.tier });
  }
  const duplicates: MergedRegistry['duplicates'] = [];
  const fresh: CollectorPool[] = [];
  const seenShelf = new Set<string>();
  for (const p of readable) {
    if (seenShelf.has(p.address)) fail(`the shelf registry holds ${p.address} twice`);
    seenShelf.add(p.address);
    const b = inBase.get(p.address);
    if (b)
      duplicates.push({
        address: p.address,
        assetSymbol: p.assetSymbol,
        stockTier: b.tier,
        shelfTier: p.tier,
      });
    else fresh.push(p);
  }
  const tiers = tierByShare(fresh, opts.rule);
  const shareText = `${Math.round(opts.rule.tierAShare * 1000) / 10}%`;
  const shelfPools: MergedPool[] = [];
  for (const p of [...fresh].sort((a, b) => b.tvlUsd - a.tvlUsd)) {
    const t = tiers.get(p.address) as Tier;
    if (t === 'X') {
      shelfLeftOut.push({
        address: p.address,
        assetSymbol: p.assetSymbol,
        reason: `dust: tvl < ${opts.rule.minPoolTvlUsd} USD`,
      });
      continue;
    }
    shelfPools.push({
      ...p,
      set: 'shelf',
      tier: t,
      tierReason:
        t === 'A'
          ? `A: among the shelf's pools that hold ${shareText} of the shelf's TVL (retier.ts's rule over the shelf's pools alone)`
          : `B: outside the shelf's pools that hold ${shareText} of the shelf's TVL (retier.ts's rule over the shelf's pools alone)`,
    });
  }
  const pools = [...stocks, ...shelfPools];
  return {
    methodVersion: REGISTRY_MERGE_METHOD_VERSION,
    fetchedAt: base.fetchedAt ?? null,
    mergedAt: opts.now.toISOString(),
    source: `${opts.baseFile} (the stock pools, as installed) + ${opts.shelfFile} (the shelf's pools)`,
    method:
      'union by pool address, the stock registry first; the shelf pools tiered by lib-tiers.ts over the shelf alone',
    provenance: 'live',
    base: {
      file: opts.baseFile,
      methodVersion: base.methodVersion ?? null,
      fetchedAt: base.fetchedAt ?? null,
      pools: stocks.length,
    },
    shelf: {
      file: opts.shelfFile,
      methodVersion: shelf.methodVersion ?? null,
      fetchedAt: shelf.fetchedAt ?? null,
      pools: shelf.pools.length,
    },
    tierRule: { ...opts.rule, appliedTo: 'the shelf pools the stock registry does not hold' },
    counts: {
      pools: pools.length,
      stocks: stocks.length,
      shelf: shelfPools.length,
      duplicates: duplicates.length,
      shelfLeftOut: shelfLeftOut.length,
      byTier: count(pools, (p) => p.tier),
      bySetTier: count(pools, (p) => `${p.set}:${p.tier}`),
      shelfAssets: new Set(shelfPools.map((p) => p.assetMint)).size,
      shelfTvlUsd: Math.round(shelfPools.reduce((s, p) => s + p.tvlUsd, 0)),
    },
    pools,
    duplicates,
    shelfLeftOut,
  };
}

/**
 * What the larger registry costs the pool collector in Solana RPC requests an hour, against the stock registry alone,
 * from the shape of pools.ts (no chain read): headers and child accounts in getMultipleAccounts of 100, tick and bin
 * lists re-discovered by getProgramAccounts at most hourly (two filters on a whirlpool), plus a measured rate of
 * re-reads when a cached tick map goes stale. `childrenPerPool` is the mean child list per venue, from the collector's
 * cache. The shelf pools take no raw capture or position scan (isStockSetPool), so those are not counted.
 */
export function addedCallsPerHour(
  shelfPools: ReadonlyArray<{ venue: string; tier: string }>,
  childrenPerPool: Record<string, number>,
  opts: { runsPerHour: number; staleRefetchShare: number },
): {
  headers: number;
  children: number;
  discoveries: number;
  staleRefetches: number;
  total: number;
  firstRunDiscoveries: number;
} {
  const A = shelfPools.filter((p) => p.tier === 'A');
  const batches = (n: number) => Math.ceil(n / 100);
  // headers: A pools in every run, A and B in the hourly one; the batch count is what is added on top of the stocks'
  const headers = (opts.runsPerHour - 1) * batches(A.length) + batches(shelfPools.length);
  // children read each run: DLMM bin arrays always, CPMM vaults always, CL tick arrays only when re-discovered
  const childAccounts = (ps: ReadonlyArray<{ venue: string }>) =>
    ps.reduce(
      (s, p) =>
        s +
        (p.venue === 'meteora_dlmm'
          ? (childrenPerPool.meteora_dlmm ?? 0)
          : p.venue === 'raydium_cpmm'
            ? 2
            : 0),
      0,
    );
  const clChildrenHourly = shelfPools.reduce(
    (s, p) =>
      s +
      (p.venue === 'raydium_clmm' || p.venue === 'orca_whirlpool'
        ? (childrenPerPool[p.venue] ?? 0)
        : 0),
    0,
  );
  const children =
    (opts.runsPerHour - 1) * batches(childAccounts(A)) +
    batches(childAccounts(shelfPools) + clChildrenHourly);
  const gpaCalls = (venue: string) =>
    venue === 'orca_whirlpool' ? 2 : venue === 'raydium_cpmm' ? 0 : 1;
  const discoveries = shelfPools.reduce((s, p) => s + gpaCalls(p.venue), 0);
  const nonCpmmA = A.filter((p) => p.venue !== 'raydium_cpmm').length;
  // a stale tick map costs one getProgramAccounts and one getMultipleAccounts
  const staleRefetches = Math.round(nonCpmmA * opts.staleRefetchShare * opts.runsPerHour * 2);
  return {
    headers,
    children,
    discoveries,
    staleRefetches,
    total: headers + children + discoveries + staleRefetches,
    firstRunDiscoveries: discoveries,
  };
}
