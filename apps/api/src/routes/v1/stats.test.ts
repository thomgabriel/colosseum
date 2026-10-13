import { snapshotRuns, vaultSnapshots, vaults } from '@colosseum/db';
import { PlatformStatsResponse, type Provenance } from '@colosseum/schemas';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainEntry } from '../../orders/chains';
import { testApp, testDb } from '../../testing/harness';
import { seedRun, seedSnapshot, seedVault, vaultAddress } from '../../testing/portfolio-world';
import { byProvenance, networkStats, STATS_KEPT_MS, STATS_SOURCE } from './stats';

// GET /v1/stats: the landing's numbers, from the vault product's tables. Other test files write vaults
// and snapshots to this database at the same time, so the exact counts are read under a label none of
// them uses (`prior_dataset` on base), and the route itself is checked for its shape and its keeping.

vi.setConfig({ testTimeout: 60_000 });

const NOW = new Date('2026-10-13T12:00:00.000Z');
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);
const LABEL: Provenance = 'prior_dataset';
const BASE = { chain: 'base', provenance: LABEL } as ChainEntry;
const stats = () => networkStats(data.db, LABEL, [BASE], NOW);

let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let clock = NOW;

const clear = async () => {
  for (const label of [LABEL, 'fixture'] as const)
    for (const table of [vaults, vaultSnapshots, snapshotRuns])
      await data.db
        .delete(table)
        .where(and(eq(table.chainId, 'base'), eq(table.provenance, label)));
};

/** A vault the worker read `minutes` ago, worth `valueUsd`; in the cache too unless `cached` is false. */
async function vault(owner: string, minutes: number, valueUsd: number, cached = true) {
  const address = vaultAddress('base');
  if (cached) await seedVault(data.db, { chain: 'base', owner, address, provenance: LABEL });
  await seedSnapshot(data.db, {
    chain: 'base',
    address,
    owner,
    observedAt: ago(minutes),
    valueUsd,
    provenance: LABEL,
  });
  return address;
}

beforeAll(async () => {
  data = await testDb();
  ({ app } = await testApp({ issuer: null, db: data.db, now: () => clock }));
});
beforeEach(clear);
afterAll(async () => {
  await clear();
  await app.close();
  await data.cleanUp();
});

describe('the platform’s numbers', () => {
  it('counts each vault the cache names or the worker read this week once, and the wallets that own them', async () => {
    const alice = vaultAddress('base');
    const bob = vaultAddress('base');
    // In the cache and among the snapshots: one vault.
    await vault(alice, 5, 100);
    // In the cache alone.
    await seedVault(data.db, { chain: 'base', owner: alice, provenance: LABEL });
    // Found by the worker alone, this week; and one it last read eight days ago, not counted.
    await vault(bob, 5, 50, false);
    await vault(vaultAddress('base'), 8 * 24 * 60, 50, false);
    // Read under another label: not this block's.
    await seedVault(data.db, { chain: 'base', owner: vaultAddress('base'), provenance: 'fixture' });

    const s = await stats();
    expect(s.vaults.value).toBe(3);
    expect(s.wallets.value).toBe(2);
    for (const figure of [s.vaults, s.wallets]) {
      expect(figure.source).toBe(STATS_SOURCE);
      expect(figure.fetchedAt).toBe(NOW.toISOString());
      expect(figure.method).not.toBe('');
    }
  });

  it('has no value, rather than 0, while the worker has not finished a pass in the last hour', async () => {
    await vault(vaultAddress('base'), 5, 100);
    // No pass at all.
    expect((await stats()).valueUsd).toBeNull();
    // A pass that failed, and one that went through more than an hour ago.
    await seedRun(data.db, { chain: 'base', finishedAt: ago(5), error: 'node', provenance: LABEL });
    await seedRun(data.db, { chain: 'base', finishedAt: ago(61), provenance: LABEL });
    expect((await stats()).valueUsd).toBeNull();
  });

  it('sums each vault’s newest snapshot of the last hour once a fresh pass stands behind it', async () => {
    const owner = vaultAddress('base');
    const address = await vault(owner, 30, 999);
    // A newer read of the same vault: only it is added.
    await seedSnapshot(data.db, {
      chain: 'base',
      address,
      owner,
      observedAt: ago(10),
      valueUsd: 25.5,
      provenance: LABEL,
    });
    await vault(owner, 12, 150, false);
    await seedRun(data.db, { chain: 'base', finishedAt: ago(8), provenance: LABEL });

    const value = (await stats()).valueUsd;
    expect(value?.value).toBe(175.5);
    // As old as the oldest read in it.
    expect(value?.fetchedAt).toBe(ago(12).toISOString());
    expect(value?.source).toBe(STATS_SOURCE);
  });

  it('has no value, rather than a smaller one, while a vault counted has no snapshot in the hour', async () => {
    const owner = vaultAddress('base');
    await vault(owner, 10, 100);
    // Its reads failing for over an hour, in passes that otherwise went through.
    const failing = await vault(owner, 90, 5000);
    await seedRun(data.db, {
      chain: 'base',
      finishedAt: ago(8),
      vaultsFailed: 1,
      provenance: LABEL,
    });
    const s = await stats();
    expect(s.vaults.value).toBe(2);
    expect(s.valueUsd).toBeNull();
    // Read again: the sum is back, and whole.
    await seedSnapshot(data.db, {
      chain: 'base',
      address: failing,
      owner,
      observedAt: ago(9),
      valueUsd: 4900,
      provenance: LABEL,
    });
    expect((await stats()).valueUsd?.value).toBe(5000);
  });

  it('keeps chains of different labels apart', () => {
    const live = { chain: 'robinhood', provenance: 'live' } as ChainEntry;
    const devnet = { chain: 'solana', provenance: 'sandbox' } as ChainEntry;
    const sepolia = { chain: 'base', provenance: 'sandbox' } as ChainEntry;
    expect([...byProvenance([devnet, live, sepolia])]).toEqual([
      ['sandbox', [devnet, sepolia]],
      ['live', [live]],
    ]);
  });

  it('is answered to anybody, one block per label of the active chains, and kept for a minute', async () => {
    const get = async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/stats' });
      expect(res.statusCode).toBe(200);
      return PlatformStatsResponse.parse(res.json());
    };
    clock = NOW;
    const first = await get();
    expect(first.networks.map((n) => n.provenance)).toEqual(['mock']);
    expect(first.networks[0]?.vaults.source).toBe(STATS_SOURCE);
    expect(first.networks[0]?.vaults.fetchedAt).toBe(NOW.toISOString());
    // Within the minute: the same answer, read at the same instant.
    clock = new Date(NOW.getTime() + STATS_KEPT_MS - 1);
    expect(await get()).toEqual(first);
    // After it: read again.
    clock = new Date(NOW.getTime() + STATS_KEPT_MS);
    expect((await get()).networks[0]?.vaults.fetchedAt).toBe(clock.toISOString());
  });
});
