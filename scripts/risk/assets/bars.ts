// `pnpm risk:assets-bars <solana|robinhood> [--dry-run]` (PLAN-ASSETS AS.7): hourly bars per pool and per
// token from the swap history both chains already hold, upserted into market_bars under `bars-0.1`. The
// readers are in bars-read.ts (no RPC); the bars are `@colosseum/risk`'s. A second run rewrites the same rows
// (the key is chain, address, pool, hour and method version). --dry-run builds and counts and writes nothing.
//
//   Solana     RISK_DATA_DIR (default data/risk): history-full/events and history-full/hourly, and the pools'
//              metadata from risk_pools
//   Robinhood  RISK_EVM_DIR (default data/risk-evm): history/robinhood (read-only: the live loop's folder),
//              the cut the list names and the newest universe file; RISK_UNIVERSE_DIR for the list
import 'dotenv/config';
import { createDb, marketBars } from '@colosseum/db';
import { assetBars, BARS_METHOD, BARS_METHOD_VERSION, type Bar } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { CROSS_POOL_ORDER, LAYER, type PoolBars, readRobinhood, readSolana } from './bars-read';

const args = process.argv.slice(2);
const chain = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
if (chain !== 'solana' && chain !== 'robinhood') {
  console.error('usage: pnpm risk:assets-bars <solana|robinhood> [--dry-run]');
  process.exit(1);
}
const t0 = Date.now();
const read =
  chain === 'solana'
    ? await readSolana(process.env.RISK_DATA_DIR ?? 'data/risk')
    : await readRobinhood(
        process.env.RISK_EVM_DIR ?? 'data/risk-evm',
        process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe',
      );
const readS = (Date.now() - t0) / 1000;

type Row = typeof marketBars.$inferInsert;
const rowOf = (
  b: Bar,
  r: Pick<Row, 'address' | 'pool' | 'quoteAddress' | 'source' | 'fetchedAt' | 'provenance'>,
): Row => ({
  chain,
  address: r.address,
  pool: r.pool,
  hour: new Date(b.hour),
  quoteAddress: r.quoteAddress,
  openQuote: b.openQuote,
  highQuote: b.highQuote,
  lowQuote: b.lowQuote,
  closeQuote: b.closeQuote,
  vwapQuote: b.vwapQuote,
  openUsd: b.openUsd,
  highUsd: b.highUsd,
  lowUsd: b.lowUsd,
  closeUsd: b.closeUsd,
  vwapUsd: b.vwapUsd,
  swaps: b.swaps,
  buySwaps: b.buySwaps,
  sellSwaps: b.sellSwaps,
  unpricedSwaps: b.unpricedSwaps,
  volumeTokens: b.volumeTokens,
  volumeUsd: b.volumeUsd,
  buyVolumeUsd: b.buyVolumeUsd,
  sellVolumeUsd: b.sellVolumeUsd,
  quoteUsdMethod: b.quoteUsdMethod,
  detail: b.detail,
  methodVersion: BARS_METHOD_VERSION,
  source: r.source,
  method: BARS_METHOD,
  fetchedAt: r.fetchedAt,
  provenance: r.provenance,
});

const rows: Row[] = [];
for (const p of read.pools)
  for (const b of p.bars)
    rows.push(
      rowOf(b, {
        address: p.address,
        pool: p.pool,
        quoteAddress: p.quoteAddress,
        source: p.source,
        fetchedAt: p.fetchedAtOf(b.hour),
        provenance: p.provenanceOf(b.hour),
      }),
    );
const poolRows = rows.length;

// the token's bar across the pools it is filed under
const byToken = new Map<string, PoolBars[]>();
for (const p of read.pools) byToken.set(p.address, [...(byToken.get(p.address) ?? []), p]);
const tokens: Array<Record<string, unknown>> = [];
for (const [address, ps] of byToken) {
  const bars = assetBars(
    ps.map((p) => ({ pool: p.pool, bars: p.bars })),
    LAYER,
    CROSS_POOL_ORDER[chain],
  );
  const barHours = new Map(ps.map((p) => [p.pool, new Set(p.bars.map((b) => b.hour))]));
  for (const b of bars) {
    const here = ps.filter((p) => barHours.get(p.pool)?.has(b.hour));
    const fetched = here.map((p) => p.fetchedAtOf(b.hour).getTime());
    rows.push(
      rowOf(b, {
        address,
        pool: 'asset',
        quoteAddress: null,
        source: `the bars-0.1 bars of the token's ${ps.length} pool${ps.length > 1 ? 's' : ''} in the held swap history (pool = each pool's address in market_bars), summed: ${ps.map((p) => p.pool).join(', ')}`,
        fetchedAt: new Date(Math.max(...fetched)),
        provenance: here.some((p) => p.provenanceOf(b.hour) !== 'live') ? 'prior_dataset' : 'live',
      }),
    );
  }
  tokens.push({
    symbol: ps[0]?.symbol,
    pools: ps.length,
    hours: bars.length,
    swaps: bars.reduce((a, b) => a + b.swaps, 0),
    unpriced: bars.reduce((a, b) => a + b.unpricedSwaps, 0),
    volumeUsd: Math.round(bars.reduce((a, b) => a + (b.volumeUsd ?? 0), 0)),
  });
}

let written = 0;
if (!dry) {
  const { db, client } = createDb();
  const cols = Object.keys(rows[0] ?? {}).filter(
    (k) => !['chain', 'address', 'pool', 'hour', 'methodVersion'].includes(k),
  ) as Array<keyof Row>;
  const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const set = Object.fromEntries(cols.map((k) => [k, sql.raw(`excluded.${snake(k)}`)]));
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(marketBars)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [
          marketBars.chain,
          marketBars.address,
          marketBars.pool,
          marketBars.hour,
          marketBars.methodVersion,
        ],
        set,
      })
      .returning({ h: marketBars.hour });
    written += res.length;
  }
  await client.end();
}

const { perPool, ...summary } = read.summary as { perPool: unknown[] } & Record<string, unknown>;
console.table(
  (tokens as Array<{ volumeUsd: number }>).sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 40),
);
console.log(
  JSON.stringify({
    chain,
    dryRun: dry,
    methodVersion: BARS_METHOD_VERSION,
    ...summary,
    poolsWithBars: read.pools.filter((p) => p.bars.length).length,
    poolBars: poolRows,
    tokens: byToken.size,
    assetBars: rows.length - poolRows,
    rows: rows.length,
    written,
    pricedPoolBars: rows.slice(0, poolRows).filter((r) => r.volumeUsd !== null).length,
    unpricedSwaps: rows.slice(0, poolRows).reduce((a, r) => a + (r.unpricedSwaps ?? 0), 0),
    readSeconds: Math.round(readS),
    seconds: Math.round((Date.now() - t0) / 1000),
  }),
);
if (process.env.BARS_PER_POOL) console.table(perPool);
