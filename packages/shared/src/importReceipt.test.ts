import { expect, test } from "bun:test";
import { importReceiptSchema } from "./importReceipt";

test("receipts reject fractional money and duplicate rows at the storage boundary", () => {
  const receipt = {
    completedAt: null,
    currency: "PLN",
    balances: [{ accountId: "a", name: "Bank", before: 10000, after: 5750 }],
    rows: [
      {
        rowId: "r",
        selected: true,
        added: true,
        name: "Edited groceries",
        date: "2026-09-10",
        amount: 4250,
        type: "expense",
        isRefund: false,
        accountId: "a",
        accountName: "Bank",
        toAccountName: null,
        envelopeName: "Food",
        categoryName: null,
        placeName: null,
        note: null,
        tag: "",
      },
    ],
  };
  expect(importReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(importReceiptSchema.safeParse({ ...receipt, rows: [{ ...receipt.rows[0], selected: false, detailsUnavailable: true }] }).success).toBe(false);
  expect(importReceiptSchema.safeParse({ ...receipt, balances: [{ ...receipt.balances[0], after: 57.5 }] }).success).toBe(false);
  expect(importReceiptSchema.safeParse({ ...receipt, rows: [...receipt.rows, ...receipt.rows] }).success).toBe(false);
});
