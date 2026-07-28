-- Drop the recurring-payments feature: `recurrences` table, `recurrence_rule` enum, and the
-- `transactions.planned`/`recurrence_id` columns. All code references were removed in
-- Tasks 1-4 (web mutators/replication, API routes/sync handlers, shared domain + ops).
--
-- `planned` rows were template placeholders for future recurrence occurrences, excluded from
-- every ledger computation (balances, envelope available, reports). Now that the code-side
-- filter is gone, they would surface as real money if left in place, so they are deleted
-- BEFORE the column drop. `txn_items` rows cascade with them (FK onDelete: cascade, see
-- migration 0000 / schema.ts). The delete flows through the `changes` trigger journal, so
-- client replicas converge to the same state on their next pull.
DELETE FROM "transactions" WHERE "planned" = true;
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_recurrence_id_recurrences_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "planned";
--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "recurrence_id";
--> statement-breakpoint
ALTER TABLE "recurrences" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TABLE "recurrences" CASCADE;
--> statement-breakpoint
DROP TYPE "public"."recurrence_rule";
