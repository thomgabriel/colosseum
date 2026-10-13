import type { UniverseAsset } from '@colosseum/schemas';
import { defaultLivenessParams, markLiveness } from '../prices/liveness';
import { type PriceObservation, sourceKind } from '../prices/observation';
import { hourlyReferencePrices, type ReferencePrice } from '../prices/reference';
import { buildPriceIndex, defaultPriceParams } from '../prices/resolve';
import { buildSessionClock } from '../prices/session';
import { defaultRegimeParams } from '../time';

// PLAN-ASSETS AS.5: the aggregators' prices of the list's tokens, as `PriceObservation`s under their own source
// (`external:defillama`, `external:jupiter`), never blended with a pool or an oracle price (ORACLE-VS-DEX) and never
// a stablecoin set at par (D20). And what keeps them from changing the installed hourly price job
// (`com.colosseum.risk-prices`, gate PRICE-JOB): that job resolves every Solana observation of its last six days,
// so a new source's price of an asset it already values lands in that asset's `others`, and a newest observation
// moves the last hour it writes. `pricesToWrite` holds those back. `priceJobReferences` is the job's resolution step
// (scripts/risk/prices/job.ts and lib.ts' buildPriceInputs) without its I/O, for the proof on a frozen window.

export const DEFILLAMA_PRICE = 'external:defillama' as const;
export const JUPITER_PRICE = 'external:jupiter' as const;

type PriceAsset = Pick<UniverseAsset, 'chain' | 'address' | 'decimals'>;

export type ExternalPrice = PriceObservation & { fetchedAt: string; source: string };

export type PriceRefusal = { address: string; priceSource: string; reason: string };

/**
 * DefiLlama coins' current price (`coins.llama.fi/prices/current/<chain>:<address>`): per whole token at the
 * decimals DefiLlama names, so a price whose decimals differ from the chain's is refused, never rescaled.
 */
export function defillamaPrice(
  a: PriceAsset,
  coin: { price?: number; timestamp?: number; decimals?: number; confidence?: number } | undefined,
  read: { fetchedAt: string; url: string },
): ExternalPrice | PriceRefusal {
  const refuse = (reason: string) => ({ address: a.address, priceSource: DEFILLAMA_PRICE, reason });
  if (!coin || typeof coin.price !== 'number' || typeof coin.timestamp !== 'number')
    return refuse('not_priced_by_source');
  if (!(coin.price > 0)) return refuse('not_a_positive_price');
  if (typeof coin.decimals === 'number' && coin.decimals !== a.decimals)
    return refuse('decimals_differ_from_chain');
  return {
    chain: a.chain,
    mint: a.address,
    priceSource: DEFILLAMA_PRICE,
    t: coin.timestamp,
    slot: null,
    price: coin.price,
    quote: 'usd',
    ref: 'coins.llama.fi/prices/current',
    market: null,
    method: 'defillama_coins_current',
    sourceTs: coin.timestamp,
    fetchedAt: read.fetchedAt,
    source: `DefiLlama coins ${read.url}`,
  };
}

/**
 * Jupiter's lite price API (`lite-api.jup.ag/price/v3`): `usdPrice` per whole token at the decimals it names, at the
 * slot it names (`blockId`). It gives no time of its own: the observation is at the fetch.
 */
export function jupiterPrice(
  a: PriceAsset,
  answer: { usdPrice?: number; blockId?: number; decimals?: number } | undefined,
  read: { fetchedAt: string; url: string },
): ExternalPrice | PriceRefusal {
  const refuse = (reason: string) => ({ address: a.address, priceSource: JUPITER_PRICE, reason });
  if (!answer || typeof answer.usdPrice !== 'number') return refuse('not_priced_by_source');
  if (!(answer.usdPrice > 0)) return refuse('not_a_positive_price');
  if (typeof answer.decimals === 'number' && answer.decimals !== a.decimals)
    return refuse('decimals_differ_from_chain');
  return {
    chain: a.chain,
    mint: a.address,
    priceSource: JUPITER_PRICE,
    t: Math.floor(Date.parse(read.fetchedAt) / 1000),
    slot: typeof answer.blockId === 'number' ? answer.blockId : null,
    price: answer.usdPrice,
    quote: 'usd',
    ref: 'lite-api.jup.ag/price/v3',
    market: null,
    method: 'jupiter_price_v3',
    fetchedAt: read.fetchedAt,
    source: `Jupiter price API ${read.url}`,
  };
}

export const isPrice = (x: ExternalPrice | PriceRefusal): x is ExternalPrice => 'price' in x;

/**
 * Which Solana prices may be written without changing what the installed price job writes for the assets it values.
 *  - `none` (the default of the import): none. Every Solana row in `risk_price_observations` enters the job's window,
 *    so even a new asset's price becomes rows the job writes every hour (counted by the proof).
 *  - `unresolved`: the prices of assets the job does not value (no observation of another source on Solana, ever,
 *    and not in the collectors' registries), and only those no later, by the hour, than the newest observation the
 *    job already holds, since the newest observation sets the last hour the job writes for every asset.
 *  - `all`: every price; it changes the `others` of every asset the job values (stated, never the default).
 * Robinhood Chain's prices are not filtered: the job reads Solana rows only.
 */
export type SolanaPriceMode = 'none' | 'unresolved' | 'all';
export const SOLANA_PRICE_MODES: readonly SolanaPriceMode[] = ['none', 'unresolved', 'all'];

export function pricesToWrite(
  prices: readonly ExternalPrice[],
  o: { mode: SolanaPriceMode; resolved: ReadonlySet<string>; jobNewestT: number | null },
): { write: ExternalPrice[]; held: Record<string, number> } {
  const write: ExternalPrice[] = [];
  const held: Record<string, number> = {};
  const hold = (why: string) => {
    held[why] = (held[why] ?? 0) + 1;
  };
  for (const p of prices) {
    if (p.chain !== 'solana' || o.mode === 'all') {
      write.push(p);
      continue;
    }
    if (o.mode !== 'unresolved')
      hold(o.mode === 'none' ? 'solana_prices_off' : 'unknown_price_mode');
    else if (o.resolved.has(p.mint)) hold('asset_valued_by_the_price_job');
    else if (o.jobNewestT === null || Math.floor(p.t / 3600) > Math.floor(o.jobNewestT / 3600))
      hold('later_than_the_price_jobs_newest_hour');
    else write.push(p);
  }
  return { write, held };
}

// ---------------------------------------------------------------------------- the price job's resolution step

export type PriceJobInputs = {
  /** The observations of the job's window, each with its stored `live` flag. */
  observations: readonly PriceObservation[];
  calendar: { closed: string[]; earlyClose13ET: string[] };
  parMints: string[];
  continuousMints: string[];
  usdStableMints: string[];
  /** The job's `now`, Unix seconds, and how far back it rewrites (two days). */
  now: number;
  refreshSec: number;
  /** The wall clock buildPriceInputs reads (Unix seconds): its clocks run to a day after it. */
  wallNow: number;
};

/**
 * What scripts/risk/prices/job.ts resolves from a window: buildPriceInputs' liveness and index, the flags stored in
 * the table winning over the computed ones, then the reference price of every asset with an observation for every
 * hour of the last `refreshSec` up to the hour of the newest observation. Copies the observations; never mutates.
 */
export function priceJobReferences(i: PriceJobInputs): {
  rows: ReferencePrice[];
  lastHour: number;
} {
  const regime = defaultRegimeParams(i.calendar);
  const params = defaultPriceParams({
    parMints: i.parMints,
    continuousMints: i.continuousMints,
    usdStableMints: i.usdStableMints,
  });
  const all = i.observations.map((o) => ({ ...o }));
  const stored = new Map(all.map((o) => [o, o.live] as const));
  let minT = i.wallNow;
  const series = new Map<string, PriceObservation[]>();
  for (const o of all) {
    if (o.t < minT) minT = o.t;
    if (sourceKind(o.priceSource) !== 'lending_oracle' || i.continuousMints.includes(o.mint))
      continue;
    const k = `${o.priceSource}|${o.mint}|${o.quote}`;
    const a = series.get(k);
    if (a) a.push(o);
    else series.set(k, [o]);
  }
  const LP = defaultLivenessParams();
  for (const a of series.values()) {
    a.sort((x, y) => x.t - y.t || (x.slot ?? 0) - (y.slot ?? 0));
    const L = markLiveness(a, regime, LP);
    L.live.forEach((v, k) => {
      const o = a[k] as PriceObservation;
      if (v) delete o.live;
      else o.live = false;
    });
  }
  const clocks = {
    us_market_hours: buildSessionClock(minT - 86400, i.wallNow + 86400, regime, 'us_market_hours'),
    us_weekdays: buildSessionClock(minT - 86400, i.wallNow + 86400, regime, 'us_weekdays'),
  };
  const index = buildPriceIndex(all);
  // the table's flag wins (job.ts): true clears the computed flag, false sets it
  for (const o of all) {
    const was = stored.get(o);
    if (was === true) delete o.live;
    else if (was === false) o.live = false;
  }
  const ctx = { params, regime, clocks };
  const lastHour = Math.floor(index.last / 3600) * 3600;
  const rows: ReferencePrice[] = [];
  for (const [mint, first] of [...index.first].sort(([x], [y]) => x.localeCompare(y)))
    for (const r of hourlyReferencePrices(
      index,
      ctx,
      mint,
      Math.max(first, i.now - i.refreshSec),
      lastHour,
    ))
      rows.push(r);
  return { rows, lastHour };
}

/**
 * Compares the job's rows before and after observations are added: rows of the assets it valued before, byte for
 * byte as JSON, and what is new.
 */
export function compareJobRows(
  before: readonly ReferencePrice[],
  after: readonly ReferencePrice[],
) {
  const key = (r: ReferencePrice) => `${r.mint}|${r.t}`;
  const was = new Map(before.map((r) => [key(r), JSON.stringify(r)]));
  const mintsBefore = new Set(before.map((r) => r.mint));
  let identical = 0;
  const changed: string[] = [];
  const added = { existingAsset: 0, newAsset: 0 };
  const seen = new Set<string>();
  for (const r of after) {
    const k = key(r);
    seen.add(k);
    const w = was.get(k);
    if (w === undefined) {
      if (mintsBefore.has(r.mint)) added.existingAsset++;
      else added.newAsset++;
    } else if (w === JSON.stringify(r)) identical++;
    else changed.push(k);
  }
  const removed = [...was.keys()].filter((k) => !seen.has(k));
  return {
    rowsBefore: before.length,
    rowsAfter: after.length,
    identical,
    changed: changed.length,
    changedSample: changed.slice(0, 5),
    added,
    removed: removed.length,
    newAssets: new Set(after.filter((r) => !mintsBefore.has(r.mint)).map((r) => r.mint)).size,
  };
}
