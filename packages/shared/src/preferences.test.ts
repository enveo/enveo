import { describe, expect, test } from "bun:test";
import { opSchemas } from "./ops";
import {
  accountPreferencesPatchSchema,
  budgetPreferencesPatchSchema,
  budgetPreferencesSchema,
  createDefaultAccountPreferences,
  createDefaultBudgetPreferences,
  createDefaultWideWidgets,
  reconcileBudgetPreferences,
  resolveAccentTheme,
} from "./preferences";

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
      "attention",
      "recent",
      "spending",
      "goals",
      "trends",
      "heatmap",
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

  test("accepts every quick action currently offered by the dashboard editor", () => {
    const actions = ["expense", "transfer", "import", "suggest", "discreet", "darkMode", "reports"];
    const preferences = reconcileBudgetPreferences({ startWidgets: [{ id: "quickActions", enabled: true, opts: { actions } }] });

    expect(preferences.startWidgets[0]).toEqual({ id: "quickActions", enabled: true, opts: { actions } });
  });

  test("the six new phone widget ids validate optionless in startWidgets", () => {
    const ids = ["attention", "recent", "spending", "goals", "trends", "heatmap"];
    const preferences = reconcileBudgetPreferences({ startWidgets: ids.map((id) => ({ id, enabled: true })) });

    for (const id of ids) {
      expect(preferences.startWidgets.find((widget) => widget.id === id)).toEqual({ id, enabled: true });
    }
  });
});

describe("schemaVersion 2 — wideWidgets migration", () => {
  test("a v1 preferences object upgrades: every v1 field survives, wideWidgets gets the default board", () => {
    const v1 = {
      schemaVersion: 1,
      aiProvider: "openai",
      openaiModel: "gpt-5.5",
      customProfiles: [{ id: crypto.randomUUID(), name: "n", prompt: "p" }],
      startWidgets: [{ id: "envelopes", enabled: true, opts: { mode: "savings" } }],
    };
    const out = reconcileBudgetPreferences(v1);
    expect(out.schemaVersion).toBe(2);
    expect(out.aiProvider).toBe("openai");
    expect(out.startWidgets[0]).toEqual({ id: "envelopes", enabled: true, opts: { mode: "savings" } });
    expect(out.wideWidgets).toEqual(createDefaultWideWidgets());
  });

  test("oldest replica shape: a row with NO wideWidgets key (not null — absent) normalises at the boundary", () => {
    const stored = { ...createDefaultBudgetPreferences() } as Record<string, unknown>;
    delete stored.wideWidgets; // the pre-v2 replica row shape — pinned per the house rule
    const out = reconcileBudgetPreferences(stored);
    expect(out.wideWidgets).toEqual(createDefaultWideWidgets());
  });

  test("phone-only ids, unknown ids, dupes and out-of-range spans are dropped from wideWidgets, then defaults backfill", () => {
    const out = reconcileBudgetPreferences({
      ...createDefaultBudgetPreferences(),
      wideWidgets: [
        { id: "quickActions", enabled: true, w: 1, h: 1 }, // phone-only → dropped by schema
        { id: "recent", enabled: true, w: 9, h: 1 }, // w out of range → dropped, default appended
        { id: "spending", enabled: true, w: 2, h: 2 },
        { id: "spending", enabled: false, w: 1, h: 1 }, // dupe → first wins
      ],
    });
    expect(out.wideWidgets.filter((widget) => widget.id === "spending")).toEqual([{ id: "spending", enabled: true, w: 2, h: 2 }]);
    expect(out.wideWidgets.some((widget) => (widget.id as string) === "quickActions")).toBe(false);
    expect(out.wideWidgets.find((widget) => widget.id === "recent")).toEqual(createDefaultWideWidgets().find((widget) => widget.id === "recent"));
  });

  test("`scroll` is additive-optional: a widget row with no `scroll` key at all still reconciles, and gains no injected default", () => {
    const stored = { id: "reportCashflow", enabled: true, w: 3, h: 1 } as Record<string, unknown>;
    expect("scroll" in stored).toBe(false); // pinned per the house rule: absent, not `undefined`-valued
    const out = reconcileBudgetPreferences({ wideWidgets: [stored] });
    const cashflow = out.wideWidgets.find((widget) => widget.id === "reportCashflow")!;
    expect(cashflow).toEqual({ id: "reportCashflow", enabled: true, w: 3, h: 1 });
    expect("scroll" in cashflow).toBe(false);
  });

  test("`scroll` survives reconciliation when the client sets it explicitly, for every wide widget id", () => {
    const out = reconcileBudgetPreferences({
      wideWidgets: [
        { id: "reportNetWorth", enabled: true, w: 1, h: 1, scroll: true },
        { id: "recent", enabled: true, w: 2, h: 4, scroll: false },
      ],
    });
    expect(out.wideWidgets.find((widget) => widget.id === "reportNetWorth")!.scroll).toBe(true);
    expect(out.wideWidgets.find((widget) => widget.id === "recent")!.scroll).toBe(false);
  });

  test("reconcile is idempotent", () => {
    const once = reconcileBudgetPreferences({ aiProvider: "openai", wideWidgets: [{ id: "goals", enabled: false, w: 1, h: 1 }] });
    expect(reconcileBudgetPreferences(once)).toEqual(once);
  });

  test("budgetPreferencesSchema is v2: parses the reconciled default and rejects a v1 object", () => {
    expect(budgetPreferencesSchema.safeParse(createDefaultBudgetPreferences()).success).toBe(true);
    const v1 = {
      schemaVersion: 1,
      aiProvider: "rules",
      openaiModel: "gpt-5.6-luna",
      customProfiles: [],
      startWidgets: createDefaultBudgetPreferences().startWidgets,
    };
    expect(budgetPreferencesSchema.safeParse(v1).success).toBe(false);
  });
});

describe("preference patch schemas", () => {
  test("account patches are strict and non-empty", () => {
    expect(accountPreferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(accountPreferencesPatchSchema.safeParse({ lang: "pl" }).success).toBe(true);
    expect(accountPreferencesPatchSchema.safeParse({ themeMode: "dark" }).success).toBe(true);
    expect(accountPreferencesPatchSchema.safeParse({ accentTheme: "duet" }).success).toBe(true);
    expect(accountPreferencesPatchSchema.safeParse({ accentTheme: "auto" }).success).toBe(true);
    expect(accountPreferencesPatchSchema.safeParse({ accentTheme: "koral" }).success).toBe(false);
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
    expect(budgetPreferencesPatchSchema.safeParse({ wideWidgets: defaults.wideWidgets }).success).toBe(true);
    expect(budgetPreferencesPatchSchema.safeParse({}).success).toBe(false);
  });

  test("the sync operation validates a known non-empty patch", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(opSchemas["budget.preferences.update"].safeParse({ id, patch: { aiProvider: "openai" } }).success).toBe(true);
    expect(opSchemas["budget.preferences.update"].safeParse({ id, patch: {} }).success).toBe(false);
    expect(opSchemas["budget.preferences.update"].safeParse({ id, patch: { schemaVersion: 1 } }).success).toBe(false);
  });
});

describe("account accent theme", () => {
  test("a fresh account stores 'auto', which resolves to Duet on a phone and Cisza on anything wider", () => {
    expect(createDefaultAccountPreferences().accentTheme).toBe("auto");
    expect(resolveAccentTheme("auto", true)).toBe("duet");
    expect(resolveAccentTheme("auto", false)).toBe("teal");
    expect(resolveAccentTheme("duet", false)).toBe("duet");
    expect(resolveAccentTheme("teal", true)).toBe("teal");
  });
});
