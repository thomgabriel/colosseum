/**
 * How a pool or asset snapshot's sell and buy sides are stored (DB-STORAGE, Oct 18). The collectors write each
 * point as an object (`notionalUsd`, `outUsd` and route detail: `costPct`, `unfilledShare`, `poolsUsed`); the
 * import stores a side as `[notionalUsd, outUsd]` pairs in the collector's order, the two numbers every reader
 * uses, as the collector wrote them (no rounding). A side that does not fit the form exactly (a point that is not
 * an object, a notional that is not a number, an outUsd absent or not a number or null) is stored as written.
 * Rows stored before the change keep the object form until retention removes them, so every reader takes both.
 */
export type CurvePair = [notionalUsd: number, outUsd: number | null];

const isPoint = (p: unknown): p is Record<string, unknown> =>
  typeof p === 'object' && p !== null && !Array.isArray(p);

/** The side as stored: its pairs when every point fits the form, else the side unchanged. */
export function packSide(side: unknown): unknown {
  if (!Array.isArray(side)) return side;
  const out: CurvePair[] = [];
  for (const p of side) {
    if (!isPoint(p)) return side;
    const n = p.notionalUsd;
    const o = p.outUsd;
    if (typeof n !== 'number' || !Number.isFinite(n)) return side;
    if (o !== null && (typeof o !== 'number' || !Number.isFinite(o))) return side;
    out.push([n, o]);
  }
  return out;
}

/**
 * A stored side's points, either form, as objects: a pair reads as `{ notionalUsd, outUsd }`, an object point
 * as stored. Anything but an array has no points.
 */
export function sidePoints(side: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(side)) return [];
  return side.map((p) =>
    Array.isArray(p) ? { notionalUsd: p[0], outUsd: p[1] } : (p as Record<string, unknown>),
  );
}
