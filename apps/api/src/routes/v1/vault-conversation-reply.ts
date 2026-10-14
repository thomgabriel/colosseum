import {
  type BasketSheet,
  type ChainId,
  OrderError,
  VaultAgentReplyShape,
  VaultAgentRequest,
  VaultRouteParams,
  warningsBelong,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ChainEntry } from '../../orders/chains';
import { refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import type { AssetLookups } from '../../orders/lookups';
import { type PlanInputs, preparePersonalInputs } from '../../orders/personalize';
import { planSheetOf } from '../../orders/plan-join';
import { readRecipe } from '../../orders/shared';
import {
  type AgentAnalytics,
  analyticsGap,
  buildVaultAgentContext,
  type FollowedPortfolio,
  readAgentAnalytics,
  replyToVaultConversation,
  vaultNotionalUsd,
} from '../../orders/vault-agent';
import { resolveVaultConversationOwner } from '../../orders/vault-conversation-owner';
import { familiesOf } from '../../portfolio/plans';
import type { VaultAgentModel } from '../../vault-agent-model';
import { signedIn } from './orders';

export const VaultConversationReply = VaultAgentReplyShape.extend({
  chain: VaultRouteParams.shape.chain,
  address: VaultRouteParams.shape.address,
}).superRefine(warningsBelong);
export const VaultConversationReplyError = z.strictObject({
  error: z.string(),
  code: z.literal('VAULT_AGENT_UNAVAILABLE'),
  reason: z.enum(['unavailable', 'timeout', 'budget', 'invalid']),
});

/**
 * The goal of the plan the vault was opened for, as the server holds it: the one the review of the
 * vault's targets checks a mix against (`MixStore.planOf`). Never taken from the request.
 */
export type VaultPlanGoal = (
  chain: ChainId,
  address: string,
  privyId: string,
) => Promise<Pick<BasketSheet, 'goal' | 'risk'> | null>;

/**
 * The shared portfolio a vault follows, read for one reply: the recipe from its chain and the family's
 * name from the server's own rows. Each half that cannot be read is null; it never fails the reply.
 */
export type FollowedReader = (
  entry: ChainEntry,
  recipeOnchainId: string,
) => Promise<FollowedPortfolio>;

/** One private preview: no DB writes, allocation engine, financial order or target mutation. */
export function registerVaultConversationReplyRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  model: VaultAgentModel | null,
  inputs: PlanInputs = async () => ({}),
  analytics?: AgentAnalytics,
  planOf: VaultPlanGoal = (chain, address, privyId) =>
    planSheetOf(deps.db, chain, address, privyId),
  more: {
    /** How the followed portfolio is read; the chain and the server's rows by default. */
    followedOf?: FollowedReader;
    /** KEEPER_ENABLED as this server read it. */
    keeperEnabled?: boolean;
    /**
     * Whether the vault's page has the rebalance action (it does since #265; on by default). Off, the
     * conversation names no control.
     */
    rebalanceOnPage?: boolean;
    /**
     * The facts the server holds of one listed asset (FIGURES-BY-REFERENCE as amended 2026-10-14): the
     * model may look them up. Default: none, and it has no tools.
     */
    lookups?: AssetLookups;
  } = {},
) {
  const followedOf: FollowedReader =
    more.followedOf ??
    (async (entry, recipeOnchainId) => {
      const [recipe, families] = await Promise.all([
        readRecipe(entry, recipeOnchainId).catch(() => null),
        familiesOf(deps.db, entry.chain, [recipeOnchainId]).catch(() => null),
      ]);
      const family = families?.get(recipeOnchainId);
      return {
        recipe,
        family: family ? { name: family.name, slug: family.slug } : null,
        readAt: deps.now().toISOString(),
      };
    });
  const path = '/v1/vaults/:chain/:address/conversation/reply';
  scope.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.url === path) reply.header('cache-control', 'private, no-store');
    return payload;
  });
  scope.withTypeProvider<ZodTypeProvider>().post(
    path,
    {
      config: { auth: 'user', limit: 'standard' },
      bodyLimit: 512 * 1024,
      schema: {
        tags: ['portfolio'],
        summary: 'Discuss an owned vault and preview a model-proposed strategy',
        description:
          'Fresh chain ownership on every call; missing and other-owned vaults return the same 404. The model receives the supplied conversation, real current vault state, listed assets and sourced risk inputs. It picks assets and the server sets the preview weights, without calling the allocation engine. The goal is the one of the plan the vault was opened for, read on the server as `POST /v1/vaults/{chain}/{address}/targets` reads it, never from the request: in an income or protect plan a stock is proposed only where the person asked for it in their own words, with the warning `outside_goal_requested`, and any other pick outside the goal is left out with the note `pick_outside_goal`, since the targets review would refuse it; a target the vault already has may be kept at its current weight or below, and raised it is held to the goal like a new one. The model is also given what the server knows of the vault: the shared portfolio it follows (read from the chain for this reply, with its lines and weights), whose its targets are, each holding against its target, auto-follow and the keeper on this server, and the network. A request to bring the holdings to the targets (a rebalance) is answered by the server itself, with each holding against its target and, where the page of the vault offers the action (by the rule the page reads), its name; no model is called for it, nothing is drafted, and no order is made. A bare confirmation the server cannot tie to one question is answered with a question and no proposal. A vault the server holds no plan for has no goal to check against, and `proposal.unknowns` says so. Sources and numerical metrics are server-authored. The model writes no number: where it states a measured figure it names one the server gave it, and the server writes the value in its place in `message`, `question` and the prose of the proposal (plain text, no markup). `figures` is then present: `figures.prose` is the same prose with each figure a `{{fact:<id>}}` placeholder and `figures.facts` what each one is, with its value, unit, shown text, source, fetchedAt, method, provenance and, for a price past the age the chain accepts, `staleAgeSec`; a figure that is not measured has a null value and its reason, and its text says so. A reference to anything the server did not measure never becomes a number: its sentence is left out. No history, plan, order, target or account-chain change is stored. Existing configured model and shared intake call quota apply. Cache-Control: private, no-store.',
        params: VaultRouteParams,
        body: VaultAgentRequest,
        response: {
          200: VaultConversationReply,
          default: z.union([OrderError, VaultConversationReplyError]),
        },
      },
    },
    async (req, reply) => {
      const principal = signedIn(req);
      const { identity, state, entry } = await resolveVaultConversationOwner(
        deps,
        req.params,
        principal,
      );
      if (!model) {
        req.log.warn(
          { reason: 'unavailable', detail: 'no_model', chain: identity.chain },
          'the vault conversation has no model configured',
        );
        return reply.code(503).send({
          error: 'The vault conversation is not available yet.',
          code: 'VAULT_AGENT_UNAVAILABLE',
          reason: 'unavailable',
        });
      }
      const context = await refusing(async () => {
        const listed = await entry.adapter.listAssets();
        const pricing = entry.adapter.getPrices(listed.map((asset) => asset.id));
        const [prices, prepared, read, plan, followed] = await Promise.all([
          pricing,
          preparePersonalInputs(
            identity.chain,
            listed,
            [],
            entry.provenance,
            (chain, assets, provenance) => inputs({ db: deps.db, chain, assets, provenance }),
          ),
          // Bearing's analytics at the vault's value, which needs its prices; they never fail the reply.
          pricing.then((prices) =>
            readAgentAnalytics(analytics, {
              db: deps.db,
              chain: identity.chain,
              assets: listed,
              provenance: entry.provenance,
              sizeUsd: vaultNotionalUsd(state, prices),
            }),
          ),
          // The stored plan's goal, which the picks are held to as the review of the targets holds them.
          planOf(identity.chain, state.address, identity.privyId),
          // What the vault follows, read here so the person is never asked to type it.
          state.recipeOnchainId
            ? followedOf(entry, state.recipeOnchainId).catch(() => null)
            : Promise.resolve(null),
        ]);
        const gap = analyticsGap(read);
        if (gap)
          req.log.warn(
            { code: gap, chain: identity.chain },
            'the vault conversation went on without its analytics',
          );
        return buildVaultAgentContext({
          state,
          entry,
          prices,
          prepared,
          person: identity.privyId,
          analytics: read,
          followed,
          ...(more.keeperEnabled === undefined ? {} : { keeperEnabled: more.keeperEnabled }),
          ...((more.rebalanceOnPage ?? true) ? { rebalanceOnPage: true } : {}),
          // No plan of this person's for the vault: no goal, and the reply says it was not checked.
          ...(plan ? { currentGoals: [{ goal: plan.goal, risk: plan.risk }] } : {}),
        });
      });
      const result = await replyToVaultConversation(
        req.body,
        context,
        model,
        ...(more.lookups
          ? [{ service: more.lookups, db: deps.db, provenance: entry.provenance }]
          : []),
      );
      if (result.kind === 'failure') {
        // The reason and which check failed: never the person's words or the model's reply.
        req.log.warn(
          {
            reason: result.reason,
            detail: result.detail ?? null,
            repair: result.repair ?? null,
            chain: identity.chain,
          },
          'the vault conversation returned no reply',
        );
        return reply.code(503).send({
          error: 'A valid strategy preview could not be returned. Your vault has not changed.',
          code: 'VAULT_AGENT_UNAVAILABLE',
          reason: result.reason,
        });
      }
      if (result.repair?.outcome === 'prose_figure_trimmed')
        // A code and a count: never the sentences, the person's words or the model's reply.
        req.log.warn(
          {
            detail: 'prose_figure_trimmed',
            sentencesCut: result.repair.sentencesCut ?? 0,
            repair: result.repair,
            chain: identity.chain,
          },
          'the vault conversation reply was served without the sentences that stated a figure',
        );
      else if (result.repair)
        req.log.warn(
          { repair: result.repair, chain: identity.chain },
          result.repair.outcome === 'repaired'
            ? 'the vault conversation reply passed on its repair attempt'
            : 'the vault conversation reply is the one the server corrected: its repair attempt failed a check too',
        );
      if (result.figures)
        // Counts only: never an id, a value, the person's words or the model's reply.
        req.log.info(
          { figures: result.figures, chain: identity.chain },
          'the vault conversation reply stated figures by reference',
        );
      if (result.lookups)
        // Counts only: never an asset, an id, a value or the model's reply.
        req.log.info(
          { lookups: result.lookups, chain: identity.chain },
          'the vault conversation looked figures up',
        );
      return { ...result.reply, chain: identity.chain, address: identity.address };
    },
  );
}
