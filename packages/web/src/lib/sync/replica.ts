import * as outbox from "../outbox";
import { store } from "../store";

/** Re-apply all outbox ops onto the mirror (reducers are idempotent). */
export function replayOutbox(): void {
  if (!store.getLedger()) return;
  for (const entry of outbox.snapshot()) {
    try {
      store.applyLocal(entry.op);
    } catch (e) {
      console.warn("replay of an outbox op failed", entry.op, e);
    }
  }
}

/**
 * The budget an E2EE replica belongs to. store.getBudgetId() is set by every bootstrap, but a
 * replica bootstrapped over sync2 against a PRE-2.0 server carries none (that snapshot did not
 * name its budget) — the `budgets` entity inside the ledger still does, and it is exactly the id
 * the pairing code is built from (Settings → Pairing code). "" = genuinely unknown, which is
 * when the ownership proof has to fall back to the DEK. Deliberately NOT used on the plain path:
 * there store.getBudgetId() is always set, and a backup import deliberately adopts the id from
 * the file (data.ts), which the ledger fallback would then second-guess.
 */
export function e2eeReplicaBudgetId(): string {
  return store.getBudgetId() || store.getLedger()?.budgets?.[0]?.id || "";
}

export function isEmptyUnboundReplica(): boolean {
  if (store.getBudgetId()) return false;
  const l = store.getLedger();
  if (!l) return true;
  return (
    l.accounts.length === 0 &&
    l.groups.length === 0 &&
    l.envelopes.length === 0 &&
    l.transactions.length === 0 &&
    l.allocations.length === 0 &&
    l.categories.length === 0 &&
    l.places.length === 0
  );
}
