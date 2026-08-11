import { describe, expect, it } from "bun:test";
import { applyOp } from "./applyOp";
import { clientLedgerSchema, REPLICATED_TABLES, type SyncOp } from "./ops";
import { asClientLedger, grp } from "./ledger.test-support";

describe("budget entity", () => {
  const base = () =>
    ({ ...asClientLedger({ accounts: [], groups: [grp({ id: "33333333-3333-3333-3333-333333333333" })], envelopes: [], allocations: [], transactions: [] }), budgets: [{ id: "11111111-1111-1111-1111-111111111111", name: "Budżet", currency: "PLN" }] });

  it("budget.update sets the currency; unknown id is a no-op", () => {
    const op: SyncOp = { opId: "o1", kind: "budget.update", payload: { id: "11111111-1111-1111-1111-111111111111", currency: "EUR" } as never };
    expect(applyOp(base(), op).budgets[0]!.currency).toBe("EUR");
    const miss: SyncOp = { opId: "o2", kind: "budget.update", payload: { id: "22222222-2222-2222-2222-222222222222", currency: "USD" } as never };
    expect(applyOp(base(), miss).budgets[0]!.currency).toBe("PLN");
  });

  it("clientLedgerSchema accepts ledgers with and without budgets (old backups)", () => {
    const l = base();
    expect(clientLedgerSchema.safeParse(l).success).toBe(true);
    const { budgets: _b, ...old } = l;
    expect(clientLedgerSchema.safeParse(old).success).toBe(true);
  });

  it("budgets is a replicated table", () => {
    expect(REPLICATED_TABLES).toContain("budgets");
  });
});
