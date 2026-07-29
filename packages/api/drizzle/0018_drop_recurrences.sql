-- ⚠ Take a pg_dump before applying — this migration DELETES rows (see below), not just schema.
--
-- Drop the recurring-payments feature: `recurrences` table, `recurrence_rule` enum, and the
-- `transactions.planned`/`recurrence_id` columns. All code references were removed in
-- Tasks 1-4 (web mutators/replication, API routes/sync handlers, shared domain + ops).
--
-- `planned` rows were template placeholders for future recurrence occurrences, excluded from
-- every ledger computation (balances, envelope available, reports). Now that the code-side
-- filter is gone, they would surface as real money if left in place, so they are deleted
-- BEFORE the column drop. `txn_items` rows cascade with them (FK onDelete: cascade, see
-- migration 0000 / schema.ts).
--
-- This DELETE only converges every replica on a PLAIN-tier budget: there it flows through the
-- `changes` trigger journal, so a client picks it up on its next pull. On an E2EE-tier budget
-- the server holds ciphertext only — this DELETE has no plaintext to match, so it is a no-op
-- there, and an e2ee replica that already had `planned` rows keeps them. That gap is closed
-- CLIENT-SIDE instead, by a one-time sweep at boot (see purgeLegacyPlannedIds /
-- sweepLegacyPlanned in packages/web/src/lib/legacyPlanned.ts and sync.ts).
DELETE FROM "transactions" WHERE "planned" = true;
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_recurrence_id_recurrences_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "planned";
--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "recurrence_id";
--> statement-breakpoint
ALTER TABLE "recurrences" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TABLE "recurrences" CASCADE;
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."recurrence_rule";
