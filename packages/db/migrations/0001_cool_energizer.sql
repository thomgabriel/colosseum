ALTER TABLE "policies" ADD COLUMN "mechanism_by_asset" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "delegation" jsonb;