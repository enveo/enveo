import { describe, expect, test } from "bun:test";
import { clientLedgerSchema } from "../ops";
import type { Budget, Transaction } from "../types";
import { buildMigrationLedger, type MigrationResult } from "./ledger";
import { parseYnabPlan, type YnabPlan, YnabPlanError, ynabPlanToMigrationSource } from "./ynab";

const budget: Budget = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Budget",
  currency: "EUR",
  preferences: {} as Budget["preferences"],
};

function convert(plan: Partial<YnabPlan>, month = "2026-09"): MigrationResult {
  let n = 100;
  const source = ynabPlanToMigrationSource(aPlan(plan), month);
  return buildMigrationLedger(source, {
    budget,
    newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
    envelopeStyle: () => ({ color: "#123456", icon: "tag" }),
    accountStyle: () => ({ color: "#654321", icon: "wallet" }),
  });
}

const account = (id: string, balance: number, over: Partial<YnabPlan["accounts"][number]> = {}) => ({
  id,
  name: `Account ${id}`,
  type: "checking",
  on_budget: true,
  closed: false,
  balance,
  ...over,
});
const category = (id: string, over: Partial<YnabPlan["categories"][number]> = {}) => ({
  id,
  category_group_id: "living",
  name: `Category ${id}`,
  hidden: false,
  ...over,
});
const txn = (id: string, amount: number, over: Partial<YnabPlan["transactions"][number]> = {}) => ({
  id,
  date: "2026-09-10",
  amount,
  account_id: "checking",
  category_id: "groceries",
  ...over,
});
const monthRow = (id: string, budgeted: number, activity: number, balance: number) => ({ id, budgeted, activity, balance });

function aPlan(over: Partial<YnabPlan>): YnabPlan {
  return {
    name: "Sample household",
    currency_format: { iso_code: "USD", decimal_digits: 2 },
    accounts: [account("checking", 0)],
    payees: [{ id: "market", name: "Linden Market" }],
    category_groups: [
      { id: "internal", name: "Internal Master Category", internal: true },
      { id: "living", name: "Living" },
      { id: "cards", name: "Credit Card Payments" },
    ],
    categories: [
      category("inflow", { category_group_id: "internal", internal: true, name: "Inflow: Ready to Assign" }),
      category("groceries", { name: "Groceries" }),
      category("rent", { name: "Rent" }),
    ],
    months: [],
    transactions: [],
    subtransactions: [],
    ...over,
  };
}

const only = (result: MigrationResult): Transaction => {
  expect(result.ledger.transactions).toHaveLength(1);
  return result.ledger.transactions[0]!;
};

describe("YNAB plan conversion", () => {
  test("given an expense when converted then milliunits become a positive amount in the payee's place", () => {
    const row = only(
      convert({
        accounts: [account("checking", -42_500)],
        transactions: [txn("t1", -42_500, { payee_id: "market", memo: "weekly shop" })],
      }),
    );
    expect(row).toMatchObject({ type: "expense", amount: 4250, isRefund: false, name: "Linden Market", note: "weekly shop" });
  });

  test("given money into Ready to Assign when converted then it is income outside any envelope", () => {
    const row = only(convert({ accounts: [account("checking", 300_000)], transactions: [txn("t1", 300_000, { category_id: "inflow" })] }));
    expect(row).toMatchObject({ type: "income", amount: 30000, envelopeId: null });
  });

  test("given an inflow to a spending category when converted then it is a refund on that envelope", () => {
    const row = only(convert({ accounts: [account("checking", 5_000)], transactions: [txn("t1", 5_000)] }));
    expect(row).toMatchObject({ type: "expense", isRefund: true, amount: 500 });
    expect(row.envelopeId).not.toBeNull();
  });

  test("given a transfer when converted then its two sides become one transfer from the paying account", () => {
    const result = convert({
      accounts: [account("checking", -10_000), account("savings", 10_000, { type: "savings" })],
      transactions: [
        txn("in", 10_000, { account_id: "savings", category_id: null, transfer_account_id: "checking", transfer_transaction_id: "out" }),
        txn("out", -10_000, { category_id: null, transfer_account_id: "savings", transfer_transaction_id: "in" }),
      ],
    });
    const row = only(result);
    const ids = new Map(result.ledger.accounts.map((a) => [a.name, a.id]));
    expect(row).toMatchObject({ type: "transfer", amount: 1000, accountId: ids.get("Account checking")!, toAccountId: ids.get("Account savings")! });
    expect(result.receipt.accountDifferences).toEqual([]);
  });

  test("given a categorized transfer off budget when converted then the envelope pays for it", () => {
    const result = convert({
      accounts: [account("checking", -25_000), account("brokerage", 25_000, { on_budget: false, type: "otherAsset" })],
      transactions: [
        txn("in", 25_000, { account_id: "brokerage", category_id: null, transfer_account_id: "checking", transfer_transaction_id: "out" }),
        txn("out", -25_000, { category_id: "rent", transfer_account_id: "brokerage", transfer_transaction_id: "in" }),
      ],
      months: [{ month: "2026-09-01", categories: [monthRow("rent", 30_000, -25_000, 5_000)] }],
    });
    const rent = result.ledger.envelopes.find((e) => e.name === "Rent")!;
    expect(only(result).allocationFromEnvelopeId).toBe(rent.id);
    expect(result.receipt.envelopeDifferences).toEqual([]);
  });

  test("given a split in one direction when converted then it keeps its envelope items", () => {
    const row = only(
      convert({
        accounts: [account("checking", -20_000)],
        transactions: [txn("t1", -20_000, { category_id: null })],
        subtransactions: [
          { id: "s1", transaction_id: "t1", amount: -15_000, category_id: "rent" },
          { id: "s2", transaction_id: "t1", amount: -5_000, category_id: "groceries" },
        ],
      }),
    );
    expect(row.items.map((item) => item.amount)).toEqual([1500, 500]);
    expect(row.amount).toBe(2000);
  });

  test("given a split with a refund line when converted then each line stands alone and the balance still matches", () => {
    const result = convert({
      accounts: [account("checking", -8_000)],
      transactions: [txn("t1", -8_000, { category_id: null })],
      subtransactions: [
        { id: "s1", transaction_id: "t1", amount: -10_000, category_id: "rent" },
        { id: "s2", transaction_id: "t1", amount: 2_000, category_id: "groceries" },
      ],
    });
    expect(result.ledger.transactions.map((t) => [t.isRefund, t.amount])).toEqual([
      [false, 1000],
      [true, 200],
    ]);
    expect(result.receipt.accountDifferences).toEqual([]);
  });

  test("given a split line that is a transfer when its counterpart names the parent then the transfer appears once", () => {
    const result = convert({
      accounts: [account("checking", -30_000), account("savings", 10_000, { type: "savings" })],
      transactions: [
        txn("parent", -30_000, { category_id: null }),
        txn("other", 10_000, { account_id: "savings", category_id: null, transfer_account_id: "checking", transfer_transaction_id: "parent" }),
      ],
      subtransactions: [
        { id: "s1", transaction_id: "parent", amount: -20_000, category_id: "rent" },
        { id: "s2", transaction_id: "parent", amount: -10_000, category_id: null, transfer_account_id: "savings", transfer_transaction_id: "other" },
      ],
    });
    expect(result.ledger.transactions.filter((t) => t.type === "transfer")).toHaveLength(1);
    expect(result.receipt.accountDifferences).toEqual([]);
  });

  test.each([
    ["receiving side first", ["other", "parent"]],
    ["paying side first", ["parent", "other"]],
  ])("given a categorized split transfer off budget with the %s when converted then the envelope pays", (_label, order) => {
    const rows = {
      parent: txn("parent", -30_000, { category_id: null }),
      other: txn("other", 10_000, { account_id: "brokerage", category_id: null, transfer_account_id: "checking", transfer_transaction_id: "parent" }),
    };
    const result = convert({
      accounts: [account("checking", -30_000), account("brokerage", 10_000, { on_budget: false })],
      transactions: order.map((key) => rows[key as keyof typeof rows]),
      subtransactions: [
        { id: "s1", transaction_id: "parent", amount: -20_000, category_id: "groceries" },
        { id: "s2", transaction_id: "parent", amount: -10_000, category_id: "rent", transfer_account_id: "brokerage", transfer_transaction_id: "other" },
      ],
      months: [
        {
          month: "2026-09-01",
          categories: [monthRow("groceries", 20_000, -20_000, 0), monthRow("rent", 10_000, -10_000, 0)],
        },
      ],
    });
    expect(result.receipt.envelopeDifferences).toEqual([]);
    expect(result.receipt.accountDifferences).toEqual([]);
  });

  test("given overspending that YNAB reset when converted then the envelope and the month match YNAB", () => {
    const result = convert(
      {
        accounts: [account("checking", 300_000)],
        transactions: [txn("t1", -150_000, { date: "2026-08-10" }), txn("t2", 450_000, { date: "2026-08-01", category_id: "inflow" })],
        months: [
          { month: "2026-08-01", categories: [monthRow("groceries", 100_000, -150_000, -50_000)] },
          { month: "2026-09-01", categories: [monthRow("groceries", 80_000, 0, 80_000)] },
        ],
      },
      "2026-09",
    );
    expect(result.receipt.envelopeDifferences).toEqual([]);
    expect(result.ledger.allocations.map((a) => [a.month, a.amount])).toEqual([
      ["2026-08", 10000],
      ["2026-09", 13000],
    ]);
  });

  test("given card payment categories when converted then no envelope is created and debt is counted", () => {
    const { ledger, receipt } = convert({
      accounts: [account("card", -40_000, { type: "creditCard" })],
      categories: [category("groceries", { name: "Groceries" }), category("cardpay", { category_group_id: "cards", name: "Visa" })],
      transactions: [txn("t1", -40_000, { account_id: "card" })],
    });
    expect(ledger.envelopes.map((e) => e.name)).toEqual(["Groceries"]);
    expect(ledger.groups.map((g) => g.name)).toEqual(["Living"]);
    expect(receipt.debtAccounts).toBe(1);
  });

  test("given a balance the transactions cannot explain when converted then the receipt names the account", () => {
    const { receipt } = convert({ accounts: [account("checking", 90_000)], transactions: [txn("t1", -10_000)] });
    expect(receipt.accountDifferences).toEqual([{ name: "Account checking", expected: 9000, actual: -1000 }]);
  });

  test("given a hidden category and a closed account when converted then both stay archived", () => {
    const { ledger } = convert({
      accounts: [account("checking", 0, { closed: true })],
      categories: [category("groceries", { hidden: true })],
    });
    expect(ledger.accounts[0]!.archived).toBe(true);
    expect(ledger.envelopes[0]!.archived).toBe(true);
  });

  test("given a monthly goal when converted then it becomes the envelope's monthly target", () => {
    const { ledger } = convert({
      categories: [category("groceries", { goal_cadence: 1, goal_cadence_frequency: 1, goal_target: 400_000 })],
    });
    expect(ledger.envelopes[0]!.monthlyTarget).toBe(40000);
  });

  test("given a converted plan when validated then it passes the same schema as a restored backup", () => {
    const { ledger } = convert({
      accounts: [account("checking", -30_000), account("savings", 10_000)],
      transactions: [
        txn("parent", -20_000, { category_id: null, payee_id: "market" }),
        txn("out", -10_000, { category_id: null, transfer_account_id: "savings", transfer_transaction_id: "in" }),
        txn("in", 10_000, { account_id: "savings", category_id: null, transfer_account_id: "checking", transfer_transaction_id: "out" }),
      ],
      subtransactions: [
        { id: "s1", transaction_id: "parent", amount: -15_000, category_id: "rent" },
        { id: "s2", transaction_id: "parent", amount: -5_000, category_id: "groceries" },
      ],
      months: [{ month: "2026-09-01", categories: [monthRow("rent", 15_000, -15_000, 0)] }],
    });
    expect(clientLedgerSchema.safeParse(ledger).success).toBe(true);
  });

  test("given a zero-decimal currency when converted then the plan is refused before any amount is read", () => {
    expect(() => convert({ currency_format: { iso_code: "JPY", decimal_digits: 0 } })).toThrow(YnabPlanError);
  });

  test("given an unrelated file when parsed then it is refused as not a YNAB export", () => {
    expect(() => parseYnabPlan({ hello: "world" })).toThrow(YnabPlanError);
  });

  test("given an impossible date when parsed then the file is refused before anything can reach the server", () => {
    expect(() => parseYnabPlan(aPlan({ transactions: [txn("t1", -100, { date: "2026-02-31" })] }))).toThrow(YnabPlanError);
  });

  test("given the API envelope old or new when parsed then both read the plan", () => {
    const plan = aPlan({});
    expect(parseYnabPlan({ data: { plan } }).name).toBe("Sample household");
    expect(parseYnabPlan({ data: { budget: plan } }).name).toBe("Sample household");
  });
});
