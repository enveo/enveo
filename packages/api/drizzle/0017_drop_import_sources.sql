-- Drop the leftover `import_sources` table.
--
-- It belonged to the URL-import feature that was removed in 1.14.0 (screenshot import stays).
-- Nothing in the codebase has referenced it since: no schema.ts declaration, no queries, no FKs
-- pointing at it, and it is not part of ClientLedger, so no replica or backup carries it.
-- Leaving it in the database was an active hazard: `drizzle-kit generate` diffs schema.ts against
-- the last snapshot, so the DROP kept re-appearing inside unrelated migrations.
DROP TABLE IF EXISTS "import_sources" CASCADE;
