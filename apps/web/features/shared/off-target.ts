import {
  OWNER_REBALANCE_SLIPPAGE_BPS,
  ownerRebalanceOffered,
  ownerShares,
  type VaultResponse,
} from '@colosseum/schemas';

type Held = Pick<VaultResponse['vault'], 'positions' | 'valueUsd'>;

/**
 * Whether a vault is off its targets by what a rebalance would trade: the server's own rule
 * (`ownerRebalanceOffered`): outside the owner's band with a trade of at least the smallest a
 * rebalance makes, or holding idle cash worth such a trade. One rule for the holdings' "Off target",
 * the page's Rebalance and the chat's (Thom, Oct 14: a vault said "Off target" with no Rebalance to
 * press). Null where it cannot be known: no target, a holding with no price, or nothing held.
 */
export function offItsTargets(vault: Held): boolean | null {
  if (!vault.positions.some((p) => p.targetBps > 0)) return null;
  const read = ownerShares(vault.positions, Number(vault.valueUsd));
  if (!read) return null;
  return ownerRebalanceOffered(
    read.rows,
    read.cashOverBps,
    OWNER_REBALANCE_SLIPPAGE_BPS,
    read.valueUsd,
  );
}
