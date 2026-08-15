import { type Budget, type BudgetPreferences, type BudgetPreferencesPatch, createDefaultBudgetPreferences, reconcileBudgetPreferences } from "@enveo/shared";
import { local } from "./mutate";
import { store } from "./store";

export interface BudgetPreferencesStoreDeps {
  readBudget(): Budget | undefined;
  subscribe(listener: () => void): () => void;
  update(id: string, patch: BudgetPreferencesPatch): void;
}

export function createBudgetPreferencesStore(deps: BudgetPreferencesStoreDeps) {
  let lastRaw: unknown = Symbol("unread");
  let lastBudgetId: string | undefined;
  let snapshot: BudgetPreferences = createDefaultBudgetPreferences();

  function getSnapshot(): BudgetPreferences {
    const budget = deps.readBudget();
    const raw = budget?.preferences;
    if (raw !== lastRaw || budget?.id !== lastBudgetId) {
      lastRaw = raw;
      lastBudgetId = budget?.id;
      snapshot = reconcileBudgetPreferences(raw);
    }
    return snapshot;
  }

  function update(patch: BudgetPreferencesPatch): void {
    const budget = deps.readBudget();
    if (!budget) return;
    deps.update(budget.id, patch);
  }

  return { getSnapshot, subscribe: deps.subscribe, update };
}

export const budgetPreferences = createBudgetPreferencesStore({
  readBudget: () => store.getLedger()?.budgets[0],
  subscribe: store.subscribe,
  update: (id, patch) => local.updateBudgetPreferences(id, patch),
});
