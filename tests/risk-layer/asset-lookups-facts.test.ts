import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AssetFigure,
  BAR_KEYS,
  type BarRow,
  barCoverage,
  factNullReason,
  type LendingMarketRow,
  lendingFigures,
  MAX_POOLS,
  newestByMetric,
  type ObservationRow,
  type PoolBarRow,
  poolFigures,
  priceHistoryFigures,
  profileFigures,
  staleAfterSec,
  windowStart,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// The pure builders of the asset lookups (API-AGENT-LOOKUPS-1), on rows read from the local database
// (fixtures/risk/assets/lookups/, read-only, NVDAx on Solana and a dollar-yield token).
const DIR = join(__dirname, '../../fixtures/risk/assets/lookups');
const load = <T>(file: string): T => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as T;
const nvdax = load<{ observations: ObservationRow[] }>('nvdax-observations.json').observations;
const yieldToken = load<{ observations: ObservationRow[] }>(
  'yield-token-observations.json',
).observations;
const bars = load<{ bars: BarRow[] }>('nvdax-bars.json').bars;
const pools = load<{ reading: ObservationRow; poolBars: PoolBarRow[] }>('nvdax-pools.json');
const lending = load<{ markets: LendingMarketRow[] }>('nvdax-lending.json').markets;

const byKey = (figures: AssetFigure[]) => new Map(figures.map((f) => [f.key, f]));
const HOUR = 3_600_000;

describe('profile: the newest reading of each metric', () => {
  // supply_total was read at 13:44; the pool TVL reading is the registry's build of Oct 1.
  const now = new Date('2026-10-14T14:00:00.000Z');
  const figures = byKey(profileFigures(nvdax, now));

  it('serves each metric once, measured with its pin or null with a reason', () => {
    expect([...figures.keys()]).toEqual([
      'supply_total',
      'supply_issuer',
      'holders_top20_share',
      'pool_tvl_usd',
      'dex_volume_24h_usd',
      'protocol_tvl_usd',
      'exchange_rate',
      'yield_realised_30d',
      'yield_quoted',
    ]);
    const supply = nvdax.find((row) => row.metric === 'supply_total') as ObservationRow;
    expect(figures.get('supply_total')).toEqual({
      key: 'supply_total',
      value: supply.value,
      unit: 'tokens',
      source: supply.source,
      method: `${supply.method} (${supply.methodVersion})`,
      fetchedAt: supply.fetchedAt,
      provenance: 'live',
    });
  });

  it("maps the job's null reasons, unknown ones to not_collected", () => {
    expect(figures.get('exchange_rate')).toEqual({
      key: 'exchange_rate',
      value: null,
      reason: 'not_applicable',
    });
    // rpc_method_unavailable: the job's own word, which no fact reason names
    expect(figures.get('holders_top20_share')).toMatchObject({
      value: null,
      reason: 'not_collected',
    });
    expect(figures.get('protocol_tvl_usd')).toMatchObject({
      value: null,
      reason: 'not_applicable',
    });
    expect(factNullReason('insufficient_history')).toBe('insufficient_samples');
    expect(factNullReason('in_yield_observations')).toBe('not_imported');
    expect(factNullReason('not_a_finite_number')).toBe('not_a_number');
    expect(factNullReason('gate_open')).toBe('gate_open');
    expect(factNullReason('something_new')).toBe('not_collected');
    expect(factNullReason(null)).toBe('not_collected');
  });

  it('serves a reading past three of its job intervals with its age, never as fresh', () => {
    const tvl = figures.get('pool_tvl_usd');
    const observed = nvdax.find((row) => row.metric === 'pool_tvl_usd') as ObservationRow;
    expect(tvl).toMatchObject({ value: observed.value, unit: 'usd' });
    expect(tvl && 'staleAgeSec' in tvl ? tvl.staleAgeSec : undefined).toBe(
      Math.floor((now.getTime() - Date.parse(observed.observedAt)) / 1_000),
    );
    // hourly: three hours; daily: three days
    expect(staleAfterSec('pool_tvl_usd')).toBe(3 * 3_600);
    expect(staleAfterSec('dex_volume_24h_usd')).toBe(3 * 86_400);
    expect(staleAfterSec('yield_realised_7d')).toBe(3 * 3_600);
    // read at 13:44 (hourly) and 20 hours ago (daily): both within their limit
    expect(figures.get('supply_total')).not.toHaveProperty('staleAgeSec');
    expect(figures.get('dex_volume_24h_usd')).not.toHaveProperty('staleAgeSec');
  });

  it("keeps each yield reading as its own figure, the newest of a metric's rows", () => {
    const at = new Date('2026-10-13T18:00:00.000Z');
    const quoted = yieldToken.find((row) => row.metric === 'yield_quoted') as ObservationRow;
    const older = { ...quoted, value: 0.5, observedAt: '2026-10-11T03:02:13.612Z' };
    const own = byKey(profileFigures([older, ...yieldToken], at));
    expect(own.get('yield_quoted')).toMatchObject({ value: quoted.value, unit: 'fraction' });
    expect(own.get('yield_realised_30d')).toMatchObject({ value: null, reason: 'not_collected' });
    expect(newestByMetric([older, quoted])).toEqual([quoted]);
  });

  it('a sum that left a pool out is a lower bound', () => {
    const row = { ...(nvdax[3] as ObservationRow), detail: { lowerBound: true } };
    expect(profileFigures([row], new Date(row.observedAt))[0]).toMatchObject({ lowerBound: true });
  });
});

describe('price history: the asset bars of a window, in dollars', () => {
  // The bars run to the hour of 05:00 on Oct 6; at 06:30 they reach the present.
  const now = new Date('2026-10-06T06:30:00.000Z');

  it('serves the window when the bars cover it', () => {
    const figures = byKey(priceHistoryFigures(bars, null, '24h', now));
    expect([...figures.keys()]).toEqual([...BAR_KEYS]);
    const start = windowStart('24h', now).getTime();
    const inside = bars.filter((bar) => Date.parse(bar.hour) >= start);
    const priced = inside.filter((bar) => bar.closeUsd !== null);
    const valued = inside.filter((bar) => bar.volumeUsd !== null);
    const first = priced[0] as BarRow;
    const last = priced.at(-1) as BarRow;
    expect(figures.get('close')).toMatchObject({ value: last.closeUsd, unit: 'usd' });
    expect(figures.get('high')?.value).toBe(Math.max(...priced.map((b) => b.highUsd as number)));
    expect(figures.get('low')?.value).toBe(Math.min(...priced.map((b) => b.lowUsd as number)));
    expect(figures.get('change')).toMatchObject({
      value: ((last.closeUsd as number) - (first.closeUsd as number)) / (first.closeUsd as number),
      unit: 'fraction',
    });
    expect(figures.get('volume')?.value).toBeCloseTo(
      valued.reduce((s, b) => s + (b.volumeUsd as number), 0),
      6,
    );
    expect(figures.get('buyvol')?.value).toBeCloseTo(
      valued.reduce((s, b) => s + (b.buyVolumeUsd as number), 0),
      6,
    );
    expect(figures.get('swaps')).toMatchObject({
      value: inside.reduce((s, b) => s + b.swaps, 0),
      unit: 'count',
    });
    expect(figures.get('gaps')).toMatchObject({ value: 24 - valued.length, unit: 'hours' });
    for (const figure of figures.values())
      expect(figure).toMatchObject({
        provenance: 'live',
        method: expect.stringContaining('bars-0.1'),
      });
  });

  it('a window the bars do not reach back to is not collected, with the hours missing', () => {
    // 30 days back from Oct 6 is Sep 6; the fixture's bars start on Sep 29 and none is older.
    const figures = priceHistoryFigures(bars, null, '30d', now);
    const start = windowStart('30d', now).getTime();
    const missing = Math.round((Date.parse((bars[0] as BarRow).hour) - start) / HOUR);
    expect(missing).toBeGreaterThan(500);
    expect(figures).toEqual(
      BAR_KEYS.map((key) => ({ key, value: null, reason: 'not_collected', missingHours: missing })),
    );
    // With an older bar before the window, the history goes back further: the hours between were quiet.
    expect(barCoverage(bars, '2026-08-01T00:00:00.000Z', '30d', now)).toEqual({ covered: true });
  });

  it('bars that stop short of now are not collected, never a part shown as the whole', () => {
    const later = new Date('2026-10-06T12:00:00.000Z');
    const figures = priceHistoryFigures(bars, null, '24h', later);
    // the last bar ended at 06:00, six hours before
    expect(figures.every((f) => f.value === null && f.missingHours === 6)).toBe(true);
    expect(priceHistoryFigures([], null, '7d', now)).toEqual(
      BAR_KEYS.map((key) => ({ key, value: null, reason: 'not_collected', missingHours: 168 })),
    );
  });

  it('reads the DEX bars in dollars only, never an oracle price', () => {
    // A row carrying more than the dollar columns: an oracle's price and the quote-token close.
    const odd = bars.map((bar) => ({ ...bar, oracleUsd: 1_000_000, closeQuote: 1_000_000 }));
    const figures = byKey(priceHistoryFigures(odd, null, '7d', now));
    const last = bars.filter((bar) => bar.closeUsd !== null).at(-1) as BarRow;
    expect(figures.get('close')?.value).toBe(last.closeUsd);
    expect(figures.get('high')?.value).toBeLessThan(1_000_000);
    for (const figure of figures.values()) {
      if (figure.value === null) continue;
      expect(figure.source).toMatch(/^market_bars \(DEX swaps;/u);
      expect(`${figure.source} ${figure.method}`).not.toMatch(/oracle|scope|chainlink|pyth/iu);
    }
  });

  it('keeps one row an hour, the later method version', () => {
    const last = bars.at(-1) as BarRow;
    const again = { ...last, methodVersion: 'bars-0.2', closeUsd: (last.closeUsd as number) * 2 };
    const figures = byKey(priceHistoryFigures([...bars, again], null, '24h', now));
    expect(figures.get('close')?.value).toBe(again.closeUsd);
  });
});

describe('pools: by dollars held, at most five', () => {
  const now = new Date('2026-10-06T06:30:00.000Z');
  const day = barCoverage(
    bars.filter((bar) => Date.parse(bar.hour) >= windowStart('24h', now).getTime()),
    null,
    '24h',
    now,
  );

  it('serves the five largest with their TVL, share and day volume, the reading aged', () => {
    const { pools: served, missing } = poolFigures(pools.reading, pools.poolBars, day, now);
    expect(missing).toBeNull();
    const listed = pools.reading.detail?.pools as Array<{ address: string; tvlUsd: number }>;
    expect(listed.length).toBeGreaterThan(MAX_POOLS);
    expect(served.map((p) => p.pool)).toEqual(listed.slice(0, MAX_POOLS).map((p) => p.address));
    expect(served.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
    const age = Math.floor((now.getTime() - Date.parse(pools.reading.observedAt)) / 1_000);
    const top = byKey((served[0] as (typeof served)[number]).figures);
    expect(top.get('tvl')).toMatchObject({ value: listed[0]?.tvlUsd, staleAgeSec: age });
    expect(top.get('share')).toMatchObject({
      value: (listed[0]?.tvlUsd as number) / (pools.reading.value as number),
      unit: 'fraction',
      staleAgeSec: age,
    });
    const own = pools.poolBars.filter(
      (bar) =>
        bar.pool === listed[0]?.address &&
        Date.parse(bar.hour) >= now.getTime() - 24 * HOUR &&
        bar.volumeUsd !== null,
    );
    expect(top.get('volume')?.value).toBeCloseTo(
      own.reduce((s, b) => s + (b.volumeUsd as number), 0),
      6,
    );
  });

  it('a day the bars do not cover leaves the volume not collected; no reading leaves the pools out', () => {
    const late = new Date('2026-10-06T12:00:00.000Z');
    const stale = barCoverage(bars, null, '24h', late);
    const { pools: served } = poolFigures(pools.reading, pools.poolBars, stale, late);
    expect(byKey((served[0] as (typeof served)[number]).figures).get('volume')).toEqual({
      key: 'volume',
      value: null,
      reason: 'not_collected',
      missingHours: 6,
    });
    expect(poolFigures(null, [], day, now)).toEqual({
      pools: [],
      missing: { key: 'tvl', value: null, reason: 'not_collected' },
    });
    const none = { ...pools.reading, value: null, nullReason: 'no_registered_pool', detail: {} };
    expect(poolFigures(none, [], day, now).missing).toEqual({
      key: 'tvl',
      value: null,
      reason: 'not_collected',
    });
  });
});

describe('lending: per market, from the report’s sheets', () => {
  it('serves the supply and borrow rate, the share lent out and what can be withdrawn now', () => {
    const now = new Date('2026-10-14T14:00:00.000Z');
    const markets = lendingFigures(lending, now);
    expect(markets.map((m) => m.account)).toEqual([...lending.map((m) => m.account)].sort());
    for (const market of markets) {
      const sheet = (lending.find((m) => m.account === market.account) as LendingMarketRow).sheet;
      const f = byKey(market.figures);
      expect(f.get('supply')).toMatchObject({
        value: sheet.rates.supplyApy.value,
        unit: 'fraction',
      });
      expect(f.get('borrow')).toMatchObject({ value: sheet.rates.borrowApy.value });
      expect(f.get('util')).toMatchObject({ value: sheet.withdrawal.shareLentOut.value });
      expect(f.get('withdrawable')).toMatchObject({
        value: sheet.withdrawal.availableUsd.value,
        unit: 'usd',
      });
      // read at 13:11, an hour of the report's: fresh
      expect(f.get('supply')).not.toHaveProperty('staleAgeSec');
    }
  });

  it('a sheet three reports old carries its age; a missing fact keeps its reason', () => {
    const later = new Date('2026-10-15T14:00:00.000Z');
    const market = lending[0] as LendingMarketRow;
    const sheet = {
      ...market.sheet,
      withdrawal: {
        ...market.sheet.withdrawal,
        availableUsd: { value: null, reason: 'not_collected' as const, unit: 'usd' as const },
      },
    };
    const [one] = lendingFigures([{ ...market, sheet }], later);
    const f = byKey(one?.figures ?? []);
    expect(f.get('supply')).toHaveProperty('staleAgeSec');
    expect(f.get('withdrawable')).toEqual({
      key: 'withdrawable',
      value: null,
      reason: 'not_collected',
    });
  });
});
