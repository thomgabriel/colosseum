import 'dotenv/config';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  riskAssetSnapshots,
  riskEvents,
  riskLpConcentration,
  riskPoolSnapshots,
  riskPools,
} from '@colosseum/db';
import { packSide } from '@colosseum/risk';
import { and, gte, lte, max, notLike, sql } from 'drizzle-orm';
import { dayFilesFrom, jsonlChunks, poolSidesToStore, rowsSince } from './lib-import';

// Imports the collectors' files (~/.colosseum/risk) into the risk tables. Idempotent: every table has a
// natural primary key and inserts skip existing rows. Snapshots for pools not in risk_pools are skipped.
// Each table reads only the day files from its newest imported day on, streamed in chunks of 500 (PLAN-ANALYTICS
// item 2: re-reading all history grew the heap by about 0.24 GB per collected day), and sends only the rows
// from its newest imported time on (`rowsSince`; Oct 18, DB-LOAD: each run sent the whole day file again, up
// to 39,000 rows and 60 MB into the hosted database). RISK_IMPORT_ALL=1 re-reads and sends all.
// The Jupiter cross-check quotes (quotes/<day>.jsonl) are no longer imported: nothing reads risk_quotes, and
// the collector's files are their record (DB-RETENTION).
// DB-STORAGE (Oct 18): curves are stored as [notionalUsd, outUsd] pairs (`packSide`), and a pool side a ten-minute
// run found unchanged as JSON null (`poolSidesToStore`, lib-import.ts); the files keep every key as written.
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const { db, client } = createDb();
const known = new Set((await db.select({ a: riskPools.address }).from(riskPools)).map((r) => r.a));
const ALL = process.env.RISK_IMPORT_ALL === '1';
type Row = Record<string, unknown>;
const counts = {
  assets: 0,
  snapshots: 0,
  events: 0,
  lp: 0,
  skippedUnknownPool: 0,
  alreadySent: 0,
  sidesAsBefore: 0,
};
/**
 * Every chunk of the rows of `sub` still to send: its day files from the table's newest imported day on, and in
 * them the rows from its newest imported time on.
 */
async function* rowsOf(
  sub: string,
  newest: () => Promise<Array<{ t: Date | null }>>,
): AsyncGenerator<Row[]> {
  const last = ALL ? null : ((await newest())[0]?.t ?? null);
  for (const f of dayFilesFrom(join(HOME, sub), last))
    for await (const c of jsonlChunks<Row>(f, 500)) {
      const fresh = rowsSince(c, last, (r) => r.fetchedAt);
      counts.alreadySent += c.length - fresh.length;
      if (fresh.length) yield fresh;
    }
}

// Each pool's last stored curve per side, from the rows up to the newest imported time (an hourly run stores
// every pool's curves, so six hours reach every pool still read); with RISK_IMPORT_ALL=1, from the files alone.
const lastSide = new Map<string, string>();
const newestPool = ALL
  ? null
  : ((await db.select({ t: max(riskPoolSnapshots.fetchedAt) }).from(riskPoolSnapshots))[0]?.t ??
    null);
if (newestPool)
  for (const s of ['sell', 'buy'] as const) {
    const col = riskPoolSnapshots[s];
    const rows = await db
      .selectDistinctOn([riskPoolSnapshots.pool], { pool: riskPoolSnapshots.pool, side: col })
      .from(riskPoolSnapshots)
      .where(
        and(
          gte(riskPoolSnapshots.fetchedAt, new Date(newestPool.getTime() - 6 * 3_600_000)),
          lte(riskPoolSnapshots.fetchedAt, newestPool),
          sql`jsonb_typeof(${col}) <> 'null'`,
        ),
      )
      .orderBy(riskPoolSnapshots.pool, sql`${riskPoolSnapshots.fetchedAt} desc`);
    for (const r of rows) lastSide.set(`${r.pool} ${s}`, JSON.stringify(packSide(r.side)));
  }
const asStored = (side: unknown) => (side === null ? sql`'null'::jsonb` : side);

for await (const all of rowsOf('pools', () =>
  db.select({ t: max(riskPoolSnapshots.fetchedAt) }).from(riskPoolSnapshots),
)) {
  const c = all.filter((r) => {
    const ok = known.has(r.pool as string);
    if (!ok) counts.skippedUnknownPool++;
    return ok && r.sell && r.buy;
  });
  if (!c.length) continue;
  const res = await db
    .insert(riskPoolSnapshots)
    .values(
      c.map((r) => {
        const side = poolSidesToStore(
          r as { pool: unknown; fetchedAt: unknown; sell: unknown; buy: unknown },
          lastSide,
        );
        counts.sidesAsBefore += Number(side.sell === null) + Number(side.buy === null);
        return {
          pool: r.pool as string,
          fetchedAt: new Date(r.fetchedAt as string),
          slot: Number(r.slot),
          midPrice: Number(r.midQuotePerAsset),
          activeLiquidity: (r.activeLiquidity as string | null) ?? null,
          sell: asStored(side.sell),
          buy: asStored(side.buy),
          inBandLiquidity:
            (r.depth2pct as { sellQuoteOut: number } | undefined)?.sellQuoteOut ?? null,
          methodVersion: r.methodVersion as string,
          source: r.source as string,
          method: r.method as string,
          provenance: 'live' as const,
        };
      }),
    )
    .onConflictDoNothing()
    .returning({ p: riskPoolSnapshots.pool });
  counts.snapshots += res.length;
}
// events.jsonl is one file: streamed, rows before the newest imported event skipped
const lastEvent = ALL
  ? null
  : ((await db.select({ t: max(riskEvents.fetchedAt) }).from(riskEvents))[0]?.t ?? null);
const eventChunks = existsSync(join(HOME, 'events.jsonl'))
  ? jsonlChunks<Row>(join(HOME, 'events.jsonl'), 500)
  : [];
for await (const all of eventChunks) {
  const c = rowsSince(all, lastEvent, (e) => e.fetchedAt);
  counts.alreadySent += all.length - c.length;
  if (!c.length) continue;
  const res = await db
    .insert(riskEvents)
    .values(
      c.map((e) => ({
        pool: e.pool as string,
        kind: e.kind as string,
        fetchedAt: new Date(e.fetchedAt as string),
        slot: Number(e.slot ?? 0),
        asset: (e.asset as string) ?? null,
        detail: e,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskEvents.pool });
  counts.events += res.length;
}
for await (const c of rowsOf('lp', () =>
  db.select({ t: max(riskLpConcentration.fetchedAt) }).from(riskLpConcentration),
)) {
  const res = await db
    .insert(riskLpConcentration)
    .values(
      c.map((r) => ({
        pool: r.pool as string,
        fetchedAt: new Date(r.fetchedAt as string),
        asset: r.asset as string,
        positions: Number(r.positions),
        inBandPositions: Number(r.inBandPositions),
        top1: Number(r.top1),
        top3: Number(r.top3),
        top10: Number(r.top10),
        holderKind: r.holderKind as string,
        bandPct: Number(r.bandPct),
        lpExitN: Number(r.lpExitN),
        sellBase: r.sellBase,
        sellWithoutTopN: r.sellWithoutTopN,
        methodVersion: r.methodVersion as string,
        source: r.source as string,
        method: r.method as string,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskLpConcentration.pool });
  counts.lp += res.length;
}
// Robinhood Chain's curves share the table (scripts/risk-evm/import.ts, on their own clock): the newest
// imported time is Solana's own, whose mints never start with 0x.
for await (const c of rowsOf('assets', () =>
  db
    .select({ t: max(riskAssetSnapshots.fetchedAt) })
    .from(riskAssetSnapshots)
    .where(notLike(riskAssetSnapshots.assetMint, '0x%')),
)) {
  const res = await db
    .insert(riskAssetSnapshots)
    .values(
      c.map((r) => ({
        assetMint: r.assetMint as string,
        asset: r.asset as string,
        fetchedAt: new Date(r.fetchedAt as string),
        slot: Number(r.slot),
        refPool: r.refPool as string,
        refMidUsd: Number(r.refMidUsd),
        pools: Number(r.pools),
        sell: packSide(r.sell),
        buy: packSide(r.buy),
        methodVersion: r.methodVersion as string,
        source: r.source as string,
        method: r.method as string,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ a: riskAssetSnapshots.assetMint });
  counts.assets += res.length;
}
await client.end();
console.log(JSON.stringify({ home: HOME, inserted: counts }));
