// The shelf of gate ASSET-SHELF as committed (PLAN-ASSETS AS.9 and AS.10): each shelf file is re-cut from the
// committed list and the readings frozen beside it (fixtures/risk/assets/shelf-readings-<chain>.json, written by
// `pnpm risk:shelf`), and each entries file is re-made from the shelf and parses as BasketAsset.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BasketAsset, UniverseList } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import {
  type EntriesFile,
  type ShelfFile,
  type StampedReading,
  shelfEntries,
  shelfFile,
} from '../scripts/risk/assets/shelf-build';

const ROOT = join(__dirname, '..');
const json = <T>(p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;

for (const chain of ['solana', 'robinhood'] as const) {
  describe(`the ${chain} shelf`, () => {
    const committed = json<ShelfFile>(`scripts/risk/assets/shelf-${chain}.json`);
    const list = UniverseList.parse(json(`scripts/risk/assets/${chain}.json`));
    const { readings, yieldAsked, yieldReadings } = json<{
      readings: StampedReading[];
      yieldAsked: string[];
      yieldReadings: Array<{ address: string }>;
    }>(committed.readingsFrozen as string);
    const frozenYield = new Set(yieldReadings.map((r) => r.address));
    const recut = () =>
      shelfFile({
        chain,
        listFile: committed.list.file,
        listCommit: committed.list.commit,
        assets: list.assets,
        readings,
        floorUsd: committed.floorUsd,
      });

    it('is the cut of the committed list and the frozen readings', () => {
      const { readingsFrozen: _, ...file } = committed;
      expect(recut()).toEqual(file);
    });

    it('holds only listed or candidate rows at or above the floor, each stamped', () => {
      expect(committed.floorUsd).toBe(100_000);
      const byId = new Map(list.assets.map((a) => [a.id, a]));
      for (const r of committed.rows) {
        expect(['listed', 'candidate']).toContain(byId.get(r.id)?.status);
        expect(r.volume24hUsd).toBeGreaterThanOrEqual(committed.floorUsd);
        for (const k of ['source', 'fetched_at', 'method'] as const) expect(r[k]).toBeTruthy();
        expect(r.provenance).toBe('live');
      }
      expect(committed.reading?.from).toBeTruthy();
      expect(committed.counts.onShelf).toBe(committed.rows.length);
      expect(
        readings.every((r) => r.provenance === 'live' && !Number.isNaN(Date.parse(r.observedAt))),
      ).toBe(true);
      // every dollar-yield token of the shelf was asked for its yield reading
      expect(yieldAsked.sort()).toEqual(
        committed.rows
          .filter((r) => r.cls === 'dollar_yield')
          .map((r) => r.address)
          .sort(),
      );
    });

    it('keeps a dollar-yield token without a yield reading out of the entries', () => {
      const entries = json<EntriesFile>(`scripts/risk/assets/shelf-entries-${chain}.json`);
      for (const r of committed.rows.filter((x) => x.cls === 'dollar_yield')) {
        const isEntry = entries.entries.some((e) => e.asset.id === r.id);
        if (!frozenYield.has(r.address)) expect(isEntry).toBe(false);
      }
    });

    it('leaves out a held-out row and a row under the floor, whatever they trade', () => {
      const held = list.assets.find((a) => a.status === 'held_out') as (typeof list.assets)[number];
      const cand = list.assets.find(
        (a) => a.status === 'candidate',
      ) as (typeof list.assets)[number];
      const at = '2026-10-12T00:00:00.000Z';
      const stamp = { source: 's', method: 'm', fetchedAt: at, provenance: 'live' };
      const cut = shelfFile({
        chain,
        listFile: 'l',
        listCommit: 'c',
        assets: [held, cand],
        readings: [
          { address: held.address, value: 9e9, observedAt: at, ...stamp },
          { address: cand.address, value: 99_999, observedAt: at, ...stamp },
        ],
        floorUsd: 100_000,
      });
      expect(cut.rows).toEqual([]);
      expect(cut.counts).toMatchObject({ considered: 1, belowFloor: 1 });
    });

    it('makes the entries from the shelf, every one a BasketAsset with the fallback tier', () => {
      const entries = json<EntriesFile>(`scripts/risk/assets/shelf-entries-${chain}.json`);
      const tracked = json<{
        assets: Array<{ id: string; oracle: { kind: string; ref: string } | null }>;
      }>(`scripts/risk/universe/${chain}.json`);
      const waitingIds = new Set(entries.waiting.map((w) => w.id));
      const remade = shelfEntries({
        shelf: committed,
        shelfPath: entries.shelf,
        assets: list.assets,
        trackedOracle: (id) => tracked.assets.find((t) => t.id === id)?.oracle ?? null,
        // the yield readings the command read, frozen beside the volume readings
        hasYieldReading: (a) => frozenYield.has(a),
      });
      expect(remade).toEqual(entries);
      expect(entries.entries.length + entries.waiting.length).toBe(committed.rows.length);
      for (const e of entries.entries) {
        expect(BasketAsset.safeParse(e.asset).success).toBe(true);
        expect([e.asset.tier, e.tierFrom, e.asset.maxWeightBps]).toEqual(['C', 'fallback', 0]);
        expect(waitingIds.has(e.asset.id)).toBe(false);
      }
      for (const w of entries.waiting) expect(w.missing.length).toBeGreaterThan(0);
    });
  });
}
