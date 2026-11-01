import { describe, expect, test } from "bun:test";
import { clientLedgerSchema } from "../ops";
import type { Budget } from "../types";
import { ActualExportError, type ActualTables, actualTablesToMigrationSource } from "./actual";
import { buildMigrationLedger, type MigrationResult } from "./ledger";

const budget: Budget = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Budget",
  currency: "USD",
  preferences: {} as Budget["preferences"],
};

function aTransaction(id: string, amount: number, date: number, over: Partial<ActualTables["transactions"][number]> = {}) {
  return {
    id,
    isParent: 0,
    isChild: 0,
    parent_id: null,
    acct: "checking",
    category: "food",
    amount,
    description: "market",
    notes: null,
    date,
    transferred_id: null,
    tombstone: 0,
    ...over,
  };
}

function tables(over: Partial<ActualTables> = {}): ActualTables {
  return {
    budgetName: "Sample household",
    accounts: [
      { id: "checking", name: "Everyday Checking", offbudget: 0, closed: 0, tombstone: 0, type: null, sort_order: 1 },
      { id: "brokerage", name: "Brokerage", offbudget: 1, closed: 0, tombstone: 0, type: "investment", sort_order: 2 },
    ],
    groups: [
      { id: "living", name: "Living", is_income: 0, hidden: 0, tombstone: 0, sort_order: 1 },
      { id: "income", name: "Income", is_income: 1, hidden: 0, tombstone: 0, sort_order: 2 },
    ],
    categories: [
      { id: "food", name: "Groceries", is_income: 0, cat_group: "living", hidden: 0, tombstone: 0, sort_order: 1 },
      { id: "rent", name: "Rent", is_income: 0, cat_group: "living", hidden: 0, tombstone: 0, sort_order: 2 },
      { id: "pay", name: "Paycheck", is_income: 1, cat_group: "income", hidden: 0, tombstone: 0, sort_order: 3 },
    ],
    categoryMapping: [],
    payees: [
      { id: "market", name: "Linden Market", transfer_acct: null },
      { id: "to-brokerage", name: "", transfer_acct: "brokerage" },
      { id: "to-checking", name: "", transfer_acct: "checking" },
    ],
    payeeMapping: [],
    transactions: [],
    budgets: [],
    preferences: [],
    ...over,
  };
}

function convert(input: ActualTables, month = "2026-09"): MigrationResult {
  let n = 100;
  return buildMigrationLedger(actualTablesToMigrationSource(input, month), {
    budget,
    newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
    envelopeStyle: () => ({ color: "#123456", icon: "tag" }),
    accountStyle: () => ({ color: "#654321", icon: "wallet" }),
  });
}

describe("Actual export conversion", () => {
  test("given income in an income category when converted then no envelope receives it", () => {
    const { ledger } = convert(tables({ transactions: [aTransaction("t1", 300000, 20260901, { category: "pay" })] }));
    expect(ledger.transactions[0]).toMatchObject({ type: "income", amount: 300000, envelopeId: null });
    expect(ledger.envelopes.map((e) => e.name)).toEqual(["Groceries", "Rent"]);
  });

  test("given a split when converted then the children become items and the parent is not counted twice", () => {
    const { ledger, receipt } = convert(
      tables({
        transactions: [
          aTransaction("parent", -20000, 20260806, { isParent: 1, category: null }),
          aTransaction("c1", -15000, 20260806, { isChild: 1, parent_id: "parent", category: "rent" }),
          aTransaction("c2", -5000, 20260806, { isChild: 1, parent_id: "parent" }),
        ],
      }),
    );
    expect(ledger.transactions).toHaveLength(1);
    expect(ledger.transactions[0]!.items.map((item) => item.amount)).toEqual([15000, 5000]);
    expect(receipt.accounts).toBe(2);
    expect(receipt.accountDifferences).toEqual([]);
  });

  test("given a categorized transfer off budget when converted then one transfer takes the money from the envelope", () => {
    const { ledger } = convert(
      tables({
        transactions: [
          aTransaction("out", -25000, 20260903, { category: "rent", description: "to-brokerage", transferred_id: "in" }),
          aTransaction("in", 25000, 20260903, { acct: "brokerage", category: null, description: "to-checking", transferred_id: "out" }),
        ],
      }),
    );
    const rent = ledger.envelopes.find((e) => e.name === "Rent")!;
    expect(ledger.transactions).toHaveLength(1);
    expect(ledger.transactions[0]).toMatchObject({ type: "transfer", amount: 25000, allocationFromEnvelopeId: rent.id });
  });

  test("given a category without rollover when overspent then next month starts at zero like in Actual", () => {
    const { ledger, receipt } = convert(
      tables({
        transactions: [aTransaction("t1", -7000, 20260810)],
        budgets: [
          { month: 202608, category: "food", amount: 5000, carryover: 0 },
          { month: 202609, category: "food", amount: 3000, carryover: 0 },
        ],
      }),
    );
    const food = ledger.envelopes.find((e) => e.name === "Groceries")!;
    expect(ledger.allocations.filter((a) => a.envelopeId === food.id).map((a) => [a.month, a.amount])).toEqual([
      ["2026-08", 5000],
      ["2026-09", 5000],
    ]);
    expect(receipt.envelopeDifferences).toEqual([]);
  });

  test("given a category with rollover when overspent then the negative balance stays", () => {
    const { ledger } = convert(
      tables({
        transactions: [aTransaction("t1", -7000, 20260810)],
        budgets: [{ month: 202608, category: "food", amount: 5000, carryover: 1 }],
      }),
    );
    expect(ledger.allocations.map((a) => [a.month, a.amount])).toEqual([["2026-08", 5000]]);
  });

  test("given deleted rows and a merged category when converted then only live data remains on the surviving category", () => {
    const { ledger } = convert(
      tables({
        categoryMapping: [{ id: "old-food", transferId: "food" }],
        transactions: [aTransaction("gone", -100, 20260801, { tombstone: 1 }), aTransaction("kept", -200, 20260802, { category: "old-food" })],
      }),
    );
    const food = ledger.envelopes.find((e) => e.name === "Groceries")!;
    expect(ledger.transactions.map((t) => [t.amount, t.envelopeId])).toEqual([[200, food.id]]);
  });

  test("given a tracking budget when converted then transactions move but no assignment is invented", () => {
    const { ledger, receipt } = convert(
      tables({
        preferences: [{ id: "budgetType", value: "tracking" }],
        transactions: [aTransaction("t1", -100, 20260801)],
        budgets: [{ month: 202608, category: "food", amount: 5000, carryover: 0 }],
      }),
    );
    expect(ledger.allocations).toEqual([]);
    expect(receipt.trackingOnly).toBe(true);
  });

  test("given a corrupt month when converted then it does not walk the centuries", () => {
    const { ledger } = convert(
      tables({
        budgets: [
          { month: 12, category: "food", amount: 5000, carryover: 0 },
          { month: 202609, category: "food", amount: 100, carryover: 0 },
        ],
      }),
    );
    expect(ledger.allocations.map((a) => [a.month, a.amount])).toEqual([["2026-09", 100]]);
  });

  test("given a stated currency the budget cannot hold when converted then the export is refused", () => {
    expect(() => convert(tables({ preferences: [{ id: "defaultCurrencyCode", value: "JPY" }] }))).toThrow(ActualExportError);
  });

  test("given a converted export when validated then it passes the same schema as a restored backup", () => {
    const { ledger } = convert(tables({ transactions: [aTransaction("t1", -100, 20260801)] }));
    expect(clientLedgerSchema.safeParse(ledger).success).toBe(true);
  });
});
