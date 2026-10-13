import {
  AcceptGoalMixRequest,
  AcceptGoalMixResponse,
  ApplyVaultMixRequest,
  ApplyVaultMixResponse,
  type BasketProposal,
  type BasketSheet,
  ChainId,
  type IntentRequest,
  normalizeAddress,
  Order,
  OrderError,
  OWNER_REBALANCE_BAND_BPS,
  type Principal,
  RebalanceQuoteRequest,
  RebalanceQuoteResponse,
  RebalanceVaultRequest,
  RebalanceVaultResponse,
  VaultRouteParams,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertBuilds } from '../../orders/chains';
import { Refusal, refusing } from '../../orders/errors';
import { familyBySlug, type StoredFamily } from '../../orders/families';
import type { OrderDeps } from '../../orders/legs';
import {
  checkMix,
  confirmedReview,
  mixContext,
  mixProposal,
  planRetarget,
  planVaultRebalance,
  quoteVaultRebalance,
  purposeFor,
  reviewMix,
  vaultValueUsd,
} from '../../orders/mix';
import type { PlanInputs } from '../../orders/personalize';
import { planSheetOf } from '../../orders/plan-join';
import { ORDER_POLICY } from '../../orders/prepare';
import { followedOn, recipeTargets } from '../../orders/shared';
import { insertOrder, insertProposal, loadProposal } from '../../orders/store';
import { resolveVaultConversationOwner } from '../../orders/vault-conversation-owner';
import { signedIn } from './orders';

// A mix from the conversation, or the person's own, made fundable (gate ANY-COMPOSITION, Thom,
// Oct 8; orders/mix.ts). Both routes answer a review first and act only on `confirm` with every
// warning accepted: a new goal's mix becomes a stored plan that `POST /v1/orders` buys, and a vault's
// becomes an order that sets its targets and trades to them.

/** Where the routes write. The database's, unless a test hands in its own. */
export type MixStore = {
  /** Answers the id of the stored plan: an earlier one where the same person stored the same mix. */
  saveProposal(proposal: BasketProposal, privyId: string): Promise<string>;
  /** The plan as stored, which is what a buy of its id reads. */
  loadProposal(id: string): Promise<BasketProposal | null>;
  saveOrder(order: Order, request: IntentRequest): Promise<void>;
  /** The goal and risk of the plan the person's vault was opened for, where the server holds it. */
  planOf(
    chain: ChainId,
    address: string,
    privyId: string,
  ): Promise<Pick<BasketSheet, 'goal' | 'risk'> | null>;
  /** A shared portfolio by its slug, for a quote of what following it would trade. */
  familyBySlug(slug: string): Promise<StoredFamily | null>;
};

export const dbMixStore = (deps: OrderDeps): MixStore => ({
  saveProposal: (proposal, privyId) => insertProposal(deps.db, proposal, privyId),
  loadProposal: (id) => loadProposal(deps.db, id),
  saveOrder: (order, request) => insertOrder(deps.db, order, request),
  planOf: (chain, address, privyId) => planSheetOf(deps.db, chain, address, privyId),
  familyBySlug: (slug) => familyBySlug(deps.db, slug),
});

/** A wallet of the signed-in person's that signs on this chain, as the conversation routes ask. */
function signsOn(principal: Principal, family: string): boolean {
  return principal.wallets.some((wallet) => {
    if (wallet.family !== family) return false;
    try {
      normalizeAddress(wallet.family, wallet.address);
      return true;
    } catch {
      return false;
    }
  });
}

/** The vault's owner as the sign-in names the wallet, so the order routes know the order as theirs. */
function ownerOf(principal: Principal, family: 'solana' | 'evm', owner: string) {
  const wallet = principal.wallets.find((w) => {
    if (w.family !== family) return false;
    try {
      return normalizeAddress(family, w.address) === normalizeAddress(family, owner);
    } catch {
      return false;
    }
  });
  if (!wallet) throw new Refusal(404, 'no vault with that address that is yours');
  return wallet.address;
}

const DESCRIPTION_CHECKS =
  'The lines are checked again against the chain now, whoever chose them: each a listed asset of this chain or its own cash token, once, in whole basis points of at least 1, at most 16 that are not cash, and all adding up to exactly 10,000; every asset needs a price the vault can trade on. Any failure answers 422 `MIX_NOT_VALID` with `details.issues` (`CODE` or `CODE:assetId`). What would once have kept a line out is a warning instead: a line over its exit ceiling (measured, or its tier where nothing is measured), over the asset list’s cap, or a stock or fund of stocks in an income or protect plan. Any other class outside an income or protect goal (crypto, gold) is refused (`NOT_FOR_GOAL:<asset>` in `details.issues`). Each warning has an `id`, and every review a `reviewHash` over the lines, the goal, risk, term and amount, and every warning with its figures. With `confirm` false, a `reviewHash` that is not the review’s as the server reads it now, or any warning id missing from `acceptedWarnings`, the answer is `status: review` with `unconfirmed`, and nothing is stored or built. Every figure is the server’s and carries its source; `origin` is the client’s statement of who chose the weights, kept with what is stored. Cache-Control: private, no-store.';

export function registerMixRoutes(
  scope: FastifyInstance,
  deps: OrderDeps,
  inputs: PlanInputs = async () => ({}),
  store: MixStore = dbMixStore(deps),
) {
  const paths = [
    '/v1/conversations/:chain/goal/accept',
    '/v1/vaults/:chain/:address/targets',
    '/v1/vaults/:chain/:address/rebalance',
    '/v1/vaults/:chain/:address/rebalance/quote',
  ];
  scope.addHook('onSend', async (req, reply, payload) => {
    if (paths.includes(req.routeOptions.url ?? ''))
      reply.header('cache-control', 'private, no-store');
    return payload;
  });
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const read = (q: Omit<Parameters<PlanInputs>[0], 'db'>) => inputs({ ...q, db: deps.db });

  f.post(
    '/v1/conversations/:chain/goal/accept',
    {
      config: { auth: 'user', limit: 'standard' },
      bodyLimit: 64 * 1024,
      schema: {
        tags: ['plans'],
        summary: 'Review a mix for a new goal, and store it as a plan once confirmed',
        description: `Requires matching sign-in tokens and a verified wallet for the chain. The amount and term are the ones the person confirmed, and the goal and risk the ones they said; a goal or risk sent as null or left out is worked out from the mix (gate DEPOSIT-DERIVE: \`protect\` when a plan to protect may hold every line, else \`grow\`; the lowest risk whose cap per issuer holds the stocks and crypto together and whose cap per stock holds each), and the review names it in \`fromMix\`. ${DESCRIPTION_CHECKS} Confirmed with every warning accepted, the mix is stored as a plan in the engine’s shape (\`engineVersion\` \`mix-1\`, \`origin\`), its lines the weights sent, and \`proposalId\` is bought by \`POST /v1/orders\` like any plan. The same mix confirmed again by the same person answers the same id and the plan as first stored. A buy of it is refused above the amount it was reviewed at (\`AMOUNT_OVER_REVIEW\`). Nothing is bought or signed here. The plan is not advice: see \`disclaimer\`.`,
        params: z.strictObject({ chain: ChainId }),
        body: AcceptGoalMixRequest,
        response: { 200: AcceptGoalMixResponse, default: OrderError },
      },
    },
    async (req): Promise<AcceptGoalMixResponse> => {
      const principal = signedIn(req);
      const entry = deps.chains.get(req.params.chain);
      if (!principal.userId || !signsOn(principal, entry.config.family))
        throw new Refusal(
          403,
          'Sign in with a wallet for this chain before choosing what your vault holds.',
        );
      const body = req.body;
      const now = deps.now().toISOString();
      const ctx = await refusing(() => mixContext(entry, read, now));
      const checked = await refusing(() => checkMix(ctx, body.allocations));
      // What the person did not say is worked out from the mix, and the review says so (DEPOSIT-DERIVE).
      const purpose = purposeFor(checked, body);
      const reviewed = reviewMix(ctx, checked, {
        origin: body.origin,
        goal: purpose.goal,
        risk: purpose.risk,
        fromMix: purpose.fromMix,
        amountUsd: body.amountUsd,
        ...(body.horizonMonths === undefined ? {} : { horizonMonths: body.horizonMonths }),
        language: body.language,
        accepted: body.acceptedWarnings,
      });
      const { review } = reviewed;
      if (!confirmedReview(review, body)) return { status: 'review', review };
      const proposal = mixProposal(ctx, reviewed, checked, {
        person: principal.userId,
        origin: body.origin,
        accepted: body.acceptedWarnings,
        language: body.language,
      });
      const proposalId = await store.saveProposal(proposal, principal.userId);
      // The plan as stored: the same mix confirmed again answers the first copy, read back whole.
      const stored = await store.loadProposal(proposalId);
      if (!stored) throw new Error('a stored plan could not be read back');
      return { status: 'stored', review, proposalId, proposal: stored };
    },
  );

  f.post(
    '/v1/vaults/:chain/:address/targets',
    {
      config: { auth: 'user', limit: 'build' },
      bodyLimit: 64 * 1024,
      schema: {
        tags: ['portfolio'],
        summary: 'Review new targets for a vault you own, and order them once confirmed',
        description: `Ownership is read from the chain on every call; a missing vault and another person’s answer the same 404. The amount the lines split is the vault’s value at the prices of the review. ${DESCRIPTION_CHECKS} A vault that follows a shared portfolio or has auto-follow on is warned that its own targets end both, as they do on chain. All cash is refused (\`ALL_CASH\`): a vault’s targets cannot be emptied once it is open. Confirmed with every warning accepted, the answer is an order (\`type\` rebalance): a \`set_targets\` step, then the trades that sell what is over its new target and buy what is under, at the prices now, each with the minimum it states, as many per step as the chain takes. It is built, signed, reported and cancelled through \`/v1/orders/{id}\` like any order. The keeper does not trade it meanwhile: own targets switch auto-follow off. If a trade step fails after the targets have landed (a price moved past a minimum, the order expired), send the targets again: the new order sets them again and trades from what the vault holds then. A vault that holds an asset no longer listed, or one with no price now, cannot be retargeted (\`NO_PRICE\`): withdraw that token first. A vault worth more than one order may move is refused (\`OVER_ORDER_LIMIT\`).`,
        params: VaultRouteParams,
        body: ApplyVaultMixRequest,
        response: { 200: ApplyVaultMixResponse, default: OrderError },
      },
    },
    async (req): Promise<ApplyVaultMixResponse> => {
      const principal = signedIn(req);
      const { identity, state, entry } = await resolveVaultConversationOwner(
        deps,
        req.params,
        principal,
      );
      assertBuilds(entry);
      const body = req.body;
      const now = deps.now().toISOString();
      const ctx = await refusing(() => mixContext(entry, read, now));
      const checked = await refusing(() => checkMix(ctx, body.allocations, state));
      const plan = await store.planOf(identity.chain, state.address, identity.privyId);
      const reviewed = reviewMix(ctx, checked, {
        origin: body.origin,
        goal: plan?.goal ?? null,
        risk: plan?.risk ?? 'medium',
        amountUsd: vaultValueUsd(state, checked.prices),
        language: body.language,
        accepted: body.acceptedWarnings,
        vault: state,
      });
      const { review } = reviewed;
      if (!confirmedReview(review, body)) return { status: 'review', review };
      const { order, request } = await refusing(() =>
        planRetarget(ctx, state, checked, {
          slippageBps: body.maxSlippageBps ?? ORDER_POLICY.slippageBps,
          now,
          owner: ownerOf(principal, entry.config.family, state.owner),
        }),
      );
      await store.saveOrder(Order.parse(order), request);
      return { status: 'ordered', review, order: { ...order, attempts: [] } };
    },
  );

  f.post(
    '/v1/vaults/:chain/:address/rebalance',
    {
      config: { auth: 'user', limit: 'build' },
      bodyLimit: 4 * 1024,
      schema: {
        tags: ['portfolio'],
        summary: 'Rebalance a vault you own to the targets it has',
        description:
          `Brings what the vault holds to the targets it has on chain now, and changes nothing else: no target is set, so a vault that follows a shared portfolio goes on following it, at the version it accepted. This is what a person does after following a portfolio with a vault that already holds something (following trades nothing), and whenever a vault has moved off its targets and no keeper trades it. Ownership is read from the chain on every call; a missing vault and another person’s answer the same 404. The body names no target and no asset: the targets are the vault’s own, and they are not checked against a goal, since they are not being changed. \`on_target\`: every asset is within ${OWNER_REBALANCE_BAND_BPS} bps of its target and the cash no more than that over its share, so there is nothing to trade, and nothing is built or stored. \`ordered\`: an order (\`type\` rebalance) of \`swap\` steps only, the sales of what is over its target and then the purchases of what is under, sized at the prices now so that the purchases have their cash even if every trade loses the order’s slippage, each with the minimum it states, as many per step as the chain takes. It is read, built, signed, reported and cancelled through \`/v1/orders/{id}\` like any order. A step is built only while the vault’s targets are still the ones in \`targets\` (409 \`TARGETS_CHANGED\` in \`details.issues\` otherwise: rebalance again). Refused with 409 and \`details.issues\`: \`NO_TARGETS\` (the vault has no target), \`AUTO_FOLLOW_ON\` (auto-follow is on and this chain runs a keeper, which rebalances the vault), \`NO_PRICE:<asset>\` (a target or a holding has no price the vault can trade on now; retryable). A vault worth more than one order may move is refused (422 \`MIX_NOT_VALID\`, \`OVER_ORDER_LIMIT\`). Cache-Control: private, no-store.`,
        params: VaultRouteParams,
        body: RebalanceVaultRequest,
        response: { 200: RebalanceVaultResponse, default: OrderError },
      },
    },
    async (req): Promise<RebalanceVaultResponse> => {
      const principal = signedIn(req);
      const { state, entry } = await resolveVaultConversationOwner(deps, req.params, principal);
      const { targets, planned } = await refusing(() =>
        planVaultRebalance(entry, state, {
          slippageBps: req.body.maxSlippageBps ?? ORDER_POLICY.slippageBps,
          now: deps.now().toISOString(),
          owner: ownerOf(principal, entry.config.family, state.owner),
        }),
      );
      if (!planned) return { status: 'on_target', targets };
      await store.saveOrder(Order.parse(planned.order), planned.request);
      return { status: 'ordered', targets, order: { ...planned.order, attempts: [] } };
    },
  );

  f.post(
    '/v1/vaults/:chain/:address/rebalance/quote',
    {
      config: { auth: 'user', limit: 'build' },
      bodyLimit: 4 * 1024,
      schema: {
        tags: ['portfolio'],
        summary: 'Quote what a rebalance of a vault you own would trade now',
        description:
          'What `POST /v1/vaults/{chain}/{address}/rebalance` would order now, as figures to show before anything is signed: nothing is built or stored. With `family`, the quote is against the weights of that shared portfolio’s version in effect on the vault’s chain, which is what the vault trades to once it follows it (a follow’s own step trades nothing); a portfolio that is not there answers 404, one not on this chain 422, and a `version` that is not the one in effect 409 `VERSION_CHANGED`. Without `family`, against the targets the vault has. `quoted`: each trade, the sales first, with what goes in and its dollar value at the reference price, what the quote says comes out, the least an order would take at `slippageBps`, and the quote’s cost against the reference in bps; `holdings`, cash first, each with its target and its share of the vault before and after the trades; `costUsd`, the trades’ quoted costs together. `on_target`: there is nothing to trade. `unavailable`: no order could be made now, and `unavailable.reason` and `unavailable.issues` say why, as the rebalance route’s refusals do (`NO_PRICE:<asset>`, `AUTO_FOLLOW_ON`, `NO_TARGETS`, `OVER_ORDER_LIMIT`, or a chain’s own code such as a closed market or a size limit); the holdings are still answered against the targets. The figures are indicative: an order is planned and quoted again when it is made, and its own minimums are the ones signed. `prices` are the reference prices the shares are worked out with, each with its `source`, `fetchedAt` and `method`; `provenance` says whether the chain is the sample one or a test network. Ownership is read from the chain on every call; a missing vault and another person’s answer the same 404. Cache-Control: private, no-store.',
        params: VaultRouteParams,
        body: RebalanceQuoteRequest,
        response: { 200: RebalanceQuoteResponse, default: OrderError },
      },
    },
    async (req): Promise<RebalanceQuoteResponse> => {
      const principal = signedIn(req);
      const { state, entry } = await resolveVaultConversationOwner(deps, req.params, principal);
      const { family, version } = req.body;
      const followed = family
        ? await refusing(() =>
            followedOn(
              family,
              entry.chain,
              { chains: deps.chains, bySlug: store.familyBySlug },
              version,
            ),
          )
        : null;
      return quoteVaultRebalance(entry, state, {
        slippageBps: req.body.maxSlippageBps ?? ORDER_POLICY.slippageBps,
        now: deps.now().toISOString(),
        owner: ownerOf(principal, entry.config.family, state.owner),
        ...(followed
          ? {
              targets: recipeTargets(followed.onchain.active),
              version: followed.onchain.active.version,
            }
          : {}),
      });
    },
  );
}
