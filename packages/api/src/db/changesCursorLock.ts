import { sql as dsql } from "drizzle-orm";
import type { DbTransaction } from "./client";

/** The database triggers hash this exact text when they journal a replicated write. */
export const CHANGES_CURSOR_LOCK_TEXT = "enveo:changes";

/**
 * Common protocol for writers that must pre-lock rows before their DML reaches `log_change()`.
 * Call on the writer's existing transaction before any lifecycle row lock. Taking this shared
 * lock early preserves the cursor barrier's exclusive-first order without changing the trigger.
 */
export async function lockChangesCursorShared(tx: DbTransaction): Promise<void> {
  await tx.execute(dsql`SELECT pg_advisory_xact_lock_shared(hashtext(${CHANGES_CURSOR_LOCK_TEXT}::text)::bigint)`);
}

/** Exclusive cursor barrier. This must remain the first statement of its transaction. */
export async function lockChangesCursorExclusive(tx: DbTransaction): Promise<void> {
  await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtext(${CHANGES_CURSOR_LOCK_TEXT}::text)::bigint)`);
}
