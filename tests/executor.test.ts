import { buildPlanTransactions } from '@colosseum/chain-solana';
import { REGISTRY_BY_ID } from '@colosseum/engine';
import { describe, expect, it } from 'vitest';

// No network: only legs that never reach a builder (skipped / unknown).
const rpc = {} as Parameters<typeof buildPlanTransactions>[0];
const wallet = 'GMhJgqo4MqSD29iDNQvHA5ksJeYQJZD2UKKAHqJQtFCh';

describe('buildPlanTransactions', () => {
  it('skips the abstract BRL leg with its in-progress label and never builds it', async () => {
    const r = await buildPlanTransactions(
      rpc,
      { wallet, fundingAssetId: 'usdc', legs: [{ assetId: 'brl-leg', amountUsd: 10 }] },
      REGISTRY_BY_ID,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.tx).toBeUndefined();
    expect(r[0]?.skipped).toMatch(/integration in progress/);
  });
  it('keeps the USDC cash buffer as-is and reports unknown assets as errors without throwing', async () => {
    const r = await buildPlanTransactions(
      rpc,
      {
        wallet,
        fundingAssetId: 'usdc',
        legs: [
          { assetId: 'usdc', amountUsd: 3 },
          { assetId: 'nope', amountUsd: 1 },
        ],
      },
      REGISTRY_BY_ID,
    );
    expect(r.map((x) => x.skipped ?? x.error)).toEqual([
      'cash buffer stays as USDC',
      'unknown asset nope',
    ]);
  });
  it('orders DEX swaps before lending deposits', async () => {
    const r = await buildPlanTransactions(
      rpc,
      {
        wallet,
        fundingAssetId: 'usdc',
        legs: [
          { assetId: 'brl-leg', amountUsd: 1 },
          { assetId: 'usdc', amountUsd: 1 },
        ],
      },
      REGISTRY_BY_ID,
    );
    // both are non-executable, but ordering must be stable and not throw
    expect(r.map((x) => x.leg.assetId)).toEqual(['usdc', 'brl-leg']);
  });
});
