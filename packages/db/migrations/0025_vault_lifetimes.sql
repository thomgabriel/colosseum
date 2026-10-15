CREATE TABLE "vault_lifetimes" (
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"reopened_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_lifetimes_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
ALTER TABLE "vault_lifetimes" ADD CONSTRAINT "vault_lifetimes_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_lifetimes" ADD CONSTRAINT "vault_lifetimes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;