import 'dotenv/config';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '@colosseum/db';
import {
  cutShelf,
  SHELF_FLOOR_USD,
  type ShelfListRow,
  shelfHash,
  type VolumeReading,
} from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { MINTS, nowIso, sleep } from '../../lib';
import type { RegistryPool } from '../lib-history';
import { getMultiple, rpc, rpcStats } from '../lib-pools';
import { ALL_VENUES, confirmPool, mintInfos, VENUES } from '../lib-venues';
import {
  assignPools,
  type DsPair,
  type PickedPool,
  pickPools,
  SHELF_POOL_RULE,
  type TokenPick,
} from './shelf-pools';

// `pnpm risk:shelf-pools-solana [--floor <dollars>] [--readings <file>] [--pairs <jsonl>]` (PLAN-ASSETS AS.12,
// ledger ASSET-3): the registry of the Solana shelf's pools, for the backfill's shelf scope
// (`pnpm risk:assets-backfill solana-swaps --registry <file>`). It
//   1. cuts the shelf as the backfill does (cutShelf over scripts/risk/assets/solana.json and the newest
//      dex_volume_24h_usd reading per address in asset_observations, or --readings <file>);
//   2. asks DexScreener's token-pairs/v1/solana/<mint> for each shelf token (at most 30 pairs a token), one call
//      every 300 ms, waiting out a 429; the answers are written to <RISK_DATA_DIR>/shelf-dexscreener-solana-<stamp>.jsonl
//      (--pairs <that file> reuses them instead of asking again);
//   3. keeps per token the pools of SHELF_POOL_RULE (shelf-pools.ts);
//   4. confirms each kept pool on chain with getMultipleAccounts (owner program the venue's, decoded mints hold the
//      token: lib-venues.ts, the code of build-registry.ts); a pool that fails is left out and the token re-picked;
//   5. writes <RISK_DATA_DIR>/shelf-registry-solana-<stamp>.json, whose `pools` are RegistryPool rows.
// The file's name does not start with `registry-`, so latestRegistryFile (lib-history.ts), history-backfill.ts and
// retier.ts never take it by default; it writes no table and nothing under ~/.colosseum. Solana calls go through
// SOLANA_RPC_URL (lib-pools.ts); run with DOTENV_CONFIG_PATH pointing at the main checkout's .env.

export const SHELF_REGISTRY_METHOD_VERSION = 'shelf-registry-0.1';
const SOL = 'So11111111111111111111111111111111111111112';
const OUT = process.env.RISK_DATA_DIR ?? 'data/risk';
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const floorUsd = Number(opt('--floor') ?? SHELF_FLOOR_USD);
const stamp = nowIso().slice(0, 16).replace(/[-:]/g, '');
const startedAt = nowIso();

// --- 1. the shelf, cut as the backfill cuts it -------------------------------------------------------------------
const listFile = 'scripts/risk/assets/solana.json';
type ListRow = ShelfListRow & { cls?: string | null };
const rows = (JSON.parse(readFileSync(listFile, 'utf8')) as { assets: ListRow[] }).assets;
const rowOf = new Map(rows.map((r) => [r.address, r]));
async function volumeReadings(): Promise<VolumeReading[]> {
  const file = opt('--readings');
  if (file)
    return (
      JSON.parse(readFileSync(file, 'utf8')) as Array<VolumeReading & { chain?: string }>
    ).filter((r) => !r.chain || r.chain === 'solana');
  // the backfill's query (backfill.ts volumeReadings), so both cut the same shelf
  const { db, client } = createDb();
  try {
    const r = (await db.execute(
      sql`select distinct on (address) address, value, observed_at from asset_observations where chain = 'solana' and metric = 'dex_volume_24h_usd' order by address, observed_at desc`,
    )) as unknown as Array<{ address: string; value: number | null; observed_at: Date | string }>;
    return [...r].map((x) => ({
      address: x.address,
      value: x.value === null ? null : Number(x.value),
      observedAt: new Date(x.observed_at).toISOString(),
    }));
  } finally {
    await client.end();
  }
}
const shelf = cutShelf(rows, await volumeReadings(), floorUsd);
if (!shelf.tokens.length)
  throw new Error(`the Solana shelf is empty (${JSON.stringify(shelf.counts)})`);
const committed = JSON.parse(readFileSync('scripts/risk/assets/shelf-solana.json', 'utf8')) as {
  rows: Array<{ address: string }>;
};
const committedHash = shelfHash(committed.rows.map((r) => r.address));
const tokensHash = shelfHash(shelf.tokens.map((t) => t.address));

// cash tokens and SOL are quotes, not subjects: their pools enter only as another shelf token's pair
const isQuote = (a: string) => a === SOL || rowOf.get(a)?.cls === 'cash';
const subjects = shelf.tokens.filter((t) => !isQuote(t.address));
const quotes = shelf.tokens.filter((t) => isQuote(t.address));

// --- 2. DexScreener's pairs per subject --------------------------------------------------------------------------
type Answer = {
  assetMint: string;
  symbol: string;
  source: string;
  fetchedAt: string;
  status: number;
  error: string | null;
  pairs: DsPair[];
};
const answers = new Map<string, Answer>();
const pairsFile = opt('--pairs');
if (pairsFile) {
  for (const l of readFileSync(pairsFile, 'utf8').split('\n').filter(Boolean)) {
    const a = JSON.parse(l) as Answer;
    answers.set(a.assetMint, a);
  }
}
const dsFile = pairsFile ?? join(OUT, `shelf-dexscreener-solana-${stamp}.jsonl`);
for (const [i, t] of subjects.entries()) {
  if (answers.has(t.address) && answers.get(t.address)?.status === 200) continue;
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${t.address}`;
  let status = 0;
  let pairs: DsPair[] = [];
  let error: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      status = res.status;
      if (status === 429) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (status !== 200) {
        error = `status ${status}`;
        break;
      }
      pairs = ((await res.json()) as DsPair[]) ?? [];
      error = null;
      break;
    } catch (e) {
      error = String(e).slice(0, 120);
      await sleep(2000 * (attempt + 1));
    }
  }
  if (status !== 200) error ??= `status ${status}`;
  const a: Answer = {
    assetMint: t.address,
    symbol: t.symbol,
    source: url,
    fetchedAt: nowIso(),
    status,
    error,
    pairs,
  };
  answers.set(t.address, a);
  appendFileSync(dsFile, `${JSON.stringify(a)}\n`);
  if (i % 20 === 0) console.error(JSON.stringify({ dexscreener: i, of: subjects.length }));
  await sleep(300);
}

// --- 3 and 4. pick, confirm on chain, re-pick past what failed ----------------------------------------------------
const rejected = new Map<string, Set<string>>();
const excluded: Array<{ address: string; assetMint: string; venue: string; reason: string }> = [];
const confirmed = new Map<string, Extract<ReturnType<typeof confirmPool>, { ok: true }>>();
let picks = new Map<string, TokenPick>();
for (let round = 0; round < 6; round++) {
  picks = new Map(
    subjects.map((t) => [
      t.address,
      pickPools(
        t.address,
        answers.get(t.address)?.pairs ?? [],
        SHELF_POOL_RULE,
        rejected.get(t.address),
      ),
    ]),
  );
  const toCheck = [
    ...new Map(
      [...picks.entries()].flatMap(([token, p]) =>
        p.picked
          .filter((x) => !confirmed.has(`${token}:${x.address}`))
          .map((x) => [`${token}:${x.address}`, { token, p: x }] as const),
      ),
    ).values(),
  ];
  if (!toCheck.length) break;
  const accs = await getMultiple(toCheck.map((c) => c.p.address));
  for (const [i, { token, p }] of toCheck.entries()) {
    const c = confirmPool(accs[i] ?? null, { expected: p.venue, mint: token, venues: ALL_VENUES });
    if (c.ok) confirmed.set(`${token}:${p.address}`, c);
    else {
      rejected.set(token, new Set([...(rejected.get(token) ?? []), p.address]));
      excluded.push({ address: p.address, assetMint: token, venue: p.dsVenue, reason: c.reason });
    }
  }
}
const confirmedAt = nowIso();

// --- 5. the registry rows ---------------------------------------------------------------------------------------
const order = subjects.map((t) => t.address);
const { owner, sharedWith } = assignPools(
  order,
  new Map([...picks.entries()].map(([t, p]) => [t, p.picked])),
);
const owned: Array<{ token: string; p: PickedPool }> = [];
for (const token of order)
  for (const p of picks.get(token)?.picked ?? [])
    if (owner.get(p.address) === token) owned.push({ token, p });
const info = await mintInfos(rpc, [
  ...new Set(
    owned.flatMap(({ token, p }) => {
      const c = confirmed.get(`${token}:${p.address}`);
      return c ? [c.mint0, c.mint1] : [];
    }),
  ),
]);
const symbolOf = (m: string, fallback: string | null) =>
  m === SOL ? 'SOL' : (rowOf.get(m)?.symbol ?? fallback);
const exitPathOf = (quote: string) =>
  quote === MINTS.USDC || quote === MINTS.USDT
    ? 'direct_usd'
    : quote === SOL
      ? 'via_sol'
      : shelf.tokens.some((t) => t.address === quote)
        ? 'via_shelf_token'
        : 'other';
const fetchedOf = (token: string) => answers.get(token)?.fetchedAt as string;
type ShelfRegistryPool = RegistryPool & {
  quoteMint: string;
  transferFeeBps0: number;
  transferFeeBps1: number;
  discoveryLiquidityUsd: number;
  dexscreenerLiquidityUsd: number;
  liquidityRepriced: boolean;
  discoveryVolume24hUsd: number;
  tierReason: string;
  source: string;
  method: string;
  fetchedAt: string;
  confirmedAt: string;
  provenance: 'live';
  /** Meteora DAMM v1 only: vault0/vault1 hold the dynamic vaults' LP token, not the pool's tokens (lib-venues.ts). */
  vaultsHold?: { kind: 'dynamic_vault_lp'; aVault: string; bVault: string };
};
const pools: ShelfRegistryPool[] = owned.map(({ token, p }) => {
  const c = confirmed.get(`${token}:${p.address}`) as NonNullable<ReturnType<typeof confirmed.get>>;
  const assetIsToken0 = c.mint0 === token ? 1 : 0;
  const quoteMint = assetIsToken0 ? c.mint1 : c.mint0;
  const m0 = info.get(c.mint0);
  const m1 = info.get(c.mint1);
  return {
    address: p.address,
    venue: c.venue,
    program: c.program,
    assetMint: token,
    assetSymbol: symbolOf(token, token.slice(0, 6)) as string,
    quoteMint,
    quoteSymbol: symbolOf(quoteMint, p.quoteSymbol),
    exitPath: exitPathOf(quoteMint),
    assetIsToken0,
    mint0: c.mint0,
    mint1: c.mint1,
    vault0: c.vault0,
    vault1: c.vault1,
    decimals0: m0?.decimals ?? 0,
    decimals1: m1?.decimals ?? 0,
    transferFeeBps0: m0?.feeBps ?? 0,
    transferFeeBps1: m1?.feeBps ?? 0,
    tvlUsd: p.liquidityUsd,
    discoveryLiquidityUsd: p.liquidityUsd,
    dexscreenerLiquidityUsd: p.dexscreenerLiquidityUsd,
    liquidityRepriced: p.repriced,
    discoveryVolume24hUsd: p.volume24hUsd,
    tier: 'B',
    tierReason:
      "B, not A: build-registry.ts tiers by on-chain TVL for the collector's refresh, and no collector reads this file; the backfill reads only X (dust, sampled) against the rest, and no pool here is dust (each holds at least the rule's minimum)",
    source: `${answers.get(token)?.source} (discovery) + Solana RPC getMultipleAccounts (confirmation)`,
    method: 'dexscreener_token_pairs + onchain_decode_owner_and_mints (lib-venues.ts)',
    fetchedAt: fetchedOf(token),
    confirmedAt,
    provenance: 'live',
    ...(c.vaultsHold ? { vaultsHold: c.vaultsHold } : {}),
  };
});

// --- per token, and the file --------------------------------------------------------------------------------------
const tokens = subjects.map((t) => {
  const p = picks.get(t.address) as TokenPick;
  const a = answers.get(t.address);
  return {
    address: t.address,
    symbol: t.symbol,
    cls: rowOf.get(t.address)?.cls ?? null,
    volume24hUsd: t.volume24hUsd,
    dexscreener: { source: a?.source, fetchedAt: a?.fetchedAt, status: a?.status, error: a?.error },
    pairs: p.pairs,
    picked: p.picked.map((x) => ({
      address: x.address,
      venue: x.venue,
      liquidityUsd: x.liquidityUsd,
      quoteSymbol: x.quoteSymbol,
      ...(owner.get(x.address) !== t.address ? { keptUnder: owner.get(x.address) } : {}),
    })),
    supportedLiquidityUsd: p.supported.liquidityUsd,
    coveredUsd: p.coveredUsd,
    leftOutUsd: p.leftOutUsd,
    coveredShare: p.coveredShare,
    belowMin: p.belowMin,
    unsupported: p.unsupported,
    referencePriceUsd: p.referencePriceUsd,
    repriced: p.repriced,
    rejected: [...(rejected.get(t.address) ?? [])],
    sharedWith: sharedWith.get(t.address) ?? [],
  };
});
const noSupportedPool = tokens
  .filter((t) => !t.picked.length)
  .map((t) => ({
    address: t.address,
    symbol: t.symbol,
    reason:
      t.dexscreener.status !== 200
        ? `DexScreener answered ${t.dexscreener.error ?? t.dexscreener.status}`
        : t.supportedLiquidityUsd === 0
          ? t.pairs
            ? `no pair on a supported venue (unsupported: ${Object.entries(t.unsupported.byVenue)
                .map(([v, l]) => `${v} $${Math.round(l)}`)
                .join(', ')})`
            : 'DexScreener lists no pair'
          : t.rejected.length && t.belowMin.pools === 0
            ? 'every supported pool failed the on-chain confirmation'
            : `no supported pool of at least $${SHELF_POOL_RULE.minLiquidityUsd} (supported $${Math.round(t.supportedLiquidityUsd)})`,
  }));
const file = join(OUT, `shelf-registry-solana-${stamp}.json`);
const byVenue: Record<string, { pools: number; liquidityUsd: number }> = {};
for (const p of pools) {
  byVenue[p.venue] ??= { pools: 0, liquidityUsd: 0 };
  const v = byVenue[p.venue] as { pools: number; liquidityUsd: number };
  v.pools++;
  v.liquidityUsd += p.tvlUsd;
}
const registry = {
  methodVersion: SHELF_REGISTRY_METHOD_VERSION,
  chain: 'solana',
  fetchedAt: startedAt,
  confirmedAt,
  source:
    'DexScreener api.dexscreener.com/token-pairs/v1/solana/<mint> (discovery) + Solana RPC getMultipleAccounts (confirmation)',
  method:
    'cutShelf over the list and the newest dex_volume_24h_usd readings; pickPools (scripts/risk/assets/shelf-pools.ts) per subject; confirmPool (scripts/risk/lib-venues.ts) per kept pool',
  provenance: 'live',
  rule: SHELF_POOL_RULE,
  stated: {
    quotes:
      'stated, not chosen: cash tokens (cls cash) and SOL are not subjects of their own. They are the quotes of the shelf; their own largest pools (SOL/USDC and the like) would dwarf every other token, so their pools enter only as the pair of another shelf token, and they are listed under `quotesNotSubjects`.',
    rule: `per subject: DexScreener's pairs on a venue the swap decoders read (${Object.keys(VENUES).join(', ')}), at least $${SHELF_POOL_RULE.minLiquidityUsd} of liquidity, largest first, kept until ${SHELF_POOL_RULE.share * 100}% of the token's supported liquidity (every supported pair, of any size) is covered, at most ${SHELF_POOL_RULE.maxPools} a token`,
    dexscreenerCap:
      "DexScreener answers at most 30 pairs a token: a token's supported and unsupported liquidity are of those pairs",
    tvlUsd:
      "a pool's tvlUsd here is DexScreener's liquidity.usd at the fetch (re-valued when mispriced, below), not build-registry.ts's on-chain vault TVL; it orders the pools only",
    repricing: `DexScreener values a pair's two sides at the pair's own price of its base, which it sometimes takes from a mispriced quote (on 2026-10-13: pairs quoted in JupSOL, JLP, MET, RAY on DLMM, a JitoSOL/JupSOL pool at $2.4 billion). The token's reference price is the median of the prices its pairs imply (pairs with at least $1,000 of 24 h volume); a pair whose price of the token is off it by more than ${SHELF_POOL_RULE.priceBand}x either way has its liquidity scaled by reference / implied (it is linear in that price). Each pool keeps dexscreenerLiquidityUsd beside it, and each token lists its repriced pairs`,
    tier: "every pool is tier B (see each pool's tierReason); no pool is X",
    shared:
      'a pool kept for two subjects is written once, under the first in the shelf order; the other names it under sharedWith (the backfill takes a pool once per address)',
    name: 'the file name does not start with registry-, so latestRegistryFile, history-backfill.ts and retier.ts never choose it by default; pass it with --registry',
  },
  shelf: {
    list: listFile,
    floorUsd: shelf.floorUsd,
    reading: shelf.reading,
    readingsFrom:
      opt('--readings') ?? 'asset_observations (local database), metric dex_volume_24h_usd',
    counts: shelf.counts,
    tokensHash,
    committedShelf: { file: 'scripts/risk/assets/shelf-solana.json', tokensHash: committedHash },
    subjects: subjects.length,
  },
  dexscreenerAnswers: dsFile,
  byVenue,
  pools,
  tokens,
  noSupportedPool,
  quotesNotSubjects: quotes.map((q) => ({
    address: q.address,
    symbol: q.symbol,
    cls: rowOf.get(q.address)?.cls ?? null,
    inPoolsAsQuote: pools.filter((p) => p.quoteMint === q.address).length,
  })),
  excluded,
  rpcStats,
};
writeFileSync(file, JSON.stringify(registry, null, 1));

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
for (const t of tokens)
  console.log(
    `${t.symbol.padEnd(12)} pools ${String(t.picked.length).padStart(1)}  covered ${usd(t.coveredUsd).padStart(14)} of ${usd(t.supportedLiquidityUsd).padStart(14)} (${t.coveredShare === null ? '  -' : `${(t.coveredShare * 100).toFixed(0).padStart(3)}%`})  left out ${usd(t.leftOutUsd).padStart(12)}  unsupported ${usd(t.unsupported.liquidityUsd).padStart(12)}${t.sharedWith.length ? `  shared ${t.sharedWith.length}` : ''}`,
  );
console.log(
  JSON.stringify(
    {
      file,
      shelf: {
        tokens: shelf.tokens.length,
        subjects: subjects.length,
        quotes: quotes.map((q) => q.symbol),
        reading: shelf.reading,
        tokensHash,
        matchesCommittedShelf: tokensHash === committedHash,
      },
      pools: pools.length,
      byVenue,
      covered: tokens.filter((t) => t.picked.length).length,
      noSupportedPool,
      excluded: excluded.length,
      rpcStats,
    },
    null,
    1,
  ),
);
