import {
  OWNER_REBALANCE_SLIPPAGE_BPS,
  ownerRebalanceOffered,
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
  const held = vault.positions.filter((p) => !/^0+$/.test(p.raw));
  if (!vault.positions.some((p) => p.targetBps > 0) || held.some((p) => p.valueUsd === null))
    return null;
  const total = Number(vault.valueUsd);
  if (!(total > 0)) return null;
  const invested = vault.positions.reduce((n, p) => n + p.weightBps, 0);
  const planned = vault.positions.reduce((n, p) => n + p.targetBps, 0);
  // cash over its share is what the positions together are under theirs; the server's own rule
  return ownerRebalanceOffered(
    vault.positions,
    planned - invested,
    OWNER_REBALANCE_SLIPPAGE_BPS,
    total,
  );
}
