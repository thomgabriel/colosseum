import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetObservations, type Db, riskPriceObservations } from '@colosseum/db';
import {
  type AssetMetric,
  type AssetObservation,
  type ExternalPrice,
  METRIC_CADENCE,
  METRICS_METHOD_VERSION,
  type RegisteredPool,
} from '@colosseum/risk';
import { sql } from 'drizzle-orm';

// PLAN-ASSETS AS.5: what the metrics import reads from and writes to the local database. Reads are SELECTs; writes
// are inserts into asset_observations and risk_price_observations that leave an existing row as it is (ON CONFLICT
// DO NOTHING on each table's key), so the same answers written twice insert nothing the second time. It loads no
// dotenv and reads no environment: the caller makes the connection.

const CHUNK = 1000;

/** postgres-js answers an array of rows; another driver may answer `{ rows }`. */
const rowsOf = <T>(r: unknown): T[] =>
  Array.isArray(r) ? (r as T[]) : (((r as { rows?: T[] } | null)?.rows ?? []) as T[]);

/** When the Solana pool registry was last built (its rows' newest fetched_at), or null when it is empty. */
export async function riskPoolsBuiltAt(db: Db) {
  const [r] = rowsOf<{ t: Date | string | null }>(
    await db.execute(sql`select max(fetched_at) as t from risk_pools`),
  );
  return r?.t ? new Date(r.t).toISOString() : null;
}

/** The Solana pool registry: every pool with its measured TVL, and the time it was built. */
export async function readRiskPools(db: Db) {
  const r = rowsOf<{
    address: string;
    venue: string;
    asset_mint: string;
    quote_mint: string;
    tvl_usd: number | null;
    tier: string;
    status: string;
    fetched_at: Date | string;
  }>(
    await db.execute(
      sql`select address, venue, asset_mint, quote_mint, tvl_usd, tier, status, fetched_at from risk_pools order by address`,
    ),
  );
  const rows: RegisteredPool[] = r.map((p) => ({
    address: p.address,
    venue: p.venue,
    assetMint: p.asset_mint,
    quoteMint: p.quote_mint,
    tvlUsd: p.tvl_usd === null ? null : Number(p.tvl_usd),
    tier: p.tier,
    status: p.status,
  }));
  const newest = r.reduce((m, p) => Math.max(m, new Date(p.fetched_at).getTime()), 0);
  return { rows, observedAt: newest ? new Date(newest).toISOString() : null };
}

/** This table's exchange-rate readings of some tokens since a time, oldest first. */
export async function readExchangeRateSeries(
  db: Db,
  chain: string,
  addresses: readonly string[],
  fromIso: string,
) {
  const byAddress: Record<string, Array<{ observedAt: string; value: number }>> = {};
  if (!addresses.length) return byAddress;
  const r = rowsOf<{ address: string; observed_at: Date | string; value: number }>(
    await db.execute(sql`select address, observed_at, value from asset_observations
      where chain = ${chain} and metric = 'exchange_rate' and value is not null
        and address in (${sql.join(
          addresses.map((a) => sql`${a}`),
          sql`, `,
        )}) and observed_at >= ${fromIso}
      order by address, observed_at`),
  );
  for (const x of r) {
    const xs = byAddress[x.address] ?? [];
    xs.push({ observedAt: new Date(x.observed_at).toISOString(), value: Number(x.value) });
    byAddress[x.address] = xs;
  }
  return byAddress;
}

/**
 * What the installed price job holds: the Solana assets it values (any observation of a source that is not
 * `external:`, ever, and every asset of the collectors' registries, so an asset a collector starts to price later is
 * counted already), and the newest of those observations, which sets the last hour it writes.
 */
export async function readPriceJobState(db: Db, riskHome: string) {
  const resolved = new Set<string>(
    rowsOf<{ mint: string }>(
      await db.execute(sql`select distinct mint from risk_price_observations
        where chain = 'solana' and price_source not like 'external:%'`),
    ).map((r) => r.mint),
  );
  const [newest] = rowsOf<{ t: Date | string | null }>(
    await db.execute(sql`select max(observed_at) as t from risk_price_observations
      where chain = 'solana' and price_source not like 'external:%'`),
  );
  const files: string[] = [];
  const reg = join(riskHome, 'registry.json');
  if (existsSync(reg)) {
    files.push(reg);
    for (const p of (
      JSON.parse(readFileSync(reg, 'utf8')) as { pools?: Array<{ assetMint?: string }> }
    ).pools ?? [])
      if (p.assetMint) resolved.add(p.assetMint);
  }
  const lreg = join(riskHome, 'lending-registry.json');
  if (existsSync(lreg)) {
    files.push(lreg);
    for (const r of (
      JSON.parse(readFileSync(lreg, 'utf8')) as {
        rows?: Array<{
          mint?: string | null;
          dexAssetMint?: string | null;
          debtMint?: string | null;
        }>;
      }
    ).rows ?? [])
      for (const m of [r.mint, r.dexAssetMint, r.debtMint]) if (m) resolved.add(m);
  }
  return {
    resolved: [...resolved].sort(),
    newestT: newest?.t ? Math.floor(new Date(newest.t).getTime() / 1000) : null,
    files,
  };
}

/** The newest row of each token and metric on one chain, keyed `address|metric`. */
export async function latestRows(db: Db, chain: string) {
  const r = rowsOf<{
    address: string;
    metric: string;
    value: number | null;
    null_reason: string | null;
    observed_at: Date | string;
    source: string;
  }>(
    await db.execute(sql`select distinct on (address, metric) address, metric, value, null_reason, observed_at, source
      from asset_observations where chain = ${chain}
      order by address, metric, observed_at desc`),
  );
  return new Map(
    r.map((x) => [
      `${x.address}|${x.metric}`,
      {
        value: x.value === null ? null : Number(x.value),
        nullReason: x.null_reason,
        observedAt: new Date(x.observed_at).toISOString(),
        source: x.source,
      },
    ]),
  );
}

/** The tokens with a row of one metric at one time on one chain. */
export async function addressesObservedAt(
  db: Db,
  chain: string,
  metric: AssetMetric,
  observedAt: string,
) {
  return new Set(
    rowsOf<{ address: string }>(
      await db.execute(sql`select distinct address from asset_observations
        where chain = ${chain} and metric = ${metric} and observed_at = ${observedAt}`),
    ).map((r) => r.address),
  );
}

/** The newest time of one metric on one chain, or null. */
export async function newestObservedAt(db: Db, chain: string, metric: AssetMetric) {
  const [r] = rowsOf<{ t: Date | string | null }>(
    await db.execute(
      sql`select max(observed_at) as t from asset_observations where chain = ${chain} and metric = ${metric}`,
    ),
  );
  return r?.t ? new Date(r.t).toISOString() : null;
}

/** A fact that has not moved is written again after this long, so a reader sees it is still read. */
export const UNCHANGED_REWRITE_MS: Record<'hourly' | 'daily', number> = {
  hourly: 24 * 3600 * 1000,
  daily: 7 * 24 * 3600 * 1000,
};

/**
 * Facts at every change (DA12): a row equal to the newest stored row of its token and metric (the same value or the
 * same reason, from the same source), no older than it and less than a day newer (a week for a daily metric), is
 * left out. A row of the same answers stored before is such a row. Pure.
 */
export function changedOnly(
  rows: readonly AssetObservation[],
  latest: ReadonlyMap<
    string,
    { value: number | null; nullReason: string | null; observedAt: string; source: string }
  >,
) {
  const keep: AssetObservation[] = [];
  let unchanged = 0;
  for (const r of rows) {
    const was = latest.get(`${r.address}|${r.metric}`);
    const age = was ? Date.parse(r.observedAt) - Date.parse(was.observedAt) : -1;
    if (
      was &&
      was.source === r.source &&
      was.value === r.value &&
      was.nullReason === r.nullReason &&
      age >= 0 &&
      age < UNCHANGED_REWRITE_MS[METRIC_CADENCE[r.metric]]
    ) {
      unchanged++;
      continue;
    }
    keep.push(r);
  }
  return { keep, unchanged };
}

export type WriteCounts = {
  dryRun: boolean;
  observations: { asked: number; inserted: number };
  prices: { asked: number; inserted: number };
};

/**
 * Writes the rows and the prices, leaving any row that exists as it is. With `dryRun` it returns what it was asked
 * and touches nothing: not one call is made on `db`.
 */
export async function writeRun(
  db: Db,
  rows: readonly AssetObservation[],
  prices: readonly ExternalPrice[],
  opts: { dryRun: boolean },
): Promise<WriteCounts> {
  const out: WriteCounts = {
    dryRun: opts.dryRun,
    observations: { asked: rows.length, inserted: 0 },
    prices: { asked: prices.length, inserted: 0 },
  };
  if (opts.dryRun) return out;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map((r) => ({
      chain: r.chain,
      address: r.address,
      metric: r.metric,
      value: r.value,
      unit: r.unit,
      nullReason: r.nullReason,
      observedAt: new Date(r.observedAt),
      height: r.height,
      detail: r.detail,
      methodVersion: r.methodVersion,
      source: r.source,
      method: r.method,
      fetchedAt: new Date(r.fetchedAt),
      provenance: r.provenance,
    }));
    const res = await db
      .insert(assetObservations)
      .values(part)
      .onConflictDoNothing()
      .returning({ a: assetObservations.address });
    out.observations.inserted += res.length;
  }
  for (let i = 0; i < prices.length; i += CHUNK) {
    const seen = new Set<string>();
    const part = prices
      .slice(i, i + CHUNK)
      .filter((p) => {
        const k = `${p.priceSource}|${p.ref}|${p.mint}|${p.t}|${p.slot ?? 0}|${p.price}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((p) => ({
        chain: p.chain,
        mint: p.mint,
        priceSource: p.priceSource,
        observedAt: new Date(p.t * 1000),
        slot: p.slot ?? 0,
        price: p.price,
        quote: p.quote,
        ref: p.ref,
        market: p.market,
        live: true,
        failedChecks: null,
        sourceTs: p.sourceTs ? new Date(p.sourceTs * 1000) : null,
        marketStatus: null,
        methodVersion: METRICS_METHOD_VERSION,
        source: p.source,
        method: p.method,
        fetchedAt: new Date(p.fetchedAt),
        provenance: 'live' as const,
      }));
    const res = await db
      .insert(riskPriceObservations)
      .values(part)
      .onConflictDoNothing()
      .returning({ m: riskPriceObservations.mint });
    out.prices.inserted += res.length;
  }
  return out;
}
