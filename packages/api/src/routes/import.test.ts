/**
 * Tests of the extended /import/apply (editing an item before adding) — pure,
 * no DB: zod validation (applyInput), insert shape (applyTxnValues),
 * transfer validation (findTransferError) and dedupe (import-dedupe).
 */
import { describe, expect, it } from "bun:test";
import { buildDupIndex, classifyDup } from "./import-dedupe";
import { type ApplyItem, applyInput, applyTxnValues, findTransferError } from "./import";

const ACC_A = "11111111-1111-1111-1111-111111111111";
const ACC_B = "22222222-2222-2222-2222-222222222222";
const ENV = "33333333-3333-3333-3333-333333333333";

const baseItem = (over: Partial<ApplyItem> = {}): ApplyItem => ({
  date: "2026-07-10",
  amount: 8640,
  type: "expense",
  name: "Test",
  tag: "sub",
  rawPlace: "ZEN*ABC",
  envelopeId: ENV,
  categoryId: null,
  placeName: "Zen",
  ...over,
});

describe("import/apply — extended items", () => {
  it("valid transfer → insert with to_account_id and an empty envelope/category, no refund", () => {
    const it_ = baseItem({ type: "transfer", toAccountId: ACC_B, isRefund: true });
    expect(findTransferError([it_], ACC_A)).toBeNull();
    const v = applyTxnValues(it_, ACC_A);
    expect(v.type).toBe("transfer");
    expect(v.accountId).toBe(ACC_A);
    expect(v.toAccountId).toBe(ACC_B);
    expect(v.envelopeId).toBeNull();
    expect(v.categoryId).toBeNull();
    expect(v.isRefund).toBe(false);
    expect(v.sourceRef).toBe("ZEN*ABC"); // source_ref unchanged — the learning loop
  });

  it("transfer without toAccountId or to the same account → error with the item index", () => {
    const ok = baseItem();
    expect(findTransferError([ok, baseItem({ type: "transfer" })], ACC_A)).toEqual({
      error: "transfer_invalid",
      index: 1,
    });
    // toAccountId == the item's global account
    expect(findTransferError([baseItem({ type: "transfer", toAccountId: ACC_A })], ACC_A)).toEqual({
      error: "transfer_invalid",
      index: 0,
    });
    // toAccountId == the account overridden per item (global one differs — still an error)
    expect(
      findTransferError([baseItem({ type: "transfer", accountId: ACC_B, toAccountId: ACC_B })], ACC_A),
    ).toEqual({ error: "transfer_invalid", index: 0 });
  });

  it("refund: is_refund true only for expense; ignored for income", () => {
    expect(applyTxnValues(baseItem({ isRefund: true }), ACC_A).isRefund).toBe(true);
    expect(applyTxnValues(baseItem({ type: "income", isRefund: true }), ACC_A).isRefund).toBe(false);
  });

  it("per-item account overrides the global one; note and confirmed from the item", () => {
    const v = applyTxnValues(baseItem({ accountId: ACC_B, note: "rata 2/12", confirmed: false }), ACC_A);
    expect(v.accountId).toBe(ACC_B);
    expect(v.note).toBe("rata 2/12");
    expect(v.confirmed).toBe(false);
  });

  it("dedupe as before: editing the AMOUNT drops out of the strong key (date+amount+source_ref)", () => {
    const idx = buildDupIndex([{ date: "2026-07-10", amount: 8640, sourceRef: "ZEN*ABC" }]);
    // same amount → sure duplicate
    expect(classifyDup({ date: "2026-07-10", amount: 8640, rawPlace: "ZEN*ABC" }, idx)).toBe("exists");
    // changed amount → NO LONGER a duplicate (not even probable — different date+amount)
    expect(classifyDup({ date: "2026-07-10", amount: 9000, rawPlace: "ZEN*ABC" }, idx)).toBe("new");
  });

  it("the old item shape (without the new fields) passes and yields the previous defaults", () => {
    const body = {
      accountId: ACC_A,
      items: [
        {
          date: "2026-07-10",
          amount: 3200,
          type: "expense",
          name: "Test",
          tag: "",
          rawPlace: "XYZ*1",
          envelopeId: ENV,
          categoryId: null,
          placeName: "Xyz",
        },
      ],
    };
    const parsed = applyInput.parse(body);
    expect(findTransferError(parsed.items, parsed.accountId)).toBeNull();
    const v = applyTxnValues(parsed.items[0]!, parsed.accountId);
    expect(v).toMatchObject({
      type: "expense",
      accountId: ACC_A,
      toAccountId: null,
      confirmed: true,
      isRefund: false,
      envelopeId: ENV,
      note: null,
      sourceRef: "XYZ*1",
      planned: false,
      recurrenceId: null,
    });
  });
});
