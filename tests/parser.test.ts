import { readFileSync } from 'node:fs';
import { parseGoalRules } from '@colosseum/engine';
import { describe, expect, it } from 'vitest';

type Case = { text: string; expect: Record<string, unknown> & { error?: boolean } };
const cases = JSON.parse(
  readFileSync(new URL('../fixtures/goals-eval.json', import.meta.url), 'utf8'),
) as Case[];
const now = '2026-10';

describe('goal parser (rules path, 20-goal eval)', () => {
  for (const c of cases) {
    it(c.text, () => {
      const r = parseGoalRules(c.text, undefined, now);
      if (c.expect.error) {
        expect(r.sheet).toBeUndefined();
        expect(r.errors.length).toBeGreaterThan(0);
        return;
      }
      expect(r.errors, JSON.stringify(r.candidate)).toEqual([]);
      const s = r.sheet;
      if (!s) throw new Error('no sheet');
      const e = c.expect;
      if (e.profile) expect(s.profile).toBe(e.profile);
      if (e.kind) expect(s.target.kind).toBe(e.kind);
      if (e.amountBrl) expect(s.target.amountBrl).toBe(e.amountBrl);
      if (e.startMonth && s.target.kind === 'monthly_cashflow')
        expect(s.target.startMonth).toBe(e.startMonth);
      if (e.byMonth && s.target.kind === 'balance') expect(s.target.byMonth).toBe(e.byMonth);
      if (e.liquidityWindowDays) expect(s.liquidityWindowDays).toBe(e.liquidityWindowDays);
      if (e.creditTolerance) expect(s.creditTolerance).toBe(e.creditTolerance);
      if (e.riskBudget) expect(s.riskBudget).toBe(e.riskBudget);
      if (e.fxStance) expect(s.fxStance).toBe(e.fxStance);
      if (e.monthlyContributionBrl) expect(s.monthlyContributionBrl).toBe(e.monthlyContributionBrl);
    });
  }
  it('never returns a sheet that fails validation', () => {
    for (const c of cases) {
      const r = parseGoalRules(c.text, undefined, now);
      if (r.sheet) expect(r.errors).toEqual([]);
    }
  });
});
