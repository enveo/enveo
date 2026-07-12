CREATE TABLE IF NOT EXISTS "import_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"url" text NOT NULL,
	"last_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_mode" text DEFAULT 'full' NOT NULL,
	"tx_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "import_source_budget_url_uniq" UNIQUE("budget_id","url")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "external_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "txn_external_idx" ON "transactions" USING btree ("budget_id","external_id");