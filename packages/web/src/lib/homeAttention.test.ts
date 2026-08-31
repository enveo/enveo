/**
 * `attentionRows` (homeAttention.ts) — pure, no DOM. Fixture builders mirror `reportSummary.test.ts`'s
 * `envRow` idiom: a full-shape default plus a partial override, so every test states only the
 * fields it cares about.
 */
import { describe, expect, test } from "bun:test";
import type { AccountView, EnvelopeView, StateResponse } from "@enveo/shared";
import { attentionRows } from "./homeAttention";
import { budgetPace } from "./reportSummary";

let envSeq = 0;
function envelope(over: Partial<EnvelopeView> = {}): EnvelopeView {
  envSeq += 1;
  return {
    id: `env-${envSeq}`,
    groupId: "g1",
    name: `Envelope ${envSeq}`,
    color: "#000",
    icon: "tag",
    note: null,
    monthlyTarget: null,
    isSavings: false,
    sort: 0,
    archived: false,
    carryIn: 0,
    allocated: 0,
    spent: 0,
    available: 0,
    ...over,
  };
}

let accSeq = 0;
function account(over: Partial<AccountView> = {}): AccountView {
  accSeq += 1;
  return {
    id: `acc-${accSeq}`,
    name: `Account ${accSeq}`,
    color: "#000",
    icon: "wallet",
    type: "checking",
    onBudget: true,
    initialBalance: 0,
    archived: false,
    sort: 0,
    automaticEnvelopeId: null,
    balance: 0,
    ...over,
  };
}

function state(over: Partial<StateResponse> = {}): StateResponse {
  return {
    month: "2026-08",
    toBeBudgeted: 0,
    readyToAssign: 0,
    monthIncome: 0,
    monthExpense: 0,
    accounts: [],
    groups: [],
    envelopes: [],
    transactions: [],
    categories: [],
    places: [],
    ...over,
  };
}

describe("attentionRows", () => {
  test("an empty state produces no rows", () => {
    // given: a budget with no envelopes, no accounts, nothing to assign
    // when / then
    expect(attentionRows(state(), 0.5)).toEqual([]);
  });

  test("a zero-budget overspent envelope appears as an 'over' row — left < 0, never pct > 100", () => {
    // given: an envelope with NO allocation or carry-in but real spending (rawBudget === 0)
    const rent = envelope({ name: "Rent", allocated: 0, carryIn: 0, spent: 12000 });

    // when
    const rows = attentionRows(state({ envelopes: [rent] }), 0.5);

    // then: the zero-budget denominator never masks the overspend behind a percentage check
    expect(rows).toEqual([{ kind: "over", n: 1, name: "Rent", amount: 12000 }]);
  });

  test("multiple overspent envelopes fold into one aggregate row with no single name", () => {
    const a = envelope({ name: "Rent", allocated: 0, spent: 5000 });
    const b = envelope({ name: "Utilities", allocated: 1000, spent: 1300 });

    const rows = attentionRows(state({ envelopes: [a, b] }), 0.5);

    expect(rows).toEqual([{ kind: "over", n: 2, name: null, amount: 5000 + 300 }]);
  });

  test("a risk row carries the SAME projected value budgetPace itself computes for that envelope", () => {
    // given: half the month gone, an envelope already on pace to bust its budget
    const groceries = envelope({ name: "Groceries", allocated: 100_00, carryIn: 0, spent: 40_00 });
    const progress = 0.2;

    // when
    const rows = attentionRows(state({ envelopes: [groceries] }), progress);

    // then: no independent re-derivation — the row's `projected` is budgetPace's own number
    const expectedProjected = budgetPace(groceries, progress).projected;
    expect(expectedProjected).toBeGreaterThan(groceries.allocated); // sanity: this fixture IS a risk case
    expect(rows).toEqual([{ kind: "risk", name: "Groceries", projected: expectedProjected, envelopeId: groceries.id }]);
  });

  test("risk rows are NOT aggregated — one row per at-risk envelope", () => {
    const a = envelope({ name: "Groceries", allocated: 100_00, spent: 40_00 });
    const b = envelope({ name: "Fuel", allocated: 50_00, spent: 20_00 });
    const progress = 0.2;

    const rows = attentionRows(state({ envelopes: [a, b] }), progress);

    expect(rows).toEqual([
      { kind: "risk", name: "Groceries", projected: budgetPace(a, progress).projected, envelopeId: a.id },
      { kind: "risk", name: "Fuel", projected: budgetPace(b, progress).projected, envelopeId: b.id },
    ]);
  });

  test("a positive pool of unassigned money produces a 'pool' row", () => {
    const rows = attentionRows(state({ readyToAssign: 3000 }), 0.5);
    expect(rows).toEqual([{ kind: "pool", amount: 3000 }]);
  });

  test("assigning more than available produces an 'overAssigned' row with a POSITIVE magnitude", () => {
    const rows = attentionRows(state({ readyToAssign: -1500 }), 0.5);
    expect(rows).toEqual([{ kind: "overAssigned", amount: 1500 }]);
  });

  test("readyToAssign exactly zero yields neither a pool nor an overAssigned row", () => {
    const rows = attentionRows(state({ readyToAssign: 0 }), 0.5);
    expect(rows.some((r) => r.kind === "pool" || r.kind === "overAssigned")).toBe(false);
  });

  test("envelopes short of their monthly goal aggregate into one 'goals' row", () => {
    const a = envelope({ monthlyTarget: 10000, allocated: 4000 }); // missing 6000
    const b = envelope({ monthlyTarget: 5000, allocated: 5000 }); // funded — no shortfall
    const c = envelope({ monthlyTarget: null, allocated: 0 }); // no goal at all

    const rows = attentionRows(state({ envelopes: [a, b, c] }), 0.5);

    expect(rows).toEqual([{ kind: "goals", n: 1, amount: 6000 }]);
  });

  test("an archived envelope's shortfall never counts toward the 'goals' row", () => {
    const archived = envelope({ monthlyTarget: 10000, allocated: 0, archived: true });
    const rows = attentionRows(state({ envelopes: [archived] }), 0.5);
    expect(rows.some((r) => r.kind === "goals")).toBe(false);
  });

  test("accounts sums CURRENT negative balances into one 'debt' row", () => {
    const a = account({ name: "Credit card", balance: -4500 });
    const b = account({ name: "Overdraft", balance: -1200 });
    const positive = account({ name: "Checking", balance: 20000 });

    const rows = attentionRows(state({ accounts: [a, b, positive] }), 0.5);

    expect(rows).toEqual([{ kind: "debt", n: 2, name: null, amount: 4500 + 1200 }]);
  });

  test("a single account in the red keeps its own name on the 'debt' row", () => {
    const only = account({ name: "Overdraft", balance: -900 });
    const rows = attentionRows(state({ accounts: [only] }), 0.5);
    expect(rows).toEqual([{ kind: "debt", n: 1, name: "Overdraft", amount: 900 }]);
  });

  test("an archived account's negative balance never counts toward 'debt'", () => {
    const archived = account({ balance: -900, archived: true });
    const rows = attentionRows(state({ accounts: [archived] }), 0.5);
    expect(rows).toEqual([]);
  });

  test("row ordering is fixed: over → risk → pool → goals → debt, with a positive pool", () => {
    const over = envelope({ name: "Rent", allocated: 0, spent: 5000 });
    const risk = envelope({ name: "Groceries", allocated: 10000, spent: 4000 });
    const goal = envelope({ monthlyTarget: 8000, allocated: 3000 });
    const debtAcc = account({ name: "Overdraft", balance: -700 });

    const rows = attentionRows(state({ envelopes: [over, risk, goal], accounts: [debtAcc], readyToAssign: 200 }), 0.2);

    expect(rows.map((r) => r.kind)).toEqual(["over", "risk", "pool", "goals", "debt"]);
  });

  test("row ordering keeps overAssigned in the same slot pool would occupy", () => {
    const over = envelope({ name: "Rent", allocated: 0, spent: 5000 });
    const risk = envelope({ name: "Groceries", allocated: 10000, spent: 4000 });
    const goal = envelope({ monthlyTarget: 8000, allocated: 3000 });
    const debtAcc = account({ name: "Overdraft", balance: -700 });

    const rows = attentionRows(state({ envelopes: [over, risk, goal], accounts: [debtAcc], readyToAssign: -200 }), 0.2);

    expect(rows.map((r) => r.kind)).toEqual(["over", "risk", "overAssigned", "goals", "debt"]);
  });
});
