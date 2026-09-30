import { computeDrift, proposeRebalance } from '@colosseum/engine';
import { LegOrder, type Policy } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

const owner = 'GMhJgqo4MqSD29iDNQvHA5ksJeYQJZD2UKKAHqJQtFCh';
const agent = 'B3uirL9uafBVzRtWWYSid9zq67yohmupFGGSzD6zio1T';
const policy: Policy = {
  id: 'p1',
  planId: 'pl1',
  wallet: owner,
  allowedAssets: ['usdy', 'syrupusdc', 'kamino-usdc'],
  bands: [
    { assetId: 'usdy', min: 0.25, max: 0.45 },
    { assetId: 'syrupusdc', min: 0.25, max: 0.45 },
    { assetId: 'kamino-usdc', min: 0.2, max: 0.4 },
  ],
  trigger: { driftPct: 5, minIntervalHours: 1 },
  withdrawalDestination: owner,
  mechanism: 'delegated',
  mechanismByAsset: { 'kamino-usdc': 'user_signed' },
  delegation: { agent, approvedBase: { usdy: '3000000', syrupusdc: '3000000' } },
  createdAt: new Date().toISOString(),
};
const targets = { usdy: 0.35, syrupusdc: 0.35, 'kamino-usdc': 0.3 };
const dex = new Set(['usdy', 'syrupusdc']);

describe('computeDrift', () => {
  it('flags out-of-band assets and treats missing positions as zero', () => {
    const d = computeDrift(policy, targets, [
      { assetId: 'usdy', valueUsd: 60 },
      { assetId: 'syrupusdc', valueUsd: 40 },
    ]);
    expect(d.total).toBe(100);
    expect(d.rows.find((r) => r.assetId === 'kamino-usdc')?.weight).toBe(0);
    expect(d.anyOutOfBand).toBe(true);
  });
});

describe('proposeRebalance', () => {
  it('does nothing inside bands and trigger', () => {
    const r = proposeRebalance({
      policy,
      targets,
      positions: [
        { assetId: 'usdy', valueUsd: 35 },
        { assetId: 'syrupusdc', valueUsd: 34 },
        { assetId: 'kamino-usdc', valueUsd: 31 },
      ],
      dexAssets: dex,
    });
    expect(r.triggered).toBe(false);
    expect(r.orders).toEqual([]);
  });
  it('respects the minimum interval', () => {
    const r = proposeRebalance({
      policy,
      targets,
      positions: [
        { assetId: 'usdy', valueUsd: 70 },
        { assetId: 'syrupusdc', valueUsd: 30 },
      ],
      dexAssets: dex,
      now: new Date('2026-10-01T10:00:00Z'),
      lastRebalanceAt: new Date('2026-10-01T09:30:00Z'),
    });
    expect(r.triggered).toBe(false);
  });
  it('never proposes an asset outside the allow-list and always delivers to the owner', () => {
    const r = proposeRebalance({
      policy,
      targets,
      positions: [
        { assetId: 'usdy', valueUsd: 60 },
        { assetId: 'syrupusdc', valueUsd: 20 },
        { assetId: 'kamino-usdc', valueUsd: 20 },
        { assetId: 'spyx', valueUsd: 500 },
      ],
      dexAssets: dex,
    });
    expect(r.triggered).toBe(true);
    for (const o of r.orders) {
      expect(LegOrder.safeParse(o).success).toBe(true);
      expect(policy.allowedAssets).toContain(o.fromAssetId);
      expect(policy.allowedAssets).toContain(o.toAssetId);
      expect(o.destination).toBe(owner);
    }
  });
  it('brings every asset back inside its band and never exceeds the over-weight excess', () => {
    const positions = [
      { assetId: 'usdy', valueUsd: 60 },
      { assetId: 'syrupusdc', valueUsd: 20 },
      { assetId: 'kamino-usdc', valueUsd: 20 },
    ];
    const r = proposeRebalance({ policy, targets, positions, dexAssets: dex });
    const after = Object.fromEntries(positions.map((p) => [p.assetId, p.valueUsd]));
    for (const o of r.orders) {
      after[o.fromAssetId] = (after[o.fromAssetId] ?? 0) - o.amountUsd;
      after[o.toAssetId] = (after[o.toAssetId] ?? 0) + o.amountUsd;
    }
    const sold = r.orders
      .filter((o) => o.fromAssetId === 'usdy')
      .reduce((s, o) => s + o.amountUsd, 0);
    expect(sold).toBeLessThanOrEqual(60 - 35 + 0.01);
    const d = computeDrift(
      policy,
      targets,
      Object.entries(after).map(([assetId, valueUsd]) => ({ assetId, valueUsd })),
    );
    expect(d.anyOutOfBand).toBe(false);
  });
  it('uses delegated only for DEX legs covered by the approval; Kamino stays user-signed', () => {
    const r = proposeRebalance({
      policy,
      targets,
      positions: [
        { assetId: 'usdy', valueUsd: 6 },
        { assetId: 'syrupusdc', valueUsd: 2 },
        { assetId: 'kamino-usdc', valueUsd: 2 },
      ],
      dexAssets: dex,
    });
    const toSyrup = r.orders.find((o) => o.toAssetId === 'syrupusdc');
    const toKamino = r.orders.find((o) => o.toAssetId === 'kamino-usdc');
    expect(toSyrup?.mechanism).toBe('delegated');
    expect(toKamino?.mechanism).toBe('user_signed');
    const big = proposeRebalance({
      policy,
      targets,
      positions: [
        { assetId: 'usdy', valueUsd: 600 },
        { assetId: 'syrupusdc', valueUsd: 200 },
        { assetId: 'kamino-usdc', valueUsd: 200 },
      ],
      dexAssets: dex,
    });
    expect(big.orders.find((o) => o.toAssetId === 'syrupusdc')?.mechanism).toBe('user_signed');
  });
});
