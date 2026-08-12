-- E2EE ciphertext format version (backlog §2 — authenticated context / AAD, format v2).
-- `cipher_version` is meaningful on tier 'e2ee' only: 1 = legacy pre-AAD "v1." ciphertext,
-- refused by every normal sync2 route (409 e2ee_upgrade_required) until the explicit upgrade
-- ceremony (fresh DEK, epoch bump, new v2 checkpoint from the trusted local replica) has run;
-- 2 = the current authenticated format. Existing plain rows and all future rows are format 2;
-- rows that are ALREADY e2ee at migration time hold v1 ciphertext by definition and are marked 1
-- exactly once below. NEVER flip cipher_version with SQL alone afterwards — that would label
-- unauthenticated ciphertext as v2 without rotating the DEK or rebuilding the snapshot.
-- (ALTER statements are drizzle-kit-generated from schema.ts so meta/0021_snapshot.json agrees
-- with this file; the UPDATE is a one-time data statement invisible to the snapshot.)
ALTER TABLE "budgets" ADD COLUMN "cipher_version" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_cipher_version_valid" CHECK ("budgets"."cipher_version" IN (1, 2));--> statement-breakpoint
UPDATE "budgets" SET "cipher_version" = 1 WHERE "tier" = 'e2ee';
