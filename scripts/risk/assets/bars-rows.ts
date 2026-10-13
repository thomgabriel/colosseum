// The rows `pnpm risk:assets-bars` writes to market_bars (AS.7, and AS.13's --source backfill): one per pool and
// hour, and one per token and hour across its pools (`pool = 'asset'`).
import { type Db, marketBars } from '@colosseum/db';
import { assetBars, BARS_METHOD, BARS_METHOD_VERSION, type Bar } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { CROSS_POOL_ORDER, LAYER, type PoolBars } from './bars-read';

export type BarRow = typeof marketBars.$inferInsert;
const rowOf = (
  chain: string,
  b: Bar,
  r: Pick<BarRow, 'address' | 'pool' | 'quoteAddress' | 'source' | 'fetchedAt' | 'provenance'>,
): BarRow => ({
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

/** Every row of a read: the pools' bars, then the tokens' across their pools. */
export function barRows(
  read: { pools: Array<PoolBars & { sourceOf?: (hour: string) => string }> },
  chain: 'solana' | 'robinhood',
  backfill: boolean,
) {
  const rows: BarRow[] = [];
  for (const p of read.pools)
    for (const b of p.bars)
      rows.push(
        rowOf(chain, b, {
          address: p.address,
          pool: p.pool,
          quoteAddress: p.quoteAddress,
          source: p.sourceOf ? p.sourceOf(b.hour) : p.source,
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
        rowOf(chain, b, {
          address,
          pool: 'asset',
          quoteAddress: null,
          source: `the bars-0.1 bars of the token's ${ps.length} pool${ps.length > 1 ? 's' : ''} in ${backfill ? `the asset backfill's day files of ${b.hour.slice(0, 10)}, every pool of the token holding the day whole` : 'the held swap history'} (pool = each pool's address in market_bars), summed: ${ps.map((p) => p.pool).join(', ')}`,
          fetchedAt: new Date(Math.max(...fetched)),
          provenance: here.some((p) => p.provenanceOf(b.hour) !== 'live')
            ? 'prior_dataset'
            : 'live',
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

  return { rows, poolRows, tokens, byToken };
}

/** A row this import wrote: a pool row names its backfill day file, a token row the backfill's day files. */
export const isBackfillSource = (source: string) =>
  source.startsWith('<ASSETS_DATA_DIR>/') || source.includes("in the asset backfill's day files");

const KEY = ['chain', 'address', 'pool', 'hour', 'methodVersion'];
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * The backfill's rows: a new key is inserted; a key this import wrote before (`isBackfillSource`) is replaced only
 * when the row differs (a pool resolved since, a pricing method added, more tokens in a day's SOL median); a key
 * of any other source (AS.7's held history) is never touched. So a re-run on the same files changes nothing.
 */
export async function upsertBackfillBars(
  db: Pick<Db, 'insert'>,
  rows: BarRow[],
): Promise<{ inserted: number; replaced: number }> {
  const out = { inserted: 0, replaced: 0 };
  if (!rows.length) return out;
  const cols = Object.keys(rows[0] as object).filter((k) => !KEY.includes(k));
  const set = Object.fromEntries(cols.map((k) => [k, sql.raw(`excluded.${snake(k)}`)]));
  const list = (prefix: string) => cols.map((k) => `${prefix}.${snake(k)}`).join(', ');
  const setWhere = sql.raw(
    `(market_bars.source like '<ASSETS_DATA_DIR>/%' or market_bars.source like '%in the asset backfill''s day files%') and (${list('market_bars')}) is distinct from (${list('excluded')})`,
  );
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
        setWhere,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    for (const r of res) r.inserted ? out.inserted++ : out.replaced++;
  }
  return out;
}
