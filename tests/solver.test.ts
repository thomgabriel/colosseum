import { applyHaircut, REGISTRY, REGISTRY_BY_ID, solve } from '@colosseum/engine';
import { type ConstraintSheet, PlanLeg, type YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// Fixture yields (fixtures are the one place literals may live): only relative order matters to these tests.
const fx = 5.2;
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
  target: { kind: 'monthly_cashflow', amountBrl: 3000, startMonth: '2028-01' },
  horizonMonths: 120,
  liquidityWindowDays: 7,
  riskBudget: 'low',
  creditTolerance: 'limited',
  fxStance: 'hedge_near_term',
};
const accumulation: ConstraintSheet = {
  language: 'pt',
  currency: 'BRL',
  profile: 'accumulation',
  target: { kind: 'balance', amountBrl: 250_000, byMonth: '2029-10' },
  horizonMonths: 36,
  liquidityWindowDays: 30,
  riskBudget: 'medium',
  creditTolerance: 'accept',
  fxStance: 'accept_fx',
};
const highRisk: ConstraintSheet = {
  language: 'en',
  currency: 'BRL',
  profile: 'high_risk',
  target: { kind: 'balance', amountBrl: 500_000, byMonth: '2031-10' },
  horizonMonths: 60,
  liquidityWindowDays: 30,
  riskBudget: 'high',
  creditTolerance: 'accept',
  fxStance: 'accept_fx',
};

const run = (sheet: ConstraintSheet, capitalUsd = 100_000) =>
  solve({ sheet, capitalUsd, assets: REGISTRY, yields, fxUsdBrl: fx, nowMonth: now });
const w = (r: ReturnType<typeof solve>, id: string) =>
  r.legs.find((l) => l.assetId === id)?.weight ?? 0;

describe('solver', () => {
  it('produces valid legs summing to one for each profile, and three different allocations', () => {
    const rs = [run(income), run(accumulation), run(highRisk)];
    for (const r of rs) {
      for (const l of r.legs) expect(PlanLeg.safeParse(l).success).toBe(true);
      expect(r.legs.reduce((s, l) => s + l.weight, 0)).toBeCloseTo(1, 3);
      for (const l of r.legs) expect(l.reasoning.length).toBeGreaterThan(10);
    }
    const keys = rs.map((r) => r.legs.map((l) => `${l.assetId}:${l.weight}`).join('|'));
    expect(new Set(keys).size).toBe(3);
  });
  it('income: includes the BRL leg and the cash buffer, never xStocks', () => {
    const r = run(income);
    expect(w(r, 'brl-leg')).toBeGreaterThan(0);
    expect(w(r, 'usdc')).toBeGreaterThan(0);
    expect(w(r, 'spyx')).toBe(0);
    expect(w(r, 'qqqx')).toBe(0);
  });
  it('high risk: includes xStocks and the credit leg', () => {
    const r = run(highRisk);
    expect(w(r, 'spyx')).toBeGreaterThan(0);
    expect(w(r, 'syrupusdc')).toBeGreaterThan(0);
  });
  it('accumulation: no stocks, credit allowed', () => {
    const r = run(accumulation);
    expect(w(r, 'spyx')).toBe(0);
    expect(w(r, 'syrupusdc')).toBeGreaterThan(0);
  });
  it('BRL leg rises with a shorter liquidity window and with nearer obligations, and never exceeds its cap', () => {
    const cap = REGISTRY_BY_ID.get('brl-leg')?.capWeight ?? 0;
    const w7 = w(run(income), 'brl-leg');
    const w90 = w(run({ ...income, liquidityWindowDays: 90 }), 'brl-leg');
    expect(w7).toBeGreaterThan(w90);
    const soon = w(
      run(
        { ...income, target: { kind: 'monthly_cashflow', amountBrl: 3000, startMonth: '2026-11' } },
        20_000,
      ),
      'brl-leg',
    );
    expect(soon).toBeGreaterThan(w7);
    const huge = run(
      { ...income, target: { kind: 'monthly_cashflow', amountBrl: 30_000, startMonth: '2026-11' } },
      10_000,
    );
    expect(w(huge, 'brl-leg')).toBeLessThanOrEqual(cap + 1e-9);
    expect(huge.bindingConstraints.join(' ')).toMatch(/BRL leg capped/);
  });
  it('credit tolerance none excludes the credit leg and says so', () => {
    const r = run({ ...income, creditTolerance: 'none' });
    expect(w(r, 'syrupusdc')).toBe(0);
    expect(r.bindingConstraints.join(' ')).toMatch(/credit legs excluded/);
  });
  it('falls back to the waterfall, reported, when caps cannot absorb the remainder', () => {
    const tight = REGISTRY.map((a) => (a.kind === 'usd_yield' ? { ...a, capWeight: 0.05 } : a));
    const r = solve({
      sheet: accumulation,
      capitalUsd: 100_000,
      assets: tight,
      yields,
      fxUsdBrl: fx,
      nowMonth: now,
    });
    expect(r.method).toBe('waterfall');
    expect(r.bindingConstraints.join(' ')).toMatch(/parked in cash/);
    expect(r.legs.reduce((s, l) => s + l.weight, 0)).toBeCloseTo(1, 3);
  });
});
