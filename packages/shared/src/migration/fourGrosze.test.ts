import { describe, expect, test } from "bun:test";
import { computeBudgetState } from "../budget";
import { clientLedgerSchema } from "../ops";
import type { Budget, Transaction } from "../types";
import { type FourGroszeExport, FourGroszeExportError, fourGroszeAmount, fourGroszeExportToMigrationSource, parseFourGroszeExport } from "./fourGrosze";
import { buildMigrationLedger, type MigrationResult } from "./ledger";

const budget: Budget = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Budget",
  currency: "USD",
  preferences: {} as Budget["preferences"],
};

const TO_BE_BUDGETED = "Do rozdysponowania";

type Row = FourGroszeExport["transactions"][number];
const row = (id: string, amount: string, over: Partial<Row> = {}): Row => ({
  id,
  pos: 0,
  date: "2026-09-10",
  payee: null,
  amount,
  account: "Checking",
  transferAccount: null,
  envelope: "Groceries",
  category: null,
  description: null,
  type: "outflow",
  ...over,
});

function anExport(over: Partial<FourGroszeExport> = {}): FourGroszeExport {
  return {
    envelopes: [
      { name: TO_BE_BUDGETED, group: "Income", archived: false },
      { name: "Groceries", group: "Living", archived: false },
      { name: "Rent", group: "Living", archived: false },
      { name: "Old hobby", group: "Fun", archived: true },
    ],
    accounts: [
      { name: "Checking", closed: false },
      { name: "Savings", closed: false },
    ],
    categories: [{ name: "Food" }],
    budgetEntries: [],
    transactions: [],
    ...over,
  };
}

function convert(input: FourGroszeExport, month = "2026-09"): MigrationResult {
  let n = 100;
  const source = fourGroszeExportToMigrationSource(parseFourGroszeExport(input), month, { name: "4grosze.pl", archive: "Archive" });
  return buildMigrationLedger(source, {
    budget,
    newId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
    envelopeStyle: () => ({ color: "#123456", icon: "tag" }),
    accountStyle: () => ({ color: "#654321", icon: "wallet" }),
  });
}

const named = (result: MigrationResult) => {
  const { ledger } = result;
  const name = (rows: Array<{ id: string; name: string }>, id: string | null) => rows.find((entry) => entry.id === id)?.name ?? null;
  return (transaction: Transaction) => ({
    type: transaction.type,
    amount: transaction.amount,
    isRefund: transaction.isRefund,
    account: name(ledger.accounts, transaction.accountId),
    to: name(ledger.accounts, transaction.toAccountId),
    envelope: name(ledger.envelopes, transaction.envelopeId),
    category: name(ledger.categories, transaction.categoryId),
    place: name(ledger.places, transaction.placeId),
    name: transaction.name,
  });
};

describe("fourGroszeAmount", () => {
  test("reads signed decimals with grouping spaces, a typographic minus and a comma", () => {
    expect(fourGroszeAmount("-1 234.56")).toBe(-123456);
    expect(fourGroszeAmount("−1 234,5")).toBe(-123450);
    expect(fourGroszeAmount("42")).toBe(4200);
    expect(fourGroszeAmount("0.07")).toBe(7);
  });

  test("refuses anything that is not an amount instead of guessing", () => {
    for (const raw of ["", "12.345", "1e3", "abc", "1.2.3"]) expect(() => fourGroszeAmount(raw)).toThrow(FourGroszeExportError);
  });
});

describe("parseFourGroszeExport", () => {
  test("refuses a file of another shape", () => {
    expect(() => parseFourGroszeExport({ data: { budget: {} } })).toThrow(FourGroszeExportError);
    expect(() => parseFourGroszeExport(null)).toThrow(FourGroszeExportError);
  });
});

describe("fourGroszeExportToMigrationSource", () => {
  test("keeps the description as the title, the payee as the place and the category alongside the envelope", () => {
    const result = convert(anExport({ transactions: [row("t1", "-23.40", { payee: "Linden Market", description: "Weekly shop", category: "Food" })] }));
    expect(result.ledger.transactions.map(named(result))).toEqual([
      {
        type: "expense",
        amount: 2340,
        isRefund: false,
        account: "Checking",
        to: null,
        envelope: "Groceries",
        category: "Food",
        place: "Linden Market",
        name: "Weekly shop",
      },
    ]);
  });

  test("money in to the amount still to assign is income, and money back into an envelope is a refund", () => {
    const result = convert(
      anExport({
        transactions: [
          row("t1", "2500.00", { type: "inflow", envelope: TO_BE_BUDGETED, description: "Salary" }),
          row("t2", "12.00", { description: "Returned item" }),
        ],
      }),
    );
    expect(result.ledger.transactions.map(named(result)).map(({ type, amount, isRefund, envelope }) => ({ type, amount, isRefund, envelope }))).toEqual([
      { type: "income", amount: 250000, isRefund: false, envelope: null },
      { type: "expense", amount: 1200, isRefund: true, envelope: "Groceries" },
    ]);
  });

  test("a transfer's two rows become one transfer, whichever side the file lists first", () => {
    for (const order of [
      ["Savings", "Checking"],
      ["Checking", "Savings"],
    ]) {
      const sides = {
        Checking: row("x1", "-300.00", { type: "transfer", transferAccount: "Savings", envelope: null, description: "To savings" }),
        Savings: row("x1", "300.00", { type: "transfer", account: "Savings", transferAccount: "Checking", envelope: null, description: "To savings" }),
      };
      const result = convert(anExport({ transactions: order.map((account) => sides[account as keyof typeof sides]) }));
      expect(result.ledger.transactions.map(named(result))).toEqual([
        {
          type: "transfer",
          amount: 30000,
          isRefund: false,
          account: "Checking",
          to: "Savings",
          envelope: null,
          category: null,
          place: null,
          name: "To savings",
        },
      ]);
    }
  });

  test("a split into envelopes becomes one transaction with an item per row", () => {
    const result = convert(
      anExport({
        transactions: [
          row("s1", "-60.00", { pos: 1, envelope: "Rent", description: "Utilities", payee: "City Power" }),
          row("s1", "-40.00", { pos: 0, envelope: "Groceries", description: "Snacks", category: "Food", payee: "City Power" }),
        ],
      }),
    );
    const [split] = result.ledger.transactions;
    expect(split).toMatchObject({ type: "expense", amount: 10000, name: "Snacks · Utilities" });
    const envelope = (id: string) => result.ledger.envelopes.find((entry) => entry.id === id)?.name;
    const category = (id: string | null) => result.ledger.categories.find((entry) => entry.id === id)?.name ?? null;
    expect(split!.items.map((item) => [envelope(item.envelopeId), category(item.categoryId), item.amount])).toEqual([
      ["Groceries", "Food", 4000],
      ["Rent", null, 6000],
    ]);
  });

  test("a split Enveo cannot hold as items stays as separate rows", () => {
    const result = convert(
      anExport({
        transactions: [row("s1", "-60.00", { pos: 0, envelope: "Rent" }), row("s1", "10.00", { pos: 1, envelope: TO_BE_BUDGETED, type: "inflow" })],
      }),
    );
    expect(result.ledger.transactions.map(named(result)).map(({ type, amount, envelope }) => ({ type, amount, envelope }))).toEqual([
      { type: "expense", amount: 6000, envelope: "Rent" },
      { type: "income", amount: 1000, envelope: null },
    ]);
  });

  test("assignments sum per envelope and month, skipping the amount still to assign", () => {
    const result = convert(
      anExport({
        budgetEntries: [
          { monthId: 202608, envelope: "Groceries", budgeted: "100.00" },
          { monthId: 202608, envelope: "Groceries", budgeted: "50.00" },
          { monthId: 202609, envelope: "Rent", budgeted: "900.00" },
          { monthId: 202609, envelope: TO_BE_BUDGETED, budgeted: "5.00" },
        ],
      }),
    );
    const envelope = (id: string) => result.ledger.envelopes.find((entry) => entry.id === id)?.name;
    expect(result.ledger.allocations.map((allocation) => [envelope(allocation.envelopeId), allocation.month, allocation.amount])).toEqual([
      ["Groceries", "2026-08", 15000],
      ["Rent", "2026-09", 90000],
    ]);
  });

  test("an envelope the export no longer lists lands hidden in an archive group, with its history", () => {
    const result = convert(
      anExport({
        budgetEntries: [{ monthId: 202607, envelope: "Gone trip", budgeted: "80.00" }],
        transactions: [row("t1", "-80.00", { envelope: "Gone trip", date: "2026-07-03" })],
      }),
    );
    const gone = result.ledger.envelopes.find((entry) => entry.name === "Gone trip")!;
    expect(gone.archived).toBe(true);
    expect(result.ledger.groups.find((group) => group.id === gone.groupId)?.name).toBe("Archive");
    expect(result.ledger.envelopes.find((entry) => entry.name === "Old hobby")?.archived).toBe(true);
    expect(result.ledger.envelopes.map((entry) => entry.name)).not.toContain(TO_BE_BUDGETED);
  });

  test("an account only the transactions name comes over closed, so its history still adds up", () => {
    const result = convert(anExport({ transactions: [row("t1", "-5.00", { account: "Old card" })] }));
    expect(result.ledger.accounts.find((account) => account.name === "Old card")).toMatchObject({ archived: true, onBudget: true });
    expect(result.ledger.transactions).toHaveLength(1);
    expect(result.receipt.uncheckedBalances).toContainEqual({ name: "Old card", amount: -500 });
  });

  test("the receipt lists the balances the move produces, because the export states none", () => {
    const result = convert(
      anExport({
        accounts: [
          { name: "Checking", closed: false },
          { name: "Savings", closed: false },
          { name: "Closed account", closed: true },
        ],
        budgetEntries: [{ monthId: 202609, envelope: "Groceries", budgeted: "100.00" }],
        transactions: [
          row("t1", "1000.00", { type: "inflow", envelope: TO_BE_BUDGETED }),
          row("t2", "-23.40"),
          row("x1", "-300.00", { type: "transfer", transferAccount: "Savings", envelope: null }),
          row("x1", "300.00", { type: "transfer", account: "Savings", transferAccount: "Checking", envelope: null }),
        ],
      }),
    );
    expect(result.receipt).toMatchObject({
      budgetName: "4grosze.pl",
      accountDifferences: [],
      envelopeDifferences: [],
      envelopesChecked: false,
      uncheckedBalances: [
        { name: "Checking", amount: 67660 },
        { name: "Savings", amount: 30000 },
      ],
    });
    const state = computeBudgetState(result.ledger, "2026-09");
    expect(state.envelopes.find((entry) => entry.envelope.name === "Groceries")?.available).toBe(7660);
    expect(clientLedgerSchema.safeParse(result.ledger).success).toBe(true);
  });

  test("a month id that is not a month refuses the file", () => {
    expect(() => convert(anExport({ budgetEntries: [{ monthId: 202613, envelope: "Rent", budgeted: "1.00" }] }))).toThrow(FourGroszeExportError);
  });

  test("a transfer whose two sides disagree refuses the file instead of picking one", () => {
    const side = (amount: string, account: string, to: string) => row("x1", amount, { type: "transfer", account, transferAccount: to, envelope: null });
    for (const rows of [
      [side("-100.00", "Checking", "Savings"), side("99.00", "Savings", "Checking")],
      [side("-100.00", "Checking", "Savings"), side("-100.00", "Savings", "Checking")],
      [side("-100.00", "Checking", "Savings"), side("100.00", "Savings", "Cash")],
      [side("-100.00", "Checking", "Savings"), { ...side("100.00", "Savings", "Checking"), date: "2026-09-11" }],
      [row("x1", "-100.00", { type: "transfer", envelope: null })],
      [side("-100.00", "Checking", "Savings"), row("x1", "-5.00")],
    ]) {
      expect(() => convert(anExport({ transactions: rows }))).toThrow(expect.objectContaining({ code: "inconsistent_export" }));
    }
  });

  test("a lone side of a transfer stays a transfer, since the other account's rows may be gone", () => {
    const result = convert(
      anExport({ transactions: [row("x1", "40.00", { type: "transfer", account: "Savings", transferAccount: "Checking", envelope: null })] }),
    );
    expect(result.ledger.transactions.map(named(result)).map(({ type, amount, account, to }) => ({ type, amount, account, to }))).toEqual([
      { type: "transfer", amount: 4000, account: "Checking", to: "Savings" },
    ]);
  });

  test("names are trimmed once, so a padded definition and its reference are one entity", () => {
    const result = convert(
      anExport({
        envelopes: [{ name: " Groceries ", group: " Living ", archived: false }],
        accounts: [{ name: " Checking", closed: false }],
        budgetEntries: [{ monthId: 202609, envelope: "Groceries", budgeted: "10.00" }],
        transactions: [row("t1", "-1.00", { account: "Checking ", envelope: " Groceries" })],
      }),
    );
    expect(result.ledger.envelopes.map((entry) => entry.name)).toEqual(["Groceries"]);
    expect(result.ledger.accounts.map((entry) => entry.name)).toEqual(["Checking"]);
    expect(new Set(result.ledger.envelopes.map((entry) => entry.id)).size).toBe(result.ledger.envelopes.length);
  });

  test("a repeated or blank name refuses the file, because names are the only identity", () => {
    for (const over of [
      {
        envelopes: [
          { name: "Food", group: "Living" },
          { name: "Food", group: "Fun" },
        ],
      },
      { accounts: [{ name: "Checking" }, { name: " Checking " }] },
      { accounts: [{ name: "  " }] },
    ] as Array<Partial<FourGroszeExport>>) {
      expect(() => convert(anExport(over))).toThrow(expect.objectContaining({ code: "inconsistent_export" }));
    }
  });

  test("a date that does not exist refuses the file", () => {
    expect(() => convert(anExport({ transactions: [row("t1", "-1.00", { date: "2026-02-30" })] }))).toThrow(FourGroszeExportError);
  });

  test("with every account closed the receipt still says nothing was compared", () => {
    const result = convert(anExport({ accounts: [{ name: "Checking", closed: true }], transactions: [] }));
    expect(result.receipt).toMatchObject({ balancesChecked: false, uncheckedBalances: [] });
  });

  test("a closed account still holding money is listed for comparison", () => {
    const result = convert(
      anExport({
        accounts: [
          { name: "Checking", closed: false },
          { name: "Old card", closed: true },
          { name: "Old wallet", closed: true },
        ],
        transactions: [
          row("t1", "-12.00", { account: "Old card" }),
          row("t2", "-5.00", { account: "Old wallet" }),
          row("t3", "5.00", { account: "Old wallet" }),
        ],
      }),
    );
    expect(result.receipt.uncheckedBalances).toEqual([
      { name: "Checking", amount: 0 },
      { name: "Old card", amount: -1200 },
    ]);
  });

  test("many rows sharing one id convert in linear time", () => {
    const rows = Array.from({ length: 20000 }, (_, index) => row("same", "-1.00", { pos: index }));
    const started = performance.now();
    const result = convert(anExport({ transactions: rows }));
    expect(result.ledger.transactions).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
