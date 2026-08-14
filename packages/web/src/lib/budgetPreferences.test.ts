import { describe, expect, it } from "bun:test";
import { type Budget, type BudgetPreferencesPatch, createDefaultBudgetPreferences } from "@enveo/shared";
import { createBudgetPreferencesStore } from "./budgetPreferences";

const BUDGET_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("budget preference store", () => {
  it("returns reconciled defaults when the replica has no budget preferences", () => {
    const budget = { id: BUDGET_ID, name: "Home", currency: "PLN", preferences: undefined } as unknown as Budget;
    const store = createBudgetPreferencesStore({ readBudget: () => budget, subscribe: () => () => {}, update: () => {} });

    expect(store.getSnapshot()).toEqual(createDefaultBudgetPreferences());
  });

  it("turns a widget or model edit into one budget.preferences.update mutation", () => {
    const budget: Budget = { id: BUDGET_ID, name: "Home", currency: "PLN", preferences: createDefaultBudgetPreferences() };
    const calls: Array<{ id: string; patch: BudgetPreferencesPatch }> = [];
    const store = createBudgetPreferencesStore({
      readBudget: () => budget,
      subscribe: () => () => {},
      update: (id, patch) => calls.push({ id, patch }),
    });

    store.update({ openaiModel: "gpt-5.6-sol" });

    expect(calls).toEqual([{ id: BUDGET_ID, patch: { openaiModel: "gpt-5.6-sol" } }]);
  });

  it("keeps a stable snapshot while the budget preference object is unchanged", () => {
    const budget: Budget = { id: BUDGET_ID, name: "Home", currency: "PLN", preferences: createDefaultBudgetPreferences() };
    const store = createBudgetPreferencesStore({ readBudget: () => budget, subscribe: () => () => {}, update: () => {} });

    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
});
