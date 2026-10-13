// PLAN-ASSETS AS.13: the readers of the backfill's swap files (AS.8) for `pnpm risk:assets-bars <chain> --source
// backfill`. They give the same pool bars as bars-read.ts (the same `@colosseum/risk` bar, the same `bars-0.1`),
// from the files under ASSETS_DATA_DIR, and read a day file only when the fetch's own records hold its UTC day
// whole (`wholeDaysOfSeconds`, `wholeDaysOfBlocks`): a day still being written is never opened.
//
//   Solana     <dir>/solana/swaps/<pool>/<day>.jsonl.gz and manifest.json; the pools and which side is the asset
//              from the shelf's registry (--registry). A token's day is built only when every registry pool of
//              the token holds the day whole, so its 'asset' row has all its pools and a re-run never finds a
//              day half built. Quote in dollars: USDC at par, else implied from the asset's USDC pool in the
//              hour (`solanaQuoteUsd`), else none.
//   Robinhood  <dir>/robinhood/swaps/<pool>/<day>.jsonl.gz, fetched.json (the blocks asked per filter and
//              scope) and every subject's manifest (which day each of its pieces fell on); the pools' tokens from
//              RU.2's creation logs (RISK_EVM_DIR, read-only), the shelf from the scope's count file, decimals
//              from the asset list. Quote in dollars: hourlyRows of scripts/risk-evm/history.ts over the day
//              (USDG at par, another token at its own USDG pool's price, ETH and WETH at the chain's median).
//
// Each day is built from that day's files alone (a price is carried only inside the day), so a day's bars do
// not depend on which other days were read: the import writes them once and a later run adds new days only.
// Read-only: no RPC, no database, no write.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  addBarSwap,
  type BarHour,
  type BarSwap,
  fileEvmPool,
  type HourVwaps,
  hourOf,
  intersectRanges,
  type Manifest,
  mergeRanges,
  newPoolBars,
  type PoolBar,
  poolBars,
  type QuoteRank,
  type Regime,
  solanaQuoteUsd,
  USDC_MINT,
  wholeDaysOfBlocks,
  wholeDaysOfSeconds,
} from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import type { LogRow } from '../../risk-evm/backfill-logs';
import { CHAINS, type ChainConfig } from '../../risk-evm/config';
import { ZERO_ADDRESS } from '../../risk-evm/discovery';
import {
  accumulateHour,
  decodeV3Swap,
  decodeV4Swap,
  type HistoryPool,
  hourIso,
  hourlyRows,
  newHourAccumulator,
  type PoolDecimals,
  poolDecimals,
  type SwapRow,
} from '../../risk-evm/history';
import { evmBarSwap, LAYER, type PoolBars, type SolanaPoolMeta, solanaBarSwaps } from './bars-read';

type Provenance = 'live' | 'prior_dataset';
/** Pool bars that also name, per hour, the day file the bar came from. */
export type BackfillPoolBars = PoolBars & { sourceOf: (hour: string) => string };
export type BackfillRead = { pools: BackfillPoolBars[]; summary: Record<string, unknown> };

const readJson = <T>(f: string): T | null => {
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    // a manifest being rewritten at this moment: not used
    return null;
  }
};
/** The lines of a gzip day file (one gzip member per piece the fetch appended). */
export function* gzLines(file: string): Generator<string> {
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf('\n', i);
    const end = j < 0 ? text.length : j;
    if (end > i) yield text.slice(i, end);
    i = end + 1;
  }
}
const hoursOfDay = (day: string) => {
  const s = Date.parse(`${day}T00:00:00Z`) / 1000;
  return Array.from({ length: 24 }, (_, k) => s + k * 3600);
};

// ---------------------------------------------------------------------------------------------------------------
// Solana

export type SolanaRegistryPool = SolanaPoolMeta & {
  venue: string;
  quoteSymbol: string | null;
  tvlUsd: number;
};
type SolRow = {
  s: string;
  q: number;
  sl: number;
  t: number;
  ev: Parameters<typeof solanaBarSwaps>[0]['ev'];
};

export function solanaRegistryPools(file: string): SolanaRegistryPool[] {
  const j = JSON.parse(readFileSync(file, 'utf8')) as {
    pools: Array<{
      address: string;
      venue: string;
      assetMint: string;
      assetSymbol: string;
      quoteMint: string;
      quoteSymbol: string | null;
      assetIsToken0: number | boolean;
      decimals0: number;
      decimals1: number;
      tvlUsd: number;
    }>;
  };
  return j.pools.map((p) => ({
    address: p.address,
    venue: p.venue,
    assetMint: p.assetMint,
    assetSymbol: p.assetSymbol,
    quoteMint: p.quoteMint,
    quoteSymbol: p.quoteSymbol,
    assetIsToken0: p.assetIsToken0 === 1 || p.assetIsToken0 === true,
    decimals0: p.decimals0,
    decimals1: p.decimals1,
    tvlUsd: p.tvlUsd,
  }));
}

/** The whole days a Solana subject's manifest holds; none without a manifest. */
export function solanaWholeDays(dataDir: string, pool: string): string[] {
  const m = readJson<Manifest>(join(dataDir, 'solana', 'swaps', pool, 'manifest.json'));
  return m ? wholeDaysOfSeconds(m.covered.filter((w) => w.unit === 'second')) : [];
}

export function readSolanaBackfill(inp: {
  dataDir: string;
  registry: SolanaRegistryPool[];
  registryFile: string;
  regimeOfT: (t: number) => Regime;
}): BackfillRead {
  const dir = join(inp.dataDir, 'solana', 'swaps');
  const byToken = new Map<string, SolanaRegistryPool[]>();
  for (const p of inp.registry) byToken.set(p.assetMint, [...(byToken.get(p.assetMint) ?? []), p]);
  const whole = new Map(
    inp.registry.map((p) => [p.address, new Set(solanaWholeDays(inp.dataDir, p.address))]),
  );
  const regimeOf = (hour: string) => inp.regimeOfT(Date.parse(hour) / 1000);
  const out = new Map<string, BackfillPoolBars & { bars: PoolBar[] }>();
  const dayFile = new Map<string, string>();
  const mtime = new Map<string, Date>();
  const perToken: Array<Record<string, unknown>> = [];
  let poolDaysWhole = 0;
  let poolDaysBuilt = 0;
  let swaps = 0;
  let duplicates = 0;
  for (const [, pools] of [...byToken].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // the token's days: those every one of its registry pools holds whole
    const sets = pools.map((p) => whole.get(p.address) as Set<string>);
    for (const s of sets) poolDaysWhole += s.size;
    const days = [...(sets[0] ?? new Set<string>())]
      .filter((d) => sets.every((s) => s.has(d)))
      .sort();
    const usdcOrder = pools
      .filter((p) => p.quoteMint === USDC_MINT)
      .sort((a, b) => b.tvlUsd - a.tvlUsd || (a.address < b.address ? -1 : 1));
    let tokenSwaps = 0;
    for (const day of days) {
      // the day's swaps of every pool of the token, and each pool's VWAP per hour
      const swapsOf = new Map<string, BarSwap[]>();
      const vwapOf = new Map<string, HourVwaps>();
      for (const p of pools) {
        const f = join(dir, p.address, `${day}.jsonl.gz`);
        const list: BarSwap[] = [];
        if (existsSync(f)) {
          dayFile.set(`${p.address}|${day}`, f);
          mtime.set(`${p.address}|${day}`, statSync(f).mtime);
          const seen = new Set<string>();
          for (const l of gzLines(f)) {
            if (!l.includes('"kind":"swap"')) continue;
            const row = JSON.parse(l) as SolRow;
            if (seen.has(row.s)) {
              duplicates++;
              continue;
            }
            seen.add(row.s);
            list.push(...solanaBarSwaps(row, p));
          }
        }
        swapsOf.set(p.address, list);
        const q = new Map<string, [number, number]>();
        for (const s of list) {
          if (s.quote === null || !(s.tokens > 0) || !(s.quote > 0)) continue;
          const h = hourOf(s.t);
          const a = q.get(h) ?? [0, 0];
          a[0] += s.quote;
          a[1] += s.tokens;
          q.set(h, a);
        }
        vwapOf.set(p.address, new Map([...q].map(([h, [qq, tt]]) => [h, qq / tt])));
      }
      const usdcPools = usdcOrder.map((p) => ({
        pool: p.address,
        vwap: vwapOf.get(p.address) as HourVwaps,
      }));
      for (const p of pools) {
        const list = swapsOf.get(p.address) as BarSwap[];
        poolDaysBuilt++;
        if (!list.length) continue;
        const own = new Map<string, number>();
        for (const h of new Set(list.map((s) => hourOf(s.t))))
          own.set(h, vwapOf.get(p.address)?.get(h) ?? Number.NaN);
        const hours = solanaQuoteUsd({ quoteMint: p.quoteMint, own, usdcPools, regimeOf });
        const acc = newPoolBars();
        for (const s of list) addBarSwap(acc, s, hours.get(hourOf(s.t)), inp.regimeOfT);
        swaps += list.length;
        tokenSwaps += list.length;
        const have = out.get(p.address);
        const bars = poolBars(acc, LAYER);
        if (have) have.bars.push(...bars);
        else
          out.set(p.address, {
            pool: p.address,
            address: p.assetMint,
            symbol: p.assetSymbol,
            quoteAddress: p.quoteMint,
            bars,
            source: '',
            sourceOf: (hour) =>
              `<ASSETS_DATA_DIR>/solana/swaps/${p.address}/${hour.slice(0, 10)}.jsonl.gz (backfill-0.1: Solana RPC getSignaturesForAddress and getTransaction, decoded by @colosseum/risk's ${p.venue} decoder; the day held whole by its manifest) with the pools of ${inp.registryFile.split('/').at(-1)}; quote in dollars: USDC at par, else implied from the asset's USDC pool in the hour (VWAP over VWAP, carried at most 24 h inside the day)`,
            fetchedAtOf: (hour) => mtime.get(`${p.address}|${hour.slice(0, 10)}`) as Date,
            provenanceOf: (): Provenance => 'live',
          });
      }
    }
    perToken.push({
      symbol: pools[0]?.assetSymbol,
      pools: pools.length,
      poolsWithFolder: pools.filter((p) => existsSync(join(dir, p.address))).length,
      daysBuilt: days.length,
      first: days[0] ?? null,
      last: days.at(-1) ?? null,
      swaps: tokenSwaps,
      usdcPools: usdcOrder.length,
    });
  }
  for (const p of out.values()) p.bars.sort((a, b) => a.hour.localeCompare(b.hour));
  return {
    pools: [...out.values()],
    summary: {
      dir,
      registry: inp.registryFile,
      registryPools: inp.registry.length,
      poolsWithFolder: inp.registry.filter((p) => existsSync(join(dir, p.address))).length,
      registryTokens: byToken.size,
      tokensWithADay: perToken.filter((t) => (t.daysBuilt as number) > 0).length,
      poolDaysWhole,
      poolDaysBuilt,
      poolDaysWholeButTokenIncomplete: poolDaysWhole - poolDaysBuilt,
      swaps,
      duplicates,
      perToken: perToken.filter(
        (t) => (t.daysBuilt as number) > 0 || (t.poolsWithFolder as number) > 0,
      ),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Robinhood Chain

type Created = { kind: 'cl' | 'v4'; id: string; token0: string; token1: string };
type Range = { from: number; to: number };

/** The blocks both swap filters were fetched over, for the list (`*`) and the given scope. */
export function swapCoverage(
  fetched: { covered: Record<string, Range[]> },
  scope: string,
): Range[] {
  const of = (f: string) =>
    mergeRanges([
      ...(fetched.covered[`${f}:*`] ?? []),
      ...(fetched.covered[`${f}:${scope}`] ?? []),
    ]);
  return intersectRanges(of('v3_swap'), of('v4_swap'));
}

/** Every subject manifest of the Robinhood Chain logs (swaps, supply, liquidity): pieces and days. */
export function robinhoodManifests(root: string): Array<{ covered: Range[]; days: string[] }> {
  const out: Array<{ covered: Range[]; days: string[] }> = [];
  for (const kind of ['swaps', 'supply', 'liquidity']) {
    const d = join(root, kind);
    if (!existsSync(d)) continue;
    for (const s of readdirSync(d)) {
      const m = readJson<Manifest>(join(d, s, 'manifest.json'));
      if (!m) continue;
      out.push({
        covered: m.covered.filter((w) => w.unit === 'block'),
        days: Object.keys(m.days),
      });
    }
  }
  return out;
}

/** A backfill log row of a swap as the walk's SwapRow (the same decoders). */
export function swapRowOf(r: LogRow): SwapRow {
  const log = {
    address: r.address,
    topics: r.topics,
    data: r.data,
    blockNumber: `0x${r.block.toString(16)}`,
    transactionHash: r.tx,
    logIndex: `0x${r.logIndex.toString(16)}`,
  };
  return r.filter === 'v4_swap' ? decodeV4Swap(log, r.t) : decodeV3Swap(log, r.t);
}

export type RobinhoodTokens = {
  decimals: Map<string, number>;
  symbol: Map<string, string>;
  rank: (address: string) => QuoteRank;
  wrapped: string | null;
};

/** Decimals, symbols and quote ranks from the asset list. */
export function robinhoodTokens(list: AssetList, chain: ChainConfig): RobinhoodTokens {
  const decimals = new Map<string, number>();
  const symbol = new Map<string, string>();
  const cat = new Map<string, string>();
  let wrapped: string | null = null;
  for (const a of list.assets as Array<{
    address: string;
    decimals: number;
    symbol: string;
    category?: string;
  }>) {
    const k = a.address.toLowerCase();
    decimals.set(k, a.decimals);
    symbol.set(k, a.symbol);
    cat.set(k, a.category ?? '');
    if (a.category === 'wrapped_eth' && a.symbol === 'WETH') wrapped = k;
  }
  const dollar = chain.dollar.address.toLowerCase();
  const rank = (address: string): QuoteRank => {
    const a = address.toLowerCase();
    if (a === dollar) return 0;
    if ((cat.get(a) ?? '').startsWith('stablecoin')) return 1;
    if (a === ZERO_ADDRESS || a === wrapped) return 2;
    return 3;
  };
  return { decimals, symbol, rank, wrapped };
}

export function readRobinhoodBackfill(inp: {
  dataDir: string;
  creation: Created[];
  list: AssetList;
  shelf: string[];
  scope: string;
  regimeOfT: (t: number) => Regime;
}): BackfillRead {
  const chain = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
  const root = join(inp.dataDir, 'robinhood');
  const fetched = readJson<{ covered: Record<string, Range[]> }>(join(root, 'fetched.json')) ?? {
    covered: {},
  };
  const covered = swapCoverage(fetched, inp.scope);
  const days = wholeDaysOfBlocks(covered, robinhoodManifests(root));
  const tokens = robinhoodTokens(inp.list, chain);
  const shelf = new Set(inp.shelf.map((a) => a.toLowerCase()));
  const created = new Map(inp.creation.map((c) => [c.id.toLowerCase(), c]));
  const swapsDir = join(root, 'swaps');
  const subjects = existsSync(swapsDir) ? readdirSync(swapsDir).sort() : [];
  const dollar = chain.dollar.address.toLowerCase();
  const out = new Map<string, BackfillPoolBars & { bars: PoolBar[] }>();
  const mtime = new Map<string, Date>();
  const perDay: Array<Record<string, unknown>> = [];
  const filed = new Map<string, ReturnType<typeof fileEvmPool>>();
  for (const s of subjects) {
    const c = created.get(s);
    if (!c) continue;
    filed.set(
      s,
      fileEvmPool(c.token0, c.token1, tokens.rank, (a) => shelf.has(a)),
    );
  }
  for (const day of days) {
    const files = subjects
      .map((s) => ({ s, f: join(swapsDir, s, `${day}.jsonl.gz`) }))
      .filter((x) => existsSync(x.f));
    const stat = {
      files: files.length,
      swaps: 0,
      unresolvedPools: 0,
      unresolvedSwaps: 0,
      notShelfPools: 0,
      notShelfSwaps: 0,
      duplicates: 0,
    };
    // first pass: the pools filed, their swap counts, and each hour's last swap for hourlyRows
    const pools: Array<HistoryPool & { n: number; file: string }> = [];
    const acc = newHourAccumulator();
    const rowsOf = (f: string) => {
      const seen = new Set<number>();
      const list: SwapRow[] = [];
      for (const l of gzLines(f)) {
        const r = JSON.parse(l) as LogRow;
        if (r.kind !== 'swaps') continue;
        const k = r.block * 1_000_000 + r.logIndex;
        if (seen.has(k)) {
          stat.duplicates++;
          continue;
        }
        seen.add(k);
        list.push(swapRowOf(r));
      }
      return list;
    };
    for (const { s, f } of files) {
      const fp = filed.get(s);
      if (!fp || 'reason' in fp) {
        const n = rowsOf(f).length;
        if (!fp) {
          stat.unresolvedPools++;
          stat.unresolvedSwaps += n;
        } else {
          stat.notShelfPools++;
          stat.notShelfSwaps += n;
        }
        continue;
      }
      const c = created.get(s) as Created;
      const rows = rowsOf(f);
      for (const r of rows) accumulateHour(acc, r);
      mtime.set(`${s}|${day}`, statSync(f).mtime);
      pools.push({
        address: s,
        kind: c.kind,
        asset: fp.asset,
        symbol: tokens.symbol.get(fp.asset) ?? fp.asset,
        venue: c.kind === 'v4' ? 'uniswap-v4' : 'uniswap-v3',
        other: fp.quote,
        otherSymbol:
          fp.quote === ZERO_ADDRESS
            ? 'native'
            : fp.quote === tokens.wrapped
              ? 'wrapped native'
              : (tokens.symbol.get(fp.quote) ?? null),
        otherIsStock: false,
        tvlUsd: null,
        reachable: true,
        assetIsToken0: fp.assetIsToken0,
        n: rows.length,
        file: f,
      });
    }
    // the asset's USDG pool is its pool with the most swaps that day (dollarPoolOf keeps the first of equal TVL)
    pools.sort((a, b) => b.n - a.n || (a.address < b.address ? -1 : 1));
    const withDollarPool = new Set(pools.filter((p) => p.other === dollar).map((p) => p.asset));
    for (const p of pools)
      p.otherIsStock =
        p.other !== dollar &&
        p.otherSymbol !== 'native' &&
        p.otherSymbol !== 'wrapped native' &&
        withDollarPool.has(p.other);
    const decimals = new Map<string, PoolDecimals>();
    for (const p of pools) {
      const d = poolDecimals(p, chain, (a) => tokens.decimals.get(a.toLowerCase()));
      if (d) decimals.set(p.address, d);
    }
    const hourly = hourlyRows({ pools, decimals, swaps: acc, hours: hoursOfDay(day), dollar });
    const byPool = new Map<string, Map<string, BarHour>>();
    for (const h of hourly) {
      let m = byPool.get(h.pool);
      if (!m) {
        m = new Map();
        byPool.set(h.pool, m);
      }
      m.set(h.hour, {
        regime: inp.regimeOfT(Date.parse(h.hour) / 1000),
        quoteUsd: h.quoteUsd,
        method: h.quoteUsdMethod,
      });
    }
    // second pass: the bars, as bars-read.ts builds them
    for (const p of pools) {
      const d = decimals.get(p.address) ?? null;
      const assetDecimals = tokens.decimals.get(p.asset) as number;
      const hs = byPool.get(p.address) ?? new Map<string, BarHour>();
      const bars = newPoolBars();
      for (const s of rowsOf(p.file)) {
        stat.swaps++;
        const b = evmBarSwap(s, p, d, assetDecimals);
        addBarSwap(
          bars,
          b,
          d ? hs.get(hourIso(s.t)) : undefined,
          inp.regimeOfT,
          d !== null && b.side !== null,
        );
      }
      const pb = poolBars(bars, LAYER);
      const have = out.get(p.address);
      if (have) have.bars.push(...pb);
      else {
        const pool = p.address;
        const venue = p.venue;
        out.set(pool, {
          pool,
          address: p.asset,
          symbol: p.symbol,
          quoteAddress: p.other,
          bars: pb,
          source: '',
          sourceOf: (hour) =>
            `<ASSETS_DATA_DIR>/robinhood/swaps/${pool}/${hour.slice(0, 10)}.jsonl.gz (backfill-0.1: Swap events of ${venue} by eth_getLogs on ${chain.name}; the day held whole by fetched.json and the subjects' manifests) priced by hourlyRows of scripts/risk-evm/history.ts over that day (USDG at par; another token at its own USDG pool's price; ETH and WETH at the chain's median)`,
          fetchedAtOf: (hour) => mtime.get(`${pool}|${hour.slice(0, 10)}`) as Date,
          provenanceOf: (): Provenance => 'live',
        });
      }
    }
    perDay.push({ day, poolsFiled: pools.length, ...stat });
  }
  for (const p of out.values()) p.bars.sort((a, b) => a.hour.localeCompare(b.hour));
  const presentDays = new Set<string>();
  for (const s of subjects)
    for (const f of readdirSync(join(swapsDir, s)))
      if (f.endsWith('.jsonl.gz')) presentDays.add(f.slice(0, 10));
  return {
    pools: [...out.values()],
    summary: {
      root,
      scope: inp.scope,
      shelfTokens: shelf.size,
      covered,
      wholeDays: days,
      daysSkippedNotWhole: [...presentDays].filter((d) => !days.includes(d)).sort(),
      subjects: subjects.length,
      subjectsNotInCreationLogs: subjects.filter((s) => !created.has(s)).length,
      swaps: perDay.reduce((a, d) => a + (d.swaps as number), 0),
      perDay,
    },
  };
}
