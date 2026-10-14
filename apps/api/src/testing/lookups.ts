import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@colosseum/db';
import type { BarRow, LendingMarketRow, ObservationRow, PoolBarRow } from '@colosseum/risk';
import type { AssetFacts } from '@colosseum/schemas';
import { createAssetLookups, type LookupReads } from '../asset-lookups';
import type { AssetLookups } from '../orders/lookups';

// The asset lookups offline, for the conversations' tests and the eval (API-AGENT-LOOKUPS-2): the
// reader of slice 1 (asset-lookups.ts) with its reads handed the rows of fixtures/risk/assets/lookups/,
// read from the local database on 2026-10-14. Every asset gets NVDAx's rows under its own ids: what is
// tested is what the conversations do with figures, not which asset has which. No database is touched.

const DIR = join(import.meta.dirname, '../../../../fixtures/risk/assets/lookups');
const load = <T>(file: string): T => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as T;

export const LOOKUP_ROWS = {
  observations: load<{ observations: ObservationRow[] }>('nvdax-observations.json').observations,
  yieldObservations: load<{ observations: ObservationRow[] }>('yield-token-observations.json')
    .observations,
  bars: load<{ bars: BarRow[] }>('nvdax-bars.json').bars,
  pools: load<{ reading: ObservationRow; poolBars: PoolBarRow[] }>('nvdax-pools.json'),
  lending: load<{ markets: LendingMarketRow[] }>('nvdax-lending.json').markets,
};
const HOUR_MS = 3_600_000;
const firstBar = Date.parse(LOOKUP_ROWS.bars[0]?.hour ?? '');
const lastBar = Date.parse(LOOKUP_ROWS.bars.at(-1)?.hour ?? '');
/**
 * The hours the chain's collector ran: every hour from the fixture's first bar to its last, as in
 * asset-lookups.test.ts. An hour with no bar of the asset in it is then a quiet hour, never an outage.
 */
export const LOOKUP_CHAIN_HOURS = Array.from(
  { length: (lastBar - firstBar) / HOUR_MS + 1 },
  (_, at) => new Date(firstBar + at * HOUR_MS).toISOString(),
);
/** The hour the fixtures' bars reach and the lending report was read: their "now". */
export const LOOKUP_NOW = Date.parse('2026-10-06T06:30:00.000Z');
/** Stands in for the database: the reads below never touch it. */
export const OFFLINE_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('the offline lookups read no database');
    },
  },
) as Db;

export function fixtureReads(over: Partial<LookupReads> = {}): LookupReads {
  return {
    observations: async (_db, _chain, address) =>
      // a dollar-yield token reads the yield token's readings; anything else NVDAx's
      address.startsWith('9BEcn') || address.startsWith('AvZZ')
        ? LOOKUP_ROWS.yieldObservations
        : LOOKUP_ROWS.observations,
    bars: async () => ({ rows: LOOKUP_ROWS.bars, before: null, chainHours: LOOKUP_CHAIN_HOURS }),
    poolReading: async () => LOOKUP_ROWS.pools.reading,
    poolBars: async () => LOOKUP_ROWS.pools.poolBars,
    lending: async () => LOOKUP_ROWS.lending,
    sheet: async (): Promise<AssetFacts | null> => null,
    ...over,
  };
}

/** The reader of slice 1 over the fixtures, at their hour, with no test-network twin. */
export function fixtureLookups(
  over: Partial<LookupReads> = {},
  options: Parameters<typeof createAssetLookups>[0] = {},
): AssetLookups {
  return createAssetLookups({
    reads: fixtureReads(over),
    twins: async () => [],
    now: () => LOOKUP_NOW,
    ...options,
  });
}
