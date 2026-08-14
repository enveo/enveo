import { describe, expect, test } from "bun:test";
import { opSchemas } from "./ops";
import { accountPreferencesPatchSchema, budgetPreferencesPatchSchema, createDefaultBudgetPreferences, reconcileBudgetPreferences } from "./preferences";

describe("reconcileBudgetPreferences", () => {
  test("returns a fresh complete default for absent data", () => {
    const first = reconcileBudgetPreferences(undefined);
    const second = reconcileBudgetPreferences(undefined);

    expect(first).toEqual(createDefaultBudgetPreferences());
    expect(first).not.toBe(second);
    expect(first.startWidgets).not.toBe(second.startWidgets);
  });

  test("keeps valid partial legacy data and fills missing fields", () => {
    const preferences = reconcileBudgetPreferences({
      aiProvider: "openai",
      openaiModel: "gpt-5.6-sol",
      customProfiles: [{ id: "11111111-1111-4111-8111-111111111111", name: "Careful", prompt: "Keep a buffer" }],
    });

    expect(preferences.aiProvider).toBe("openai");
    expect(preferences.openaiModel).toBe("gpt-5.6-sol");
    expect(preferences.customProfiles).toHaveLength(1);
    expect(preferences.startWidgets).toEqual(createDefaultBudgetPreferences().startWidgets);
  });

  test("falls back field by field when scalar values are corrupt", () => {
    const preferences = reconcileBudgetPreferences({ aiProvider: "other", openaiModel: 42 });

    expect(preferences.aiProvider).toBe("rules");
    expect(preferences.openaiModel).toBe("gpt-5.6-luna");
  });

  test("drops unknown and duplicate widgets, preserves valid order, and appends missing defaults", () => {
    const preferences = reconcileBudgetPreferences({
      startWidgets: [
        { id: "accounts", enabled: false, opts: { collapsed: false, count: 8 } },
        { id: "future-widget", enabled: true },
        { id: "accounts", enabled: true },
        { id: "quickActions", enabled: true, opts: { actions: ["suggest", "expense"] } },
      ],
    });

    expect(preferences.startWidgets.slice(0, 2)).toEqual([
      { id: "accounts", enabled: false, opts: { collapsed: false, count: 8 } },
      { id: "quickActions", enabled: true, opts: { actions: ["suggest", "expense"] } },
    ]);
    expect(preferences.startWidgets.map((widget) => widget.id)).toEqual([
      "accounts",
      "quickActions",
      "envelopes",
      "envelopesSavings",
      "reportCashflow",
      "reportNetWorth",
    ]);
  });

  test("replaces widgets with invalid references or option shapes by their defaults", () => {
    const preferences = reconcileBudgetPreferences({
      startWidgets: [
        { id: "accounts", enabled: true, opts: { picked: ["not-a-uuid"] } },
        { id: "envelopes", enabled: true, opts: { mode: "group:not-a-uuid" } },
        { id: "quickActions", enabled: true, opts: { actions: ["expense", "unknown"] } },
      ],
    });

    expect(preferences.startWidgets).toEqual(createDefaultBudgetPreferences().startWidgets);
  });
});

describe("preference patch schemas", () => {
  test("account patches are strict and non-empty", () => {
    expect(accountPreferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(accountPreferencesPatchSchema.safeParse({ lang: "pl" }).success).toBe(true);
    expect(accountPreferencesPatchSchema.safeParse({ themeMode: "dark" }).success).toBe(true);
    expect(accountPreferencesPatchSchema.safeParse({ accentTheme: "duet" }).success).toBe(true);
    expect(accountPreferencesPatchSchema.safeParse({ lang: "pl", unknown: true }).success).toBe(false);
  });

  test("budget patches reject empty, unknown, and schemaVersion fields", () => {
    expect(budgetPreferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(budgetPreferencesPatchSchema.safeParse({ schemaVersion: 1 }).success).toBe(false);
    expect(budgetPreferencesPatchSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  test("budget patches accept each durable field independently", () => {
    const defaults = createDefaultBudgetPreferences();
    expect(budgetPreferencesPatchSchema.safeParse({ aiProvider: "enveo" }).success).toBe(true);
    expect(budgetPreferencesPatchSchema.safeParse({ openaiModel: "gpt-5.6-terra" }).success).toBe(true);
    expect(budgetPreferencesPatchSchema.safeParse({ customProfiles: defaults.customProfiles }).success).toBe(true);
    expect(budgetPreferencesPatchSchema.safeParse({ startWidgets: defaults.startWidgets }).success).toBe(true);
  });

  test("the sync operation validates a known non-empty patch", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(opSchemas["budget.preferences.update"].safeParse({ id, patch: { aiProvider: "openai" } }).success).toBe(true);
    expect(opSchemas["budget.preferences.update"].safeParse({ id, patch: {} }).success).toBe(false);
    expect(opSchemas["budget.preferences.update"].safeParse({ id, patch: { schemaVersion: 1 } }).success).toBe(false);
  });
});
