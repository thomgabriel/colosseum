import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  ASSET_METRICS,
  type AssetObservation,
  compareJobRows,
  type DexPair,
  defillamaPrice,
  discoveryExtract,
  type ExternalPrice,
  isPrice,
  jupiterPrice,
  METRIC_UNIT,
  type MetricAnswers,
  type MetricAsset,
  type MetricSources,
  metricPlan,
  type PriceObservation,
  priceJobReferences,
  pricesToWrite,
  realisedFromSeries,
  rowsFromAnswers,
  top20Share,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import { changedOnly, writeRun } from '../scripts/risk/assets/metrics-db';
import { decodeAnswers } from '../scripts/risk/assets/metrics-run';

// PLAN-ASSETS AS.5 (gate ASSET-METRICS): the metric readers on frozen real reads. Two runs' answers, cut to a few
// tokens of each list (pnpm risk:assets-freeze-metrics), are turned into rows as the import does, and every metric's
// figure is recomputed here by hand from the raw answer: the mint's bytes, the call's word, the API's fields. The
// reasons of the missing facts are checked, the dry run's write touches nothing, and the price job's resolution is run
// on a frozen window of its own observations before and after the aggregators' prices are added. No network; nothing
// here loads dotenv.

const SOL = 'fixtures/risk/assets/metrics/solana-answers-20261011T0354Z.jsonl.gz';
const RH = 'fixtures/risk-evm/assets/metrics/robinhood-answers-20261011T0357Z.jsonl.gz';
const WINDOW = 'fixtures/risk/assets/metrics/price-window-20261011T0359Z.json.gz';
const sources = JSON.parse(
  readFileSync('scripts/risk/assets/metrics.sources.json', 'utf8'),
) as MetricSources;
const listOf = (chain: string) =>
  (
    JSON.parse(readFileSync(`scripts/risk/assets/${chain}.json`, 'utf8')) as {
      assets: MetricAsset[];
    }
  ).assets;

function run(file: string) {
  const A = decodeAnswers(readFileSync(file));
  const keep = new Set([
    ...(A.mints ?? []).flatMap((c) => Object.keys(c.accounts)),
    ...Object.keys(A.totalSupply ?? {}),
    ...Object.keys(A.dex && 'byToken' in A.dex ? A.dex.byToken : {}),
  ]);
  const list = listOf(A.chain).filter(
    (a) =>
      keep.has(a.address) ||
      (a.standard === 'native' && A.chain === 'robinhood') ||
      (a.symbol === 'SOL' && A.chain === 'solana'),
  );
  return { A, list, out: rowsFromAnswers(list, sources, A) };
}
const sol = run(SOL);
const rh = run(RH);
const bySym = (r: typeof sol, symbol: string) => {
  const a = r.list.find((x) => x.symbol === symbol);
  if (!a) throw new Error(`no ${symbol} in the frozen list`);
  return a;
};
const rowOf = (r: typeof sol, symbol: string, metric: string): AssetObservation => {
  const a = bySym(r, symbol);
  const xs = r.out.rows.filter((x) => x.address === a.address && x.metric === metric);
  if (xs.length !== 1) throw new Error(`${symbol} ${metric}: ${xs.length} rows`);
  return xs[0] as AssetObservation;
};
/** An answer the frozen run must hold, typed as the test reads it. */
const must = <T>(x: unknown, what: string): T => {
  if (x === undefined || x === null) throw new Error(`the frozen answers hold no ${what}`);
  return x as T;
};
const u64At = (b64: string, o: number) => {
  const b = Buffer.from(b64, 'base64');
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i] as number);
  return v;
};
const mintB64 = (A: MetricAnswers, address: string) => {
  for (const c of A.mints ?? [])
    if (c.accounts[address]) return c.accounts[address]?.data as string;
  throw new Error(`no mint ${address}`);
};

describe('the rows of a run', () => {
  it('every row of the frozen list has one row per metric, and a value exactly when it has no reason', () => {
    for (const r of [sol, rh]) {
      for (const a of r.list)
        for (const m of r.A.metrics)
          expect(
            r.out.rows.filter((x) => x.address === a.address && x.metric === m).length,
            `${a.symbol} ${m}`,
          ).toBe(1);
      for (const x of r.out.rows) {
        expect(x.value === null, `${x.address} ${x.metric}`).toBe(x.nullReason !== null);
        expect(x.unit).toBe(METRIC_UNIT[x.metric]);
        expect(x.provenance).toBe('live');
        expect(x.source.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(x.observedAt))).toBe(false);
      }
    }
  });
  it('the same answers give the same rows (so a second import inserts nothing)', () => {
    const again = rowsFromAnswers(sol.list, sources, sol.A);
    expect(JSON.stringify(again.rows)).toBe(JSON.stringify(sol.out.rows));
    const key = (x: AssetObservation) =>
      `${x.chain}|${x.address}|${x.metric}|${x.source}|${x.observedAt}`;
    expect(new Set(sol.out.rows.map(key)).size).toBe(sol.out.rows.length);
    expect(new Set(rh.out.rows.map(key)).size).toBe(rh.out.rows.length);
  });
});

describe('each metric, recomputed by hand from the frozen answer', () => {
  it('supply_total on Solana: the u64 at byte 36 of the mint over 10^decimals', () => {
    for (const s of ['USDC', 'SPYx', 'PST']) {
      const a = bySym(sol, s);
      const raw = u64At(mintB64(sol.A, a.address), 36);
      const r = rowOf(sol, s, 'supply_total');
      expect(r.value).toBe(Number(raw) / 10 ** a.decimals);
      expect(r.detail.raw).toBe(raw.toString());
      expect(r.height).not.toBeNull();
    }
    // SPYx is Token-2022 with a UI multiplier, kept beside the raw supply, never applied to it
    expect(
      (rowOf(sol, 'SPYx', 'supply_total').detail.scaledUiAmount as { multiplier: number })
        .multiplier,
    ).toBeGreaterThan(0);
  });
  it('supply_total of SOL: getSupply total over 10^9', () => {
    const n = sol.A.nativeSupply as { value: { total: number } };
    expect(rowOf(sol, 'SOL', 'supply_total').value).toBe(n.value.total / 1e9);
  });
  it('supply_total on Robinhood Chain: the totalSupply() word over 10^decimals; none for the gas coin', () => {
    for (const s of ['SGOV', 'USDG', 'steakUSDG']) {
      const a = bySym(rh, s);
      const w = (rh.A.totalSupply as Record<string, { data: string }>)[a.address]?.data as string;
      expect(rowOf(rh, s, 'supply_total').value).toBe(Number(BigInt(w)) / 10 ** a.decimals);
    }
    expect(rowOf(rh, 'ETH', 'supply_total').nullReason).toBe('native_token_no_supply_call');
  });
  it("supply_issuer: Circle's amount on SOL; Tether's tokens authorised less those not issued", () => {
    const circle = must<{
      answer: { data: Array<{ symbol: string; chains: Array<{ chain: string; amount: string }> }> };
    }>(sol.A.issuer?.circle_stablecoins, 'Circle answer').answer;
    const amt = circle.data
      .find((c) => c.symbol === 'USDC')
      ?.chains.find((c) => c.chain === 'SOL')?.amount;
    expect(rowOf(sol, 'USDC', 'supply_issuer').value).toBe(Number(amt));
    const t = must<{ answer: { data: { usdt: Record<string, string> } } }>(
      sol.A.issuer?.tether_transparency,
      'Tether answer',
    ).answer.data.usdt;
    expect(rowOf(sol, 'USDT', 'supply_issuer').value).toBe(
      Number(t.totaltokens_sol) - Number(t.reserve_balance_sol),
    );
    expect(rowOf(sol, 'PST', 'supply_issuer').nullReason).toBe('no_issuer_source_in_map');
  });
  it('holders_top20_share: the RPC refused the method, so it is missing with that reason; the share by hand', () => {
    const r = rowOf(sol, 'USDC', 'holders_top20_share');
    expect(r.nullReason).toBe('rpc_method_unavailable');
    expect(rowOf(rh, 'USDG', 'holders_top20_share').nullReason).toBe('no_free_indexer');
    const a = bySym(sol, 'USDC');
    const st = {
      observedAt: r.observedAt,
      fetchedAt: r.fetchedAt,
      height: 1,
      source: 's',
      method: 'm',
    };
    const one = top20Share(
      a,
      {
        slot: 1,
        value: [
          { address: 'a', amount: '300' },
          { address: 'b', amount: '100' },
        ],
      },
      { raw: '1000', slot: 1 },
      st,
    );
    expect(one.value).toBe(0.4);
    expect(top20Share(a, { slot: 1, value: [] }, { raw: '0', slot: 1 }, st).nullReason).toBe(
      'zero_supply',
    );
  });
  it('pool_tvl_usd on Solana: the measured TVL of the registered pools holding the mint on either side', () => {
    const rp = sol.A.riskPools as {
      rows: Array<{ assetMint: string; quoteMint: string; tvlUsd: number | null }>;
      observedAt: string;
    };
    for (const s of ['SPYx', 'USDC']) {
      const a = bySym(sol, s);
      const sum = rp.rows
        .filter(
          (p) => (p.assetMint === a.address || p.quoteMint === a.address) && p.tvlUsd !== null,
        )
        .reduce((t, p) => t + (p.tvlUsd as number), 0);
      const r = rowOf(sol, s, 'pool_tvl_usd');
      expect(r.value).toBeCloseTo(sum, 6);
      expect(r.observedAt).toBe(rp.observedAt);
    }
    expect(rowOf(sol, 'PST', 'pool_tvl_usd').nullReason).toBe('no_registered_pool');
  });
  it('pool_tvl_usd on Robinhood Chain: the discovery file’s measured pools, at the file’s time', () => {
    const d = rh.A.discovery as {
      fetchedAt: string;
      byToken: Record<string, { measured: Array<{ tvlUsd: number }> }>;
    };
    for (const s of ['SGOV', 'USDG']) {
      const a = bySym(rh, s);
      const sum = (d.byToken[a.address]?.measured ?? []).reduce((t, p) => t + p.tvlUsd, 0);
      expect(rowOf(rh, s, 'pool_tvl_usd').value).toBeCloseTo(sum, 6);
      expect(rowOf(rh, s, 'pool_tvl_usd').observedAt).toBe(d.fetchedAt);
    }
    expect(rowOf(rh, 'steakUSDG', 'pool_tvl_usd').nullReason).toBe('no_registered_pool');
  });
  it("dex_volume_24h_usd: DexScreener's own 24 h volume of the token's distinct pairs, under its name", () => {
    const d = sol.A.dex as { byToken: Record<string, { pairs: DexPair[] }> };
    const a = bySym(sol, 'PST');
    const seen = new Set<string>();
    const sum = (d.byToken[a.address]?.pairs ?? [])
      .filter(
        (p) =>
          p.chainId === 'solana' &&
          (p.baseToken.address === a.address || p.quoteToken.address === a.address),
      )
      .filter((p) => !seen.has(p.pairAddress) && seen.add(p.pairAddress))
      .reduce((t, p) => t + (p.volume?.h24 ?? 0), 0);
    const r = rowOf(sol, 'PST', 'dex_volume_24h_usd');
    expect(r.value).toBeCloseTo(sum, 6);
    expect(r.source).toMatch(/DexScreener/);
    const none = sol.out.rows.find(
      (x) => x.metric === 'dex_volume_24h_usd' && x.nullReason === 'no_dexscreener_pair',
    );
    expect(none, 'a frozen token DexScreener names no pair for').toBeDefined();
  });
  it('Jupiter Lend: exchange rate, quoted supply rate (rewards apart) and the vault in dollars', () => {
    const j = sol.A.jupiterLend as {
      tokens: Array<Record<string, unknown> & { asset: Record<string, unknown> }>;
    };
    const a = bySym(sol, 'jlJUPUSD');
    const t = j.tokens.find((x) => x.address === a.address) as (typeof j.tokens)[number];
    const dec = Number(t.asset.decimals);
    expect(rowOf(sol, 'jlJUPUSD', 'exchange_rate').value).toBe(
      Number(t.convertToAssets) / 10 ** dec,
    );
    expect(rowOf(sol, 'jlJUPUSD', 'yield_quoted').value).toBe(Number(t.supplyRate) / 10_000);
    expect(rowOf(sol, 'jlJUPUSD', 'protocol_tvl_usd').value).toBe(
      (Number(t.totalAssets) / 10 ** dec) * Number(t.asset.price),
    );
    expect(rowOf(sol, 'jlJUPUSD', 'yield_realised_30d').nullReason).toBe('insufficient_history');
  });
  it("Kamino: kUSDC's rate is the reserve's supply over the cToken supply; its yield stays in yield_observations", () => {
    const r = rowOf(sol, 'kUSDC', 'exchange_rate');
    const d = r.detail as { supplied: string; collateralMintSupply: string };
    // the reserve's total supply is floored to whole units: the rate by hand agrees to the unit
    expect(r.value as number).toBeCloseTo(Number(d.supplied) / Number(d.collateralMintSupply), 9);
    expect(rowOf(sol, 'kUSDC', 'yield_quoted').nullReason).toBe('in_yield_observations');
    expect(rowOf(sol, 'kUSDC', 'yield_quoted').detail.assetId).toBe('kamino-usdc');
  });
  it('ERC-4626 and the issuer multiplier on Robinhood Chain', () => {
    const v = (
      rh.A.erc4626 as Record<
        string,
        { convertToAssets: { data: string }; assetDecimals: { data: string } }
      >
    )[bySym(rh, 'steakUSDG').address];
    expect(rowOf(rh, 'steakUSDG', 'exchange_rate').value).toBe(
      Number(BigInt(v?.convertToAssets.data as string)) /
        10 ** Number(BigInt(v?.assetDecimals.data as string)),
    );
    const m = (rh.A.registry as { byAddress: Record<string, { currentMultiplier: string }> })
      .byAddress[bySym(rh, 'SGOV').address];
    expect(rowOf(rh, 'SGOV', 'exchange_rate').value).toBe(Number(m?.currentMultiplier));
    expect(rowOf(rh, 'SGOV', 'yield_realised_30d').nullReason).toBe('in_yield_observations');
    expect(rowOf(rh, 'USDG', 'exchange_rate').nullReason).toBe('not_an_exchange_rate_token');
  });
  it("DefiLlama's yield pool: the newest point's total rate over 100 and its TVL", () => {
    const e = sources.defillamaYieldPools.find((p) => p.symbol === 'wYLDS');
    const pts = must<{ points: Array<{ apy: number; tvlUsd: number; timestamp: string }> }>(
      sol.A.llamaPools?.[e?.pool as string],
      'wYLDS pool',
    ).points;
    const last = pts.at(-1) as (typeof pts)[number];
    expect(rowOf(sol, 'wYLDS', 'yield_quoted').value).toBe(last.apy / 100);
    expect(rowOf(sol, 'wYLDS', 'protocol_tvl_usd').value).toBe(last.tvlUsd);
    expect(rowOf(sol, 'wYLDS', 'yield_quoted').observedAt).toBe(
      new Date(last.timestamp).toISOString(),
    );
    // wYLDS pays by a way its price does not show: no realised rate is made from its price
    expect(rowOf(sol, 'wYLDS', 'yield_realised_30d').nullReason).toBe(
      'no_realised_method_for_its_mechanism',
    );
  });
  it('yield_realised_30d from the price path: (last / first)^(365 / days) - 1 over 31 daily points', () => {
    const c = sol.A.llamaCharts?.[`solana:${bySym(sol, 'PST').address}`] as {
      prices: Array<{ timestamp: number; price: number }>;
    };
    const f = c.prices[0] as { timestamp: number; price: number };
    const l = c.prices.at(-1) as { timestamp: number; price: number };
    const days = (l.timestamp - f.timestamp) / 86400;
    expect(rowOf(sol, 'PST', 'yield_realised_30d').value).toBe(
      (l.price / f.price) ** (365 / days) - 1,
    );
    expect(rowOf(sol, 'USDY', 'yield_realised_30d').nullReason).toBe('in_yield_observations');
  });
  it('yield_realised_30d from this table’s own exchange-rate series, once it reaches 30 days back', () => {
    const a = bySym(sol, 'jlJUPUSD');
    const st = {
      observedAt: '2026-11-11T00:00:00.000Z',
      fetchedAt: '2026-11-11T00:00:00.000Z',
      height: null,
      source: 's',
      method: 'm',
    };
    const short = realisedFromSeries(a, [{ observedAt: '2026-10-20T00:00:00.000Z', value: 1 }], st);
    expect(short.nullReason).toBe('insufficient_history');
    const r = realisedFromSeries(
      a,
      [
        { observedAt: '2026-10-11T00:00:00.000Z', value: 1 },
        { observedAt: '2026-11-10T00:00:00.000Z', value: 1.0025 },
      ],
      st,
    );
    expect(r.value).toBeCloseTo(1.0025 ** (365 / 30) - 1, 12);
  });
  it('the plan says why a metric has no read, for every row', () => {
    for (const r of [sol, rh])
      for (const a of r.list) {
        const p = metricPlan(a, { sources });
        expect(Object.keys(p).sort()).toEqual([...ASSET_METRICS].sort());
      }
    const spyx = metricPlan(bySym(sol, 'SPYx'), { sources });
    expect(spyx.protocol_tvl_usd).toEqual({ reason: 'not_a_dollar_yield_token' });
    expect(spyx.exchange_rate).toEqual({ reason: 'not_an_exchange_rate_token' });
  });
  it('the discovery extract sorts each token’s pools to their sides, measured ones in full', () => {
    const x = discoveryExtract(
      [
        {
          id: 'p1',
          venue: 'v3',
          token: '0xAA',
          other: '0xbb',
          tvlUsd: 10,
          tvlReason: null,
          reachable: true,
        },
        {
          id: 'p2',
          venue: 'v4',
          token: '0xaa',
          other: '0xcc',
          tvlUsd: null,
          tvlReason: 'token_not_priced',
          reachable: false,
        },
      ],
      ['0xaa', '0xBB'],
    );
    expect(x['0xaa']).toEqual({
      measured: [{ id: 'p1', venue: 'v3', side: 'token', reachable: true, tvlUsd: 10 }],
      unmeasured: 1,
      unmeasuredBy: { token_not_priced: 1 },
    });
    expect(x['0xbb']?.measured[0]?.side).toBe('other');
  });
});

describe('the import writes nothing on a dry run, and nothing twice', () => {
  it('a dry run makes no call on the database', async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the database was touched');
        },
      },
    );
    const w = await writeRun(db as never, sol.out.rows, sol.out.prices, { dryRun: true });
    expect(w).toEqual({
      dryRun: true,
      observations: { asked: sol.out.rows.length, inserted: 0 },
      prices: { asked: sol.out.prices.length, inserted: 0 },
    });
  });
  it('a supply equal to the newest stored one and less than a day after it is not written again', () => {
    const supply = sol.out.rows.filter((r) => r.metric === 'supply_total');
    const latest = new Map(
      supply.map((r) => [
        `${r.address}|${r.metric}`,
        { value: r.value, nullReason: r.nullReason, observedAt: r.observedAt, source: r.source },
      ]),
    );
    expect(changedOnly(supply, latest)).toEqual({ keep: [], unchanged: supply.length });
    const moved = new Map([...latest].map(([k, v]) => [k, { ...v, value: (v.value ?? 0) + 1 }]));
    expect(changedOnly(supply, moved).keep.length).toBe(supply.length);
  });
});

describe('prices: under their own source, never at par, refused when the decimals differ', () => {
  it('each aggregator price is its own observation', () => {
    const usdc = bySym(sol, 'USDC');
    const ps = sol.out.prices.filter((p) => p.mint === usdc.address);
    expect(new Set(ps.map((p) => p.priceSource))).toEqual(
      new Set(['external:defillama', 'external:jupiter']),
    );
    for (const p of ps) {
      const raw =
        p.priceSource === 'external:defillama'
          ? must<{ coins: Record<string, { price: number }> }>(
              sol.A.prices?.defillama,
              'DefiLlama prices',
            ).coins[`solana:${usdc.address}`]?.price
          : must<{ answers: Record<string, { usdPrice: number }> }>(
              sol.A.prices?.jupiter,
              'Jupiter prices',
            ).answers[usdc.address]?.usdPrice;
      expect(p.price).toBe(raw);
      expect(p.quote).toBe('usd');
    }
  });
  it('a price at other decimals than the chain answers is refused, never rescaled', () => {
    const a = { chain: 'solana', address: 'x', decimals: 6 } as const;
    const read = { fetchedAt: '2026-10-11T00:00:00.000Z', url: 'u' };
    expect(defillamaPrice(a, { price: 2, timestamp: 1, decimals: 8 }, read)).toMatchObject({
      reason: 'decimals_differ_from_chain',
    });
    expect(isPrice(jupiterPrice(a, { usdPrice: 2, decimals: 6 }, read))).toBe(true);
    expect(defillamaPrice(a, undefined, read)).toMatchObject({ reason: 'not_priced_by_source' });
  });
});

describe("the installed price job's rows for the assets it values do not change (frozen window)", () => {
  const W = JSON.parse(gunzipSync(readFileSync(WINDOW)).toString('utf8')) as {
    now: number;
    refreshSec: number;
    calendar: { closed: string[]; earlyClose13ET: string[] };
    parMints: string[];
    continuousMints: string[];
    usdStableMints: string[];
    resolved: string[];
    jobNewestT: number;
    observations: PriceObservation[];
    prices: ExternalPrice[];
  };
  const job = (obs: PriceObservation[]) =>
    priceJobReferences({
      observations: obs,
      calendar: W.calendar,
      parMints: W.parMints,
      continuousMints: W.continuousMints,
      usdStableMints: W.usdStableMints,
      now: W.now,
      refreshSec: W.refreshSec,
      wallNow: W.now,
    });
  const before = job(W.observations);
  const filtered = (mode: 'none' | 'unresolved' | 'all') =>
    pricesToWrite(W.prices, { mode, resolved: new Set(W.resolved), jobNewestT: W.jobNewestT });

  it('the window resolves the frozen assets', () => {
    expect(before.rows.length).toBeGreaterThan(0);
    expect(W.prices.some((p) => W.resolved.includes(p.mint))).toBe(true);
    expect(W.prices.some((p) => !W.resolved.includes(p.mint))).toBe(true);
  });
  it('none: nothing is added', () => {
    expect(filtered('none').write).toEqual([]);
  });
  it('unresolved: every row of an asset it values is the same, byte for byte, and its last hour too', () => {
    const f = filtered('unresolved');
    expect(f.write.length).toBeGreaterThan(0);
    expect(f.write.every((p) => !W.resolved.includes(p.mint))).toBe(true);
    const after = job([...W.observations, ...f.write]);
    const c = compareJobRows(before.rows, after.rows);
    expect(after.lastHour).toBe(before.lastHour);
    expect(c.changed).toBe(0);
    expect(c.removed).toBe(0);
    expect(c.added.existingAsset).toBe(0);
    expect(c.identical).toBe(before.rows.length);
  });
  it('all: the assets it values change (their `others`), which is why it is never the default', () => {
    const after = job([...W.observations, ...filtered('all').write]);
    expect(compareJobRows(before.rows, after.rows).changed).toBeGreaterThan(0);
  });
  it('a price later, by the hour, than the newest observation the job holds is held back', () => {
    const late = {
      ...(W.prices.find((p) => !W.resolved.includes(p.mint)) as ExternalPrice),
      t: W.jobNewestT + 7200,
    };
    expect(
      pricesToWrite([late], {
        mode: 'unresolved',
        resolved: new Set(W.resolved),
        jobNewestT: W.jobNewestT,
      }).held,
    ).toEqual({
      later_than_the_price_jobs_newest_hour: 1,
    });
  });
});

describe('what the review asked for', () => {
  it('an unknown Solana price mode writes nothing', () => {
    const p = { chain: 'solana', mint: 'x', t: 1 } as unknown as ExternalPrice;
    const out = pricesToWrite([p], { mode: 'off' as never, resolved: new Set(), jobNewestT: 3600 });
    expect(out).toEqual({ write: [], held: { unknown_price_mode: 1 } });
  });
});

describe('a chain part refused every time', () => {
  it('leaves its rows missing with the reason, and the rest of the run as it is', () => {
    const { block: _b, totalSupply: _t, erc4626: _e, ...rest } = rh.A;
    const A = {
      ...rest,
      chainError: { error: 'RPC unreachable after 3 tries (HTTP 429)', fetchedAt: rh.A.startedAt },
    };
    const out = rowsFromAnswers(rh.list, sources, A as MetricAnswers);
    const supply = out.rows.filter(
      (r) => r.metric === 'supply_total' && r.method === 'erc20_totalSupply',
    );
    expect(supply.length).toBe(rh.list.filter((a) => a.standard !== 'native').length);
    expect(supply.every((r) => r.nullReason === 'read_failed')).toBe(true);
    expect(out.rows.filter((r) => r.metric === 'pool_tvl_usd').length).toBe(rh.list.length);
  });
});
