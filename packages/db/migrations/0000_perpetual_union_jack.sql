CREATE TYPE "public"."asset_kind" AS ENUM('usd_yield', 'brl_stable', 'cash', 'equity');--> statement-breakpoint
CREATE TYPE "public"."chain" AS ENUM('solana', 'evm');--> statement-breakpoint
CREATE TYPE "public"."execution_kind" AS ENUM('swap', 'deposit', 'withdraw', 'mint', 'redeem', 'rebalance', 'approve');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('built', 'signed', 'sent', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mint_path" AS ENUM('dex_swap', 'lending_deposit', 'issuer_mint', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."policy_mechanism" AS ENUM('delegated', 'user_signed');--> statement-breakpoint
CREATE TYPE "public"."profile" AS ENUM('income', 'accumulation', 'high_risk');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('live', 'mock', 'sandbox', 'fixture', 'prior_dataset');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"chain" "chain" NOT NULL,
	"mint" text,
	"token_program" text,
	"decimals" integer,
	"eligible_profiles" jsonb NOT NULL,
	"cap_weight" numeric(6, 4) NOT NULL,
	"mint_path" "mint_path" NOT NULL,
	"metadata" jsonb NOT NULL,
	"provenance" "provenance" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "constraint_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"sheet" jsonb NOT NULL,
	"valid" boolean NOT NULL,
	"validation_errors" jsonb,
	"origin" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depth_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" text NOT NULL,
	"side" text NOT NULL,
	"notional_usd" numeric(18, 2) NOT NULL,
	"price_impact_pct" numeric(12, 8) NOT NULL,
	"out_amount" text NOT NULL,
	"route" jsonb,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid,
	"plan_leg_id" uuid,
	"wallet" text NOT NULL,
	"chain" "chain" NOT NULL,
	"kind" "execution_kind" NOT NULL,
	"asset_id" text,
	"signature" text,
	"explorer_url" text,
	"status" "execution_status" NOT NULL,
	"error" text,
	"amount_in" text,
	"amount_out" text,
	"provenance" "provenance" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fx_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pair" text NOT NULL,
	"value" numeric(18, 8) NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_text" text NOT NULL,
	"language" text NOT NULL,
	"wallet" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"weight" numeric(6, 4) NOT NULL,
	"amount_usd" numeric(18, 2) NOT NULL,
	"reasoning" text NOT NULL,
	"yield_observation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"constraint_sheet_id" uuid NOT NULL,
	"profile" "profile" NOT NULL,
	"capital_usd" numeric(18, 2) NOT NULL,
	"wallet" text,
	"solver_version" text NOT NULL,
	"binding_constraints" jsonb NOT NULL,
	"disclaimer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"allowed_assets" jsonb NOT NULL,
	"bands" jsonb NOT NULL,
	"trigger" jsonb NOT NULL,
	"withdrawal_destination" text NOT NULL,
	"mechanism" "policy_mechanism" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" text NOT NULL,
	"asset_id" text NOT NULL,
	"amount" numeric(30, 9) NOT NULL,
	"value_usd" numeric(18, 2),
	"observed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rebalances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"trigger_reason" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"mechanism" "policy_mechanism" NOT NULL,
	"execution_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"case_id" text NOT NULL,
	"rows" jsonb NOT NULL,
	"liquidity_ok" boolean NOT NULL,
	"fx_observation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stress_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"stress_id" text NOT NULL,
	"name" text NOT NULL,
	"params" jsonb NOT NULL,
	"liquidity_ok" boolean NOT NULL,
	"summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "yield_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" text NOT NULL,
	"quoted_yield" numeric(10, 6) NOT NULL,
	"haircut_yield" numeric(10, 6) NOT NULL,
	"haircut_rule" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "constraint_sheets" ADD CONSTRAINT "constraint_sheets_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depth_observations" ADD CONSTRAINT "depth_observations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_plan_leg_id_plan_legs_id_fk" FOREIGN KEY ("plan_leg_id") REFERENCES "public"."plan_legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_legs" ADD CONSTRAINT "plan_legs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_legs" ADD CONSTRAINT "plan_legs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_legs" ADD CONSTRAINT "plan_legs_yield_observation_id_yield_observations_id_fk" FOREIGN KEY ("yield_observation_id") REFERENCES "public"."yield_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_constraint_sheet_id_constraint_sheets_id_fk" FOREIGN KEY ("constraint_sheet_id") REFERENCES "public"."constraint_sheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebalances" ADD CONSTRAINT "rebalances_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebalances" ADD CONSTRAINT "rebalances_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_sheets" ADD CONSTRAINT "risk_sheets_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_sheets" ADD CONSTRAINT "risk_sheets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_fx_observation_id_fx_observations_id_fk" FOREIGN KEY ("fx_observation_id") REFERENCES "public"."fx_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stress_cases" ADD CONSTRAINT "stress_cases_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_observations" ADD CONSTRAINT "yield_observations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;