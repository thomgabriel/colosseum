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

/**
 * How far above the sum of its sales' quotes the cash step of a withdrawal in dollars may pay, in bps
 * of those quotes: `WITHDRAW_DOLLARS_MARGIN_BPS` of packages/schemas, which this package imports for
 * types only (dollars.test.ts holds the two equal). A fill can land above its quote when the price
 * moves the person's way; past this the step would be taking cash the order did not bring.
 */
export const DOLLARS_MARGIN_BPS = 300;

/** `ORDER_LIMITS.maxSlippageBps` of packages/schemas: the furthest a minimum is under its quote. */
export const MAX_SLIPPAGE_BPS = 300;

/** The most a quote can be over a minimum stated at most `MAX_SLIPPAGE_BPS` under it, rounded down. */
export const quoteCeiling = (minimum: bigint): bigint => {
  const keep = BigInt(10_000 - MAX_SLIPPAGE_BPS);
  return ((minimum + 1n) * 10_000n + keep - 1n) / keep;
};

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
    plan.publish ||
    plan.dollars
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
 * A follow of a vault the person has (an order with an accept) swaps only to sell what the vault holds
 * of the assets the version drops, as the caller read them: each for the cash token, each once, never
 * an asset the version keeps, all of the amount read, with a minimum at most `MAX_SLIPPAGE_BPS` under
 * its quote, and before the accept.
 */
function heldToLeftovers(legs: Leg[], plan: PlanTerms, cash: string): void {
  const accept = legs.find((l) => l.kind === 'accept_version');
  if (!accept) return;
  const swaps = legs.filter((l) => l.kind === 'swap');
  if (!swaps.length) return;
  const reviewed = new Map((plan.leftovers?.sales ?? []).map((s) => [s.asset, s.amountRaw]));
  if (!reviewed.size)
    throw refuse('a follow trades only to sell what the version drops, and no sale was reviewed');
  const keeps = new Set(plan.leftovers?.keeps ?? []);
  if (!keeps.size) throw refuse('a follow that sells names the assets its version keeps');
  const sold = new Set<string>();
  for (const leg of swaps) {
    if (leg.seq > accept.seq)
      throw refuse('a sale of what the version drops comes after the accept it is for', leg.id);
    if (leg.expected.length !== leg.trades.length)
      throw refuse('a trade was shown with no minimum, so it has none to be held to', leg.id);
    for (const [i, t] of leg.trades.entries()) {
      if (t.buy !== cash || t.sell === cash)
        throw refuse(
          `a follow sells what the version drops for the cash token: this step trades ${t.sell} for ${t.buy}`,
          leg.id,
        );
      if (keeps.has(t.sell))
        throw refuse(`the version keeps ${t.sell}, and this step sells it`, leg.id);
      if (sold.has(t.sell)) throw refuse(`${t.sell} is sold twice`, leg.id);
      if (reviewed.get(t.sell) !== t.amountInRaw)
        throw refuse(
          `this step sells ${t.amountInRaw} of ${t.sell}, and the review sold ${reviewed.get(t.sell) ?? 'none'}`,
          leg.id,
        );
      const least = leg.expected[i]?.minOutRaw;
      if (!least || !isRawAmount(least) || BigInt(least) === 0n)
        throw refuse('a sale states no minimum', leg.id);
      // The minimum is the person's slippage under the quote the review showed, never a token one.
      const quoted = leg.expected[i]?.outRaw;
      if (!quoted || !isRawAmount(quoted) || BigInt(quoted) > quoteCeiling(BigInt(least)))
        throw refuse(
          `a sale's minimum, ${least}, is further under its quote, ${quoted ?? 'none'}, than any slippage an order may have`,
          leg.id,
        );
      sold.add(t.sell);
    }
  }
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
  // A switch of auto-follow that rides beside a step (gate EVM-MULTICALL-STEPS) is the way the review
  // said, and only where it can go: off before a swap or a withdrawal that opens the order, so the
  // keeper is stopped before anything moves; off or on beside the version a follow takes.
  for (const [i, leg] of legs.entries()) {
    const to = leg.switchAutoFollow;
    if (to === undefined) continue;
    if (leg.kind !== 'accept_version' && leg.kind !== 'swap' && leg.kind !== 'withdraw')
      throw refuse(`a ${leg.kind} step switches no auto-follow beside it`, leg.id);
    if (plan.autoFollow !== to)
      throw refuse(
        `the step switches auto-follow ${to ? 'on' : 'off'}, and the review said ${plan.autoFollow === undefined ? 'nothing of it' : plan.autoFollow ? 'on' : 'off'}`,
        leg.id,
      );
    if (leg.kind !== 'accept_version' && (to || i !== 0))
      throw refuse('auto-follow is switched off before anything moves, in the first step', leg.id);
  }
  if (plan.rebalance) heldToRebalance(order, legs, plan, deployment.cash);
  heldToLeftovers(legs, plan, deployment.cash);

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
    // Where the chain needs an approval, it names a vault that is there (gate CREATE-BEFORE-APPROVE):
    // the vault is opened first, empty, and the cash goes in by a deposit after the approval. A create
    // that takes the cash would have the cash approved to an address with no code yet.
    if (approval)
      for (const create of legs.filter((l) => l.kind === 'create_vault')) {
        if (create === mover)
          throw refuse(
            'the vault is opened with the cash it was approved before it existed',
            create.id,
          );
        if (approval.seq < create.seq)
          throw refuse('the approval comes before the vault it names is opened', approval.id);
      }
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
  // A withdrawal in dollars is exactly this and nothing else: at most one switch (off) first, sales of
  // a holding into the cash token, each token once, and the cash out last. A purchase, a sale into
  // another token, a second withdrawal or a withdrawal of anything but the cash is not that order.
  const { dollars } = plan;
  let cashLeast: string | null = null;
  let cashMost: string | null = null;
  if (dollars) {
    const { cash } = deployment;
    if (!isRawAmount(dollars.cashRaw))
      throw refuse('the share of the cash a withdrawal in dollars takes is not an amount');
    const reviewed = new Map((dollars.sales ?? []).map((s) => [s.asset, s.amountRaw]));
    if (plan.withdrawals || plan.held)
      throw refuse(
        'a withdrawal in dollars names no tokens: it takes out the cash and nothing else',
      );
    const last = legs.at(-1) as Leg;
    if (withdrawLegs.length !== 1 || last.kind !== 'withdraw')
      throw refuse('a withdrawal in dollars ends with one withdrawal of the cash', last.id);
    const sold = new Set<string>();
    let least = BigInt(dollars.cashRaw);
    let quoted = 0n;
    for (const [i, leg] of legs.entries()) {
      if (leg === last) continue;
      if (leg.kind === 'set_auto_follow' && i === 0 && plan.autoFollow === false) continue;
      // The switch off may ride in the first sale instead (gate EVM-MULTICALL-STEPS): checked above.
      if (leg.kind !== 'swap' || !leg.trades.length)
        throw refuse(
          `a withdrawal in dollars sells holdings for cash and withdraws the cash: a ${leg.kind} step is neither`,
          leg.id,
        );
      for (const trade of tradesOf(leg)) {
        if (trade.buy !== cash || trade.sell === cash)
          throw refuse(
            `a withdrawal in dollars sells a holding for the cash token: this step trades ${trade.sell} for ${trade.buy}`,
            leg.id,
          );
        if (sold.has(trade.sell)) throw refuse(`${trade.sell} is sold twice`, leg.id);
        if (reviewed.get(trade.sell) !== trade.inRaw)
          throw refuse(
            `this step sells ${trade.inRaw} of ${trade.sell}, and the review sold ${reviewed.get(trade.sell) ?? 'none'}`,
            leg.id,
          );
        sold.add(trade.sell);
        if (!isRawAmount(trade.minOutRaw) || trade.minOutRaw === '0')
          throw refuse('a sale states no minimum', leg.id);
        least += BigInt(trade.minOutRaw);
        const figure = leg.expected[leg.trades.findIndex((t) => t.sell === trade.sell)];
        if (!figure || !isRawAmount(figure.outRaw))
          throw refuse('a sale was shown with no quote', leg.id);
        // The quote is no figure the person reads, and it sets the most the cash step may pay: it is
        // held to its minimum. A minimum is at most `MAX_SLIPPAGE_BPS` under its quote, rounded down,
        // so the quote is at most (minimum + 1) / (1 - that), rounded up.
        if (BigInt(figure.outRaw) > quoteCeiling(BigInt(trade.minOutRaw)))
          throw refuse(
            `a sale's quote, ${figure.outRaw}, is further above its minimum, ${trade.minOutRaw}, than any slippage an order may have`,
            leg.id,
          );
        quoted += BigInt(figure.outRaw);
      }
    }
    if (last.trades.length) throw refuse('the cash step of a withdrawal trades nothing', last.id);
    if (least === 0n) throw refuse('a withdrawal in dollars that pays out nothing', last.id);
    cashLeast = least.toString();
    cashMost = (
      BigInt(dollars.cashRaw) +
      quoted +
      (quoted * BigInt(DOLLARS_MARGIN_BPS)) / 10_000n
    ).toString();
  }
  const withdrawalsOf = (leg: Leg): Withdrawal[] | 'all' => {
    if (cashLeast !== null && cashMost !== null)
      return [{ asset: deployment.cash, amountRaw: null, minRaw: cashLeast, maxRaw: cashMost }];
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
        return {
          ...base,
          kind: 'swap',
          trades: tradesOf(leg),
          ...(leg.switchAutoFollow === false ? { switchAutoFollow: false as const } : {}),
        };
      case 'set_targets':
        if (!plan.targets?.length)
          throw refuse('the step sets targets, and none were given', leg.id);
        return { ...base, kind: 'set_targets', targets: plan.targets, trades: tradesOf(leg) };
      case 'accept_version':
        if (!plan.follow) throw refuse('the step accepts a version, and none was given', leg.id);
        return {
          ...base,
          kind: 'accept_version',
          follow: plan.follow,
          ...(leg.switchAutoFollow === undefined ? {} : { switchAutoFollow: leg.switchAutoFollow }),
        };
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
          ...(leg.switchAutoFollow === false ? { switchAutoFollow: false as const } : {}),
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
