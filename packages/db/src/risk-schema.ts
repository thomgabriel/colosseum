import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { provenanceEnum } from './schema';

// Risk layer tables (branch risk-layer). Kept apart from schema.ts so the structurer's schema and its
// tests are untouched. Every computed row carries method_version plus source / method / fetched_at.
const ts = (name: string) => timestamp(name, { withTimezone: true });
const provenanceCols = {
  source: text('source').notNull(),
  method: text('method').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
  provenance: provenanceEnum('provenance').notNull(),
};

/** Every DEX pool that trades an xStock, confirmed on-chain, with its refresh tier. */
export const riskPools = pgTable(
  'risk_pools',
  {
    address: text('address').primaryKey(),
    program: text('program').notNull(),
    venue: text('venue').notNull(),
    assetMint: text('asset_mint').notNull(),
    assetSymbol: text('asset_symbol').notNull(),
    quoteMint: text('quote_mint').notNull(),
    quoteSymbol: text('quote_symbol'),
    /** direct_usd (USDC/USDT), via_sol, via_xstock, other: how a seller reaches dollars through this pool. */
    exitPath: text('exit_path').notNull(),
    assetIsToken0: integer('asset_is_token0').notNull(),
    decimals0: integer('decimals0').notNull(),
    decimals1: integer('decimals1').notNull(),
    transferFeeBps0: integer('transfer_fee_bps0').notNull().default(0),
    transferFeeBps1: integer('transfer_fee_bps1').notNull().default(0),
    /** Pool TVL in USD measured on-chain from vault balances at registry build time. */
    tvlUsd: doublePrecision('tvl_usd'),
    discoveryLiquidityUsd: doublePrecision('discovery_liquidity_usd'),
    discoveryVolume24hUsd: doublePrecision('discovery_volume24h_usd'),
    /** A = refreshed every 5 min (pools holding the top share of TVL), B = hourly, X = excluded. */
    tier: text('tier').notNull(),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    methodVersion: text('method_version').notNull(),
    ...provenanceCols,
  },
  (t) => [index('risk_pools_asset_idx').on(t.assetMint), index('risk_pools_tier_idx').on(t.tier)],
);

/** One simulated depth snapshot of one pool: price, active liquidity, sell and buy curves. */
export const riskPoolSnapshots = pgTable(
  'risk_pool_snapshots',
  {
    pool: text('pool')
      .notNull()
      .references(() => riskPools.address),
    fetchedAt: ts('fetched_at').notNull(),
    slot: doublePrecision('slot'),
    /** Mid price of the asset in the quote token (UI units). */
    midPrice: doublePrecision('mid_price').notNull(),
    activeLiquidity: text('active_liquidity'),
    /** [{notionalUsd, out, costPct, unfilledShare}] for selling the asset into the quote token. */
    sell: jsonb('sell').notNull(),
    buy: jsonb('buy').notNull(),
    /** Liquidity within ±band of price, for LP-withdrawal detection. */
    inBandLiquidity: doublePrecision('in_band_liquidity'),
    methodVersion: text('method_version').notNull(),
    source: text('source').notNull(),
    method: text('method').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pool, t.fetchedAt] })],
);
