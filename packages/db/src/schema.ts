import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Enums mirror packages/schemas/src/enums.ts. Keep both in sync (test: tests/db-schema.test.ts).
export const profileEnum = pgEnum('profile', ['income', 'accumulation', 'high_risk']);
export const assetKindEnum = pgEnum('asset_kind', ['usd_yield', 'brl_stable', 'cash', 'equity']);
export const chainEnum = pgEnum('chain', ['solana', 'evm']);
export const provenanceEnum = pgEnum('provenance', [
  'live',
  'mock',
  'sandbox',
  'fixture',
  'prior_dataset',
]);
export const mintPathEnum = pgEnum('mint_path', [
  'dex_swap',
  'lending_deposit',
  'issuer_mint',
  'unavailable',
]);
export const executionStatusEnum = pgEnum('execution_status', [
  'built',
  'signed',
  'sent',
  'confirmed',
  'failed',
]);
export const executionKindEnum = pgEnum('execution_kind', [
  'swap',
  'deposit',
  'withdraw',
  'mint',
  'redeem',
  'rebalance',
  'approve',
]);
export const policyMechanismEnum = pgEnum('policy_mechanism', ['delegated', 'user_signed']);

const ts = (name: string) => timestamp(name, { withTimezone: true });
const provenanceCols = {
  source: text('source').notNull(),
  method: text('method').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
  provenance: provenanceEnum('provenance').notNull(),
};

/** Raw goal text as the user typed it. */
export const goals = pgTable('goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  rawText: text('raw_text').notNull(),
  language: text('language').notNull(),
  wallet: text('wallet'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Parsed and validated constraints; one goal can have several versions (LLM output, then user edits). */
export const constraintSheets = pgTable('constraint_sheets', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id')
    .notNull()
    .references(() => goals.id),
  sheet: jsonb('sheet').notNull(),
  valid: boolean('valid').notNull(),
  validationErrors: jsonb('validation_errors'),
  origin: text('origin').notNull(), // 'llm' | 'user_edit' | 'fixture'
  model: text('model'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Asset registry: static description plus provenance. No yield numbers here. */
export const assets = pgTable('assets', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  kind: assetKindEnum('kind').notNull(),
  chain: chainEnum('chain').notNull(),
  mint: text('mint'),
  tokenProgram: text('token_program'),
  decimals: integer('decimals'),
  eligibleProfiles: jsonb('eligible_profiles').notNull(),
  capWeight: numeric('cap_weight', { precision: 6, scale: 4 }).notNull(),
  mintPath: mintPathEnum('mint_path').notNull(),
  metadata: jsonb('metadata').notNull(),
  provenance: provenanceEnum('provenance').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Every yield figure ever shown: quoted, haircut, rule, source, timestamp. */
export const yieldObservations = pgTable('yield_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id),
  quotedYield: numeric('quoted_yield', { precision: 10, scale: 6 }).notNull(),
  haircutYield: numeric('haircut_yield', { precision: 10, scale: 6 }).notNull(),
  haircutRule: text('haircut_rule').notNull(),
  ...provenanceCols,
});

/** FX and rate observations (USD/BRL PTAX, Selic, CDI). */
export const fxObservations = pgTable('fx_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  pair: text('pair').notNull(),
  value: numeric('value', { precision: 18, scale: 8 }).notNull(),
  ...provenanceCols,
});

/** Jupiter quote depth snapshots (the xStocks weekend cron writes here). */
export const depthObservations = pgTable('depth_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id),
  side: text('side').notNull(),
  notionalUsd: numeric('notional_usd', { precision: 18, scale: 2 }).notNull(),
  priceImpactPct: numeric('price_impact_pct', { precision: 12, scale: 8 }).notNull(),
  outAmount: text('out_amount').notNull(),
  route: jsonb('route'),
  ...provenanceCols,
});

/** A solved plan for one constraint sheet. */
export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id')
    .notNull()
    .references(() => goals.id),
  constraintSheetId: uuid('constraint_sheet_id')
    .notNull()
    .references(() => constraintSheets.id),
  profile: profileEnum('profile').notNull(),
  capitalUsd: numeric('capital_usd', { precision: 18, scale: 2 }).notNull(),
  wallet: text('wallet'),
  solverVersion: text('solver_version').notNull(),
  bindingConstraints: jsonb('binding_constraints').notNull(),
  disclaimer: text('disclaimer').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** One row per leg: weight, amount, reasoning, and the yield observation it was priced on. */
export const planLegs = pgTable('plan_legs', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id),
  weight: numeric('weight', { precision: 6, scale: 4 }).notNull(),
  amountUsd: numeric('amount_usd', { precision: 18, scale: 2 }).notNull(),
  reasoning: text('reasoning').notNull(),
  yieldObservationId: uuid('yield_observation_id').references(() => yieldObservations.id),
});

/** Month-by-month BRL schedule for the base case. */
export const schedules = pgTable('schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  caseId: text('case_id').notNull(), // 'base' or a stress id
  rows: jsonb('rows').notNull(),
  liquidityOk: boolean('liquidity_ok').notNull(),
  fxObservationId: uuid('fx_observation_id').references(() => fxObservations.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Stress definitions and outcomes for a plan. */
export const stressCases = pgTable('stress_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  stressId: text('stress_id').notNull(),
  name: text('name').notNull(),
  params: jsonb('params').notNull(),
  liquidityOk: boolean('liquidity_ok').notNull(),
  summary: jsonb('summary'),
});

/** Per-leg risk sheet as rendered, frozen at plan time. */
export const riskSheets = pgTable('risk_sheets', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id),
  entry: jsonb('entry').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** The stored policy: allowed assets, bands, trigger, withdrawal destination, mechanism. */
export const policies = pgTable('policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  wallet: text('wallet').notNull(),
  allowedAssets: jsonb('allowed_assets').notNull(),
  bands: jsonb('bands').notNull(),
  trigger: jsonb('trigger').notNull(),
  withdrawalDestination: text('withdrawal_destination').notNull(),
  mechanism: policyMechanismEnum('mechanism').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Observed on-chain positions per wallet and asset. */
export const positions = pgTable('positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull(),
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id),
  amount: numeric('amount', { precision: 30, scale: 9 }).notNull(),
  valueUsd: numeric('value_usd', { precision: 18, scale: 2 }),
  observedAt: ts('observed_at').notNull(),
  source: text('source').notNull(),
});

/** Every mainnet transaction, with its explorer link. */
export const executions = pgTable('executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').references(() => plans.id),
  planLegId: uuid('plan_leg_id').references(() => planLegs.id),
  wallet: text('wallet').notNull(),
  chain: chainEnum('chain').notNull(),
  kind: executionKindEnum('kind').notNull(),
  assetId: text('asset_id').references(() => assets.id),
  signature: text('signature'),
  explorerUrl: text('explorer_url'),
  status: executionStatusEnum('status').notNull(),
  error: text('error'),
  amountIn: text('amount_in'),
  amountOut: text('amount_out'),
  provenance: provenanceEnum('provenance').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  confirmedAt: ts('confirmed_at'),
});

/** A rebalance decided by a policy, linked to the execution that carried it out. */
export const rebalances = pgTable('rebalances', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id')
    .notNull()
    .references(() => policies.id),
  triggerReason: text('trigger_reason').notNull(),
  proposed: jsonb('proposed').notNull(),
  mechanism: policyMechanismEnum('mechanism').notNull(),
  executionId: uuid('execution_id').references(() => executions.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});
