import { expect, test } from "bun:test";
import { type ClientLedger, type ImportReceipt, importReceiptSchema } from "@enveo/shared";
import type { ImportReviewRow } from "../importReview";
import { planLocalImport } from "../localImport";
import { finishImportReceipt, prepareImportReceipt } from "./receipt";

test("completion freezes the actual applied rows and account balances, including a resumed import", () => {
  const draft = {
    completedAt: null,
    currency: "PLN",
    balances: [{ accountId: "a", name: "Bank", before: 10000, after: null }],
    rows: [
      { rowId: "first", selected: true, added: false, name: "Edited purchase" },
      { rowId: "second", selected: true, added: false, name: "Skipped duplicate" },
    ],
  } as ImportReceipt;
  const ledger = {
    budgets: [],
    accounts: [{ id: "a", initialBalance: 10000 }],
    transactions: [{ accountId: "a", type: "expense", amount: 4250, date: "2026-09-10", isRefund: false }],
    envelopes: [],
    groups: [],
    allocations: [],
    categories: [],
    places: [],
  } as unknown as ClientLedger;
  const receipt = finishImportReceipt(draft, ["first"], ledger, "2026-09-10T12:00:00.000Z");
  expect(receipt.balances).toEqual([{ accountId: "a", name: "Bank", before: 10000, after: 5750 }]);
  expect(receipt.rows.map((row) => [row.name, row.selected, row.added])).toEqual([
    ["Edited purchase", true, true],
    ["Skipped duplicate", true, false],
  ]);
  ledger.transactions[0]!.amount = 1;
  expect(receipt.balances[0]!.after).toBe(5750);
});

test("completion retry keeps the first historical balance even after unrelated ledger changes", () => {
  const saved = {
    completedAt: "2026-09-10T12:00:00.000Z",
    currency: "PLN",
    balances: [{ accountId: "a", name: "Bank", before: 10000, after: 5750 }],
    rows: [],
  } satisfies ImportReceipt;
  expect(finishImportReceipt(saved, [], {} as ClientLedger, "2026-09-11T12:00:00.000Z")).toEqual(saved);
});

test("skipped rows retain manual corrections and foreign rows retain their currency", () => {
  const ledger = {
    budgets: [{ currency: "PLN" }],
    accounts: [{ id: "a", name: "Bank", initialBalance: 0 }],
    transactions: [],
    envelopes: [],
    groups: [],
    allocations: [],
    categories: [],
    places: [],
  } as unknown as ClientLedger;
  const row = {
    rowId: "r",
    include: false,
    rawTextLines: ["Original"],
    date: "2026-09-10",
    amount: 1000,
    currency: "EUR",
    item: null,
    draftItem: { name: "Original", type: "expense", amount: 1000, date: "2026-09-10", tag: "" },
  } as ImportReviewRow;
  const emptyPlan = { dryRun: false, added: 0, skipped: 0, transactions: [], results: [] };
  const unnamedPlan = planLocalImport({
    ledger,
    globalAccountId: "a",
    dryRun: false,
    items: [{ importRowId: "r", name: "", type: "expense", date: "2026-09-10", amount: 1000, tag: "", envelopeId: null }],
  });
  const unnamed = prepareImportReceipt(null, ledger, "a", [row], unnamedPlan, []);
  expect(unnamed.rows[0]?.name).toBe("");
  const foreign = prepareImportReceipt(null, ledger, "a", [row], emptyPlan, []);
  expect(foreign.rows[0]).toMatchObject({ currency: "EUR", amount: 1000, selected: false });
  const edited = prepareImportReceipt(null, ledger, "a", [row], emptyPlan, [], {
    0: {
      type: "expense",
      accountId: "a",
      toAccountId: null,
      isRefund: false,
      amount: 1250,
      date: "2026-09-09",
      name: "Corrected",
      envelopeId: null,
      categoryId: null,
      placeName: "Shop",
      note: "Saved correction",
    },
  });
  expect(edited.rows[0]).toMatchObject({
    currency: "PLN",
    amount: 1250,
    name: "Corrected",
    date: "2026-09-09",
    placeName: "Shop",
    note: "Saved correction",
    selected: false,
  });
  const partial = prepareImportReceipt(null, ledger, "a", [{ ...row, date: null, draftItem: { ...row.draftItem!, type: null, date: null } }], emptyPlan, ["r"]);
  const completed = finishImportReceipt(partial, ["r"], ledger, "2026-09-10T12:00:00.000Z");
  expect(completed.balances[0]?.before).toBeNull();
  expect(completed.rows[0]?.detailsUnavailable).toBe(true);
  expect(importReceiptSchema.safeParse(completed).success).toBe(true);
});

test("a resumed import preserves known before balances and leaves newly encountered accounts unknown", () => {
  const ledger = {
    budgets: [],
    accounts: [
      { id: "a", initialBalance: 10000 },
      { id: "b", initialBalance: 5000 },
    ],
    transactions: [],
    envelopes: [],
    groups: [],
    allocations: [],
    categories: [],
    places: [],
  } as unknown as ClientLedger;
  const previous: ImportReceipt = { completedAt: null, currency: "EUR", balances: [{ accountId: "a", name: "Bank", before: 12000, after: null }], rows: [] };
  const result = prepareImportReceipt(previous, ledger, "b", [], { dryRun: false, added: 0, skipped: 0, transactions: [], results: [] }, ["already-applied"]);
  expect(result.balances.find((a) => a.accountId === "a")?.before).toBe(12000);
  expect(result.balances.find((a) => a.accountId === "b")?.before).toBeNull();
});
