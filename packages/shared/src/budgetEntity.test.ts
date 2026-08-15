import { describe, expect, it } from "bun:test";
import { applyOp } from "./applyOp";
import { asClientLedger, grp } from "./ledger.test-support";
import { clientLedgerSchema, REPLICATED_TABLES, type SyncOp } from "./ops";
import { createDefaultBudgetPreferences } from "./preferences";

describe("budget entity", () => {
  const base = () => ({
    ...asClientLedger({ accounts: [], groups: [grp({ id: "33333333-3333-3333-3333-333333333333" })], envelopes: [], allocations: [], transactions: [] }),
    budgets: [{ id: "11111111-1111-1111-1111-111111111111", name: "Budżet", currency: "PLN", preferences: createDefaultBudgetPreferences() }],
  });

  it("budget.update sets the currency; unknown id is a no-op", () => {
    const op: SyncOp = { opId: "o1", kind: "budget.update", payload: { id: "11111111-1111-1111-1111-111111111111", currency: "EUR" } as never };
    expect(applyOp(base(), op).budgets[0]!.currency).toBe("EUR");
    const miss: SyncOp = { opId: "o2", kind: "budget.update", payload: { id: "22222222-2222-2222-2222-222222222222", currency: "USD" } as never };
    expect(applyOp(base(), miss).budgets[0]!.currency).toBe("PLN");
  });

  it("clientLedgerSchema accepts ledgers with and without budgets (old backups)", () => {
    const l = base();
    expect(clientLedgerSchema.safeParse(l).success).toBe(true);
    const withoutPreferences = { ...l, budgets: l.budgets.map(({ preferences: _preferences, ...budget }) => budget) };
    const parsed = clientLedgerSchema.parse(withoutPreferences);
    expect(parsed.budgets?.[0]?.preferences).toEqual(createDefaultBudgetPreferences());
    const { budgets: _b, ...old } = l;
    expect(clientLedgerSchema.safeParse(old).success).toBe(true);
  });

  it("applies disjoint budget preference patches without replacing unrelated fields", () => {
    const widgets = createDefaultBudgetPreferences().startWidgets.toReversed();
    const widgetOp: SyncOp = {
      opId: "o3",
      kind: "budget.preferences.update",
      payload: { id: "11111111-1111-1111-1111-111111111111", patch: { startWidgets: widgets } } as never,
    };
    const modelOp: SyncOp = {
      opId: "o4",
      kind: "budget.preferences.update",
      payload: { id: "11111111-1111-1111-1111-111111111111", patch: { openaiModel: "gpt-5.6-sol" } } as never,
    };

    const afterWidgets = applyOp(base(), widgetOp);
    const afterModel = applyOp(afterWidgets, modelOp);

    expect(afterWidgets.budgets[0]!.preferences.openaiModel).toBe("gpt-5.6-luna");
    expect(afterModel.budgets[0]!.preferences.openaiModel).toBe("gpt-5.6-sol");
    expect(afterModel.budgets[0]!.preferences.startWidgets).toEqual(widgets);
  });

  it("is idempotent on replay and refuses a missing budget", () => {
    const op: SyncOp = {
      opId: "o5",
      kind: "budget.preferences.update",
      payload: { id: "11111111-1111-1111-1111-111111111111", patch: { aiProvider: "enveo" } } as never,
    };
    const once = applyOp(base(), op);
    expect(applyOp(once, op)).toEqual(once);

    const missing: SyncOp = {
      opId: "o6",
      kind: "budget.preferences.update",
      payload: { id: "22222222-2222-2222-2222-222222222222", patch: { aiProvider: "openai" } } as never,
    };
    expect(applyOp(once, missing)).toBe(once);
  });

  it("budgets is a replicated table", () => {
    expect(REPLICATED_TABLES).toContain("budgets");
  });
});
