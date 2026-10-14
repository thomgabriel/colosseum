import { type Db, vaultSnapshots, vaults } from '@colosseum/db';
import {
  DISCLAIMER,
  OrderError,
  type PlatformFigure,
  type PlatformNetwork,
  PlatformStatsResponse,
  type Provenance,
} from '@colosseum/schemas';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import type { OrderDeps } from '../../orders/legs';
import { STALE_AFTER_SECONDS } from '../../portfolio/plans';
import { thisLife } from '../../portfolio/scope';
import { chainAnsweredAt, SNAPSHOT_LOOKBACK_DAYS } from '../../portfolio/snapshots';

// GET /v1/stats: the platform's numbers under the landing's hero, from the vault product's tables.
// The structurer's `/stats` counts its own tables (`plans`, `executions`, `positions`), which nothing
// of the vault product writes, so it answers zeros. Rows are counted under the label their chain's
// figures carry now, as the portfolio's reads do (`ownedOn`): a vault read on a test network before
// its chain went to mainnet is not counted as a mainnet one. A vault is counted as the portfolio lists
// one: named by the cache, or read by the worker in the last week (`SNAPSHOT_LOOKBACK_DAYS`). The value
// is the snapshot worker's, and only when a pass of it in the last hour stands behind every chain of
// the block and every vault counted has a snapshot in that hour; otherwise it is null, never 0 and
// never a sum with a vault missing from it. A vault its person closed is not counted (gate
// VAULT-CLOSE-REUSE). Anybody may ask, so an answer is kept for a minute.

export const STATS_SOURCE = 'tenonfi API /v1/stats';
/** How long an answer is kept, in milliseconds. */
export const STATS_KEPT_MS = 60_000;

/** The active chains, one group per label their figures carry, in the order the registry lists them. */
export function byProvenance(entries: ChainEntry[]): Map<Provenance, ChainEntry[]> {
  const groups = new Map<Provenance, ChainEntry[]>();
  for (const entry of entries)
    groups.set(entry.provenance, [...(groups.get(entry.provenance) ?? []), entry]);
  return groups;
}

/**
 * The vaults counted, the wallets that own them, and, of each one, its newest snapshot since `fresh`:
 * how many have one, their sum, and the oldest of them. Snapshots are read back to `seen` only.
 */
async function readVaults(
  db: Db,
  chains: ChainEntry['chain'][],
  provenance: Provenance,
  a: { seen: Date; fresh: Date },
) {
  const cached = db
    .select({ chainId: vaults.chainId, address: vaults.address, owner: vaults.owner })
    .from(vaults)
    .where(
      and(inArray(vaults.chainId, chains), eq(vaults.provenance, provenance), thisLife(vaults)),
    );
  const snapped = db
    .select({
      chainId: vaultSnapshots.chainId,
      address: vaultSnapshots.address,
      owner: vaultSnapshots.owner,
    })
    .from(vaultSnapshots)
    .where(
      and(
        inArray(vaultSnapshots.chainId, chains),
        eq(vaultSnapshots.provenance, provenance),
        gt(vaultSnapshots.observedAt, a.seen),
        thisLife(vaultSnapshots),
      ),
    );
  const known = cached.union(snapped).as('known');
  const newest = db
    .selectDistinctOn([vaultSnapshots.chainId, vaultSnapshots.address], {
      chainId: vaultSnapshots.chainId,
      address: vaultSnapshots.address,
      valueUsd: vaultSnapshots.valueUsd,
      observedAt: vaultSnapshots.observedAt,
    })
    .from(vaultSnapshots)
    .where(
      and(
        inArray(vaultSnapshots.chainId, chains),
        eq(vaultSnapshots.provenance, provenance),
        gt(vaultSnapshots.observedAt, a.fresh),
      ),
    )
    .orderBy(vaultSnapshots.chainId, vaultSnapshots.address, sql`${vaultSnapshots.observedAt} desc`)
    .as('newest');
  const [row] = await db
    .select({
      vaults: sql<number>`count(*)::int`,
      wallets: sql<number>`count(distinct (${known.chainId}, ${known.owner}))::int`,
      read: sql<number>`count(${newest.address})::int`,
      total: sql<string>`coalesce(sum(${newest.valueUsd}), 0)`,
      oldest: sql<Date | null>`min(${newest.observedAt})`.mapWith(vaultSnapshots.observedAt),
    })
    .from(known)
    .leftJoin(newest, and(eq(known.chainId, newest.chainId), eq(known.address, newest.address)));
  return {
    vaults: row?.vaults ?? 0,
    wallets: row?.wallets ?? 0,
    read: row?.read ?? 0,
    totalUsd: Math.round(Number(row?.total ?? 0) * 100) / 100,
    oldest: row?.oldest ?? null,
  };
}

/** The numbers of one group of chains, read at `now`. */
export async function networkStats(
  db: Db,
  provenance: Provenance,
  entries: ChainEntry[],
  now: Date,
): Promise<PlatformNetwork> {
  const chains = entries.map((e) => e.chain);
  const fresh = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);
  const seen = new Date(now.getTime() - SNAPSHOT_LOOKBACK_DAYS * 86_400_000);
  const read = await readVaults(db, chains, provenance, { seen, fresh });
  const at = now.toISOString();
  const figure = (value: number, method: string, fetchedAt = at): PlatformFigure => ({
    value,
    source: STATS_SOURCE,
    fetchedAt,
    method,
  });
  // The oldest of the chains' last good passes, and of the snapshots summed: the value is as old as
  // the stalest read in it.
  const answered = await Promise.all(entries.map((entry) => chainAnsweredAt(db, entry)));
  const times = [...answered, ...(read.vaults ? [read.oldest] : [])];
  const oldest = times.every((t): t is Date => t !== null)
    ? new Date(Math.min(...times.map((t) => t.getTime())))
    : null;
  const known = oldest !== null && oldest > fresh && read.read === read.vaults;
  return {
    provenance,
    chains,
    vaults: figure(
      read.vaults,
      'count of vaults in the server’s cache, or read by the snapshot worker in the last 7 days',
    ),
    wallets: figure(read.wallets, 'count of distinct wallets owning those vaults'),
    valueUsd: known
      ? figure(
          read.totalUsd,
          'sum of each vault’s newest snapshot value in the last hour, USD',
          oldest.toISOString(),
        )
      : null,
  };
}

export function registerStatsRoute(scope: FastifyInstance, deps: OrderDeps) {
  let kept: { at: number; answer: PlatformStatsResponse } | null = null;
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/stats',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: 'The platform in numbers: vaults, the wallets that own them, what they hold',
        description:
          'One block per label the active chains carry (`live` for a mainnet, `sandbox` for a test network, `mock`), so figures of different networks are never added together. Every figure carries `source`, `fetchedAt` and `method`. A vault is counted when the server’s cache names it or the snapshot worker read it in the last 7 days. `valueUsd` is the sum of each vault’s newest snapshot, and null when the snapshot worker has not finished a pass in the last hour on every chain of the block or a vault counted has no snapshot in that hour: an unknown value is null, never 0 and never a partial sum. An answer is kept for 60 seconds.',
        response: { 200: PlatformStatsResponse, default: OrderError },
      },
    },
    async () => {
      const now = deps.now();
      if (kept && now.getTime() - kept.at < STATS_KEPT_MS) return kept.answer;
      const groups = byProvenance(deps.chains.active());
      const networks = await Promise.all(
        [...groups].map(([provenance, entries]) => networkStats(deps.db, provenance, entries, now)),
      );
      const answer = { networks, disclaimer: DISCLAIMER.en };
      kept = { at: now.getTime(), answer };
      return answer;
    },
  );
}
