import type { Db } from '@colosseum/db';
import {
  type Address,
  type BasketAsset,
  type BasketLine,
  type BasketProposal,
  type ChainId,
  decidingReason,
  type Reason,
  type VaultHoldingWhy,
  type VaultResponse,
  type VaultView,
} from '@colosseum/schemas';
import { Refusal } from '../orders/errors';
import { type JoinLog, readablePlanOf } from '../orders/plan-join';
import { targetsOf } from '../orders/prepare';
import { loadFamilies } from '../orders/store';
import { loggable } from '../plugins/loggable';

// Why each holding is in a vault, for the vault's page (`VaultHoldingWhy`), from what the server
// already holds, in this order: the shared portfolio the vault follows, then the plan it was opened for
// (the engine's, or the person's own mix). Nothing is written here: a reason is a stored sentence or a
// kind of asset, and a holding the server holds none for has none.
//
// What a plan says is its maker's: its lines' reasons name the person's limits and amounts, so they go
// where the plan's goal goes (`readablePlanOf`), to the owner alone. A shared portfolio is public.

type Why = VaultHoldingWhy | null;
type AnsweredVault = VaultResponse['vault'];

/** What the positions leave of the whole: the vault's share in cash, in basis points. */
export const cashTargetBps = (positions: readonly { targetBps: number }[]): number =>
  10_000 - positions.reduce((n, p) => n + p.targetBps, 0);

/**
 * The reasons anybody is answered: a vault that follows a shared portfolio holds, at a target above 0,
 * what the portfolio holds, and the server has the asset's kind for it (`cls`, as the chain's list has
 * it). Every other holding is null here: a vault that follows none, and a holding at a target of 0,
 * which the portfolio no longer holds and the vault is selling.
 */
export function publicWhy(
  vault: VaultView,
  listed: readonly BasketAsset[],
): { cash: Why; positions: Why[] } {
  if (!vault.recipeOnchainId) return { cash: null, positions: vault.positions.map(() => null) };
  const clsOf = new Map(listed.map((a) => [a.id, a.cls]));
  const held = (asset: string, targetBps: number): Why => {
    if (targetBps <= 0) return null;
    const cls = clsOf.get(asset);
    return { source: 'portfolio', ...(cls ? { cls } : {}) };
  };
  return {
    cash: held(vault.cash.asset, cashTargetBps(vault.positions)),
    positions: vault.positions.map((p) => held(p.asset, p.targetBps)),
  };
}

/**
 * The owner's answer: each holding still without a reason is given its line's reason from the plan the
 * vault was opened for, where the person may read that plan. A line's reason stands only while the
 * vault's target for the asset is the one the plan set, worked out as the step that opened the vault
 * worked it out (`targetsOf`): a holding the person has changed since has none. A mix the person chose
 * or confirmed (`origin` person or model) is the owner's, with the line's stored "you chose" reason;
 * the engine's plan is the plan's, with the reason that decided the line (`decidingReason`).
 *
 * It never fails the read it is part of: where the plan cannot be read, the vault is answered as
 * anybody has it, and the log says why.
 */
export async function ownerWhy(
  db: Db,
  chain: ChainId,
  vault: AnsweredVault,
  listed: BasketAsset[],
  privyId: string | undefined,
  log: Pick<JoinLog, 'error'>,
): Promise<AnsweredVault> {
  const cashTarget = cashTargetBps(vault.positions);
  const missing =
    vault.positions.some((p) => !p.why && p.targetBps > 0) || (!vault.cash.why && cashTarget > 0);
  if (!missing) return vault;
  let plan: BasketProposal | null;
  let set: Awaited<ReturnType<typeof plannedTargets>>;
  try {
    plan = await readablePlanOf(db, chain, vault.address as Address, privyId);
    set = plan ? await plannedTargets(plan, chain, listed, db) : null;
  } catch (err) {
    log.error(
      { err: loggable(err), chain, vault: vault.address },
      'the plan of a vault could not be read: its holdings are answered with no reason from it',
    );
    return vault;
  }
  if (!plan || !set) return vault;
  const owner = plan.origin === 'person' || plan.origin === 'model';
  const lineOf = new Map(plan.lines.map((l) => [l.assetId, l]));
  const why = (asset: string, targetBps: number, cash: boolean): Why => {
    const line = lineOf.get(asset);
    const planned = cash ? set.cashBps : set.targets.get(asset);
    if (!line || targetBps <= 0 || planned !== targetBps) return null;
    const reason = owner
      ? (chosen(line) ?? decidingReason(line, cash))
      : decidingReason(line, cash);
    return reason?.text ? { source: owner ? 'owner' : 'plan', text: reason.text } : null;
  };
  return {
    ...vault,
    cash: vault.cash.why
      ? vault.cash
      : { ...vault.cash, why: why(vault.cash.asset, cashTarget, true) },
    positions: vault.positions.map((p) =>
      p.why ? p : { ...p, why: why(p.asset, p.targetBps, false) },
    ),
  };
}

/** The line's reason that says the person chose its share, or confirmed the one proposed to them. */
const chosen = (line: BasketLine): Reason | undefined =>
  line.reasons.find((r) => r.rule.startsWith('MIX_FROM_'));

/**
 * The targets the plan gives a vault on this chain, as the step that opens it sets them, and the cash
 * share they leave. Null when the plan has no recipe here, or can no longer be opened into its assets
 * (a shared portfolio it holds whole has changed or gone): then no line of it is said to stand.
 */
async function plannedTargets(
  plan: BasketProposal,
  chain: ChainId,
  listed: BasketAsset[],
  db: Db,
): Promise<{ targets: Map<string, number>; cashBps: number } | null> {
  const recipe = plan.recipes.find((r) => r.chain === chain);
  if (!recipe) return null;
  try {
    const targets = await targetsOf(chain, recipe.components, listed, (c) => loadFamilies(db, c));
    return {
      targets: new Map(targets.map((t) => [t.asset, t.weightBps])),
      cashBps: 10_000 - targets.reduce((n, t) => n + t.weightBps, 0),
    };
  } catch (e) {
    if (e instanceof Refusal) return null;
    throw e;
  }
}
