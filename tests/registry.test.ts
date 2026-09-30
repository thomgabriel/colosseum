import { isEligible, isExecutable, REGISTRY, REGISTRY_BY_ID } from '@colosseum/engine';
import { Asset } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

describe('asset registry', () => {
  it('every entry validates against the Asset schema', () => {
    for (const a of REGISTRY) expect(Asset.safeParse(a).success, a.id).toBe(true);
  });
  it('ids are unique', () => {
    expect(new Set(REGISTRY.map((a) => a.id)).size).toBe(REGISTRY.length);
  });
  it('xStocks are never eligible for income and only for high_risk', () => {
    for (const id of ['spyx', 'qqqx']) {
      const a = REGISTRY_BY_ID.get(id);
      if (!a) throw new Error(id);
      expect(isEligible(a, 'income')).toBe(false);
      expect(isEligible(a, 'accumulation')).toBe(false);
      expect(isEligible(a, 'high_risk')).toBe(true);
    }
  });
  it('the BRL leg is abstract: no mint, zero-yield kind, capped, not executable, labelled in progress', () => {
    const brl = REGISTRY_BY_ID.get('brl-leg');
    if (!brl) throw new Error('brl-leg');
    expect(brl.kind).toBe('brl_stable');
    expect(brl.mint).toBeUndefined();
    expect(brl.capWeight).toBeGreaterThan(0);
    expect(brl.capWeight).toBeLessThan(1);
    expect(isExecutable(brl)).toBe(false);
    expect(brl.metadata.label).toMatch(/integration in progress/);
    // The only BRS-specific string allowed pre-gate is the mandated label (HANDOFF §6): no mint, no API, no limits.
    expect(brl.metadata.docsUrl).toBeUndefined();
    expect(brl.metadata.issuer).toBeUndefined();
  });
  it('carries no numeric yield fields', () => {
    for (const a of REGISTRY) expect(Object.keys(a).some((k) => /apy|yield/i.test(k))).toBe(false);
  });
  it('token-2022 mints carry the permanentDelegate gate', () => {
    for (const a of REGISTRY.filter((x) => x.tokenProgram === 'token-2022'))
      expect(a.metadata.gates.join(' ')).toMatch(/permanentDelegate/);
  });
});
