/**
 * Enveo AI requires server-visible budget data and is therefore impossible on E2EE.
 * Call this only after pending/peer work has been reconciled onto the mirror: when a stale
 * Enveo preference won that ordering, the normal local mutation path appends one terminal
 * rules operation. The mirror change makes repeated calls idempotent.
 */
import * as e2ee from "./e2ee";
import { local } from "./mutate";
import { store } from "./store";
import { replayOutbox } from "./sync/replica";

export function ensureE2eeProviderPreference(): boolean {
  if (e2ee.getTierMeta().tier !== "e2ee") return false;
  const budget = store.getLedger()?.budgets[0];
  if (budget?.preferences.aiProvider !== "enveo") return false;
  local.updateBudgetPreferences(budget.id, { aiProvider: "rules" });
  return true;
}

/** Boot/tier-adoption seam: pending work wins first, then the privacy invariant wins last. */
export function replayPendingWithE2eeProviderPreference(): boolean {
  replayOutbox();
  return ensureE2eeProviderPreference();
}
