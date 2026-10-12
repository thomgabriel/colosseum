import { cutShelf, type Shelf, type VolumeReading } from '@colosseum/risk';
import {
  type AssetClass,
  BasketAsset,
  type ChainId,
  type PriceKind,
  type UniverseAsset,
} from '@colosseum/schemas';

// The shelf of gate ASSET-SHELF as committed files (PLAN-ASSETS AS.9 and AS.10). Pure: the list, the tracked
// list's oracles, the volume readings and the yield readings are passed in. `shelf.ts` reads them and writes.

export const SHELF_METHOD = 'shelf-0.1';
/** The fields of an on-chain asset entry only a deploy sets (ledger OPS-4): never guessed here. */
export const DEPLOY_FIELDS = {
  solana: ['priceIndex', 'twapIndex', 'pairs', 'range', 'spreadBps', 'maxWeightBps', 'keeperOn'],
  robinhood: ['feed', 'pairs', 'maxWeightBps', 'keeperOn'],
} as const;

/** A volume reading as the metrics job stored it, with its stamp. */
export type StampedReading = VolumeReading & {
  source: string;
  method: string;
  fetchedAt: string;
  provenance: string;
};
export type TrackedOracle = { kind: string; ref: string } | null;

export type ShelfRow = {
  id: string;
  address: string;
  symbol: string;
  cls: string;
  category: string;
  status: string;
  volume24hUsd: number;
  source: string;
  fetched_at: string;
  method: string;
  provenance: string;
};
export type ShelfFile = {
  chain: ChainId;
  rule: string;
  floorUsd: number;
  list: { file: string; commit: string };
  reading: Shelf['reading'];
  counts: Shelf['counts'];
  /** By volume, the largest first: a cut to fewer entries (AS.11) reads from the top. */
  rows: ShelfRow[];
  method: string;
  /** Every reading the cut considered, frozen for the test (written by shelf.ts). */
  readingsFrozen?: string;
};

export type ShelfEntry = {
  asset: BasketAsset;
  /** The tier is the fallback until Bearing measures the token's exit (EXIT-SOURCE). */
  tierFrom: 'fallback';
  /** The on-chain entry's fields a deploy sets, and the asset's that wait for it. */
  toSet: string[];
};
export type EntriesFile = {
  chain: ChainId;
  shelf: string;
  stated: Record<string, string>;
  entries: ShelfEntry[];
  /** Shelf tokens that are not entries yet, with the missing piece. */
  waiting: Array<{ id: string; symbol: string; missing: string[] }>;
  method: string;
};

const RULE =
  'ASSET-SHELF: every listed or candidate row of the list whose newest DexScreener 24 h volume reading (asset_observations, dex_volume_24h_usd) is at least the floor';

/** The shelf file of a chain: the cut, stamped, its rows by volume. */
export function shelfFile(args: {
  chain: ChainId;
  listFile: string;
  listCommit: string;
  assets: UniverseAsset[];
  readings: StampedReading[];
  floorUsd: number;
}): ShelfFile {
  const key = args.chain === 'solana' ? (a: string) => a : (a: string) => a.toLowerCase();
  const cut = cutShelf(args.assets, args.readings, args.floorUsd, key);
  const byAddress = new Map(args.assets.map((a) => [key(a.address), a]));
  const stampOf = new Map(
    args.readings.map((r) => [`${key(r.address)}|${r.observedAt}`, r] as const),
  );
  const rows = cut.tokens
    .map((t) => {
      const a = byAddress.get(key(t.address)) as UniverseAsset;
      const r = stampOf.get(`${key(t.address)}|${t.observedAt}`) as StampedReading;
      return {
        id: a.id,
        address: a.address,
        symbol: a.symbol,
        cls: a.cls ?? 'none',
        category: a.category,
        status: a.status,
        volume24hUsd: t.volume24hUsd,
        source: r.source,
        fetched_at: r.fetchedAt,
        method: r.method,
        provenance: r.provenance,
      };
    })
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd || (a.id < b.id ? -1 : 1));
  return {
    chain: args.chain,
    rule: RULE,
    floorUsd: args.floorUsd,
    list: { file: args.listFile, commit: args.listCommit },
    reading: cut.reading,
    counts: cut.counts,
    rows,
    method: SHELF_METHOD,
  };
}

/** Stocks and funds of shares trade with the US session; every other class always (stated, not chosen). */
const SESSION_OF: Record<AssetClass, BasketAsset['session']> = {
  stock: 'us_equity',
  etf: 'us_equity',
  crypto: 'always',
  gold: 'always',
  commodity: 'always',
  dollar_yield: 'always',
  cash: 'always',
};

/**
 * The shelf's entries: a `basket_assets` row per token, from the list, its tier the fallback C, its
 * deploy-only fields left to the deploy. A dollar-yield token joins only with its leg types and a yield
 * reading; a token of no class never joins.
 */
export function shelfEntries(args: {
  shelf: ShelfFile;
  shelfPath: string;
  assets: UniverseAsset[];
  trackedOracle: (id: string) => TrackedOracle;
  hasYieldReading: (address: string) => boolean;
}): EntriesFile {
  const { chain } = args.shelf;
  const byId = new Map(args.assets.map((a) => [a.id, a]));
  const entries: ShelfEntry[] = [];
  const waiting: EntriesFile['waiting'] = [];
  for (const row of args.shelf.rows) {
    const a = byId.get(row.id);
    if (!a) throw new Error(`${row.id}: on the shelf and not in the list`);
    const missing: string[] = [];
    if (!a.cls) missing.push('a class');
    if (a.cls === 'dollar_yield') {
      if (!a.legTypes || a.legTypes.length === 0) missing.push('its leg types');
      if (!args.hasYieldReading(a.address)) missing.push('a yield reading');
    }
    if (a.decimals === null || a.decimals > 18) missing.push('decimals of at most 18');
    if (missing.length > 0) {
      waiting.push({ id: a.id, symbol: a.symbol, missing });
      continue;
    }
    const oracle = a.tracked ? args.trackedOracle(a.tracked.id) : a.oracle;
    const priceKind: PriceKind =
      oracle?.kind === 'scope' ? 'scope' : oracle?.kind === 'chainlink' ? 'chainlink' : 'none';
    const asset = BasketAsset.parse({
      id: a.id,
      chain,
      address: a.address,
      symbol: a.symbol,
      decimals: a.decimals,
      cls: a.cls,
      underlying: a.underlying ?? a.symbol,
      issuer: a.issuer ?? 'not stated in the list',
      tier: 'C',
      priceKind,
      priceRef: priceKind === 'none' ? '' : (oracle?.ref ?? ''),
      session: SESSION_OF[a.cls as AssetClass],
      autoFollowEligible: false,
      maxWeightBps: 0,
      blockedCountries: [],
      sheet: '',
      provenance: 'live',
    });
    entries.push({
      asset,
      tierFrom: 'fallback',
      toSet: [
        ...DEPLOY_FIELDS[chain === 'solana' ? 'solana' : 'robinhood'],
        ...(priceKind === 'none'
          ? ['a price source (priceKind none: the keeper never trades it)']
          : []),
        'sheet (the risk sheet under content/risk-sheets/)',
      ],
    });
  }
  return {
    chain,
    shelf: args.shelfPath,
    stated: {
      tier: "C on every entry, the careful side, labelled tierFrom 'fallback' (gate EXIT-SOURCE): where Bearing measures a token's exit capacity, a plan line holds shareOfDepth of it and the tier is not read.",
      maxWeightBps:
        '0 until the asset entry of a deploy sets it (ledger OPS-4): a cap is never guessed here.',
      session:
        "us_equity for stocks and funds of shares, always for every other class: stated, not chosen (the program's session flag).",
      eligibility:
        "By class, the engine's (packages/engine/src/personal/registry.ts on staging): no entry carries profiles of its own.",
      autoFollowEligible: 'false on every entry until a person turns it on.',
    },
    entries,
    waiting,
    method: SHELF_METHOD,
  };
}
