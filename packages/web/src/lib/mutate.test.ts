/**
 * `txnToPayload` is the pure txn→payload mapping `duplicateTxn` builds on (one field
 * list, not copy-pasted) — tested directly, since it's the part that would silently
 * drift if a new Transaction field were added later.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ClientLedger, createDefaultBudgetPreferences, type Transaction, type TxnPayload } from "@enveo/shared";
import { prepareTxnCreate, prepareTxnUpdate, txnToDuplicatePayload, txnToPayload } from "./mutate";

const ACC = crypto.randomUUID();
const ENV1 = crypto.randomUUID();
const ENV2 = crypto.randomUUID();
const CAT1 = crypto.randomUUID();
const PLACE = crypto.randomUUID();
const TXN = crypto.randomUUID();

const flowLedger = (): ClientLedger => ({
  budgets: [{ id: crypto.randomUUID(), name: "Budget", currency: "EUR", preferences: createDefaultBudgetPreferences() }],
  accounts: [
    {
      id: ACC,
      name: "Savings",
      color: "#fff",
      icon: "bank",
      type: "savings",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: ENV1,
    },
    {
      id: PLACE,
      name: "Travel",
      color: "#fff",
      icon: "bank",
      type: "savings",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 1,
      automaticEnvelopeId: ENV2,
    },
  ],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
  allocations: [],
  transactions: [],
});

const txnPayload = (overrides: Partial<TxnPayload> = {}): TxnPayload => ({
  type: "income",
  accountId: ACC,
  toAccountId: null,
  amount: 5000,
  date: "2026-08-14",
  isRefund: false,
  envelopeId: ENV1,
  placeId: null,
  categoryId: null,
  name: "Paycheck",
  note: null,
  tag: null,
  sourceRef: null,
  allocationFromEnvelopeId: null,
  allocationToEnvelopeId: null,
  items: [],
  ...overrides,
});

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
  sourceRef: "BIEDRONKA 123 POZNAN",
  allocationFromEnvelopeId: null,
  allocationToEnvelopeId: null,
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
      sourceRef: "BIEDRONKA 123 POZNAN",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
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

  it("a user duplicate clears both import identifiers", () => {
    expect(txnToDuplicatePayload(splitTxn(), "2026-08-14")).toMatchObject({
      date: "2026-08-14",
      tag: null,
      sourceRef: null,
    });
  });
});

describe("transaction mutation preparation", () => {
  it("captures an income destination flow and clears its legacy envelope", () => {
    expect(prepareTxnCreate(flowLedger(), txnPayload())).toMatchObject({
      envelopeId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: ENV1,
    });
  });

  it("captures source and destination flow for a transfer", () => {
    expect(prepareTxnCreate(flowLedger(), txnPayload({ type: "transfer", toAccountId: PLACE, envelopeId: null }))).toMatchObject({
      allocationFromEnvelopeId: ENV1,
      allocationToEnvelopeId: ENV2,
    });
  });

  it("preserves a stored flow when an update keeps its routing", () => {
    const ledger = flowLedger();
    ledger.transactions.push({ ...splitTxn(), type: "income", accountId: ACC, envelopeId: null, allocationToEnvelopeId: ENV2 });

    expect(prepareTxnUpdate(ledger, TXN, txnPayload({ amount: 9999, date: "2026-08-15", envelopeId: ENV1 }))).toMatchObject({
      amount: 9999,
      date: "2026-08-15",
      envelopeId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: ENV2,
    });
  });

  it("recaptures current flow after an account, type, or transfer destination changes", () => {
    const ledger = flowLedger();
    ledger.transactions.push({ ...splitTxn(), type: "income", accountId: ACC, envelopeId: null, allocationToEnvelopeId: ENV2 });

    expect(prepareTxnUpdate(ledger, TXN, txnPayload({ type: "transfer", accountId: PLACE, toAccountId: ACC, envelopeId: ENV1 }))).toMatchObject({
      envelopeId: ENV1,
      allocationFromEnvelopeId: ENV2,
      allocationToEnvelopeId: ENV1,
    });
  });

  it("drops stale duplicate flow before create preparation captures current links", () => {
    const stale = { ...splitTxn(), type: "income" as const, accountId: ACC, envelopeId: null, allocationToEnvelopeId: ENV2 };
    const duplicate = txnToDuplicatePayload(stale, "2026-08-14");

    expect(duplicate).toMatchObject({ allocationFromEnvelopeId: null, allocationToEnvelopeId: null });
    expect(prepareTxnCreate(flowLedger(), duplicate)).toMatchObject({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: ENV1,
    });
  });

  it("clears flow fields for expenses and refunds", () => {
    expect(
      prepareTxnCreate(flowLedger(), txnPayload({ type: "expense", isRefund: true, allocationFromEnvelopeId: ENV1, allocationToEnvelopeId: ENV2 })),
    ).toMatchObject({ allocationFromEnvelopeId: null, allocationToEnvelopeId: null });
  });
});

describe("transaction creation ports", () => {
  it("routes manual Add and reconciliation creates through local.createTxn", () => {
    const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

    expect(source("screens/Add.tsx")).toContain("else local.createTxn(payload)");
    expect(source("components/widgets.tsx")).toContain("local.createTxn({");
  });
});
