import { isCashId } from '../order/plain';
import { shareTenths } from '../portfolio/figures';
import type { HoldingRow } from '../portfolio/portfolio';
import type { CompositionItem } from './Composition';

/**
 * A vault's holdings as the rows of a <Composition>: every holding the vault has an amount of, cash
 * included, with its share now. The shares are rounded together to a tenth of a percent so they add
 * up to the whole, as the portfolio writes them (features/portfolio/figures.ts). A holding with no
 * price has no share that was worked out: a dash, said as `noPrice`, and nothing drawn.
 */
export function heldItems(
  rows: readonly HoldingRow[],
  name: (asset: string) => string,
  noPrice: string,
): CompositionItem[] {
  const tenths = shareTenths(rows.map((row) => (row.valueUsd === null ? 0 : row.weightBps)));
  return rows.map((row, i) => ({
    key: row.asset,
    name: name(row.asset),
    asset: row.asset,
    cash: row.cash === true || isCashId(row.asset),
    bps: row.valueUsd === null ? 0 : (tenths[i] ?? 0) * 10,
    listed: true,
    ...(row.valueUsd === null ? { unknown: noPrice } : {}),
  }));
}
