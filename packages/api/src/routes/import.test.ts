/**
 * Tests of the extended /import/apply (editing an item before adding) — pure,
 * no DB: zod validation (applyInput), insert shape (applyTxnValues),
 * transfer validation (findTransferError) and dedupe (import-dedupe).
 */
import { describe, expect, it } from "bun:test";
import { type ApplyItem, applyInput, applyTxnValues, findTransferError } from "./import";
import { buildDupIndex, classifyDup } from "./import-dedupe";
import { budgetAssertionFails } from "./sync";

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
    expect(findTransferError([baseItem({ type: "transfer", accountId: ACC_B, toAccountId: ACC_B })], ACC_A)).toEqual({ error: "transfer_invalid", index: 0 });
  });

  it("refund: is_refund true only for expense; ignored for income", () => {
    expect(applyTxnValues(baseItem({ isRefund: true }), ACC_A).isRefund).toBe(true);
    expect(applyTxnValues(baseItem({ type: "income", isRefund: true }), ACC_A).isRefund).toBe(false);
  });

  it("per-item account overrides the global one; note from the item", () => {
    const v = applyTxnValues(baseItem({ accountId: ACC_B, note: "rata 2/12" }), ACC_A);
    expect(v.accountId).toBe(ACC_B);
    expect(v.note).toBe("rata 2/12");
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
      isRefund: false,
      envelopeId: ENV,
      note: null,
      sourceRef: "XYZ*1",
    });
  });
});

/* ── The per-request tenant assertion on /import/apply ─────────────────
   Same threat as on /sync/push: the server resolves the target budget from the
   session cookie alone, the cookie is shared by every tab, and the import sheet
   sits open for minutes — a sign-out+sign-in in another tab swaps the session
   between the client's ownership check and the apply request, and fresh creates
   pass every FK guard. The body therefore NAMES the budget the client verified
   (budgetAssertionFails, resolved server-side by requireTier — the resolution is
   a DB read, so the 409-before-write path is exercised against a throwaway
   stack; here we pin the schema and the assertion semantics, DB-free, exactly
   like sync.test.ts does for push). */

const BUDGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUDGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("import/apply — the per-request budget assertion", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    accountId: ACC_A,
    items: [baseItem()],
    ...over,
  });

  it("the apply body accepts an optional budgetId and rejects a non-uuid", () => {
    expect(applyInput.safeParse(body()).success).toBe(true); // absent = pre-fix client (back-compat)
    expect(applyInput.safeParse(body({ budgetId: BUDGET_A })).success).toBe(true);
    expect(applyInput.safeParse(body({ budgetId: "not-a-uuid" })).success).toBe(false);
  });

  it("a client that names ANOTHER budget than the session's is refused", () => {
    const claimed = applyInput.parse(body({ budgetId: BUDGET_A })).budgetId;
    expect(budgetAssertionFails(claimed, BUDGET_B)).toBe(true);
  });

  it("naming the session's own budget passes", () => {
    const claimed = applyInput.parse(body({ budgetId: BUDGET_A })).budgetId;
    expect(budgetAssertionFails(claimed, BUDGET_A)).toBe(false);
  });

  it("a client that names no budget is not refused (pre-fix client)", () => {
    const claimed = applyInput.parse(body()).budgetId;
    expect(claimed).toBeUndefined();
    expect(budgetAssertionFails(claimed, BUDGET_A)).toBe(false);
  });
});
