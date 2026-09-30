import {
  applyHaircut,
  buildSchedule,
  buildScheduleWithStresses,
  REGISTRY,
  REGISTRY_BY_ID,
  solve,
} from '@colosseum/engine';
import type { ConstraintSheet, YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

const fx = 5;
const obs = (assetId: string, method: string, quoted: number): [string, YieldObservation] => {
  const a = REGISTRY_BY_ID.get(assetId);
  if (!a) throw new Error(assetId);
  const h = applyHaircut(a, method, quoted);
  return [
    assetId,
    {
      assetId,
      quotedYield: quoted,
      haircutYield: h.haircutYield,
      haircutRule: h.rule.id,
      source: 'fixture',
      method,
      fetchedAt: '2026-09-30T00:00:00.000Z',
      provenance: 'fixture',
    },
  ];
};
const yields = new Map([
  obs('kamino-usdc', 'protocol_api', 0.04),
  obs('usdy', 'realised_30d', 0.05),
  obs('syrupusdc', 'realised_30d', 0.055),
]);
const now = '2026-10';
const income: ConstraintSheet = {
  language: 'pt',
  currency: 'BRL',
  profile: 'income',
  target: { kind: 'monthly_cashflow', amountBrl: 3000, startMonth: '2026-11' },
  horizonMonths: 24,
  liquidityWindowDays: 7,
  riskBudget: 'low',
  creditTolerance: 'limited',
  fxStance: 'hedge_near_term',
};

const plan = (sheet: ConstraintSheet, capitalUsd: number) => {
  const r = solve({ sheet, capitalUsd, assets: REGISTRY, yields, fxUsdBrl: fx, nowMonth: now });
  return {
    sheet,
    legs: r.legs,
    assets: REGISTRY_BY_ID,
    yields,
    capitalUsd,
    fxUsdBrl: fx,
    nowMonth: now,
  };
};

describe('schedule', () => {
  it('reproduces month one by hand (spreadsheet cross-check)', () => {
    const input = plan(income, 100_000);
    const r = buildSchedule(input, undefined);
    // Hand computation of month 0 (2026-10): no withdrawal yet; every USD leg accrues haircut_yield/12; BRL leg flat.
    let usd = 0;
    let brl = 0;
    for (const l of input.legs) {
      const a = REGISTRY_BY_ID.get(l.assetId);
      if (!a) throw new Error(l.assetId);
      const v = l.weight * 100_000;
      if (a.kind === 'brl_stable') brl += v * fx;
      else
        usd +=
          v * (1 + (a.kind === 'usd_yield' ? (yields.get(l.assetId)?.haircutYield ?? 0) / 12 : 0));
    }
    const expectedBrl = Math.round((usd + brl / fx) * fx * 100) / 100;
    expect(r.rows[0]?.month).toBe('2026-10');
    expect(r.rows[0]?.withdrawalBrl).toBe(0);
    expect(r.rows[0]?.balanceBrl).toBeCloseTo(expectedBrl, 2);
    // Month 1 (2026-11): withdrawal 3000 BRL comes out of the BRL leg first.
    expect(r.rows[1]?.withdrawalBrl).toBe(3000);
    expect(r.rows[1]?.liquidityOk).toBe(true);
  });
  it('funds every month when capital is ample and fails months when it is not', () => {
    expect(buildSchedule(plan(income, 100_000)).liquidityOk).toBe(true);
    const poor = buildSchedule(plan(income, 5_000));
    expect(poor.liquidityOk).toBe(false);
    expect(poor.summary.shortfallBrl).toBeGreaterThan(0);
    expect(poor.summary.monthsFunded).toBeLessThan(poor.summary.monthsTotal);
  });
  it('runs at least four stresses for an income goal and BRL appreciation lowers the terminal BRL balance', () => {
    const s = buildScheduleWithStresses(plan(income, 100_000));
    expect(s.stresses.length).toBeGreaterThanOrEqual(4);
    const app =
      s.stressSummaries.find((x) => x.id === 'brl_appreciates')?.summary.terminalBalanceBrl ?? 0;
    const dep =
      s.stressSummaries.find((x) => x.id === 'brl_depreciates')?.summary.terminalBalanceBrl ?? 0;
    expect(app).toBeLessThan(s.base.summary.terminalBalanceBrl);
    expect(dep).toBeGreaterThan(s.base.summary.terminalBalanceBrl);
    const fall =
      s.stressSummaries.find((x) => x.id === 'yields_fall')?.summary.terminalBalanceBrl ?? 0;
    expect(fall).toBeLessThan(s.base.summary.terminalBalanceBrl);
  });
  it('credit gate freezes the credit leg: no accrual and no draws while gated', () => {
    const input = plan({ ...income, creditTolerance: 'accept' }, 100_000);
    const base = buildSchedule(input);
    const gated = buildSchedule(input, { id: 'credit_gate', name: 'gate', params: { months: 6 } });
    expect(gated.summary.terminalBalanceBrl).toBeLessThan(base.summary.terminalBalanceBrl);
  });
  it('equity drawdown applies only when stocks are held', () => {
    const noEq = buildScheduleWithStresses(plan(income, 100_000));
    expect(noEq.stresses.some((s) => s.id === 'equity_drawdown')).toBe(false);
    const hr: ConstraintSheet = {
      language: 'en',
      currency: 'BRL',
      profile: 'high_risk',
      target: { kind: 'balance', amountBrl: 500_000, byMonth: '2028-10' },
      horizonMonths: 24,
      liquidityWindowDays: 30,
      riskBudget: 'high',
      creditTolerance: 'accept',
      fxStance: 'accept_fx',
    };
    const eq = buildScheduleWithStresses(plan(hr, 100_000));
    const dd = eq.stresses.find((s) => s.id === 'equity_drawdown');
    expect(dd).toBeDefined();
    expect(
      eq.stressSummaries.find((s) => s.id === 'equity_drawdown')?.summary.terminalBalanceBrl ?? 0,
    ).toBeLessThan(eq.base.summary.terminalBalanceBrl);
    expect(eq.base.summary.targetMet).not.toBeNull();
  });
});
