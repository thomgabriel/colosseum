// PLAN-ASSETS AS.7: the readers of the swap history both chains already hold, for `pnpm risk:assets-bars`.
// Each turns the held event files into pool bars (`@colosseum/risk`'s poolBars) with the quote put in dollars
// by exactly the method risk_pool_flow used on that chain:
//   Solana     Step 5b's files (data/risk/history-full): the day files with a `.done` marker, swaps of
//              successful transactions, each hour priced by the pool's hourly reconstruction
//              (hourly/<pool>.jsonl, history-replay-0.1: USDC at par, D20; other quotes implied from the
//              asset's USDC pool), as scripts/risk/facts/import-flow.ts does.
//   Robinhood  RU.14's walk (<RISK_EVM_DIR>/history/robinhood/swaps): every day file, a swap seen twice
//              counted once, each hour priced by scripts/risk-evm/history.ts hourlyRows over the whole walk
//              (USDG at par, as RU.14's method states; another stock at its own dollar pool's price; the
//              native token at the chain's median), as scripts/risk-evm/flow-import.ts does.
// Read-only: no RPC, no write. The database is read for Solana's pool metadata (risk_pools), as the flow
// import reads it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, riskPools } from '@colosseum/db';
import {
  addBarSwap,
  type BarHour,
  type BarSwap,
  defaultRegimeParams,
  hourOf,
  newPoolBars,
  type PoolBar,
  type PoolEvent,
  poolBars,
  type Regime,
  regimeAt,
} from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { inArray } from 'drizzle-orm';
import { CHAINS, type ChainConfig } from '../../risk-evm/config';
import type { CutRow } from '../../risk-evm/cut';
import {
  accumulateHour,
  type HistoryPool,
  historyPools,
  hourIso,
  hourlyRows,
  hoursOf,
  newHourAccumulator,
  type PoolDecimals,
  poolDecimals,
  type SwapRow,
  swapSides,
} from '../../risk-evm/history';
import type { Cursor } from '../../risk-evm/history-run';

export const LAYER = 'raw_events';
/** Solana orders a token's pools by slot only (each pool's walk orders inside a slot); Robinhood Chain by block and log index. */
export const CROSS_POOL_ORDER = { solana: 'slot', robinhood: 'place' } as const;
type Provenance = 'live' | 'prior_dataset';

/** One pool's bars and what each row says of where it came from. */
export type PoolBars = {
  pool: string;
  /** The token the pool is filed under (the asset of risk_pool_flow), as the universe list writes it. */
  address: string;
  symbol: string;
  quoteAddress: string;
  bars: PoolBar[];
  source: string;
  fetchedAtOf: (hour: string) => Date;
  provenanceOf: (hour: string) => Provenance;
};
export type ReadSummary = Record<string, unknown>;

const P = () =>
  defaultRegimeParams(JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')));

/** Every line of a file, without holding an array of them. */
export function* lines(file: string): Generator<string> {
  const text = readFileSync(file, 'utf8');
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf('\n', i);
    const end = j < 0 ? text.length : j;
    if (end > i) yield text.slice(i, end);
    i = end + 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Solana

export type SolanaPoolMeta = {
  address: string;
  assetMint: string;
  assetSymbol: string;
  quoteMint: string;
  assetIsToken0: boolean;
  decimals0: number;
  decimals1: number;
};
type SolRow = { s: string; q: number; sl: number; t: number; ev: PoolEvent[] | null };

/** The pool's swaps in one decoded transaction row of Step 5b, as bar swaps (other pools' events are skipped). */
export function solanaBarSwaps(row: SolRow, m: SolanaPoolMeta): BarSwap[] {
  const out: BarSwap[] = [];
  for (const e of row.ev ?? []) {
    if (e.kind !== 'swap' || e.pool !== m.address) continue;
    const sell = m.assetIsToken0 === e.zeroForOne;
    const [a, q, da, dq] = m.assetIsToken0
      ? [e.amount0, e.amount1, m.decimals0, m.decimals1]
      : [e.amount1, e.amount0, m.decimals1, m.decimals0];
    out.push({
      t: row.t,
      // the walk numbers a pool's signatures newest first: a larger `q` is earlier inside its slot
      at: [row.sl, -row.q, e.ixIndex],
      side: sell ? 'sell' : 'buy',
      tokens: Number(a) / 10 ** da,
      quote: Number(q) / 10 ** dq,
      minRaw: Math.min(Number(a), Number(q)),
    });
  }
  return out;
}

type SolHourly = {
  hour: string;
  regime: Regime;
  quoteUsd: unknown;
  quoteUsdMethod?: string | null;
  provenance?: string;
};

/**
 * One pool of Step 5b: its hourly prices, then its done days, line by line. `until` (unix seconds): only the
 * transactions at or before it, for the check's look at what an earlier import could have read.
 */
export function solanaPoolBars(
  dir: string,
  m: SolanaPoolMeta,
  regimeOfT: (t: number) => Regime,
  until = Number.POSITIVE_INFINITY,
) {
  const events = join(dir, 'events', m.address);
  const hourly = new Map<string, BarHour & { provenance: Provenance }>();
  const hf = join(dir, 'hourly', `${m.address}.jsonl`);
  if (existsSync(hf))
    for (const l of lines(hf)) {
      const h = JSON.parse(l) as SolHourly;
      hourly.set(h.hour, {
        regime: h.regime,
        quoteUsd: typeof h.quoteUsd === 'number' ? h.quoteUsd : null,
        method: typeof h.quoteUsd === 'number' ? (h.quoteUsdMethod ?? null) : null,
        provenance: h.provenance && h.provenance !== 'live' ? 'prior_dataset' : 'live',
      });
    }
  const files = readdirSync(events).filter((f) => f.endsWith('.jsonl'));
  const days = files.filter((f) => existsSync(join(events, f.replace('.jsonl', '.done')))).sort();
  const doneAt = new Map<string, Date>();
  const acc = newPoolBars();
  let rows = 0;
  let duplicates = 0;
  let swaps = 0;
  for (const d of days) {
    const done = JSON.parse(readFileSync(join(events, d.replace('.jsonl', '.done')), 'utf8')) as {
      fetchedAt: string;
    };
    doneAt.set(d.slice(0, 10), new Date(done.fetchedAt));
    const seen = new Set<string>();
    for (const l of lines(join(events, d))) {
      if (!l.includes('"kind":"swap"')) continue;
      const row = JSON.parse(l) as SolRow;
      if (row.t > until) continue;
      if (seen.has(row.s)) {
        duplicates++;
        continue;
      }
      seen.add(row.s);
      rows++;
      for (const s of solanaBarSwaps(row, m)) {
        swaps++;
        addBarSwap(acc, s, hourly.get(hourOf(s.t)), regimeOfT);
      }
    }
  }
  const bars = poolBars(acc, LAYER);
  const first = days[0]?.slice(0, 10);
  const last = days.at(-1)?.slice(0, 10);
  return {
    bars,
    first,
    last,
    days: days.length,
    notDone: files.length - days.length,
    rows,
    swaps,
    duplicates,
    hourlyRows: hourly.size,
    doneAt,
    hourly,
  };
}

/** The metadata of Step 5b's pools, from risk_pools, as the flow import reads it. */
export async function solanaMeta(dir: string): Promise<SolanaPoolMeta[]> {
  const addresses = readdirSync(join(dir, 'events'));
  const { db, client } = createDb();
  const meta = await db.select().from(riskPools).where(inArray(riskPools.address, addresses));
  await client.end();
  const missing = addresses.filter((a) => !meta.some((m) => m.address === a));
  if (missing.length) throw new Error(`pools not in risk_pools: ${missing.join(', ')}`);
  return meta.map((r) => ({
    address: r.address,
    assetMint: r.assetMint,
    assetSymbol: r.assetSymbol,
    quoteMint: r.quoteMint,
    assetIsToken0: r.assetIsToken0 === 1,
    decimals0: r.decimals0,
    decimals1: r.decimals1,
  }));
}

export const solanaRegime = () => {
  const params = P();
  return (t: number): Regime => regimeAt(new Date(t * 1000), params);
};

export async function readSolana(
  dataDir: string,
): Promise<{ pools: PoolBars[]; summary: ReadSummary }> {
  const dir = join(dataDir, 'history-full');
  const meta = await solanaMeta(dir);
  const regimeOfT = solanaRegime();
  const pools: PoolBars[] = [];
  const perPool: Array<Record<string, unknown>> = [];
  for (const m of meta) {
    const got = solanaPoolBars(dir, m, regimeOfT);
    const dayOf = (hour: string) => hour.slice(0, 10);
    pools.push({
      pool: m.address,
      address: m.assetMint,
      symbol: m.assetSymbol,
      quoteAddress: m.quoteMint,
      bars: got.bars,
      source: `data/risk/history-full/events/${m.address}/${got.first}..${got.last}.jsonl (history-full-0.1, decoded swap events of successful transactions by Solana RPC getTransaction; ${got.days} day files with a .done marker) priced by data/risk/history-full/hourly/${m.address}.jsonl (history-replay-0.1)`,
      fetchedAtOf: (hour) => got.doneAt.get(dayOf(hour)) as Date,
      provenanceOf: (hour) => got.hourly.get(hour)?.provenance ?? 'live',
    });
    perPool.push({
      asset: m.assetSymbol,
      pool: m.address.slice(0, 8),
      days: got.days,
      notDone: got.notDone,
      txRows: got.rows,
      duplicates: got.duplicates,
      swaps: got.swaps,
      bars: got.bars.length,
      unpriced: got.bars.reduce((a, b) => a + b.unpricedSwaps, 0),
      hourlyRows: got.hourlyRows,
    });
  }
  return {
    pools,
    summary: {
      dir,
      pools: pools.length,
      perPool,
      swaps: perPool.reduce((a, r) => a + (r.swaps as number), 0),
      duplicates: perPool.reduce((a, r) => a + (r.duplicates as number), 0),
      daysNotDone: perPool.reduce((a, r) => a + (r.notDone as number), 0),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Robinhood Chain

/** One logged swap as a bar swap; `side` null when the event logged nothing going in on either side. */
export function evmBarSwap(
  s: SwapRow,
  p: Pick<HistoryPool, 'assetIsToken0'>,
  d: PoolDecimals | null,
  assetDecimals: number,
): BarSwap {
  const at = [s.block, s.logIndex, 0] as const;
  let sides: ReturnType<typeof swapSides> | null = null;
  try {
    sides = swapSides(s);
  } catch {
    sides = null;
  }
  if (!sides) return { t: s.t, at, side: null, tokens: 0, quote: null, minRaw: 0 };
  const { zeroForOne, in0, in1 } = sides;
  const sell = p.assetIsToken0 === zeroForOne;
  const rawAsset = p.assetIsToken0 ? in0 : in1;
  const rawQuote = p.assetIsToken0 ? in1 : in0;
  const abs = (x: bigint) => Number(x < 0n ? -x : x);
  return {
    t: s.t,
    at,
    side: sell ? 'sell' : 'buy',
    tokens: abs(rawAsset) / 10 ** assetDecimals,
    quote: d ? abs(rawQuote) / 10 ** (p.assetIsToken0 ? d.decimals1 : d.decimals0) : null,
    minRaw: d ? Math.min(abs(rawAsset), abs(rawQuote)) : abs(rawAsset),
  };
}

export async function readRobinhood(
  evmDir: string,
  listDir: string,
): Promise<{ pools: PoolBars[]; summary: ReadSummary }> {
  const chain = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
  const root = join(evmDir, 'history', chain.id);
  const cursor = JSON.parse(readFileSync(join(root, 'cursor.json'), 'utf8')) as Cursor;
  const list = JSON.parse(readFileSync(join(listDir, `${chain.id}.json`), 'utf8')) as AssetList;
  const cutFile = list.inputs.cut ?? '';
  const cut = JSON.parse(readFileSync(join(evmDir, cutFile), 'utf8')) as {
    chain: string;
    pools: CutRow[];
  };
  const pools = historyPools(cut, chain);
  const universeFile = readdirSync(evmDir)
    .filter((f) => f.startsWith(`universe-${chain.id}-`) && f.endsWith('.json'))
    .sort()
    .at(-1) as string;
  const universe = JSON.parse(readFileSync(join(evmDir, universeFile), 'utf8')) as {
    tokens: Array<{ address: string; decimals: number }>;
  };
  const decimalsByAddress = new Map(
    universe.tokens.map((t) => [t.address.toLowerCase(), t.decimals]),
  );
  const decimals = new Map<string, PoolDecimals>();
  for (const p of pools) {
    const d = poolDecimals(p, chain, (a) => decimalsByAddress.get(a));
    if (d) decimals.set(p.address, d);
  }
  const swapsDir = join(root, 'swaps');
  const dayFiles = (pool: string) => {
    const d = join(swapsDir, pool);
    return existsSync(d)
      ? readdirSync(d)
          .filter((x) => x.endsWith('.jsonl'))
          .sort()
          .map((f) => join(d, f))
      : [];
  };
  function* swapsOf(pool: string): Generator<SwapRow> {
    for (const f of dayFiles(pool)) for (const l of lines(f)) yield JSON.parse(l) as SwapRow;
  }
  const place = (s: SwapRow) => s.block * 1_000_000 + s.logIndex;
  // first pass: the last swap of each hour of each pool (the hourly prices), as flow-import builds them
  const acc = newHourAccumulator();
  for (const p of pools) {
    const seen = new Set<number>();
    for (const s of swapsOf(p.address)) {
      if (s.pool !== p.address) continue;
      const k = place(s);
      if (seen.has(k)) continue;
      seen.add(k);
      accumulateHour(acc, s);
    }
  }
  const span = { fromT: cursor.complete ? cursor.fromT : cursor.oldestDoneT, headT: cursor.headT };
  const hourly = hourlyRows({
    pools,
    decimals,
    swaps: acc,
    hours: hoursOf(span.fromT, span.headT),
    dollar: chain.dollar.address,
  });
  const params = P();
  const regimeOfT = (t: number): Regime => regimeAt(new Date(t * 1000), params);
  const byPool = new Map<string, Map<string, BarHour>>();
  for (const h of hourly) {
    let m = byPool.get(h.pool);
    if (!m) {
      m = new Map();
      byPool.set(h.pool, m);
    }
    m.set(h.hour, {
      regime: regimeOfT(Date.parse(h.hour) / 1000),
      quoteUsd: h.quoteUsd,
      method: h.quoteUsdMethod,
    });
  }
  const fetchedAt = new Date(cursor.updatedAt);
  const out: PoolBars[] = [];
  const perPool: Array<Record<string, unknown>> = [];
  let noAssetDecimals = 0;
  for (const p of pools) {
    const d = decimals.get(p.address) ?? null;
    const assetDecimals = decimalsByAddress.get(p.asset.toLowerCase());
    if (assetDecimals === undefined) {
      noAssetDecimals++;
      continue;
    }
    const hs = byPool.get(p.address) ?? new Map<string, BarHour>();
    const bars = newPoolBars();
    const seen = new Set<number>();
    let n = 0;
    let dup = 0;
    let withoutSide = 0;
    for (const s of swapsOf(p.address)) {
      if (s.pool !== p.address) continue;
      const k = place(s);
      if (seen.has(k)) {
        dup++;
        continue;
      }
      seen.add(k);
      n++;
      const b = evmBarSwap(s, p, d, assetDecimals);
      if (b.side === null) withoutSide++;
      // as flow-import: a pool with unknown decimals, and a swap with no side, are added without the hour's row
      addBarSwap(
        bars,
        b,
        d ? hs.get(hourIso(s.t)) : undefined,
        regimeOfT,
        d !== null && b.side !== null,
      );
    }
    const pb = poolBars(bars, LAYER);
    out.push({
      pool: p.address,
      address: p.asset.toLowerCase(),
      symbol: p.symbol,
      quoteAddress: p.other,
      bars: pb,
      source: `${evmDir.replace(homedir(), '~')}/history/${chain.id}/swaps/${p.address}/<day>.jsonl (${cursor.method}: Swap events by eth_getLogs of the Uniswap v3 pools and the v4 pool manager on ${chain.name}, ${dayFiles(p.address).length} day files) priced by hourlyRows of scripts/risk-evm/history.ts over the whole walk (the pricing of risk_pool_flow's flow-0.1 rows)`,
      fetchedAtOf: () => fetchedAt,
      provenanceOf: () => 'live',
    });
    perPool.push({
      symbol: p.symbol,
      pool: p.address.slice(0, 10),
      quote: p.otherSymbol ?? p.other.slice(0, 10),
      decimals: d !== null,
      swaps: n,
      duplicates: dup,
      withoutSide,
      bars: pb.length,
      unpriced: pb.reduce((a, b) => a + b.unpricedSwaps, 0),
    });
  }
  return {
    pools: out,
    summary: {
      root,
      cut: cutFile,
      universe: universeFile,
      pools: pools.length,
      poolsWithoutDecimals: pools.length - decimals.size,
      poolsWithoutAssetDecimals: noAssetDecimals,
      span: {
        from: new Date(span.fromT * 1000).toISOString(),
        to: new Date(span.headT * 1000).toISOString(),
      },
      swaps: perPool.reduce((a, r) => a + (r.swaps as number), 0),
      duplicates: perPool.reduce((a, r) => a + (r.duplicates as number), 0),
      withoutSide: perPool.reduce((a, r) => a + (r.withoutSide as number), 0),
      perPool,
    },
  };
}
