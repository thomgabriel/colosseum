import 'dotenv/config';
import { createDb, depthObservations, fxObservations, yieldObservations } from '@colosseum/db';
import {
  buildRiskSheet,
  fetchAllYields,
  fetchFx,
  pickPrimaryYield,
  REGISTRY,
} from '@colosseum/engine';
import type { DepthObservation } from '@colosseum/schemas';
import { desc } from 'drizzle-orm';

// Refreshes yield and FX observations into Postgres and prints the risk sheet built from the latest data.
// Run: pnpm feeds:refresh   (D4-PM; later a cron every hour)
const { db, client } = createDb();
const { observations, errors } = await fetchAllYields(REGISTRY);
for (const o of observations) {
  await db.insert(yieldObservations).values({
    assetId: o.assetId,
    quotedYield: String(o.quotedYield),
    haircutYield: String(o.haircutYield),
    haircutRule: o.haircutRule,
    source: o.source,
    method: o.method,
    fetchedAt: new Date(o.fetchedAt),
    provenance: o.provenance,
  });
}
const fx = await fetchFx();
for (const f of fx)
  await db.insert(fxObservations).values({
    pair: f.pair,
    value: String(f.value),
    source: f.source,
    method: f.method,
    fetchedAt: new Date(f.fetchedAt),
    provenance: f.provenance,
  });

const depthRows = await db
  .select()
  .from(depthObservations)
  .orderBy(desc(depthObservations.fetchedAt))
  .limit(400);
const depth = new Map<string, DepthObservation[]>();
for (const r of depthRows) {
  const list = depth.get(r.assetId) ?? [];
  if (!list.some((x) => x.notionalUsd === Number(r.notionalUsd)))
    list.push({
      assetId: r.assetId,
      side: r.side as 'buy',
      notionalUsd: Number(r.notionalUsd),
      priceImpactPct: Number(r.priceImpactPct),
      outAmount: r.outAmount,
      source: r.source,
      method: r.method,
      fetchedAt: r.fetchedAt.toISOString(),
      provenance: r.provenance,
    });
  depth.set(r.assetId, list);
}
const sheet = buildRiskSheet({ assets: REGISTRY, yields: pickPrimaryYield(observations), depth });
console.log(
  JSON.stringify(
    {
      yields: observations.map((o) => ({
        assetId: o.assetId,
        method: o.method,
        quoted: o.quotedYield,
        haircut: o.haircutYield,
        rule: o.haircutRule,
        fetchedAt: o.fetchedAt,
      })),
      errors,
      fx: fx.map((f) => ({ pair: f.pair, value: f.value, method: f.method })),
      riskSheet: sheet,
    },
    null,
    1,
  ),
);
await client.end();
