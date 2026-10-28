import { z } from 'zod';
import { AssetClass } from './basket-asset';
import { BasketProposal } from './basket-sheet';
import { AssetId, Bps, ChainId, DecimalString, Sourced } from './chain';
import { Language, Provenance } from './enums';
import { ORDER_LIMITS } from './order';
import { OrderDetail } from './order-api';
import { Target, VAULT_MAX_TARGETS } from './recipe';
import { Price } from './vault';

// A mix a person takes from the vault or new-goal conversation, or chooses themselves, made into
// something that can be bought (gate ANY-COMPOSITION, Thom, Oct 8). The client sends the lines
// back; the server checks them again against the catalog and prices of the chain as they are now, and
// writes every figure and warning itself. Nothing the model wrote is a number here.

/** Who chose the weights, as the client says: the model in the conversation, or the person. */
export const MixOrigin = z.enum(['model', 'person']);
export type MixOrigin = z.infer<typeof MixOrigin>;

/**
 * One line as the client sends it. The cash line is the chain's dollar token and is the share left in
 * cash; every other line is a listed asset. Shape only: the server's checks are in `MixIssue`.
 */
export const MixLine = z.strictObject({ assetId: AssetId, weightBps: Bps });
export type MixLine = z.infer<typeof MixLine>;

/** At most 64 lines are read, as the conversation's proposal allows; a vault holds 16 (`TOO_MANY_LINES`). */
export const MixLines = z.array(MixLine).min(1).max(64);

/**
 * Why a mix cannot be bought. `NOT_LISTED`, `DUPLICATE`, `NO_PRICE` and `FOREIGN_CASH` carry the
 * asset (`NOT_LISTED:solana:xyz`); the rest stand alone. Sent in `details.issues` of a 422
 * `MIX_NOT_VALID`.
 */
export const MixIssueCode = z.enum([
  /** A weight that is not a whole number of bps from 1 to 10,000. */
  'WEIGHT_NOT_WHOLE',
  /** Not on this chain's asset list now. */
  'NOT_LISTED',
  /** Named twice. */
  'DUPLICATE',
  /** A cash-class token that is not the chain's own dollar token. */
  'FOREIGN_CASH',
  /** The weights, cash included, do not add up to exactly 10,000. */
  'SUM_NOT_10000',
  /** More than 16 lines that are not cash: a vault holds 16. */
  'TOO_MANY_LINES',
  /** No usable price now: the asset has no feed, or the chain's price is older than it trades on. */
  'NO_PRICE',
  /**
   * An asset an income or protect plan cannot hold: crypto, gold and any class the goal's list leaves
   * out but stocks, which are a warning instead (`NOT_FOR_GOAL` among the warnings).
   */
  'NOT_FOR_GOAL',
  /** All cash, for a vault that is already open: a vault's own targets cannot be emptied (orders/README item 9). */
  'ALL_CASH',
  /** A vault worth more than one order may move (`ORDER_LIMITS.maxAmountUsd`): a rebalance trades up to its value. */
  'OVER_ORDER_LIMIT',
]);
export type MixIssueCode = z.infer<typeof MixIssueCode>;

/** A figure a warning or a line stands on, with where it came from. */
export const MixFigure = Sourced.extend({
  label: z.string().min(1),
  value: z.number().finite(),
  unit: z.enum(['USD', 'bps']),
});
export type MixFigure = z.infer<typeof MixFigure>;

/**
 * What the person is told before the mix is bought or applied. None of these stops it: each is
 * confirmed by its `id` in `acceptedWarnings`.
 *
 * - `EXIT_OVER_CAPACITY`: the line is larger than the share of the measured exit a plan counts on.
 * - `EXIT_OVER_TIER_CEILING`: nothing is measured for the asset, and the line is larger than its tier's
 *   ceiling, which stands in (gate EXIT-SOURCE).
 * - `OVER_LISTED_CAP`: the line weighs more than the asset list's cap for the asset.
 * - `NOT_FOR_GOAL`: a stock or a fund of stocks in an income or protect plan (gate PROTECT-NO-STOCKS, a
 *   warning for a mix the person confirms since Oct 8). Any other class outside the goal is refused.
 * - `STOPS_FOLLOWING`: the vault follows a shared portfolio or has auto-follow on; its own targets end
 *   both.
 */
export const MixWarningCode = z.enum([
  'EXIT_OVER_CAPACITY',
  'EXIT_OVER_TIER_CEILING',
  'OVER_LISTED_CAP',
  'NOT_FOR_GOAL',
  'STOPS_FOLLOWING',
]);
export type MixWarningCode = z.infer<typeof MixWarningCode>;

export const MixWarning = z.strictObject({
  /** `CODE` or `CODE:assetId`: what `acceptedWarnings` names. */
  id: z.string().min(1).max(200),
  code: MixWarningCode,
  assetId: AssetId.optional(),
  /** Written by the server from a template, in the request's language. */
  text: z.string().min(1),
  figures: z.array(MixFigure),
});
export type MixWarning = z.infer<typeof MixWarning>;

/** One line as the server checked it, with the figures it shows. */
export const MixReviewLine = z.strictObject({
  assetId: AssetId,
  symbol: z.string().min(1),
  cls: AssetClass,
  weightBps: Bps,
  /** The line's share of the amount, in dollars to the cent: the amount times the weight, split to the cent. */
  amountUsd: z.number().nonnegative(),
  /** The reference price used, with its source. Null for cash, counted at one dollar. */
  price: Sourced.extend({ usdPerToken: DecimalString }).nullable(),
  /**
   * The most this line may hold and still be sold as planned: the share of the measured exit a plan
   * counts on, or, where nothing is measured, the tier's ceiling (`measured` false). Null for cash.
   */
  exitCeiling: Sourced.extend({ usd: z.number().nonnegative(), measured: z.boolean() }).nullable(),
  /**
   * What selling this line's amount costs, in basis points, in the worst measured time of the exit
   * window, from the same measured curves as `exitCeiling` (gate DEPOSIT-ONE-SCREEN). Left out where
   * the exit is not measured, for cash, and beyond the largest size measured: never zero for unknown.
   */
  exitCost: Sourced.extend({
    bps: z.number().nonnegative(),
    sizeUsd: z.number().nonnegative(),
  }).optional(),
});
export type MixReviewLine = z.infer<typeof MixReviewLine>;

/** The server's reading of a mix: the lines, the figures and the warnings. Nothing is stored or built. */
export const MixReview = z.strictObject({
  chain: ChainId,
  origin: MixOrigin,
  /** The goal the stock check was made against; null for a vault whose plan the server does not hold. */
  goal: z.enum(['grow', 'income', 'protect']).nullable(),
  /** A new goal's risk, as the plan is stored with it. Left out for a vault. */
  risk: z.enum(['low', 'medium', 'high']).optional(),
  /**
   * What the person did not say and the server worked out from the mix (gate DEPOSIT-DERIVE): `goal`,
   * `risk`, both or neither. Left out: neither.
   */
  fromMix: z
    .array(z.enum(['goal', 'risk']))
    .max(2)
    .optional(),
  /** The amount the lines split: the buy's amount, or the vault's value at the prices of `lines`. */
  amountUsd: z.number().nonnegative(),
  /** Cash first where there is any, then each asset in the order sent. They add up to 10,000. */
  lines: z.array(MixReviewLine).min(1),
  /** What a vault is given: each asset that is not cash, with its weight. Cash is what they leave. */
  targets: z.array(Target).max(VAULT_MAX_TARGETS),
  cashBps: Bps,
  warnings: z.array(MixWarning),
  /** The warnings `acceptedWarnings` does not name yet. Empty: the mix can be confirmed as sent. */
  unconfirmed: z.array(z.string()),
  /**
   * What a confirm sends back: the hash of the lines, the amount and every warning with its figures,
   * as the server read them. Another hash, or none, is answered with the review again.
   */
  reviewHash: z.string().regex(/^[0-9a-f]{64}$/),
  provenance: Provenance,
  disclaimer: z.string(),
});
export type MixReview = z.infer<typeof MixReview>;

const confirmation = {
  version: z.literal(1),
  origin: MixOrigin,
  language: Language,
  allocations: MixLines,
  /** False: answer the review and store nothing. True: go ahead once `reviewHash` matches and every warning is accepted. */
  confirm: z.boolean(),
  /** The ids of the warnings the person confirmed, from the review they saw. */
  acceptedWarnings: z.array(z.string().min(1).max(200)).max(200).default([]),
  /** With `confirm`: the `reviewHash` of the review the person saw. */
  reviewHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
};

/**
 * `POST /v1/conversations/{chain}/goal/accept`: a mix for a new vault, with the amount the person
 * confirmed and the goal and risk they said. A goal or risk they did not say is null (or left out):
 * the server works it out from the mix (gate DEPOSIT-DERIVE) and the review says which it worked out.
 */
export const AcceptGoalMixRequest = z.strictObject({
  ...confirmation,
  goal: z.enum(['grow', 'income', 'protect']).nullable().optional(),
  risk: z.enum(['low', 'medium', 'high']).nullable().optional(),
  amountUsd: z
    .number()
    .min(ORDER_LIMITS.minAmountUsd, 'one deposit is at least $1')
    .max(ORDER_LIMITS.maxAmountUsd, 'one deposit is at most $1,000,000'),
  /** The goal's term. Left out: the goal has no date (`horizonOpen`). */
  horizonMonths: z.number().int().min(1).max(480).optional(),
});
export type AcceptGoalMixRequest = z.infer<typeof AcceptGoalMixRequest>;

/**
 * `review`: nothing stored; `unconfirmed` lists what is left to accept. `stored`: the mix is a plan,
 * and `proposalId` is what `POST /v1/orders` buys, as any plan.
 */
export const AcceptGoalMixResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('review'), review: MixReview }),
  z.strictObject({
    status: z.literal('stored'),
    review: MixReview,
    proposalId: z.uuid(),
    proposal: BasketProposal,
  }),
]);
export type AcceptGoalMixResponse = z.infer<typeof AcceptGoalMixResponse>;

/** `POST /v1/vaults/{chain}/{address}/targets`: new targets for a vault the person owns. */
export const ApplyVaultMixRequest = z.strictObject({
  ...confirmation,
  /** The slippage each trade is built with. Left out, the server's own figure. */
  maxSlippageBps: Bps.max(ORDER_LIMITS.maxSlippageBps).optional(),
});
export type ApplyVaultMixRequest = z.infer<typeof ApplyVaultMixRequest>;

/**
 * `review`: nothing built or stored. `ordered`: an order whose first step sets the targets and whose
 * other steps sell and buy to them, signed and reported as any order (`/v1/orders/{id}/...`).
 */
export const ApplyVaultMixResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('review'), review: MixReview }),
  z.strictObject({ status: z.literal('ordered'), review: MixReview, order: OrderDetail }),
]);
export type ApplyVaultMixResponse = z.infer<typeof ApplyVaultMixResponse>;

/**
 * `POST /v1/vaults/{chain}/{address}/rebalance`: bring what a vault the person owns holds to the
 * targets it has on chain now. It names no target: the vault's own are read from the chain.
 */
export const RebalanceVaultRequest = z.strictObject({
  /** The slippage each trade is built with. Left out, the server's own figure. */
  maxSlippageBps: Bps.max(ORDER_LIMITS.maxSlippageBps).optional(),
});
export type RebalanceVaultRequest = z.infer<typeof RebalanceVaultRequest>;

/**
 * `on_target`: nothing to trade, and nothing built or stored. `ordered`: an order of swaps only, the
 * sales then the purchases, signed and reported as any order (`/v1/orders/{id}/...`). `targets` are the
 * vault's own as the chain had them, which the order is held to.
 */
export const RebalanceVaultResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('on_target'), targets: z.array(Target) }),
  z.strictObject({ status: z.literal('ordered'), targets: z.array(Target), order: OrderDetail }),
]);
export type RebalanceVaultResponse = z.infer<typeof RebalanceVaultResponse>;

/**
 * `POST /v1/vaults/{chain}/{address}/rebalance/quote`: what a rebalance of a vault the person owns
 * would trade now, and nothing stored. With `family`, against the weights of that shared portfolio's
 * version in effect on the vault's chain, which is what following it would then trade to; without,
 * against the targets the vault has.
 */
export const RebalanceQuoteRequest = z.strictObject({
  family: z.string().min(1).max(64).optional(),
  /** With `family`: the version the person is looking at. Another in effect answers `VERSION_CHANGED`. */
  version: z.number().int().min(1).optional(),
  maxSlippageBps: Bps.max(ORDER_LIMITS.maxSlippageBps).optional(),
});
export type RebalanceQuoteRequest = z.infer<typeof RebalanceQuoteRequest>;

/** One trade of a quote: what goes in, what the quote says comes out, and the least the order would take. */
export const RebalanceQuoteTrade = z.strictObject({
  sell: AssetId,
  buy: AssetId,
  amountInRaw: z.string().regex(/^\d+$/),
  /** What goes in, in dollars at the reference price: cash at one dollar. */
  valueUsd: DecimalString,
  expectedOutRaw: z.string().regex(/^\d+$/),
  minOutRaw: z.string().regex(/^\d+$/),
  /** The quote against the reference price, in bps of what goes in. */
  costBps: z.number(),
});
export type RebalanceQuoteTrade = z.infer<typeof RebalanceQuoteTrade>;

/**
 * `quoted`: the trades, sales first. `on_target`: there is nothing to trade. `unavailable`: no order
 * could be made now, and `unavailable` says why (`issues` as the rebalance route's `details.issues`).
 * The figures are indicative: the order is planned and quoted again when it is made. Every share is
 * of the vault's value at `prices`, which carry their source; `after` counts each trade at its quote.
 */
export const RebalanceQuoteResponse = z.strictObject({
  status: z.enum(['quoted', 'on_target', 'unavailable']),
  chain: ChainId,
  provenance: Provenance,
  /** The version of the shared portfolio the quote is against. Null: the vault's own targets. */
  version: z.number().int().min(1).nullable(),
  targets: z.array(Target),
  slippageBps: Bps,
  valueUsd: DecimalString.nullable(),
  trades: z.array(RebalanceQuoteTrade),
  /** Cash first, then each asset held or targeted. */
  holdings: z.array(
    z.strictObject({
      asset: AssetId,
      cash: z.boolean(),
      targetBps: Bps,
      beforeBps: Bps,
      afterBps: Bps,
    }),
  ),
  /** What the trades together are quoted to cost against the reference prices, in dollars. */
  costUsd: DecimalString.nullable(),
  prices: z.array(Price),
  /** Where the trades' own figures come from (what comes out, the minimum, the cost): the chain's quote. */
  quote: Sourced,
  unavailable: z.strictObject({ reason: z.string(), issues: z.array(z.string()) }).nullable(),
  quotedAt: z.string().datetime(),
  disclaimer: z.string(),
});
export type RebalanceQuoteResponse = z.infer<typeof RebalanceQuoteResponse>;
