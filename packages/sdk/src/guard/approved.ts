import type { Leg, Order } from '@colosseum/schemas';
import { familyOf, isRawAmount } from './context';
import { GuardRefusal } from './refusal';
import type { ApprovedStep, ApprovedTrade, GuardDeployment, PlanTerms, Withdrawal } from './types';

// The order as the person approved it, turned into what each of its steps may sign. It is worked out
// once, from the order the review screen showed, and never again from what a server says later.
//
// The order says what cash it moves (`Order.depositRaw`, repeated as `Leg.cashRaw` on the approval and
// on the step that deposits) and what each step trades. It does not yet say everything else a step
// does: it has no plan number, no targets and no version. Those come in as `PlanTerms`, from what the
// screen showed beside the order.

/** The kinds of step the owner signs through this guard. */
const SIGNED_HERE: readonly string[] = [
  'approve',
  'create_vault',
  'deposit',
  'swap',
  'set_targets',
  'accept_version',
  'set_auto_follow',
  'withdraw',
  'publish',
];

const refuse = (message: string, legId?: string) =>
  new GuardRefusal('order', message, legId ?? null);

/**
 * A rebalance is the reviewed trades and nothing else: no other term rides with it, no cash moves in,
 * every step is a swap, every trade has the chain's cash on exactly one side, every purchase is one of
 * the vault's targets, every trade states a minimum above zero, and the trades are the reviewed ones,
 * asset for asset and amount for amount, in the order signed.
 */
function heldToRebalance(
  order: Pick<Order, 'depositRaw'>,
  legs: Leg[],
  plan: PlanTerms,
  cash: string,
): void {
  const reviewed = plan.rebalance;
  if (!reviewed) return;
  if (
    plan.targets ||
    plan.follow ||
    plan.autoFollow !== undefined ||
    plan.withdrawals ||
    plan.held ||
    plan.publish
  )
    throw refuse('a rebalance is reviewed as trades alone, and other terms came with it');
  if (order.depositRaw !== undefined) throw refuse('a rebalance deposits nothing');
  if (!reviewed.targets.length) throw refuse('a rebalance has targets to trade toward');
  const targets = new Set(reviewed.targets.map((t) => t.asset));
  const shown = reviewed.trades;
  let at = 0;
  for (const leg of legs) {
    if (leg.kind !== 'swap' || !leg.trades.length)
      throw refuse(`a rebalance only swaps, and this step is a ${leg.kind}`, leg.id);
    if (leg.withdrawals !== undefined || (leg.cashRaw !== undefined && leg.cashRaw !== '0'))
      throw refuse('a step of a rebalance moves cash or tokens out of the trades', leg.id);
    if (leg.expected.length !== leg.trades.length)
      throw refuse('a trade was shown with no minimum, so it has none to be held to', leg.id);
    for (const [i, t] of leg.trades.entries()) {
      if ((t.sell === cash) === (t.buy === cash))
        throw refuse('a trade of a rebalance has the cash on one side, and only one', leg.id);
      if (t.buy !== cash && !targets.has(t.buy))
        throw refuse(`a rebalance acquires only the vault's targets, and not ${t.buy}`, leg.id);
      const least = leg.expected[i]?.minOutRaw;
      if (!least || !isRawAmount(least) || BigInt(least) === 0n)
        throw refuse('a trade of a rebalance states no minimum above zero', leg.id);
      const was = shown[at];
      at += 1;
      if (!was || was.sell !== t.sell || was.buy !== t.buy || was.amountInRaw !== t.amountInRaw)
        throw refuse('a trade is not the one the rebalance was reviewed with', leg.id);
    }
  }
  if (at !== shown.length) throw refuse('the order has fewer trades than the rebalance reviewed');
}

/**
 * One approved step per leg, in the order they are signed. Throws a `GuardRefusal` with code `order`
 * when the order cannot mean what it says, and `unsupported` for a step this guard signs none of.
 */
export function approvedSteps(
  order: Pick<Order, 'id' | 'owner' | 'legs' | 'depositRaw'>,
  plan: PlanTerms,
  deployment: GuardDeployment,
): ApprovedStep[] {
  const chain = deployment.chain;
  const owner = order.owner[familyOf(chain)];
  if (!owner) throw refuse(`the order's owner has no address on ${chain}`);
  if (!order.legs.length) throw refuse('the order has no steps');
  const legs = [...order.legs].sort((a, b) => a.seq - b.seq);
  if (new Set(legs.map((l) => l.seq)).size !== legs.length)
    throw refuse('two steps of the order have the same place');
  if (new Set(legs.map((l) => l.id)).size !== legs.length)
    throw refuse('two steps of the order have the same id');

  const tradesOf = (leg: Leg): ApprovedTrade[] => {
    if (leg.expected.length !== leg.trades.length)
      throw refuse('a trade was shown with no minimum, so it has none to be held to', leg.id);
    return leg.trades.map((t, i) => ({
      sell: t.sell,
      buy: t.buy,
      inRaw: t.amountInRaw,
      minOutRaw: (leg.expected[i] as Leg['expected'][number]).minOutRaw,
    }));
  };

  for (const leg of legs) {
    // One chain per plan (gate ONE-CHAIN): every step of an order is on it.
    if (leg.chain !== chain)
      throw refuse(`a step is on ${leg.chain}, and this order is on ${chain}`, leg.id);
    if (leg.orderId !== order.id) throw refuse('a step belongs to another order', leg.id);
    if (leg.signer !== 'owner')
      throw new GuardRefusal('unsupported', 'a step the keeper signs is never signed here', leg.id);
    if (!SIGNED_HERE.includes(leg.kind))
      throw new GuardRefusal('unsupported', `this guard signs no ${leg.kind} step`, leg.id);
    // What a creator publishes is an order of its own: the terms describe one publish step, and no
    // other step rides along under them.
    if (plan.publish && leg.kind !== 'publish')
      throw refuse(
        'the order publishes a shared portfolio, and one of its steps does something else',
        leg.id,
      );
  }
  if (plan.publish && legs.length !== 1)
    throw refuse('the order publishes one shared portfolio, in one step');
  if (plan.rebalance) heldToRebalance(order, legs, plan, deployment.cash);

  // The cash an order moves is said once, by the order (`depositRaw`), and one step moves it: the create
  // or the deposit. An approval exists only to serve that step, for that exact amount. An order that
  // states no deposit moves no cash, so none of its steps may be about any.
  const { depositRaw } = order;
  if (depositRaw !== undefined && (!isRawAmount(depositRaw) || depositRaw === '0'))
    throw refuse('the deposit the order states is not an amount');
  const moving = legs.filter(
    (l) => l.kind === 'deposit' || (l.kind === 'create_vault' && (l.cashRaw ?? '0') !== '0'),
  );
  const approvals = legs.filter((l) => l.kind === 'approve');
  const [mover] = moving;
  if (depositRaw === undefined) {
    const about = legs.find((l) => l.cashRaw !== undefined && l.cashRaw !== '0');
    if (about ?? mover ?? approvals[0])
      throw refuse(
        'the order states no deposit, and one of its steps is about cash',
        (about ?? mover ?? approvals[0])?.id,
      );
  } else {
    if (!mover || moving.length !== 1)
      throw refuse(`the order deposits ${depositRaw}, and ${moving.length} of its steps move cash`);
    if (approvals.length > 1) throw refuse('the order has more than one approval');
    const [approval] = approvals;
    if (approval && approval.seq > mover.seq)
      throw refuse('the approval comes after the step it is for', approval.id);
    for (const leg of legs) {
      const about = leg === mover || leg === approval;
      if (about ? leg.cashRaw !== depositRaw : leg.cashRaw !== undefined && leg.cashRaw !== '0')
        throw refuse(
          `a step is about ${leg.cashRaw ?? 'no'} cash, and the order deposits ${depositRaw} once`,
          leg.id,
        );
    }
  }
  /** The cash of the one step that moves it, or of its approval. Null on every other step. */
  const cashOf = (leg: Leg): string | null =>
    depositRaw !== undefined && (leg === mover || leg === approvals[0]) ? depositRaw : null;
  const funded = (leg: Leg): string => {
    const cash = cashOf(leg);
    if (cash === null) throw refuse('the step does not say how much cash it is about', leg.id);
    return cash;
  };
  for (const leg of legs)
    for (const t of leg.trades)
      if (!isRawAmount(t.amountInRaw)) throw refuse('a trade has no amount', leg.id);

  const withdrawLegs = legs.filter((l) => l.kind === 'withdraw');
  const withdrawalsOf = (leg: Leg): Withdrawal[] | 'all' => {
    const listed = plan.withdrawals;
    if (!listed) return 'all';
    if (withdrawLegs.length === 1) return listed;
    if (listed.length !== withdrawLegs.length)
      throw refuse('the withdrawals named are not one per step', leg.id);
    return [listed[withdrawLegs.indexOf(leg)] as Withdrawal];
  };

  return legs.map((leg): ApprovedStep => {
    const base = { legId: leg.id, chain, owner, basketId: plan.basketId };
    switch (leg.kind) {
      case 'approve':
        return { ...base, kind: 'approve', amountRaw: funded(leg) };
      case 'create_vault': {
        // A plan that is all cash has no target: an empty list, said out loud, and never a missing one.
        if (!plan.follow && !plan.targets)
          throw refuse(
            'nothing says what the vault holds: no targets and nothing followed',
            leg.id,
          );
        return {
          ...base,
          kind: 'create_vault',
          targets: plan.follow ? [] : (plan.targets ?? []),
          follow: plan.follow ?? null,
          autoFollow: plan.autoFollow ?? false,
          depositRaw: cashOf(leg) ?? '0',
          trades: tradesOf(leg),
        };
      }
      case 'deposit':
        return { ...base, kind: 'deposit', amountRaw: funded(leg), trades: tradesOf(leg) };
      case 'swap':
        return { ...base, kind: 'swap', trades: tradesOf(leg) };
      case 'set_targets':
        if (!plan.targets?.length)
          throw refuse('the step sets targets, and none were given', leg.id);
        return { ...base, kind: 'set_targets', targets: plan.targets };
      case 'accept_version':
        if (!plan.follow) throw refuse('the step accepts a version, and none was given', leg.id);
        return { ...base, kind: 'accept_version', follow: plan.follow };
      case 'set_auto_follow':
        if (plan.autoFollow === undefined)
          throw refuse('the step switches auto-follow, and nothing says which way', leg.id);
        return { ...base, kind: 'set_auto_follow', on: plan.autoFollow };
      case 'withdraw':
        return {
          ...base,
          kind: 'withdraw',
          withdrawals: withdrawalsOf(leg),
          ...(plan.held ? { held: plan.held } : {}),
        };
      case 'publish':
        if (!plan.publish)
          throw refuse('the step publishes a shared portfolio, and none was given', leg.id);
        return { ...base, kind: 'publish', ...plan.publish };
      default:
        throw new GuardRefusal('unsupported', `this guard signs no ${leg.kind} step`, leg.id);
    }
  });
}
