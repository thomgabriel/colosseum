import { snapshotRuns, vaultSnapshots, vaults } from '@colosseum/db';
import { PlatformStatsResponse, type Provenance } from '@colosseum/schemas';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry } from '../../orders/chains';
import { testApp, testDb } from '../../testing/harness';
import { seedRun, seedSnapshot, seedVault, vaultAddress } from '../../testing/portfolio-world';
import { byProvenance, networkStats, STATS_SOURCE } from './stats';

// GET /v1/stats: the landing's numbers, from the vault product's tables. Other test files write vaults
// and snapshots to this database at the same time, so the exact counts are read under a label none of
// them uses (`prior_dataset` on base), and the route itself is checked for its shape.

vi.setConfig({ testTimeout: 60_000 });

const NOW = new Date('2026-10-13T12:00:00.000Z');
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);
const LABEL: Provenance = 'prior_dataset';
const BASE = { chain: 'base', provenance: LABEL } as ChainEntry;

let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;

const clear = async () => {
  for (const table of [vaults, vaultSnapshots, snapshotRuns])
    await data.db.delete(table).where(and(eq(table.chainId, 'base'), eq(table.provenance, LABEL)));
};

beforeAll(async () => {
  data = await testDb();
  await clear();
  ({ app } = await testApp({ issuer: null, db: data.db, now: () => NOW }));
});
afterAll(async () => {
  await clear();
  await app.close();
  await data.cleanUp();
});

describe('the platform’s numbers', () => {
  it('counts every vault the cache or the worker holds once, and the wallets that own them', async () => {
    const alice = vaultAddress('base');
    const bob = vaultAddress('base');
    const a1 = await seedVault(data.db, { chain: 'base', owner: alice, provenance: LABEL });
    await seedVault(data.db, { chain: 'base', owner: alice, provenance: LABEL });
    // In the cache and among the snapshots: one vault.
    await seedSnapshot(data.db, {
      chain: 'base',
      address: a1,
      owner: alice,
      observedAt: ago(5),
      valueUsd: 100,
      provenance: LABEL,
    });
    // Found by the worker alone.
    await seedSnapshot(data.db, {
      chain: 'base',
      address: vaultAddress('base'),
      owner: bob,
      observedAt: ago(5),
      valueUsd: 50,
      provenance: LABEL,
    });
    // Read under another label: not this block's.
    await seedVault(data.db, { chain: 'base', owner: vaultAddress('base'), provenance: 'fixture' });

    const stats = await networkStats(data.db, LABEL, [BASE], NOW);
    expect(stats.vaults.value).toBe(3);
    expect(stats.wallets.value).toBe(2);
    for (const figure of [stats.vaults, stats.wallets]) {
      expect(figure.source).toBe(STATS_SOURCE);
      expect(figure.fetchedAt).toBe(NOW.toISOString());
      expect(figure.method).not.toBe('');
    }
    await data.db
      .delete(vaults)
      .where(and(eq(vaults.chainId, 'base'), eq(vaults.provenance, 'fixture')));
  });

  it('has no value, rather than 0, while the worker has not finished a pass in the last hour', async () => {
    // No pass at all.
    expect((await networkStats(data.db, LABEL, [BASE], NOW)).valueUsd).toBeNull();
    // A pass that failed, and one that went through more than an hour ago.
    await seedRun(data.db, { chain: 'base', finishedAt: ago(5), error: 'node', provenance: LABEL });
    await seedRun(data.db, { chain: 'base', finishedAt: ago(61), provenance: LABEL });
    expect((await networkStats(data.db, LABEL, [BASE], NOW)).valueUsd).toBeNull();
  });

  it('sums each vault’s newest snapshot of the last hour once a fresh pass stands behind it', async () => {
    const owner = vaultAddress('base');
    const address = vaultAddress('base');
    // An older read of the same vault is not added; a read older than the hour is left out.
    await seedSnapshot(data.db, {
      chain: 'base',
      address,
      owner,
      observedAt: ago(30),
      valueUsd: 999,
      provenance: LABEL,
    });
    await seedSnapshot(data.db, {
      chain: 'base',
      address,
      owner,
      observedAt: ago(10),
      valueUsd: 25.5,
      provenance: LABEL,
    });
    await seedSnapshot(data.db, {
      chain: 'base',
      address: vaultAddress('base'),
      owner,
      observedAt: ago(90),
      valueUsd: 7000,
      provenance: LABEL,
    });
    await seedRun(data.db, { chain: 'base', finishedAt: ago(8), provenance: LABEL });

    const value = (await networkStats(data.db, LABEL, [BASE], NOW)).valueUsd;
    // 100 and 50 from the first test, 25.5 here.
    expect(value?.value).toBe(175.5);
    expect(value?.fetchedAt).toBe(ago(8).toISOString());
    expect(value?.source).toBe(STATS_SOURCE);
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

  it('is answered to anybody, one block per label of the active chains', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/stats' });
    expect(res.statusCode).toBe(200);
    const body = PlatformStatsResponse.parse(res.json());
    expect(body.networks.map((n) => n.provenance)).toEqual(['mock']);
    expect(body.networks[0]?.vaults.source).toBe(STATS_SOURCE);
  });
});
