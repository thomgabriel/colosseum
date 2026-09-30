import {
  applyHaircut,
  buildRiskSheet,
  HAIRCUT_RULES,
  pickPrimaryYield,
  REGISTRY,
  REGISTRY_BY_ID,
} from '@colosseum/engine';
import { RiskSheetEntry, type YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

const obs = (
  assetId: string,
  method: string,
  quoted: number,
  fetchedAt = '2026-09-30T20:00:00.000Z',
): YieldObservation => {
  const a = REGISTRY_BY_ID.get(assetId);
  if (!a) throw new Error(assetId);
  const h = applyHaircut(a, method, quoted);
  return {
    assetId,
    quotedYield: quoted,
    haircutYield: h.haircutYield,
    haircutRule: h.rule.id,
    source: `fixture://${method}`,
    method,
    fetchedAt,
    provenance: 'fixture',
  };
};

describe('haircut rules', () => {
  it('every registry asset has a rule for its primary method', () => {
    for (const a of REGISTRY) {
      const method =
        a.kind === 'usd_yield'
          ? a.mintPath === 'lending_deposit'
            ? 'protocol_api'
            : 'realised_30d'
          : 'by_construction';
      expect(() => applyHaircut(a, method, 0.01), a.id).not.toThrow();
    }
  });
  it('zero-yield kinds always haircut to zero; yield legs keep a strictly positive share', () => {
    expect(applyHaircut(REGISTRY_BY_ID.get('spyx')!, 'by_construction', 0.5).haircutYield).toBe(0);
    expect(applyHaircut(REGISTRY_BY_ID.get('brl-leg')!, 'by_construction', 0.5).haircutYield).toBe(
      0,
    );
    const k = applyHaircut(REGISTRY_BY_ID.get('kamino-usdc')!, 'protocol_api', 0.04);
    expect(k.haircutYield).toBeGreaterThan(0);
    expect(k.haircutYield).toBeLessThan(0.04);
  });
  it('aggregator figures are haircut harder than realised ones', () => {
    const agg = HAIRCUT_RULES.find((r) => r.id === 'HC-AGGREGATOR')!;
    const rea = HAIRCUT_RULES.find((r) => r.id === 'HC-REALISED')!;
    expect(agg.fraction).toBeGreaterThan(rea.fraction);
  });
});

describe('risk sheet', () => {
  const yields = pickPrimaryYield([
    obs('usdy', 'aggregator_defillama', 0.036, '2026-09-30T21:00:00.000Z'),
    obs('usdy', 'realised_30d', 0.05),
    obs('kamino-usdc', 'protocol_api', 0.04),
    obs('spyx', 'by_construction', 0),
    obs('brl-leg', 'by_construction', 0),
  ]);
  const depth = new Map([
    [
      'spyx',
      [
        {
          assetId: 'spyx',
          side: 'buy' as const,
          notionalUsd: 5000,
          priceImpactPct: 0.0001,
          outAmount: '1',
          source: 'fixture',
          method: 'jupiter_quote_exact_in_usdc',
          fetchedAt: '2026-09-30T20:00:00.000Z',
          provenance: 'fixture' as const,
        },
      ],
    ],
  ]);
  const sheet = buildRiskSheet({ assets: REGISTRY, yields, depth });

  it('prefers realised over aggregator even when the aggregator is fresher', () => {
    expect(yields.get('usdy')?.method).toBe('realised_30d');
  });
  it('has one valid entry per asset, and every yield shown carries source, timestamp and rule', () => {
    expect(sheet).toHaveLength(REGISTRY.length);
    for (const e of sheet) {
      expect(RiskSheetEntry.safeParse(e).success, e.assetId).toBe(true);
      if (e.haircutYield !== null) {
        expect(e.yieldSource).toBeTruthy();
        expect(e.yieldFetchedAt).toBeTruthy();
        expect(e.haircutRule).toBeTruthy();
      }
    }
  });
  it('xStocks show zero yield, 24/5 redemption, the permanent-delegate gate and measured depth', () => {
    const s = sheet.find((e) => e.assetId === 'spyx')!;
    expect(s.haircutYield).toBe(0);
    expect(s.redemptionPath).toMatch(/24\/5/);
    expect(s.gates.join(' ')).toMatch(/permanentDelegate/);
    expect(s.depthNote).toMatch(/\$5,000: 0\.010% impact/);
  });
  it('the BRL leg carries the in-progress label and no BRS specifics', () => {
    const b = sheet.find((e) => e.assetId === 'brl-leg')!;
    expect(b.label).toMatch(/integration in progress/);
    expect(b.issuer).toBeNull();
  });
  it('matches the snapshot', () => {
    expect(
      sheet.map((e) => ({ ...e, yieldFetchedAt: e.yieldFetchedAt ? 'T' : null })),
    ).toMatchSnapshot();
  });
});
