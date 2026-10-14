-- A shared portfolio's recipe names the network it was published on (gate PRODUCTS-MAINNET-ONLY).
-- Every recipe before this one was published on the network its chain runs in this database: one
-- database serves one network (`seedChains`). On the hosted database that is the three of Solana
-- devnet (2026-10-06); Robinhood Chain has none. A chain's mainnet recipe and its test network's are
-- two rows.
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_family_chain_key";--> statement-breakpoint
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_chain_onchain_key";--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "network" text;--> statement-breakpoint
UPDATE "recipes" SET "network" = "chains"."network" FROM "chains" WHERE "chains"."id" = "recipes"."chain_id" AND "recipes"."network" IS NULL;--> statement-breakpoint
ALTER TABLE "recipes" ALTER COLUMN "network" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_family_chain_network_key" UNIQUE("family_id","chain_id","network");--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_chain_network_onchain_key" UNIQUE("chain_id","network","onchain_id");
