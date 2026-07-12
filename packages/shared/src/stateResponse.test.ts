import { describe, expect, it } from "bun:test";
import { computeBudgetState } from "./budget";
import { computeStateResponse } from "./stateResponse";
import { acc, alloc, deepFreeze, env, grp, tx } from "./test-helpers";
import type { ClientLedger } from "./types";

function fixture(): ClientLedger {
  const g = grp({ id: "G1" });
  const a1 = acc({ id: "A1", initialBalance: 100_00 });
  const a2 = acc({ id: "A2", onBudget: false, initialBalance: 500_00 });
  const e1 = env("G1", { id: "E1" });
  return {
    accounts: [a1, a2],
    groups: [g],
    envelopes: [e1],
    allocations: [alloc("E1", "2026-06", 50_00)],
    transactions: [
      // deliberately in the "wrong" order — the sort must arrange them
      tx({ id: "T-old", accountId: "A1", envelopeId: "E1", amount: 1_00, date: "2026-06-03", createdAt: "2026-06-03T08:00:00Z" }),
      tx({ id: "T-july", accountId: "A1", envelopeId: "E1", amount: 2_00, date: "2026-07-01", createdAt: "2026-07-01T08:00:00Z" }),
      tx({ id: "T-morning", accountId: "A1", envelopeId: "E1", amount: 3_00, date: "2026-06-10", createdAt: "2026-06-10T07:00:00Z" }),
      tx({ id: "T-evening", accountId: "A1", envelopeId: "E1", amount: 4_00, date: "2026-06-10", createdAt: "2026-06-10T21:00:00Z" }),
      tx({ id: "T-uncleared", accountId: "A1", envelopeId: "E1", amount: 5_00, date: "2026-06-20", confirmed: false, createdAt: "2026-06-20T08:00:00Z" }),
    ],
    categories: [{ id: "C1", name: "Jedzenie" }],
    places: [{ id: "P1", name: "Lidl" }],
    recurrences: [],
  };
}

describe("computeStateResponse", () => {
  it("filters transactions to the month and sorts: date descending, then createdAt descending", () => {
    const resp = computeStateResponse(deepFreeze(fixture()), "2026-06");
    expect(resp.month).toBe("2026-06");
    expect(resp.transactions.map((t) => t.id)).toEqual([
      "T-uncleared", // 2026-06-20
      "T-evening", // 2026-06-10, later createdAt before the earlier one
      "T-morning",
      "T-old", // 2026-06-03
    ]);
  });

  it("flattens accounts and envelopes (entity fields + computed values side by side)", () => {
    const l = fixture();
    const resp = computeStateResponse(l, "2026-06");
    const state = computeBudgetState(l, "2026-06");

    expect(resp.accounts).toHaveLength(2);
    const a1 = resp.accounts[0]!;
    // entity fields…
    expect(a1.id).toBe("A1");
    expect(a1.initialBalance).toBe(100_00);
    expect(a1.onBudget).toBe(true);
    // …and computeBudgetState computations next to them
    expect(a1.balance).toBe(state.accounts[0]!.balance);
    expect(a1.cleared).toBe(state.accounts[0]!.cleared);
    expect(a1.uncleared).toBe(a1.balance - a1.cleared);
    expect(a1.uncleared).toBe(-5_00); // unconfirmed T-uncleared

    const e1 = resp.envelopes[0]!;
    expect(e1.id).toBe("E1");
    expect(e1.groupId).toBe("G1");
    expect(e1.allocated).toBe(50_00);
    expect(e1.spent).toBe(1_00 + 3_00 + 4_00 + 5_00);
    expect(e1.available).toBe(50_00 - 13_00);
    expect(e1.carryIn).toBe(0);

    // aggregate headers — exactly from computeBudgetState
    expect(resp.toBeBudgeted).toBe(state.toBeBudgeted);
    expect(resp.monthIncome).toBe(state.monthIncome);
    expect(resp.monthExpense).toBe(13_00);
    expect(resp.groups).toEqual(l.groups);
  });

  it("categories and places pass through unchanged (passthrough)", () => {
    const l = fixture();
    const resp = computeStateResponse(l, "2026-06");
    expect(resp.categories).toBe(l.categories);
    expect(resp.places).toBe(l.places);
  });

  it("another month: filter + envelope carry-in", () => {
    const resp = computeStateResponse(fixture(), "2026-07");
    expect(resp.transactions.map((t) => t.id)).toEqual(["T-july"]);
    expect(resp.envelopes[0]!.carryIn).toBe(50_00 - 13_00);
    expect(resp.envelopes[0]!.available).toBe(50_00 - 13_00 - 2_00);
  });

  it("an empty month yields an empty transaction list", () => {
    const resp = computeStateResponse(fixture(), "2025-01");
    expect(resp.transactions).toEqual([]);
  });
});
