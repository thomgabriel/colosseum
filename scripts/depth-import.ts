import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, depthObservations } from '@colosseum/db';
import { and, eq } from 'drizzle-orm';

// Imports the cron's JSONL (default ~/.colosseum/depth) into depth_observations. Idempotent on (asset, notional, fetchedAt).
const dir = process.env.DEPTH_DIR ?? join(homedir(), '.colosseum', 'depth');
const { db, client } = createDb();
let inserted = 0;
let skipped = 0;
for (const f of readdirSync(dir)
  .filter((n) => n.endsWith('.jsonl'))
  .sort()) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as {
      assetId: string;
      side: string;
      notionalUsd: number;
      priceImpactPct: number | null;
      outAmount: string | null;
      routes: number | null;
      error: string | null;
      source: string;
      method: string;
      fetchedAt: string;
      provenance: 'live';
    };
    if (r.priceImpactPct === null || r.outAmount === null) {
      skipped++;
      continue;
    }
    const fetchedAt = new Date(r.fetchedAt);
    const exists = await db
      .select({ id: depthObservations.id })
      .from(depthObservations)
      .where(
        and(
          eq(depthObservations.assetId, r.assetId),
          eq(depthObservations.notionalUsd, String(r.notionalUsd)),
          eq(depthObservations.fetchedAt, fetchedAt),
        ),
      )
      .limit(1);
    if (exists.length) {
      skipped++;
      continue;
    }
    await db.insert(depthObservations).values({
      assetId: r.assetId,
      side: r.side,
      notionalUsd: String(r.notionalUsd),
      priceImpactPct: String(r.priceImpactPct),
      outAmount: r.outAmount,
      route: { routes: r.routes },
      source: r.source,
      method: r.method,
      fetchedAt,
      provenance: r.provenance,
    });
    inserted++;
  }
}
console.log(JSON.stringify({ dir, inserted, skipped }));
await client.end();
