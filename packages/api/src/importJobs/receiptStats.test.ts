import { expect, test } from "bun:test";
import type { ImportReceipt } from "@enveo/shared";
import { summarizeImportReceipts } from "./receiptStats";

type Row = ImportReceipt["rows"][number];
const row = (rowId: string, overrides: Partial<Row> = {}): Row => ({
  rowId,
  selected: true,
  added: true,
  name: "Coffee shop",
  date: "2031-03-14",
  amount: 450,
  type: "expense",
  isRefund: false,
  accountId: "a",
  accountName: "Checking",
  toAccountName: null,
  envelopeName: null,
  categoryName: null,
  placeName: null,
  note: null,
  tag: "",
  correctionFields: [],
  reviewReasons: [],
  duplicateStatus: "new",
  relationKind: null,
  ...overrides,
});
const receipt = (rows: Row[], balanceCheck?: ImportReceipt["balanceCheck"]): ImportReceipt => ({
  completedAt: "2031-03-15T10:00:00.000Z",
  currency: "USD",
  balances: [],
  rows,
  ...(balanceCheck ? { balanceCheck } : {}),
});

test("import stats count how the human treated each flag and what the flags missed", () => {
  const stats = summarizeImportReceipts([
    receipt([
      row("kept-repeat", { added: false, selected: false, reviewReasons: ["possible_duplicate"], duplicateStatus: "probable", relationKind: "duplicate_of" }),
      row("included-repeat", { reviewReasons: ["possible_duplicate"], duplicateStatus: "probable", correctionFields: ["selection"] }),
      row("missed-amount", { correctionFields: ["amount", "envelopeId"] }),
      row("clean"),
      row("older-row", { correctionFields: undefined, reviewReasons: undefined, duplicateStatus: undefined, relationKind: undefined }),
    ]),
  ]);

  expect(stats).toMatchObject({ imports: 1, rows: 5, added: 4, measuredRows: 4 });
  expect(stats.byReason.possible_duplicate).toEqual({ rows: 2, added: 1, selectionChanged: 1, corrected: 0 });
  expect(stats.byDuplicateStatus.probable).toEqual({ rows: 2, added: 1, selectionChanged: 1, corrected: 0 });
  expect(stats.byRelation.duplicate_of).toEqual({ rows: 1, added: 0, selectionChanged: 0, corrected: 0 });
  expect(stats.unflagged).toEqual({ rows: 2, added: 2, selectionChanged: 0, corrected: 1 });
  expect(stats.corrections).toMatchObject({ selection: 1, amount: 1, envelopeId: 1, currency: 0 });
  expect(stats.balance.imports).toBe(0);
});

test("import stats add up what the bank-balance checks did", () => {
  const check = {
    screenshotFigure: "kept",
    difference: "zero",
    foreignAtFaceValue: false,
    suggested: 2,
    declined: 0,
    unmatched: 1,
    applied: 1,
    appliedChanges: 2,
    reconcileAfter: false,
  } as const;

  const stats = summarizeImportReceipts([
    receipt([], check),
    receipt([], { ...check, screenshotFigure: "changed", difference: "nonzero", foreignAtFaceValue: true, reconcileAfter: true }),
    receipt([]),
  ]);

  expect(stats.balance).toEqual({
    imports: 2,
    screenshotFigure: { none: 0, kept: 1, changed: 1 },
    difference: { none: 0, zero: 1, nonzero: 1 },
    foreignAtFaceValue: 1,
    suggested: 4,
    declined: 0,
    unmatched: 2,
    applied: 2,
    appliedChanges: 4,
    reconcileAfter: 1,
  });
});
