import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createDb } from '@colosseum/db';
import { SHELF_FLOOR_USD } from '@colosseum/risk';
import { type ChainId, UniverseList } from '@colosseum/schemas';
import { sql } from 'drizzle-orm';
import { type StampedReading, shelfEntries, shelfFile, type TrackedOracle } from './shelf-build';

// `pnpm risk:shelf <solana|robinhood|all> [--floor <dollars>]` (PLAN-ASSETS AS.9 and AS.10, gate ASSET-SHELF):
// cuts each chain's shelf from the committed list and the newest dex_volume_24h_usd reading in
// asset_observations, and writes scripts/risk/assets/shelf-<chain>.json and shelf-entries-<chain>.json.
// Reads the local database (DATABASE_URL, else the local one) and the committed lists only.

const args = process.argv.slice(2);
const which = args[0];
if (!which || !['solana', 'robinhood', 'all'].includes(which)) {
  console.error('usage: pnpm risk:shelf <solana|robinhood|all> [--floor <dollars>]');
  process.exit(2);
}
const i = args.indexOf('--floor');
const floorUsd = i >= 0 ? Number(args[i + 1]) : SHELF_FLOOR_USD;
if (!Number.isFinite(floorUsd) || floorUsd <= 0)
  throw new Error(`--floor ${args[i + 1]}: not a floor`);
const chains: ChainId[] = which === 'all' ? ['solana', 'robinhood'] : [which as ChainId];

const dir = 'scripts/risk/assets';
const { db, client } = createDb();
try {
  for (const chain of chains) {
    const listFile = `${dir}/${chain}.json`;
    // the list as committed: a shelf names the commit it was cut from
    const commit = execFileSync('git', ['log', '-1', '--format=%h', '--', listFile], {
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', listFile], {
      encoding: 'utf8',
    }).trim();
    if (!commit || dirty) throw new Error(`${listFile}: commit the list before cutting its shelf`);
    const list = UniverseList.parse(JSON.parse(readFileSync(listFile, 'utf8')));
    const tracked = JSON.parse(readFileSync(`scripts/risk/universe/${chain}.json`, 'utf8')) as {
      assets: Array<{ id: string; oracle: TrackedOracle }>;
    };
    const trackedOracle = new Map(tracked.assets.map((t) => [t.id, t.oracle]));
    const res = await db.execute(
      sql`select distinct on (address) address, value, observed_at, source, method, fetched_at, provenance
          from asset_observations where chain = ${chain} and metric = 'dex_volume_24h_usd'
          and provenance = 'live'
          order by address, observed_at desc`,
    );
    const readings: StampedReading[] = (res as unknown as Array<Record<string, unknown>>).map(
      (r) => ({
        address: String(r.address),
        value: r.value === null ? null : Number(r.value),
        observedAt: new Date(r.observed_at as string).toISOString(),
        source: String(r.source),
        method: String(r.method),
        fetchedAt: new Date(r.fetched_at as string).toISOString(),
        provenance: String(r.provenance),
      }),
    );
    const shelf = shelfFile({
      chain,
      listFile,
      listCommit: commit,
      assets: list.assets,
      readings,
      floorUsd,
    });
    // a dollar-yield token's yield reading: a yield_observations row of a registry asset at its address
    // (live only), frozen with the shelf's dollar-yield tokens so the test reads the same answer
    const y = (await db.execute(
      sql`select distinct on (a.mint) a.mint, a.id, y.source, y.fetched_at
          from yield_observations y join assets a on a.id = y.asset_id
          where a.mint is not null and y.provenance = 'live' order by a.mint, y.fetched_at desc`,
    )) as unknown as Array<{ mint: string; id: string; source: string; fetched_at: string }>;
    const yieldOf = new Map(y.map((r) => [r.mint.toLowerCase(), r]));
    const dollarYield = shelf.rows.filter((r) => r.cls === 'dollar_yield');
    const yieldReadings = dollarYield.flatMap((r) => {
      const hit = yieldOf.get(r.address.toLowerCase());
      return hit
        ? [
            {
              address: r.address,
              assetId: hit.id,
              source: hit.source,
              fetchedAt: new Date(hit.fetched_at).toISOString(),
            },
          ]
        : [];
    });
    const withYield = new Set(yieldReadings.map((r) => r.address.toLowerCase()));
    const shelfPath = `${dir}/shelf-${chain}.json`;
    const entries = shelfEntries({
      shelf,
      shelfPath,
      assets: list.assets,
      trackedOracle: (id) => trackedOracle.get(id) ?? null,
      hasYieldReading: (a) => withYield.has(a.toLowerCase()),
    });
    // every reading the cut considered, frozen so the test re-cuts the shelf
    const listed = new Set(
      list.assets
        .filter((a) => a.status === 'listed' || a.status === 'candidate')
        .map((a) => (chain === 'solana' ? a.address : a.address.toLowerCase())),
    );
    const frozen = readings.filter((r) =>
      listed.has(chain === 'solana' ? r.address : r.address.toLowerCase()),
    );
    const fixture = `fixtures/risk/assets/shelf-readings-${chain}.json`;
    writeFileSync(
      fixture,
      `${JSON.stringify({ chain, readings: frozen, yieldAsked: dollarYield.map((r) => r.address), yieldReadings }, null, 1)}\n`,
    );
    writeFileSync(shelfPath, `${JSON.stringify({ ...shelf, readingsFrozen: fixture }, null, 2)}\n`);
    writeFileSync(`${dir}/shelf-entries-${chain}.json`, `${JSON.stringify(entries, null, 2)}\n`);
    const byCls: Record<string, number> = {};
    for (const r of shelf.rows) byCls[r.cls] = (byCls[r.cls] ?? 0) + 1;
    console.log(
      JSON.stringify({
        chain,
        reading: shelf.reading,
        counts: shelf.counts,
        byClass: byCls,
        entries: entries.entries.length,
        waiting: entries.waiting,
      }),
    );
  }
} finally {
  await client.end();
}
