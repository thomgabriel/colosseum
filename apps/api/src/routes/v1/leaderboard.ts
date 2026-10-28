import { DISCLAIMER, LeaderboardQuery, LeaderboardResponse, OrderError } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { LEADERBOARD_RULE, leaderboardOf } from '../../portfolio/leaderboard';
import { keeper } from '../../read-cache';

// GET /v1/leaderboard: every open vault on a chain, ranked by what it made (portfolio/leaderboard.ts).
// Anybody may ask, so an answer is kept for a minute, as GET /v1/stats keeps its own.

/** How long an answer is kept, in milliseconds. */
export const LEADERBOARD_KEPT_MS = 60_000;

export function registerLeaderboardRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  /** The event window (`LEADERBOARD_SINCE`), read when the server starts; null for every vault. */
  since: Date | null = null,
) {
  const kept = keeper<LeaderboardResponse>(LEADERBOARD_KEPT_MS, () => deps.now().getTime());
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/leaderboard',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags: ['platform'],
        summary: 'Every open vault on a chain, ranked by what it made',
        description:
          'Every vault the server knows on the chain (named by its vault cache, or read by the snapshot worker in the last 7 days) and that is open: a closed vault is left out, and a vault opened again counts from then. Read from the database alone. Each row has the vault’s address, the wallet that owns it in short form (nothing else about who owns it: not the name its owner gave it, nor its number among their vaults, which only the owner is answered), what it holds at its newest snapshot with each share of its value, its value then, and the shared portfolio it follows where the server names it. `pnl` is its value less what went in: the cash of each confirmed deposit made in this app, less each confirmed withdrawal at its value when it was ordered; `pct` is that over the deposits, a fraction, whatever was taken out since. A vault with no deposit the server holds (made outside this app) has no `pnl`, says so in `noPnl` and is ranked last. Every figure carries `source`, `fetchedAt`, `method` and `provenance` (`sandbox` on a test network). Where the server runs an event window (`LEADERBOARD_SINCE`), `since` is its start and only vaults whose first confirmed deposit made in this app is at or after it are listed, so a vault with none is left out; otherwise `since` is null. An answer is kept for 60 seconds.',
        querystring: LeaderboardQuery,
        response: { 200: LeaderboardResponse, default: OrderError },
      },
    },
    async (req): Promise<LeaderboardResponse> => {
      const { chain } = req.query;
      const entry = deps.chains.active().find((e) => e.chain === chain);
      if (!entry)
        throw new Refusal(503, `${deps.chains.name(chain)} is switched off on this server`, {
          code: 'CHAIN_UNAVAILABLE',
          fix: 'Ask again once the chain is on.',
        });
      return kept(`${chain}:${entry.provenance}:${since?.toISOString() ?? 'all'}`, async () => {
        const now = deps.now();
        return {
          chain,
          name: entry.config.name,
          provenance: entry.provenance,
          readAt: now.toISOString(),
          rule: LEADERBOARD_RULE,
          since: since?.toISOString() ?? null,
          vaults: await leaderboardOf(deps.db, entry, now, since),
          disclaimer: DISCLAIMER.en,
        };
      });
    },
  );
}
