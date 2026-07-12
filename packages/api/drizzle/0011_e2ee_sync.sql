CREATE TABLE IF NOT EXISTS "e2ee_ops" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"budget_id" uuid NOT NULL,
	"op_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_ops_budget_op_uniq" UNIQUE("budget_id","op_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "e2ee_snapshots" (
	"budget_id" uuid PRIMARY KEY NOT NULL,
	"upto_seq" bigint DEFAULT 0 NOT NULL,
	"blob" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "tier" text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "wrapped_dek" text;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "kdf_params" text;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "e2ee_ops" ADD CONSTRAINT "e2ee_ops_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "e2ee_snapshots" ADD CONSTRAINT "e2ee_snapshots_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "e2ee_ops_budget_idx" ON "e2ee_ops" USING btree ("budget_id","seq");