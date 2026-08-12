/**
 * One-time client-side cleanup for legacy `planned` template transactions.
 *
 * The recurring-payments feature (and the per-transaction `planned` flag) was removed from the
 * shared domain in 3.2, and migration 0018 drops `transactions.planned`/`recurrence_id` server
 * side, deleting every `planned = true` row FIRST. On a PLAIN-tier budget that DELETE is real —
 * it flows through the `changes` trigger journal, and every replica converges on its next pull.
 *
 * On an E2EE-tier budget the server holds ciphertext only: migration 0018's DELETE has nothing
 * to touch there, so a replica that already had `planned` rows keeps them. Those rows used to be
 * excluded from every ledger computation (they were template placeholders, never real money);
 * with the filter gone they would now count as real balances. This sweep finds and removes them
 * client-side, on whichever device notices first — the delete then replicates normally (encrypted
 * on e2ee, an idempotent no-op on plain where the server already dropped the row).
 *
 * `Transaction` no longer declares `planned` in the TS type (dropped with the rest of the shared
 * recurrence domain) — a leftover value only shows up by reading PAST the type: an old IDB blob
 * or a replica synced before 3.2 still literally carries the JSON field.
 */
import type { ClientLedger } from "@enveo/shared";

/** Ids of transactions whose stored JSON still carries `planned === true`. */
export function purgeLegacyPlannedIds(ledger: ClientLedger): string[] {
  return ledger.transactions.filter((t) => (t as unknown as { planned?: boolean }).planned === true).map((t) => t.id);
}
