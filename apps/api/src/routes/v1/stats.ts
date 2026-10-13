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
import { chainAnsweredAt } from '../../portfolio/snapshots';

// GET /v1/stats: the platform's numbers under the landing's hero, from the vault product's tables.
// The structurer's `/stats` counts its own tables (`plans`, `executions`, `positions`), which nothing
// of the vault product writes, so it answers zeros. Rows are counted under the label their chain's
// figures carry now, as the portfolio's reads do (`ownedOn`): a vault read on a test network before
// its chain went to mainnet is not counted as a mainnet one. The value is the snapshot worker's, and
// only when a pass of it in the last hour stands behind every chain of the block; otherwise it is
// null, never 0.

export const STATS_SOURCE = 'tenonfi API /v1/stats';

/** The active chains, one group per label their figures carry, in the order the registry lists them. */
export function byProvenance(entries: ChainEntry[]): Map<Provenance, ChainEntry[]> {
  const groups = new Map<Provenance, ChainEntry[]>();
  for (const entry of entries)
    groups.set(entry.provenance, [...(groups.get(entry.provenance) ?? []), entry]);
  return groups;
}

async function countVaults(db: Db, chains: ChainEntry['chain'][], provenance: Provenance) {
  const cached = db
    .select({ chainId: vaults.chainId, address: vaults.address, owner: vaults.owner })
    .from(vaults)
    .where(and(inArray(vaults.chainId, chains), eq(vaults.provenance, provenance)));
  const snapped = db
    .select({
      chainId: vaultSnapshots.chainId,
      address: vaultSnapshots.address,
      owner: vaultSnapshots.owner,
    })
    .from(vaultSnapshots)
    .where(and(inArray(vaultSnapshots.chainId, chains), eq(vaultSnapshots.provenance, provenance)));
  const known = cached.union(snapped).as('known');
  const [row] = await db
    .select({
      vaults: sql<number>`count(*)::int`,
      wallets: sql<number>`count(distinct (${known.chainId}, ${known.owner}))::int`,
    })
    .from(known);
  return { vaults: row?.vaults ?? 0, wallets: row?.wallets ?? 0 };
}

/** Each vault's newest snapshot since `since`, summed, in dollars. */
async function sumNewest(
  db: Db,
  chains: ChainEntry['chain'][],
  provenance: Provenance,
  since: Date,
): Promise<number> {
  const newest = db
    .selectDistinctOn([vaultSnapshots.chainId, vaultSnapshots.address], {
      valueUsd: vaultSnapshots.valueUsd,
    })
    .from(vaultSnapshots)
    .where(
      and(
        inArray(vaultSnapshots.chainId, chains),
        eq(vaultSnapshots.provenance, provenance),
        gt(vaultSnapshots.observedAt, since),
      ),
    )
    .orderBy(vaultSnapshots.chainId, vaultSnapshots.address, sql`${vaultSnapshots.observedAt} desc`)
    .as('newest');
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${newest.valueUsd}), 0)` })
    .from(newest);
  return Math.round(Number(row?.total ?? 0) * 100) / 100;
}

/** The numbers of one group of chains, read at `now`. */
export async function networkStats(
  db: Db,
  provenance: Provenance,
  entries: ChainEntry[],
  now: Date,
): Promise<PlatformNetwork> {
  const chains = entries.map((e) => e.chain);
  const counted = await countVaults(db, chains, provenance);
  const at = now.toISOString();
  const figure = (value: number, method: string, fetchedAt = at): PlatformFigure => ({
    value,
    source: STATS_SOURCE,
    fetchedAt,
    method,
  });
  // The oldest of the chains' last good passes: the value is as old as the stalest chain in it.
  const since = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);
  const answered = await Promise.all(entries.map((entry) => chainAnsweredAt(db, entry)));
  const oldest = answered.every((a): a is Date => a !== null)
    ? new Date(Math.min(...answered.map((a) => a.getTime())))
    : null;
  const fresh = oldest !== null && oldest > since;
  return {
    provenance,
    chains,
    vaults: figure(
      counted.vaults,
      'count of vaults in the server’s cache or the snapshot worker’s reads',
    ),
    wallets: figure(counted.wallets, 'count of distinct wallets owning those vaults'),
    valueUsd: fresh
      ? figure(
          await sumNewest(db, chains, provenance, since),
          'sum of each vault’s newest snapshot value in the last hour, USD',
          oldest.toISOString(),
        )
      : null,
  };
}

export function registerStatsRoute(scope: FastifyInstance, deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/stats',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: 'The platform in numbers: vaults, the wallets that own them, what they hold',
        description:
          'One block per label the active chains carry (`live` for a mainnet, `sandbox` for a test network, `mock`), so figures of different networks are never added together. Every figure carries `source`, `fetchedAt` and `method`. `valueUsd` is the sum of each vault’s newest snapshot, and null when the snapshot worker has not finished a pass in the last hour on every chain of the block: an unknown value is null, never 0.',
        response: { 200: PlatformStatsResponse, default: OrderError },
      },
    },
    async () => {
      const now = deps.now();
      const groups = byProvenance(deps.chains.active());
      const networks = await Promise.all(
        [...groups].map(([provenance, entries]) => networkStats(deps.db, provenance, entries, now)),
      );
      return { networks, disclaimer: DISCLAIMER.en };
    },
  );
}
