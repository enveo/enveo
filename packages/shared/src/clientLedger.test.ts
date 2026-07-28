import { describe, expect, test } from "bun:test";
import { clientLedgerSchema } from "./ops";
import type { ClientLedger } from "./types";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const emptyLedger: ClientLedger = {
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
};

/** Full, valid ledger with one entity of each kind (to be mutated in tests). */
function fullLedger(): ClientLedger {
  return {
    accounts: [{ id: U(1), name: "Konto", color: "#000", icon: "wallet", type: "checking", onBudget: true, initialBalance: -500, archived: false, sort: 0 }],
    groups: [{ id: U(2), name: "Grupa", sort: 0 }],
    envelopes: [{ id: U(3), groupId: U(2), name: "Jedzenie", color: "#f1dca0", icon: "food", note: null, sort: 0, archived: false }],
    categories: [{ id: U(4), name: "Sklep" }],
    places: [{ id: U(5), name: "Lidl" }],
    allocations: [{ id: "alloc-local:x", envelopeId: U(3), month: "2026-07", amount: -1200 }],
    transactions: [
      {
        id: U(7),
        type: "expense",
        accountId: U(1),
        toAccountId: null,
        amount: 300,
        date: "2026-07-04",
        confirmed: true,
        isRefund: false,
        envelopeId: null,
        placeId: U(5),
        categoryId: null,
        name: "Zakupy",
        note: null,
        tag: null,
        items: [
          { id: "item-local:7:0", envelopeId: U(3), categoryId: U(4), amount: 100 },
          { id: "item-local:7:1", envelopeId: U(3), categoryId: null, amount: 200 },
        ],
        createdAt: "2026-07-04T10:00:00.000Z",
      },
    ],
  };
}

describe("clientLedgerSchema", () => {
  test("an empty ledger is valid (clean wipe)", () => {
    expect(clientLedgerSchema.safeParse(emptyLedger).success).toBe(true);
  });

  test("a full ledger with synthetic allocation/item ids passes", () => {
    const res = clientLedgerSchema.safeParse(fullLedger());
    expect(res.success).toBe(true);
  });

  test("negative amounts allowed for allocations and initial balance, positive for transactions", () => {
    const l = fullLedger();
    l.allocations[0]!.amount = -9999;
    l.accounts[0]!.initialBalance = -12345;
    expect(clientLedgerSchema.safeParse(l).success).toBe(true);
  });

  test("Σ split items ≠ amount → rejected", () => {
    const l = fullLedger();
    l.transactions[0]!.items[0]!.amount = 999; // 999 + 200 ≠ 300
    const res = clientLedgerSchema.safeParse(l);
    expect(res.success).toBe(false);
  });

  test("entity id must be a uuid (an envelope with a non-uuid → rejected)", () => {
    const l = fullLedger();
    l.envelopes[0]!.id = "not-a-uuid";
    expect(clientLedgerSchema.safeParse(l).success).toBe(false);
  });

  test("bad transaction date (not YYYY-MM-DD) → rejected", () => {
    const l = fullLedger();
    l.transactions[0]!.date = "2026/07/04";
    expect(clientLedgerSchema.safeParse(l).success).toBe(false);
  });

  test("bad allocation month (not YYYY-MM) → rejected", () => {
    const l = fullLedger();
    l.allocations[0]!.month = "2026-7";
    expect(clientLedgerSchema.safeParse(l).success).toBe(false);
  });

  test("missing collection key → rejected (the contract requires all 7)", () => {
    const l = fullLedger() as Partial<ClientLedger>;
    delete l.places;
    expect(clientLedgerSchema.safeParse(l).success).toBe(false);
  });

  test("a transaction without items (items: []) is valid", () => {
    const l = fullLedger();
    l.transactions[0]!.items = [];
    expect(clientLedgerSchema.safeParse(l).success).toBe(true);
  });
});
