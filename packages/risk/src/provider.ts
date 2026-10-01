import type {
  ExitCapacity,
  LiquidityAssessInput,
  LiquidityAssessment,
  LiquidityEntry,
  LiquidityProvider,
} from '@colosseum/schemas';
import { type AssetCurves, curveFor, weekendRatio, worstCapacity } from './assess';
import { assessLiquidity } from './breach';
import { costAt } from './curves';
import { REGIMES, type Regime, type RegimeParams } from './time';

/**
 * LiquidityProvider over a frozen snapshot of curves (deterministic: no clock, no I/O).
 * "Worst regime of a window" is the worst of every measured regime: any window of two days or more
 * contains a weekend, and shorter windows are treated the same way (conservative, documented).
 */
export type ProviderSnapshot = {
  /** Curves keyed by the structurer's asset id (registry id, e.g. 'spyx'). */
  curves: Map<string, AssetCurves>;
  /** Optional LP-exit stress cost (fraction) at a notional, per asset id. */
  lpExitCost?: (assetId: string, notionalUsd: number) => number | null;
  regimeParams: RegimeParams;
  methodVersion: string;
  provenance: 'live' | 'fixture' | 'mock';
};

export function createLiquidityProvider(s: ProviderSnapshot): LiquidityProvider {
  const measured = (a: AssetCurves): Regime[] => REGIMES.filter((r) => curveFor(a, r).curve);
  const cap = (assetId: string, tau: number): ExitCapacity | null => {
    const a = s.curves.get(assetId);
    if (!a) return null;
    const regimes = measured(a);
    if (!regimes.length) return null;
    const w = worstCapacity(a, regimes, tau);
    const c = curveFor(a, w.regime).curve;
    return {
      capacityUsd: w.capacityUsd,
      lowerBound: w.lowerBound,
      regime: w.regime,
      samples: c?.samples ?? 0,
      dataFrom: c?.from ?? null,
      dataTo: c?.to ?? null,
    };
  };
  const cost = (assetId: string, n: number): number | null => {
    const a = s.curves.get(assetId);
    if (!a) return null;
    let worst: number | null = null;
    for (const r of measured(a)) {
      const c = curveFor(a, r).curve;
      const k = c ? costAt(c, n) : null;
      if (k === null) return null; // beyond measured in some regime: not sellable at a known cost
      worst = worst === null ? k : Math.max(worst, k);
    }
    return worst;
  };
  return {
    methodVersion: s.methodVersion,
    provenance: s.provenance,
    covers: (id) => s.curves.has(id),
    exitCapacity: (id, tau) => cap(id, tau),
    exitCost: (id, n) => cost(id, n),
    weekendRatio: (id, tau) => {
      const a = s.curves.get(id);
      return a ? weekendRatio(a, tau) : null;
    },
    entry: (id, ctx): LiquidityEntry | null => {
      const c = cap(id, ctx.tau);
      if (!c) return null;
      return {
        assetId: id,
        score: ctx.legAmountUsd > 0 ? Math.min(1, c.capacityUsd / ctx.legAmountUsd) : 1,
        capacityUsd: c.capacityUsd,
        capacityLowerBound: c.lowerBound,
        worstRegime: c.regime,
        tau: ctx.tau,
        windowDays: ctx.windowDays,
        legAmountUsd: ctx.legAmountUsd,
        weekendRatio: (() => {
          const a = s.curves.get(id);
          return a ? weekendRatio(a, ctx.tau) : null;
        })(),
        lpExitCostPct: (() => {
          const k = s.lpExitCost?.(id, ctx.legAmountUsd);
          return k === null || k === undefined ? null : k * 100;
        })(),
        primaryPath: null,
        samples: c.samples,
        dataFrom: c.dataFrom,
        dataTo: c.dataTo,
        methodVersion: s.methodVersion,
        provenance: s.provenance,
      };
    },
    assess: (inp: LiquidityAssessInput): LiquidityAssessment => {
      const illiquid = inp.illiquid
        .filter((l) => s.curves.has(l.assetId))
        .map((l) => ({ ...l, curves: s.curves.get(l.assetId) as AssetCurves }));
      const r = assessLiquidity({ ...inp, illiquid, regimeParams: s.regimeParams });
      return {
        breach: r.breach,
        likelyBreach: r.likelyBreach,
        shortfallUsd: r.shortfallUsd,
        monthsAtRisk: r.monthsAtRisk,
        orders: r.orders,
        params: r.params,
        methodVersion: s.methodVersion,
      };
    },
  };
}
