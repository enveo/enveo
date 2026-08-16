import { describe, expect, test } from "bun:test";
import { clientLedgerSchema, txnPayload } from "./ops";
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
    accounts: [
      {
        id: U(1),
        name: "Konto",
        color: "#000",
        icon: "wallet",
        type: "checking",
        onBudget: true,
        initialBalance: -500,
        archived: false,
        sort: 0,
        automaticEnvelopeId: null,
      },
    ],
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
        isRefund: false,
        envelopeId: null,
        placeId: U(5),
        categoryId: null,
        name: "Zakupy",
        note: null,
        tag: null,
        sourceRef: "LIDL POZNAN 123",
        allocationFromEnvelopeId: null,
        allocationToEnvelopeId: null,
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

  test("sourceRef round-trips, while an old backup without it defaults to null", () => {
    const current = clientLedgerSchema.parse(fullLedger());
    expect(current.transactions[0]!.sourceRef).toBe("LIDL POZNAN 123");
    const old = fullLedger() as unknown as { transactions: Array<Record<string, unknown>> };
    delete old.transactions[0]!.sourceRef;
    expect(clientLedgerSchema.parse(old).transactions[0]!.sourceRef).toBeNull();
  });

  test("automatic-envelope links round-trip and legacy backups default them to null", () => {
    const linked = fullLedger() as unknown as {
      accounts: Array<Record<string, unknown>>;
      transactions: Array<Record<string, unknown>>;
    };
    linked.accounts[0]!.automaticEnvelopeId = U(3);
    linked.transactions[0]!.type = "transfer";
    linked.transactions[0]!.toAccountId = U(1);
    linked.transactions[0]!.envelopeId = null;
    linked.transactions[0]!.items = [];
    linked.transactions[0]!.allocationFromEnvelopeId = U(3);
    linked.transactions[0]!.allocationToEnvelopeId = U(3);

    const current = clientLedgerSchema.parse(linked);
    expect(current.accounts[0]!.automaticEnvelopeId).toBe(U(3));
    expect(current.transactions[0]!.allocationFromEnvelopeId).toBe(U(3));
    expect(current.transactions[0]!.allocationToEnvelopeId).toBe(U(3));

    const oldLedger = fullLedger() as unknown as {
      accounts: Array<Record<string, unknown>>;
      transactions: Array<Record<string, unknown>>;
    };
    delete oldLedger.accounts[0]!.automaticEnvelopeId;
    delete oldLedger.transactions[0]!.allocationFromEnvelopeId;
    delete oldLedger.transactions[0]!.allocationToEnvelopeId;
    expect(clientLedgerSchema.parse(oldLedger).accounts[0]!.automaticEnvelopeId).toBeNull();
    expect(clientLedgerSchema.parse(oldLedger).transactions[0]!.allocationFromEnvelopeId).toBeNull();
    expect(clientLedgerSchema.parse(oldLedger).transactions[0]!.allocationToEnvelopeId).toBeNull();
  });

  test("restored transaction entities enforce the same allocation-flow semantics as write payloads", () => {
    const invalidRows: Array<Partial<ClientLedger["transactions"][number]>> = [
      { type: "expense", allocationFromEnvelopeId: U(3) },
      { type: "expense", allocationToEnvelopeId: U(3) },
      { type: "income", allocationFromEnvelopeId: U(3) },
      { type: "income", envelopeId: U(3), allocationToEnvelopeId: U(3) },
      { type: "transfer", toAccountId: null },
    ];

    for (const patch of invalidRows) {
      const ledger = fullLedger();
      ledger.transactions[0] = { ...ledger.transactions[0]!, items: [], ...patch };
      expect(clientLedgerSchema.safeParse(ledger).success).toBe(false);
    }

    const validTransfer = fullLedger();
    validTransfer.transactions[0] = {
      ...validTransfer.transactions[0]!,
      type: "transfer",
      toAccountId: U(1),
      envelopeId: null,
      items: [],
      allocationFromEnvelopeId: U(3),
      allocationToEnvelopeId: U(3),
    };
    expect(clientLedgerSchema.safeParse(validTransfer).success).toBe(true);
  });

  test("a pre-flag envelope without isSavings parses to false, never undefined (flag = only savings signal)", () => {
    const l = fullLedger();
    // fullLedger()'s envelope deliberately omits `isSavings` — exactly what a pre-flag backup looks like.
    const flagged = { ...l.envelopes[0]!, id: U(10), name: "Poduszka", isSavings: true };
    l.envelopes = [l.envelopes[0]!, flagged];
    const res = clientLedgerSchema.safeParse(l);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.envelopes[0]!.isSavings).toBe(false); // normalized at the restore boundary
    expect(res.data.envelopes[1]!.isSavings).toBe(true); // an explicit flag survives
  });

  test("pre-3.2 planned=true template rows are dropped on parse (never materialize as real money)", () => {
    const l = fullLedger();
    const base = l.transactions[0]!;
    const plannedTrue = { ...base, id: U(8), planned: true }; // legacy template row — must be dropped
    const plannedFalse = { ...base, id: U(9), planned: false }; // legacy but not a template — kept
    l.transactions = [base, plannedTrue, plannedFalse];
    const res = clientLedgerSchema.safeParse(l);
    expect(res.success).toBe(true);
    const ids = res.success ? res.data.transactions.map((t) => t.id) : [];
    expect(ids.sort()).toEqual([base.id, plannedFalse.id].sort());
    expect(ids).not.toContain(plannedTrue.id);
  });
});

describe("txnPayload allocation-flow rules", () => {
  const base = { type: "transfer" as const, accountId: U(1), toAccountId: U(1), amount: 100, date: "2026-07-04" };

  test("allows transfer flow but rejects it for expenses and invalid income combinations", () => {
    expect(txnPayload.safeParse({ ...base, allocationFromEnvelopeId: U(3), allocationToEnvelopeId: U(3) }).success).toBe(true);
    expect(txnPayload.safeParse({ ...base, type: "expense", allocationFromEnvelopeId: U(3) }).success).toBe(false);
    expect(txnPayload.safeParse({ ...base, type: "expense", allocationToEnvelopeId: U(3) }).success).toBe(false);
    expect(txnPayload.safeParse({ ...base, type: "income", allocationFromEnvelopeId: U(3) }).success).toBe(false);
    expect(txnPayload.safeParse({ ...base, type: "income", toAccountId: null, envelopeId: U(3), allocationToEnvelopeId: U(3) }).success).toBe(false);
  });
});
