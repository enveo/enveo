/**
 * `txnToPayload` is the pure txn→payload mapping `duplicateTxn` builds on (one field
 * list, not copy-pasted) — tested directly, since it's the part that would silently
 * drift if a new Transaction field were added later.
 */
import { describe, expect, it } from "bun:test";
import type { Transaction, TxnPayload } from "@enveo/shared";
import { txnToPayload } from "./mutate";

const ACC = crypto.randomUUID();
const ENV1 = crypto.randomUUID();
const ENV2 = crypto.randomUUID();
const CAT1 = crypto.randomUUID();
const PLACE = crypto.randomUUID();
const TXN = crypto.randomUUID();

/**
 * A SPLIT expense exercising every field txnToPayload must carry through: a refund,
 * a place, a tag (import idempotency key), a note distinct from the name, and a
 * balanced split with a per-item category.
 */
const splitTxn = (): Transaction => ({
  id: TXN,
  type: "expense",
  accountId: ACC,
  toAccountId: null,
  amount: 5000,
  date: "2026-07-01",
  isRefund: true,
  envelopeId: null,
  placeId: PLACE,
  categoryId: null,
  name: "Zakupy",
  note: "z paragonu",
  tag: "merchant:biedronka",
  items: [
    { id: "item-a", envelopeId: ENV1, categoryId: null, amount: 2000 },
    { id: "item-b", envelopeId: ENV2, categoryId: CAT1, amount: 3000 },
  ],
  createdAt: "2026-07-01T10:00:00.000Z",
});

describe("txnToPayload (pure mapping)", () => {
  it("maps every field verbatim and strips item ids (txnItemPayload has none)", () => {
    const t = splitTxn();
    const expected: TxnPayload = {
      type: "expense",
      accountId: ACC,
      toAccountId: null,
      amount: 5000,
      date: "2026-07-01",
      isRefund: true,
      envelopeId: null,
      placeId: PLACE,
      categoryId: null,
      name: "Zakupy",
      note: "z paragonu",
      tag: "merchant:biedronka",
      items: [
        { envelopeId: ENV1, categoryId: null, amount: 2000 },
        { envelopeId: ENV2, categoryId: CAT1, amount: 3000 },
      ],
    };
    expect(txnToPayload(t)).toEqual(expected);
  });

  it("maps a non-split transaction's empty items to [] and keeps its envelope/category", () => {
    const t: Transaction = { ...splitTxn(), items: [], envelopeId: ENV1, categoryId: CAT1 };
    const p = txnToPayload(t);
    expect(p.items).toEqual([]);
    expect(p.envelopeId).toBe(ENV1);
    expect(p.categoryId).toBe(CAT1);
  });
});
