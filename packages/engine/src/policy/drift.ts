import type { Policy } from '@colosseum/schemas';

export type PositionValue = { assetId: string; valueUsd: number };
export type DriftRow = {
  assetId: string;
  valueUsd: number;
  weight: number;
  target: number;
  drift: number;
  min: number;
  max: number;
  outOfBand: boolean;
};

/** Current weights vs target weights and bands. Assets absent from positions count as zero. */
export function computeDrift(
  policy: Pick<Policy, 'bands'>,
  targets: Record<string, number>,
  positions: PositionValue[],
): { total: number; rows: DriftRow[]; maxAbsDrift: number; anyOutOfBand: boolean } {
  const total = positions.reduce((s, p) => s + p.valueUsd, 0);
  const byId = new Map(positions.map((p) => [p.assetId, p.valueUsd]));
  const ids = new Set([...Object.keys(targets), ...byId.keys()]);
  const rows: DriftRow[] = [...ids].map((assetId) => {
    const valueUsd = byId.get(assetId) ?? 0;
    const weight = total > 0 ? valueUsd / total : 0;
    const target = targets[assetId] ?? 0;
    const band = policy.bands.find((b) => b.assetId === assetId);
    const min = band?.min ?? target;
    const max = band?.max ?? target;
    return {
      assetId,
      valueUsd,
      weight,
      target,
      drift: weight - target,
      min,
      max,
      outOfBand: weight < min - 1e-9 || weight > max + 1e-9,
    };
  });
  return {
    total,
    rows,
    maxAbsDrift: Math.max(0, ...rows.map((r) => Math.abs(r.drift))),
    anyOutOfBand: rows.some((r) => r.outOfBand),
  };
}
