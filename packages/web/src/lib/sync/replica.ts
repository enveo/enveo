/**
 * Stateless helpers over the REPLICA (store + outbox) shared by several sync modules
 * (workflow §3c-3 — a map-extension: transport, identity, cycle and the local-mode
 * transitions all need these, and hosting them in any one of those layers would force
 * either an import cycle or duplicated logic). No mutable module state lives here.
 */
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

/**
 * An EMPTY replica that is bound to NO budget: it carries no data and names no server budget, so
 * it can prove nothing and restore nothing — the only thing a full-budget replace built from it
 * can do is DESTROY the session user's budget. It is reachable: "Clear local data" while in local
 * mode leaves exactly this (bootLocalReady puts an EMPTY_LEDGER with no budgetId in place), and
 * so does the discard of a foreign replica.
 */
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
