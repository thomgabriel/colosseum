// Hourly token bars of Solana from the pool collector's mid prices (gate HOURLY-BARS, Rodrigo, 2026-10-21): no
// collector keeps Solana's swap history, so the hosted database's price history of a Solana token is built from the
// mids the hosted pool collector already records in `risk_pool_snapshots` every few minutes. No new RPC call. Pure:
// no I/O, no clock.
//
//   Which pool    a token's bar of an hour is ONE pool's: among its pools quoted in USDC with a snapshot in the
//                 hour, the deepest, by the median over the hour's snapshots of `in_band_liquidity` (the dollars
//                 a sale within 2% of the mid reaches, which the collector measures on every snapshot), then by
//                 address. Pools are never blended (ORACLE-VS-DEX): the mid of a thin pool is not averaged into a
//                 deep one's. A pool quoted in SOL, USDT or another stock is not read: the snapshot keeps no dollar
//                 price of its quote, and only USDC is decided at par in the bars (DA21-PAR).
//   The marks     open and close: the pool's first and last snapshot of the hour by `fetched_at`; high and low:
//                 the extremes of its snapshots. Mids, not trades: `mid_price` in USDC per token, USDC at par.
//   No volume     no swap is read, so `swaps`, the swaps by side and `volume_tokens` are 0 (the table's columns are
//                 NOT NULL) and every dollar volume is null; the API serves none of them for a window holding such
//                 a bar (`priceHistoryFigures`): they answer not collected.
//   Complete hours  the caller hands only hours that have ended; a later run rebuilds the same hours from the same
//                 snapshots, so a late import is caught up by the next run.
import type { Provenance } from '@colosseum/schemas';
import { USDC_MINT } from './history';

/** Bars built from the collector's mid prices, not from swaps. A swap-built bar of the same hour wins over it. */
export const MIDS_METHOD_VERSION = 'mids-0.1';
export const MIDS_LAYER = 'collector_mids';
export const MIDS_METHOD =
  "hourly marks of the token's mid price in dollars from the pool collector's snapshots (risk_pool_snapshots.mid_price, or the same reading in the collector's day files, midQuotePerAsset: the simulated pool's marginal price in USDC per token, USDC at par): one pool an hour, the token's USDC pool with the deepest median 2% sell depth (in_band_liquidity, the day files' depth2pct.sellQuoteOut) over the hour's snapshots, never blended across pools; open and close its first and last snapshot of the hour, high and low its extremes; no swap read: volume, the volume by side and the swaps are not collected";

/** Whether a bar was built from the collector's mids (no swap, no volume). */
export const isMidsVersion = (methodVersion: string): boolean => methodVersion.startsWith('mids-');

/** One collector snapshot of one pool, its columns the bars read. */
export type MidSnapshot = {
  pool: string;
  fetchedAt: Date;
  /** Quote per token (UI units). */
  midPrice: number;
  /** Quote reached selling within 2% of the mid (UI units of the quote): dollars for a USDC pool. */
  inBandLiquidity: number | null;
  methodVersion: string;
  provenance: Provenance;
};
/** One pool of the registry (`risk_pools`), its columns the bars read. */
export type MidPool = { address: string; assetMint: string; quoteMint: string; venue: string };

/** One hour of one token: the row `market_bars` takes, without its key's chain. */
export type MidBar = {
  address: string;
  pool: 'asset';
  hour: Date;
  quoteAddress: null;
  openQuote: null;
  highQuote: null;
  lowQuote: null;
  closeQuote: null;
  vwapQuote: null;
  openUsd: number;
  highUsd: number;
  lowUsd: number;
  closeUsd: number;
  vwapUsd: null;
  swaps: 0;
  buySwaps: 0;
  sellSwaps: 0;
  unpricedSwaps: 0;
  volumeTokens: 0;
  volumeUsd: null;
  buyVolumeUsd: null;
  sellVolumeUsd: null;
  quoteUsdMethod: string;
  detail: Record<string, unknown>;
  methodVersion: string;
  source: string;
  method: string;
  fetchedAt: Date;
  provenance: Provenance;
};

const HOUR_MS = 3_600_000;
// as facts-of.ts worstProvenance (not imported: facts-of reads this file)
const worst = (a: Provenance, b: Provenance): Provenance =>
  a === b || b === 'live' ? a : a === 'live' ? b : 'mock';
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * The token bars of the hours from `from` (inclusive) to `to` (exclusive), both on the hour, from the snapshots of
 * the registry's USDC pools. Snapshots of another pool, outside the hours, or with a mid that is not a positive
 * number are left out. One bar per token and hour, in hour then address order.
 */
export function midBars(
  snapshots: readonly MidSnapshot[],
  pools: readonly MidPool[],
  hours: { from: Date; to: Date },
  /** Where the snapshots were read: the database (the hourly job) or the collector's day files (a one-off fill). */
  read: 'snapshots' | 'day_files' = 'snapshots',
): MidBar[] {
  const usdc = new Map(pools.filter((p) => p.quoteMint === USDC_MINT).map((p) => [p.address, p]));
  const from = hours.from.getTime();
  const to = hours.to.getTime();
  // token → hour → pool → snapshots
  const by = new Map<string, Map<number, Map<string, MidSnapshot[]>>>();
  for (const s of snapshots) {
    const p = usdc.get(s.pool);
    const t = s.fetchedAt.getTime();
    if (!p || !(t >= from && t < to) || !(Number.isFinite(s.midPrice) && s.midPrice > 0)) continue;
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    let token = by.get(p.assetMint);
    if (!token) {
      token = new Map();
      by.set(p.assetMint, token);
    }
    let h = token.get(hour);
    if (!h) {
      h = new Map();
      token.set(hour, h);
    }
    const list = h.get(s.pool);
    if (list) list.push(s);
    else h.set(s.pool, [s]);
  }
  const out: MidBar[] = [];
  for (const [address, token] of by)
    for (const [hour, byPool] of token) {
      const ranked = [...byPool.entries()]
        .map(([pool, snaps]) => {
          const depths = snaps
            .map((s) => s.inBandLiquidity)
            .filter((d): d is number => d !== null && Number.isFinite(d));
          return { pool, snaps, depth: depths.length ? median(depths) : null };
        })
        .sort(
          (a, b) =>
            (b.depth ?? Number.NEGATIVE_INFINITY) - (a.depth ?? Number.NEGATIVE_INFINITY) ||
            (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0),
        );
      const chosen = ranked[0] as (typeof ranked)[number];
      const snaps = [...chosen.snaps].sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime());
      const first = snaps[0] as MidSnapshot;
      const last = snaps.at(-1) as MidSnapshot;
      const mids = snaps.map((s) => s.midPrice);
      const venue = usdc.get(chosen.pool)?.venue ?? 'unknown';
      const versions = [...new Set(snaps.map((s) => s.methodVersion))].sort().join(', ');
      out.push({
        address,
        pool: 'asset',
        hour: new Date(hour),
        quoteAddress: null,
        openQuote: null,
        highQuote: null,
        lowQuote: null,
        closeQuote: null,
        vwapQuote: null,
        openUsd: first.midPrice,
        highUsd: Math.max(...mids),
        lowUsd: Math.min(...mids),
        closeUsd: last.midPrice,
        vwapUsd: null,
        swaps: 0,
        buySwaps: 0,
        sellSwaps: 0,
        unpricedSwaps: 0,
        volumeTokens: 0,
        volumeUsd: null,
        buyVolumeUsd: null,
        sellVolumeUsd: null,
        quoteUsdMethod: 'usdc_at_par',
        detail: {
          layer: MIDS_LAYER,
          pool: chosen.pool,
          snapshots: snaps.length,
          depth2pctUsd: chosen.depth,
          poolsWithSnapshots: ranked.length,
        },
        methodVersion: MIDS_METHOD_VERSION,
        source: `${read === 'snapshots' ? 'risk_pool_snapshots.mid_price' : "the pool collector's day files (pools/<day>.jsonl, midQuotePerAsset)"} of the USDC pool ${chosen.pool} (${venue}): ${snaps.length} snapshot${snaps.length > 1 ? 's' : ''} of the pool collector in the hour (Solana RPC getMultipleAccounts, decoded by @colosseum/risk; ${versions})`,
        method: MIDS_METHOD,
        fetchedAt: last.fetchedAt,
        provenance: snaps.reduce<Provenance>((p, s) => worst(p, s.provenance), 'live'),
      });
    }
  return out.sort(
    (a, b) =>
      a.hour.getTime() - b.hour.getTime() ||
      (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
  );
}
