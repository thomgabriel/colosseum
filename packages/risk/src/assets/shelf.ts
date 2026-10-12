// The shelf of gate ASSET-SHELF, as the backfill's trading series take it (gate ASSET-HISTORY-2, PLAN-ASSETS
// AS.8): on a chain, every `listed` or `candidate` row of the universe list whose newest DexScreener 24 h volume
// reading (`asset_observations`, metric `dex_volume_24h_usd`) is at least the floor. Pure: the rows and the
// readings are passed in; the reading's time is named from the readings themselves.

/** The statuses a shelf row may have (ASSET-SHELF): `held_out` and `excluded` never join. */
export const SHELF_STATUSES: readonly string[] = ['listed', 'candidate'];
/** The floor of ASSET-SHELF, in dollars of DEX volume a day. */
export const SHELF_FLOOR_USD = 100_000;

export type ShelfListRow = { address: string; symbol: string; status: string };
/** One reading of a token's DEX volume: `value` null when the metric job read none (its null reason). */
export type VolumeReading = { address: string; value: number | null; observedAt: string };
export type ShelfToken = {
  address: string;
  symbol: string;
  volume24hUsd: number;
  observedAt: string;
};
export type Shelf = {
  floorUsd: number;
  tokens: ShelfToken[];
  /** The oldest and newest of the newest readings of the rows considered: the reading the shelf names. */
  reading: { from: string; to: string } | null;
  counts: {
    considered: number;
    onShelf: number;
    belowFloor: number;
    nullReading: number;
    noReading: number;
  };
};

/** The newest reading per address (by `observedAt`), addresses keyed by `key`. */
export function newestReadings(
  readings: VolumeReading[],
  key: (address: string) => string = (a) => a,
): Map<string, VolumeReading> {
  const out = new Map<string, VolumeReading>();
  for (const r of readings) {
    const k = key(r.address);
    const have = out.get(k);
    if (!have || Date.parse(r.observedAt) > Date.parse(have.observedAt)) out.set(k, r);
  }
  return out;
}

/**
 * The shelf: the rows of a shelf status whose newest reading is at least `floorUsd`. A row whose newest reading
 * is null is off the shelf even when an older one passed (the newest reading decides). `key` makes addresses
 * comparable (lower case on EVM). Tokens are in the list's order.
 */
export function cutShelf(
  rows: ShelfListRow[],
  readings: VolumeReading[],
  floorUsd: number = SHELF_FLOOR_USD,
  key: (address: string) => string = (a) => a,
): Shelf {
  const newest = newestReadings(readings, key);
  const considered = rows.filter((r) => SHELF_STATUSES.includes(r.status));
  const tokens: ShelfToken[] = [];
  const times: string[] = [];
  let belowFloor = 0;
  let nullReading = 0;
  let noReading = 0;
  for (const r of considered) {
    const n = newest.get(key(r.address));
    if (!n) {
      noReading++;
      continue;
    }
    times.push(n.observedAt);
    if (n.value === null) nullReading++;
    else if (n.value >= floorUsd)
      tokens.push({
        address: r.address,
        symbol: r.symbol,
        volume24hUsd: n.value,
        observedAt: n.observedAt,
      });
    else belowFloor++;
  }
  const sorted = times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    floorUsd,
    tokens,
    reading: sorted.length
      ? { from: sorted[0] as string, to: sorted[sorted.length - 1] as string }
      : null,
    counts: {
      considered: considered.length,
      onShelf: tokens.length,
      belowFloor,
      nullReading,
      noReading,
    },
  };
}

/**
 * Eight hex characters naming a set of addresses (FNV-1a over the sorted, `key`ed addresses): two shelves with
 * the same tokens have the same name whatever the reading, and a token in or out changes it.
 */
export function shelfHash(addresses: string[], key: (a: string) => string = (a) => a): string {
  let h = 0x811c9dc5;
  for (const a of [...new Set(addresses.map(key))].sort()) {
    for (let i = 0; i < a.length; i++) {
      h ^= a.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c; // a separator, so ["ab","c"] and ["a","bc"] differ
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The block nearest a time (within the tolerance), by the secant on block times read through `timeOf` (the caller's reader,
 * which waits out the live loop's minutes): from the head and a first guess at `blocksPerDay`, at most `steps`
 * reads, ending within `toleranceS` seconds. The answer is never past the head nor below block 0.
 */
export async function blockAtTime(
  timeOf: (block: number) => Promise<number>,
  head: number,
  t: number,
  opts: { blocksPerDay: number; toleranceS?: number; steps?: number } = { blocksPerDay: 855_000 },
): Promise<{ block: number; time: number; reads: number }> {
  const tol = opts.toleranceS ?? 60;
  const steps = opts.steps ?? 8;
  let b1 = head;
  let t1 = await timeOf(b1);
  let reads = 1;
  if (t >= t1) return { block: head, time: t1, reads };
  let b2 = Math.max(0, Math.round(head - ((t1 - t) / 86_400) * opts.blocksPerDay));
  let t2 = await timeOf(b2);
  reads++;
  for (let i = 0; i < steps && Math.abs(t2 - t) > tol && b1 !== b2 && t1 !== t2; i++) {
    const next = Math.min(head, Math.max(0, Math.round(b2 + ((t - t2) * (b1 - b2)) / (t1 - t2))));
    if (next === b2) break;
    b1 = b2;
    t1 = t2;
    b2 = next;
    t2 = await timeOf(b2);
    reads++;
  }
  return { block: b2, time: t2, reads };
}
