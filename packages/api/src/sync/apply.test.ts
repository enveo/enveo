/**
 * Pure part of the budget-scope guards (no DB): which body FKs get collected
 * for the ownership EXISTS checks, and the ledger-internal ref validation used
 * by the restore path. The DB behavior (foreign id → rejected op) is covered
 * by E2E.
 */
import type { ClientLedgerInput } from "@enveo/shared";
import { describe, expect, it } from "bun:test";
import { collectFkChecks, findForeignLedgerRef } from "./apply";

describe("collectFkChecks", () => {
  it("collects only non-null ids with their tables", () => {
    expect(
      collectFkChecks({
        accountId: "A",
        toAccountId: null,
        envelopeId: "E",
        categoryId: undefined,
      }),
    ).toEqual([
      { table: "accounts", id: "A" },
      { table: "envelopes", id: "E" },
    ]);
  });

  it("toAccountId checks the accounts table", () => {
    expect(collectFkChecks({ toAccountId: "B" })).toEqual([{ table: "accounts", id: "B" }]);
  });

  it("placeId checks places, groupId checks envelope_groups", () => {
    expect(collectFkChecks({ placeId: "P", groupId: "G" })).toEqual([
      { table: "places", id: "P" },
      { table: "envelope_groups", id: "G" },
    ]);
  });
});

/* ── findForeignLedgerRef (restore-path scope guard) ────────────────── */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOREIGN = U(666);

function ledger(over: Partial<ClientLedgerInput> = {}): ClientLedgerInput {
  return {
    accounts: [
      { id: U(1), name: "a", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 0, archived: false, sort: 0 },
      { id: U(11), name: "b", color: "#fff", icon: "wallet", type: "savings", onBudget: true, initialBalance: 0, archived: false, sort: 1 },
    ],
    groups: [{ id: U(2), name: "g", sort: 0 }],
    envelopes: [
      { id: U(3), groupId: U(2), name: "e", color: "#fff", icon: "tag", note: null, monthlyTarget: null, isSavings: false, sort: 0, archived: false },
    ],
    categories: [{ id: U(4), name: "c" }],
    places: [{ id: U(5), name: "p" }],
    allocations: [],
    transactions: [],
    ...over,
  };
}

type Txn = ClientLedgerInput["transactions"][number];
const txn = (over: Partial<Txn> = {}): Txn => ({
  id: U(7),
  type: "expense",
  accountId: U(1),
  toAccountId: null,
  amount: 100,
  date: "2026-01-02",
  confirmed: true,
  isRefund: false,
  envelopeId: U(3),
  placeId: null,
  categoryId: null,
  name: null,
  note: null,
  tag: null,
  items: [],
  createdAt: "2026-01-02T00:00:00.000Z",
  ...over,
});

describe("findForeignLedgerRef", () => {
  it("accepts a self-consistent ledger referencing every entity type", () => {
    const l = ledger({
      transactions: [
        txn({ placeId: U(5), categoryId: U(4) }),
        txn({ id: U(8), type: "transfer", envelopeId: null, toAccountId: U(11) }),
        txn({
          id: U(9),
          envelopeId: null,
          items: [{ id: "item-local:1", envelopeId: U(3), categoryId: U(4), amount: 100 }],
        }),
      ],
      allocations: [{ id: "alloc-local:1", envelopeId: U(3), month: "2026-01", amount: 100 }],
    });
    expect(findForeignLedgerRef(l)).toBeNull();
  });

  it("flags an envelope whose groupId is not carried by the payload", () => {
    const l = ledger({
      envelopes: [
        { id: U(3), groupId: FOREIGN, name: "e", color: "#fff", icon: "tag", note: null, monthlyTarget: null, isSavings: false, sort: 0, archived: false },
      ],
    });
    expect(findForeignLedgerRef(l)).toContain("groupId");
  });

  const foreignTxnCases: Array<[string, Partial<Txn>]> = [
    ["accountId", { accountId: FOREIGN }],
    ["toAccountId", { type: "transfer", envelopeId: null, toAccountId: FOREIGN }],
    ["envelopeId", { envelopeId: FOREIGN }],
    ["placeId", { placeId: FOREIGN }],
    ["categoryId", { categoryId: FOREIGN }],
  ];
  for (const [field, over] of foreignTxnCases) {
    it(`flags a transaction with a foreign ${field}`, () => {
      const l = ledger({ transactions: [txn(over)] });
      expect(findForeignLedgerRef(l)).toContain(field);
    });
  }

  it("flags split items with a foreign envelopeId or categoryId", () => {
    const foreignEnv = ledger({
      transactions: [
        txn({ envelopeId: null, items: [{ id: "i1", envelopeId: FOREIGN, categoryId: null, amount: 100 }] }),
      ],
    });
    expect(findForeignLedgerRef(foreignEnv)).toContain("items.envelopeId");
    const foreignCat = ledger({
      transactions: [
        txn({ envelopeId: null, items: [{ id: "i1", envelopeId: U(3), categoryId: FOREIGN, amount: 100 }] }),
      ],
    });
    expect(findForeignLedgerRef(foreignCat)).toContain("items.categoryId");
  });

  it("does NOT flag allocations (insertLedger drops foreign ones instead)", () => {
    const l = ledger({
      allocations: [{ id: "alloc-local:1", envelopeId: FOREIGN, month: "2026-01", amount: 100 }],
    });
    expect(findForeignLedgerRef(l)).toBeNull();
  });
});
