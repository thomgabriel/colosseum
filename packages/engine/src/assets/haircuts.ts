import type { Asset } from '@colosseum/schemas';

/**
 * Haircut discipline (prior work: analysis-rules; parameters here are policy, not yields).
 * Rule ids appear on every yield observation and on the risk sheet. The founder's full rule set replaces
 * these parameters in a `prior:` commit; the structure (rule id + fraction + rationale) stays.
 */
export type HaircutRule = {
  id: string;
  appliesTo: (asset: Pick<Asset, 'kind' | 'mintPath'>, method: string) => boolean;
  fraction: number;
  rationale: string;
};

export const HAIRCUT_RULES: HaircutRule[] = [
  {
    id: 'HC-EQUITY-ZERO',
    appliesTo: (a) => a.kind === 'equity',
    fraction: 1,
    rationale: 'stocks and gold pay no coupon; income is zero whatever the price move',
  },
  {
    id: 'HC-BRL-ZERO',
    appliesTo: (a) => a.kind === 'brl_stable',
    fraction: 1,
    rationale: 'the BRL leg pays no yield; its value is zero FX risk against a BRL goal',
  },
  {
    id: 'HC-CASH-ZERO',
    appliesTo: (a) => a.kind === 'cash',
    fraction: 1,
    rationale: 'cash buffer earns nothing',
  },
  {
    id: 'HC-LEND-VAR',
    appliesTo: (a, m) => a.mintPath === 'lending_deposit' && m === 'protocol_api',
    fraction: 0.25,
    rationale:
      'variable lending rates mean-revert with utilisation; plan on three quarters of the quoted rate',
  },
  {
    id: 'HC-REALISED',
    appliesTo: (_a, m) => m.startsWith('realised_'),
    fraction: 0.1,
    rationale: 'realised yield already nets fees and dilution; keep a tenth for regime change',
  },
  {
    id: 'HC-AGGREGATOR',
    appliesTo: (_a, m) => m.startsWith('aggregator_'),
    fraction: 0.3,
    rationale:
      'aggregator and issuer-reported figures overstate by 2-5x in our prior analysis; use 70% until realised data exists',
  },
];

export function applyHaircut(
  asset: Pick<Asset, 'kind' | 'mintPath'>,
  method: string,
  quoted: number,
): { haircutYield: number; rule: HaircutRule } {
  const rule = HAIRCUT_RULES.find((r) => r.appliesTo(asset, method));
  if (!rule)
    throw new Error(
      `no haircut rule for kind=${asset.kind} mintPath=${asset.mintPath} method=${method}`,
    );
  return { haircutYield: Math.max(0, quoted * (1 - rule.fraction)), rule };
}
