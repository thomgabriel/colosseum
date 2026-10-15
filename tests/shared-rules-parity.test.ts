import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREATOR_LIMITS_V2, VAULT_MAX_LINES, VAULT_MAX_TARGETS } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// The numbers the app holds a shared portfolio and a vault to, against the contracts that hold them on
// chain (gate SHARED-RULES-V2): the vault's line limit is one number, `VAULT_MAX_TARGETS`, and the
// registry's second rules are `CREATOR_LIMITS_V2`. A change on one side alone fails here.

const source = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', 'contracts', 'src', name), 'utf8');
const constant = (text: string, name: string): number => {
  const found = new RegExp(`constant ${name} = ([0-9_]+);`).exec(text)?.[1];
  if (found === undefined) throw new Error(`no constant ${name}`);
  return Number(found.replaceAll('_', ''));
};

describe('the vault and the registry hold the numbers the app holds', () => {
  const vault = source('BasketVault.sol');
  const registry = source('IndexRegistry.sol');

  it('a vault holds VAULT_MAX_TARGETS above zero, with room for leftovers beside them', () => {
    expect(constant(vault, 'MAX_TARGETS')).toBe(VAULT_MAX_TARGETS);
    expect(constant(vault, 'MAX_LINES')).toBe(VAULT_MAX_LINES.evm);
  });

  it('the registry holds the second rules', () => {
    expect(constant(registry, 'RULES_VERSION')).toBe(CREATOR_LIMITS_V2.rules);
    expect(constant(registry, 'MIN_ASSETS')).toBe(CREATOR_LIMITS_V2.minAssets);
    expect(constant(registry, 'MAX_ASSETS')).toBe(CREATOR_LIMITS_V2.maxAssets);
    expect(constant(registry, 'MIN_WEIGHT_BPS')).toBe(CREATOR_LIMITS_V2.minWeightBps);
    expect(constant(registry, 'MAX_WEIGHT_BPS')).toBe(CREATOR_LIMITS_V2.maxWeightBps);
    expect(constant(registry, 'STEP_BPS')).toBe(CREATOR_LIMITS_V2.stepBps);
    expect(constant(registry, 'SUM_BPS')).toBe(CREATOR_LIMITS_V2.sumBps);
    expect(constant(registry, 'MAX_TURNOVER_BPS')).toBe(CREATOR_LIMITS_V2.maxTurnoverBps);
  });
});
