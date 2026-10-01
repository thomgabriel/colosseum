import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  riskAssetSnapshots,
  riskEvents,
  riskLpConcentration,
  riskPoolSnapshots,
  riskPools,
  riskQuotes,
} from '@colosseum/db';

// Imports the collectors' files (~/.colosseum/risk) into the risk tables. Idempotent: every table has a
// natural primary key and inserts skip existing rows. Snapshots for pools not in risk_pools are skipped.
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const { db, client } = createDb();
const known = new Set((await db.select({ a: riskPools.address }).from(riskPools)).map((r) => r.a));
const lines = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith('.jsonl'))
        .sort()
        .flatMap((n) =>
          readFileSync(join(dir, n), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>),
        )
    : [];
const counts = { assets: 0, snapshots: 0, events: 0, lp: 0, quotes: 0, skippedUnknownPool: 0 };
const chunk = <T>(xs: T[], n = 500) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const snaps = lines(join(HOME, 'pools')).filter((r) => {
  const ok = known.has(r.pool as string);
  if (!ok) counts.skippedUnknownPool++;
  return ok && r.sell && r.buy;
});
for (const c of chunk(snaps)) {
  const res = await db
    .insert(riskPoolSnapshots)
    .values(
      c.map((r) => ({
        pool: r.pool as string,
        fetchedAt: new Date(r.fetchedAt as string),
        slot: Number(r.slot),
        midPrice: Number(r.midQuotePerAsset),
        activeLiquidity: (r.activeLiquidity as string | null) ?? null,
        sell: r.sell,
        buy: r.buy,
        inBandLiquidity:
          (r.depth2pct as { sellQuoteOut: number } | undefined)?.sellQuoteOut ?? null,
        methodVersion: r.methodVersion as string,
        source: r.source as string,
        method: r.method as string,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskPoolSnapshots.pool });
  counts.snapshots += res.length;
}
const evs = existsSync(join(HOME, 'events.jsonl'))
  ? readFileSync(join(HOME, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  : [];
for (const c of chunk(evs)) {
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
const lps = lines(join(HOME, 'lp'));
for (const c of chunk(lps)) {
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
const qs = lines(join(HOME, 'quotes')).filter(
  (q) => q.runId && q.assetMint && q.side && q.notionalUsd,
);
for (const c of chunk(qs)) {
  const res = await db
    .insert(riskQuotes)
    .values(
      c.map((q) => ({
        runId: q.runId as string,
        assetMint: q.assetMint as string,
        asset: q.asset as string,
        side: q.side as string,
        notionalUsd: Number(q.notionalUsd),
        amountIn: (q.amountIn as string) ?? null,
        outAmount: (q.outAmount as string) ?? null,
        route: q.route ?? null,
        error: (q.error as string) ?? null,
        fetchedAt: new Date(q.fetchedAt as string),
        source: (q.source as string) ?? null,
        method: (q.method as string) ?? null,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskQuotes.runId });
  counts.quotes += res.length;
}
const as = lines(join(HOME, 'assets'));
for (const c of chunk(as)) {
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
        sell: r.sell,
        buy: r.buy,
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
