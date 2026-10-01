import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createDb, riskDepthCurves, riskPoolSnapshots, riskPools } from '@colosseum/db';
import {
  type CostSample,
  defaultRegimeParams,
  fitCurve,
  REGIMES,
  type Regime,
  regimeAt,
} from '@colosseum/risk';
import { inArray, sql } from 'drizzle-orm';

// Computes asset-level depth curves from pool snapshots. Per asset and snapshot time, the asset's sell
// (buy) outcome at each notional is the best single exit pool (USDC/USDT and SOL pools); routing across
// pools is not added, so curves are a lower bound on what a router achieves. Samples are bucketed by
// regime and fitted with fitCurve. Persisted to risk_depth_curves with method_version.
export const CURVE_METHOD_VERSION = 'risk-0.2';
const QUANTILE = Number(process.env.RISK_CURVE_QUANTILE ?? 0.5);
const MIN_SAMPLES = Number(process.env.RISK_MIN_SAMPLES ?? 8);
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);

const { db, client } = createDb();
const pools = await db
  .select()
  .from(riskPools)
  .where(inArray(riskPools.exitPath, ['direct_usd', 'via_sol']));
const byPool = new Map(pools.map((p) => [p.address, p]));
const snaps = await db
  .select({
    pool: riskPoolSnapshots.pool,
    fetchedAt: riskPoolSnapshots.fetchedAt,
    sell: riskPoolSnapshots.sell,
    buy: riskPoolSnapshots.buy,
  })
  .from(riskPoolSnapshots)
  .where(inArray(riskPoolSnapshots.pool, [...byPool.keys()]));
type Pt = { notionalUsd: number; outUsd: number };
// asset → time → side → notional → best outUsd
const best = new Map<
  string,
  Map<string, { sell: Map<number, number>; buy: Map<number, number> }>
>();
for (const s of snaps) {
  const p = byPool.get(s.pool);
  if (!p) continue;
  const t = s.fetchedAt.toISOString();
  const a = best.get(p.assetMint) ?? new Map();
  const e = a.get(t) ?? { sell: new Map<number, number>(), buy: new Map<number, number>() };
  for (const side of ['sell', 'buy'] as const) {
    for (const pt of (s[side] as Pt[]) ?? []) {
      if (!Number.isFinite(pt.outUsd)) continue;
      e[side].set(pt.notionalUsd, Math.max(e[side].get(pt.notionalUsd) ?? 0, pt.outUsd));
    }
  }
  a.set(t, e);
  best.set(p.assetMint, a);
}
const symbol = new Map(pools.map((p) => [p.assetMint, p.assetSymbol]));
let written = 0;
const now = new Date();
for (const [mint, times] of best) {
  for (const side of ['sell', 'buy'] as const) {
    const byRegime = new Map<Regime, Array<CostSample & { at: string }>>();
    for (const [t, e] of times) {
      const r = regimeAt(new Date(t), P);
      const arr = byRegime.get(r) ?? [];
      for (const [n, out] of e[side]) arr.push({ notionalUsd: n, cost: 1 - out / n, at: t });
      byRegime.set(r, arr);
    }
    for (const r of REGIMES) {
      const samples = byRegime.get(r);
      if (!samples?.length) continue;
      const c = fitCurve(samples, { quantile: QUANTILE, minSamples: MIN_SAMPLES });
      const row = {
        assetMint: mint,
        assetSymbol: symbol.get(mint) ?? mint.slice(0, 6),
        side,
        regime: r,
        points: c.points,
        insufficientFrom: c.insufficientFrom,
        quantile: c.quantile,
        minSamples: c.minSamples,
        samples: c.samples,
        dataFrom: c.from ? new Date(c.from) : null,
        dataTo: c.to ? new Date(c.to) : null,
        computedAt: now,
        methodVersion: CURVE_METHOD_VERSION,
        source: 'risk_pool_snapshots (best single exit pool per snapshot)',
        method: 'fitCurve_isotonic_pl_ln_notional',
        provenance: 'live' as const,
      };
      await db
        .insert(riskDepthCurves)
        .values(row)
        .onConflictDoUpdate({
          target: [
            riskDepthCurves.assetMint,
            riskDepthCurves.side,
            riskDepthCurves.regime,
            riskDepthCurves.methodVersion,
          ],
          set: { ...row, assetMint: sql`excluded.asset_mint` },
        });
      written++;
    }
  }
}
await client.end();
console.log(
  JSON.stringify({
    assets: best.size,
    curves: written,
    snapshots: snaps.length,
    quantile: QUANTILE,
    minSamples: MIN_SAMPLES,
    methodVersion: CURVE_METHOD_VERSION,
  }),
);
