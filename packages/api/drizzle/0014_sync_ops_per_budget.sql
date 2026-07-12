-- opId idempotency scoped PER BUDGET (mirrors e2ee_ops): the global op_id PK
-- would let one tenant block another tenant's op with the same uuid.
-- budget_id stays nullable: pre-0014 rows can only be backfilled unambiguously
-- when exactly one budget exists (single-budget installs — the norm pre-2.0).
ALTER TABLE "sync_ops" ADD COLUMN "budget_id" uuid;--> statement-breakpoint
UPDATE "sync_ops" SET "budget_id" = (SELECT id FROM "budgets" LIMIT 1)
  WHERE (SELECT count(*) FROM "budgets") = 1;--> statement-breakpoint
ALTER TABLE "sync_ops" DROP CONSTRAINT "sync_ops_pkey";--> statement-breakpoint
CREATE UNIQUE INDEX "sync_ops_budget_op_uniq" ON "sync_ops" ("budget_id","op_id");
