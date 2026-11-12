import { expect, test } from "bun:test";
import { type ClientLedger, type ImportReceipt, importReceiptSchema } from "@enveo/shared";
import type { ImportReviewRow } from "../importReview";
import { planLocalImport } from "../localImport";
import { emptyImportBalanceTally, finishImportReceipt, importBalanceCheck, prepareImportReceipt } from "./receipt";

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

test("each receipt row records which fields the human corrected, by name only", () => {
  const ledger = {
    budgets: [{ currency: "USD" }],
    accounts: [{ id: "a", name: "Bank", initialBalance: 0 }],
    transactions: [],
    envelopes: [],
    groups: [],
    allocations: [],
    categories: [],
    places: [],
  } as unknown as ClientLedger;
  const recognizedRow = (rowId: string, over: Partial<ImportReviewRow> = {}) =>
    ({
      rowId,
      include: true,
      rawTextLines: ["SAAS VENDOR"],
      reviewReasons: [],
      duplicateStatus: "new",
      relation: null,
      date: "2031-03-14",
      amount: 1650,
      currency: "USD",
      item: null,
      draftItem: { name: "Software", type: "expense", amount: 1650, date: "2031-03-14", tag: "", envelopeId: null },
      ...over,
    }) as ImportReviewRow;
  const recognized = [recognizedRow("untouched"), recognizedRow("unchecked"), recognizedRow("foreign", { currency: "EUR" })];
  const reviewed = [recognized[0]!, { ...recognized[1]!, include: false }, recognized[2]!];
  const edit = {
    type: "expense" as const,
    accountId: "a",
    toAccountId: null,
    isRefund: false,
    amount: 1782,
    date: "2031-03-14",
    name: "Software",
    envelopeId: null,
    categoryId: null,
    placeName: null,
    note: "",
  };
  const emptyPlan = { dryRun: false, added: 0, skipped: 0, transactions: [], results: [] };

  const receipt = prepareImportReceipt(null, ledger, "a", reviewed, emptyPlan, [], { 2: edit }, recognized);
  expect(receipt.rows.map((row) => [row.rowId, row.correctionFields])).toEqual([
    ["untouched", []],
    ["unchecked", ["selection"]],
    ["foreign", ["amount", "currency"]],
  ]);
  expect(importReceiptSchema.safeParse(receipt).success).toBe(true);

  // An edit saved without changing anything (or changed and undone) is no correction.
  const unchanged = prepareImportReceipt(null, ledger, "a", reviewed, emptyPlan, [], { 0: { ...edit, amount: 1650 } }, recognized);
  expect(unchanged.rows[0]!.correctionFields).toEqual([]);

  // Without a recognized baseline nothing is claimed; older receipts without the field still parse.
  expect(prepareImportReceipt(null, ledger, "a", reviewed, emptyPlan, []).rows[0]).not.toHaveProperty("correctionFields");
  const withFields = (correctionFields: unknown) => ({ ...receipt, rows: [{ ...receipt.rows[0]!, correctionFields }] });
  expect(importReceiptSchema.safeParse(withFields(["amount", "amount"])).success).toBe(false);
  expect(importReceiptSchema.safeParse(withFields(["merchant"])).success).toBe(false);
});

test("each receipt row records the flags its recognized row carried, by name only", () => {
  const ledger = {
    budgets: [{ currency: "USD" }],
    accounts: [{ id: "a", name: "Bank", initialBalance: 0 }],
    transactions: [],
    envelopes: [],
    groups: [],
    allocations: [],
    categories: [],
    places: [],
  } as unknown as ClientLedger;
  const repeat = {
    rowId: "repeat",
    include: false,
    rawTextLines: ["SAAS VENDOR"],
    reviewReasons: ["relation_changes_ledger_shape"],
    duplicateStatus: "probable",
    relation: { kind: "duplicate_of", rowId: "kept" },
    date: "2031-03-14",
    amount: 1650,
    currency: "USD",
    item: null,
    draftItem: { name: "Software", type: "expense", amount: 1650, date: "2031-03-14", tag: "", envelopeId: null },
  } as unknown as ImportReviewRow;
  const emptyPlan = { dryRun: false, added: 0, skipped: 0, transactions: [], results: [] };

  const receipt = prepareImportReceipt(null, ledger, "a", [{ ...repeat, include: true }], emptyPlan, [], {}, [repeat]);
  expect(receipt.rows[0]).toMatchObject({
    reviewReasons: ["relation_changes_ledger_shape"],
    duplicateStatus: "probable",
    relationKind: "duplicate_of",
    correctionFields: ["selection"],
  });
  expect(importReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(prepareImportReceipt(null, ledger, "a", [repeat], emptyPlan, []).rows[0]).not.toHaveProperty("reviewReasons");
  const withReasons = (reviewReasons: unknown) => ({ ...receipt, rows: [{ ...receipt.rows[0]!, reviewReasons }] });
  expect(importReceiptSchema.safeParse(withReasons(["made_up_reason"])).success).toBe(false);
});

test("the receipt records what the bank-balance check did, without any amount", () => {
  const check = (overrides: Partial<Parameters<typeof importBalanceCheck>[0]>) =>
    importBalanceCheck({
      bankValue: "",
      recognizedBankValue: "",
      difference: null,
      foreignRows: 0,
      reconcileAfter: false,
      tally: emptyImportBalanceTally(),
      ...overrides,
    });

  // when: a figure read from the screenshot is kept and the selection leaves no difference
  const kept = check({
    bankValue: "1250.40",
    recognizedBankValue: "1250.40",
    difference: 0,
    tally: { ...emptyImportBalanceTally(), suggested: 1, applied: 1, appliedChanges: 2 },
  });

  expect(kept).toEqual({
    screenshotFigure: "kept",
    difference: "zero",
    foreignAtFaceValue: false,
    suggested: 1,
    declined: 0,
    unmatched: 0,
    applied: 1,
    appliedChanges: 2,
    reconcileAfter: false,
  });
  expect(check({ bankValue: "1300", recognizedBankValue: "1250.40", difference: -1200, foreignRows: 1, reconcileAfter: true })).toMatchObject({
    screenshotFigure: "changed",
    difference: "nonzero",
    foreignAtFaceValue: true,
    reconcileAfter: true,
  });
  expect(check({ recognizedBankValue: "1250.40" })).toMatchObject({ screenshotFigure: "changed", difference: "none" });
  expect(check({ bankValue: "90", difference: 5 })).toMatchObject({ screenshotFigure: "none", difference: "nonzero" });
  expect(check({ tally: { ...emptyImportBalanceTally(), unmatched: 20_000 } }).unmatched).toBe(10_000);

  const ledger = {
    budgets: [{ currency: "USD" }],
    accounts: [{ id: "a", name: "Bank", initialBalance: 0 }],
    transactions: [],
    envelopes: [],
    groups: [],
    allocations: [],
    categories: [],
    places: [],
  } as unknown as ClientLedger;
  const emptyPlan = { dryRun: false, added: 0, skipped: 0, transactions: [], results: [] };
  const receipt = prepareImportReceipt(null, ledger, "a", [], emptyPlan, [], {}, [], kept);
  expect(receipt.balanceCheck).toEqual(kept);
  expect(importReceiptSchema.safeParse(receipt).success).toBe(true);
  // A resumed Add without a fresh check keeps the one the first attempt recorded.
  expect(prepareImportReceipt(receipt, ledger, "a", [], emptyPlan, []).balanceCheck).toEqual(kept);
  expect(prepareImportReceipt(null, ledger, "a", [], emptyPlan, [])).not.toHaveProperty("balanceCheck");
  expect(importReceiptSchema.safeParse({ ...receipt, balanceCheck: { ...kept, bankFigure: 1250 } }).success).toBe(false);
  expect(importReceiptSchema.safeParse({ ...receipt, balanceCheck: { ...kept, suggested: -1 } }).success).toBe(false);
});
