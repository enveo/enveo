import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { applyOp, MISSING_CREATED_AT } from "./applyOp";
import { budgetedPlusToBeBudgeted, computeBudgetState, totalOnBudget } from "./budget";
import { acc, alloc, asClientLedger, deepFreeze, env, grp, interpret, ledgerArb, MONTHS, mkOp, specArb, tx } from "./ledger.test-support";
import type { OpKind, OpPayload } from "./ops";
import type { ClientLedger, Transaction } from "./types";

const apply = <K extends OpKind>(l: ClientLedger, kind: K, payload: OpPayload<K>) => applyOp(deepFreeze(l), mkOp(kind, payload));

function base(): ClientLedger {
  const g1 = grp({ id: "G1" });
  const g2 = grp({ id: "G2" });
  const a1 = acc({ id: "A1", initialBalance: 100_00 });
  const a2 = acc({ id: "A2" });
  const e1 = env("G1", { id: "E1" });
  const e2 = env("G1", { id: "E2" });
  const e3 = env("G2", { id: "E3" });
  return {
    accounts: [a1, a2],
    groups: [g1, g2],
    envelopes: [e1, e2, e3],
    allocations: [alloc("E1", "2026-06", 50_00)],
    transactions: [],
    categories: [{ id: "C1", name: "Groceries" }],
    places: [{ id: "P1", name: "Linden Market" }],
  };
}

describe("applyOp: txn.create", () => {
  it("appends a normalized transaction with server defaults at the end", () => {
    const l = { ...base(), transactions: [tx({ id: "T0", accountId: "A1" })] };
    const next = apply(l, "txn.create", {
      id: "T1",
      type: "expense",
      accountId: "A1",
      amount: 30_00,
      date: "2026-06-05",
      envelopeId: "E1",
      sourceRef: "LINDEN MARKET 123 DENVER",
      createdAt: "2026-06-05T10:00:00.000Z",
    });
    expect(next.transactions.map((t) => t.id)).toEqual(["T0", "T1"]);
    expect(next.transactions[1]).toEqual({
      id: "T1",
      type: "expense",
      accountId: "A1",
      toAccountId: null,
      amount: 30_00,
      date: "2026-06-05",
      isRefund: false,
      envelopeId: "E1",
      placeId: null,
      categoryId: null,
      name: null,
      note: null,
      tag: null,
      sourceRef: "LINDEN MARKET 123 DENVER",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-06-05T10:00:00.000Z",
    });
  });

  it("transfer: toAccountId kept, envelopeId cleared", () => {
    const next = apply(base(), "txn.create", {
      id: "T1",
      type: "transfer",
      accountId: "A1",
      toAccountId: "A2",
      amount: 10_00,
      date: "2026-06-05",
      envelopeId: "E1",
      categoryId: "C1",
      createdAt: "2026-06-05T10:00:00.000Z",
    });
    const t = next.transactions[0]!;
    expect(t.toAccountId).toBe("A2");
    expect(t.envelopeId).toBeNull();

    expect(t.categoryId).toBe("C1");
  });

  it("split: parent envelopeId/categoryId null, items with synthetic ids", () => {
    const next = apply(base(), "txn.create", {
      id: "T1",
      type: "expense",
      accountId: "A1",
      amount: 50_00,
      date: "2026-06-05",
      envelopeId: "E1",
      categoryId: "C1",
      items: [
        { envelopeId: "E1", categoryId: "C1", amount: 30_00 },
        { envelopeId: "E2", amount: 20_00 },
      ],
      createdAt: "2026-06-05T10:00:00.000Z",
    });
    const t = next.transactions[0]!;
    expect(t.envelopeId).toBeNull();
    expect(t.categoryId).toBeNull();
    expect(t.items).toEqual([
      { id: "item-local:T1:0", envelopeId: "E1", categoryId: "C1", amount: 30_00 },
      { id: "item-local:T1:1", envelopeId: "E2", categoryId: null, amount: 20_00 },
    ]);
  });

  it("missing createdAt in the payload → the documented sentinel", () => {
    const next = apply(base(), "txn.create", {
      id: "T1",
      type: "income",
      accountId: "A1",
      amount: 10_00,
      date: "2026-06-05",
    });
    expect(next.transactions[0]!.createdAt).toBe(MISSING_CREATED_AT);
  });
});

describe("applyOp: txn.update", () => {
  const existing = (): Transaction =>
    tx({
      id: "T1",
      accountId: "A1",
      envelopeId: "E1",
      amount: 30_00,
      note: "previous note",
      tag: "LINDEN MARKET",
      sourceRef: "LINDEN MARKET 123 DENVER",
      createdAt: "2026-06-01T08:00:00.000Z",
      items: [{ id: "srv-item-1", envelopeId: "E1", categoryId: null, amount: 30_00 }],
    });

  it("full field replacement: fields missing from the payload revert to defaults (except import metadata/createdAt)", () => {
    const l = { ...base(), transactions: [existing()] };
    const next = apply(l, "txn.update", {
      id: "T1",
      type: "expense",
      accountId: "A2",
      amount: 40_00,
      date: "2026-06-07",
      envelopeId: "E2",
    });
    expect(next.transactions[0]).toEqual({
      id: "T1",
      type: "expense",
      accountId: "A2",
      toAccountId: null,
      amount: 40_00,
      date: "2026-06-07",
      isRefund: false,
      envelopeId: "E2",
      placeId: null,
      categoryId: null,
      name: null,
      note: null, // full replacement — a field not sent = null
      tag: "LINDEN MARKET",
      sourceRef: "LINDEN MARKET 123 DENVER",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-06-01T08:00:00.000Z", // NEVER changed
    });
  });

  it("tag: null overwrites, a value overwrites, undefined keeps", () => {
    const l = { ...base(), transactions: [existing()] };
    const upd = (tag: string | null | undefined) =>
      apply(l, "txn.update", {
        id: "T1",
        type: "expense",
        accountId: "A1",
        amount: 30_00,
        date: "2026-06-01",
        envelopeId: "E1",
        ...(tag !== undefined ? { tag } : {}),
      }).transactions[0]!.tag;
    expect(upd(undefined)).toBe("LINDEN MARKET");
    expect(upd(null)).toBeNull();
    expect(upd("CLOVER MARKET")).toBe("CLOVER MARKET");
  });

  it("sourceRef: null overwrites, a value overwrites, undefined keeps", () => {
    const l = { ...base(), transactions: [existing()] };
    const upd = (sourceRef: string | null | undefined) =>
      apply(l, "txn.update", {
        id: "T1",
        type: "expense",
        accountId: "A1",
        amount: 30_00,
        date: "2026-06-01",
        envelopeId: "E1",
        ...(sourceRef !== undefined ? { sourceRef } : {}),
      }).transactions[0]!.sourceRef;
    expect(upd(undefined)).toBe("LINDEN MARKET 123 DENVER");
    expect(upd(null)).toBeNull();
    expect(upd("CLOVER MARKET RAW")).toBe("CLOVER MARKET RAW");
  });

  it("preserves omitted allocation flow only when the merged transaction remains valid", () => {
    const baseWithFlow = {
      ...base(),
      transactions: [
        {
          ...existing(),
          type: "transfer",
          toAccountId: "A2",
          envelopeId: null,
          items: [],
          allocationFromEnvelopeId: "E1",
          allocationToEnvelopeId: "E2",
        },
      ],
    } as unknown as ClientLedger;
    const updateWithoutFlowFields = {
      id: "T1",
      type: "transfer",
      accountId: "A1",
      toAccountId: "A2",
      amount: 30_00,
      date: "2026-06-01",
    };

    const preserved = apply(baseWithFlow, "txn.update", updateWithoutFlowFields);
    expect(preserved.transactions[0]!.allocationFromEnvelopeId).toBe("E1");
    expect(preserved.transactions[0]!.allocationToEnvelopeId).toBe("E2");

    const invalidTypeChange = apply(baseWithFlow, "txn.update", {
      ...updateWithoutFlowFields,
      type: "expense",
      toAccountId: null,
      envelopeId: "E1",
    });
    expect(invalidTypeChange).toBe(baseWithFlow);
    expect(invalidTypeChange.transactions[0]!.type).toBe("transfer");

    const cleared = apply(baseWithFlow, "txn.update", {
      ...updateWithoutFlowFields,
      type: "expense",
      toAccountId: null,
      envelopeId: "E1",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    } as never);
    expect(cleared.transactions[0]!.allocationFromEnvelopeId).toBeNull();
    expect(cleared.transactions[0]!.allocationToEnvelopeId).toBeNull();
  });

  it("items: delete+reinsert with fresh synthetic ids", () => {
    const l = { ...base(), transactions: [existing()] };
    const next = apply(l, "txn.update", {
      id: "T1",
      type: "expense",
      accountId: "A1",
      amount: 50_00,
      date: "2026-06-01",
      items: [
        { envelopeId: "E2", amount: 20_00 },
        { envelopeId: "E1", categoryId: "C1", amount: 30_00 },
      ],
    });
    expect(next.transactions[0]!.items).toEqual([
      { id: "item-local:T1:0", envelopeId: "E2", categoryId: null, amount: 20_00 },
      { id: "item-local:T1:1", envelopeId: "E1", categoryId: "C1", amount: 30_00 },
    ]);
    expect(next.transactions[0]!.envelopeId).toBeNull();
  });

  it("an update to transfer normalizes like create", () => {
    const l = { ...base(), transactions: [existing()] };
    const next = apply(l, "txn.update", {
      id: "T1",
      type: "transfer",
      accountId: "A1",
      toAccountId: "A2",
      amount: 15_00,
      date: "2026-06-02",
      envelopeId: "E1",
      categoryId: "C1",
    });
    const t = next.transactions[0]!;
    expect(t.toAccountId).toBe("A2");
    expect(t.envelopeId).toBeNull();

    expect(t.categoryId).toBe("C1");
  });

  it("missing id → no-op (same ledger reference)", () => {
    const l = { ...base(), transactions: [existing()] };
    const frozen = deepFreeze(l);
    const next = applyOp(
      frozen,
      mkOp("txn.update", {
        id: "MISSING",
        type: "expense",
        accountId: "A1",
        amount: 1,
        date: "2026-06-01",
      }),
    );
    expect(next).toBe(frozen);
  });
});

describe("applyOp: txn.delete", () => {
  it("removes the row; missing row = no-op (idempotent)", () => {
    const l = { ...base(), transactions: [tx({ id: "T1", accountId: "A1" })] };
    const next = apply(l, "txn.delete", { id: "T1" });
    expect(next.transactions).toEqual([]);
    const frozen = deepFreeze(next);
    expect(applyOp(frozen, mkOp("txn.delete", { id: "T1" }))).toBe(frozen);
  });
});

describe("applyOp: alloc.set", () => {
  it("insert: synthetic id from the natural key", () => {
    const next = apply(base(), "alloc.set", { envelopeId: "E2", month: "2026-06", amount: 70_00 });
    expect(next.allocations).toHaveLength(2);
    expect(next.allocations[1]).toEqual({
      id: "alloc-local:E2:2026-06",
      envelopeId: "E2",
      month: "2026-06",
      amount: 70_00,
    });
  });

  it("upsert by (envelopeId, month): keeps the existing id, replaces the amount", () => {
    const l = base();
    const canonicalId = l.allocations[0]!.id;
    const next = apply(l, "alloc.set", { envelopeId: "E1", month: "2026-06", amount: 99_00 });
    expect(next.allocations).toHaveLength(1);
    expect(next.allocations[0]).toEqual({
      id: canonicalId,
      envelopeId: "E1",
      month: "2026-06",
      amount: 99_00,
    });

    const other = apply(l, "alloc.set", { envelopeId: "E1", month: "2026-07", amount: 10_00 });
    expect(other.allocations).toHaveLength(2);
  });
});

describe("applyOp: account.*", () => {
  it("create: DB defaults for omitted fields", () => {
    const next = apply(base(), "account.create", { id: "A9", name: "New checking" });
    expect(next.accounts[2]).toEqual({
      id: "A9",
      name: "New checking",
      color: "#54c6bd",
      icon: "wallet",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: null,
    });
  });

  it("update: partial merge — only the fields sent", () => {
    const next = apply(base(), "account.update", { id: "A1", name: "Updated", sort: 5 });
    const a = next.accounts[0]!;
    expect(a.name).toBe("Updated");
    expect(a.sort).toBe(5);
    expect(a.initialBalance).toBe(100_00);
    expect(a.onBudget).toBe(true);

    const frozen = deepFreeze(next);
    expect(applyOp(frozen, mkOp("account.update", { id: "MISSING", name: "x" }))).toBe(frozen);
  });

  it("delete: removes the account AND transactions with accountId or toAccountId (row cascade)", () => {
    const l = {
      ...base(),
      transactions: [
        tx({ id: "T1", accountId: "A1", envelopeId: "E1", amount: 10_00 }),
        tx({ id: "T2", type: "transfer", accountId: "A2", toAccountId: "A1", amount: 5_00 }),
        tx({ id: "T3", accountId: "A2", envelopeId: "E1", amount: 7_00 }),
      ],
    };
    const next = apply(l, "account.delete", { id: "A1" });
    expect(next.accounts.map((a) => a.id)).toEqual(["A2"]);
    expect(next.transactions.map((t) => t.id)).toEqual(["T3"]);
  });

  it("delete removes transactions carrying automatic allocation effects with their account", () => {
    const l = {
      ...base(),
      transactions: [
        {
          ...tx({ id: "T1", accountId: "A1", envelopeId: "E1", amount: 10_00 }),
          allocationFromEnvelopeId: "E1",
          allocationToEnvelopeId: "E2",
        },
        tx({ id: "T2", accountId: "A2", envelopeId: "E1", amount: 7_00 }),
      ],
    } as unknown as ClientLedger;
    const next = apply(l, "account.delete", { id: "A1" });
    expect(next.transactions.map((t) => t.id)).toEqual(["T2"]);
  });
});

describe("applyOp: envelope.*", () => {
  it("create: DB defaults for omitted fields", () => {
    const next = apply(base(), "envelope.create", { id: "E9", groupId: "G1", name: "New envelope" });
    expect(next.envelopes[3]).toEqual({
      id: "E9",
      groupId: "G1",
      name: "New envelope",
      color: "#f1dca0",
      icon: "tag",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: 0,
      archived: false,
    });
  });

  it("update: partial merge; missing id → no-op", () => {
    const next = apply(base(), "envelope.update", { id: "E1", note: "note", archived: true });
    expect(next.envelopes[0]!.note).toBe("note");
    expect(next.envelopes[0]!.archived).toBe(true);
    expect(next.envelopes[0]!.name).toBe("Envelope");
    const frozen = deepFreeze(next);
    expect(applyOp(frozen, mkOp("envelope.update", { id: "MISSING", name: "x" }))).toBe(frozen);
  });

  it("delete: removes the envelope + its allocations, SET NULL on references, cuts split items", () => {
    const l: ClientLedger = {
      ...base(),
      accounts: base().accounts.map((account) => ({ ...account, automaticEnvelopeId: account.id === "A1" ? "E1" : "E2" })),
      allocations: [alloc("E1", "2026-06", 50_00), alloc("E2", "2026-06", 20_00)],
      transactions: [
        {
          ...tx({ id: "T1", accountId: "A1", envelopeId: "E1", amount: 10_00 }),
          allocationFromEnvelopeId: "E1",
          allocationToEnvelopeId: "E1",
        },
        tx({
          id: "T2",
          accountId: "A1",
          amount: 50_00,
          items: [
            { id: "i1", envelopeId: "E1", categoryId: null, amount: 30_00 },
            { id: "i2", envelopeId: "E2", categoryId: null, amount: 20_00 },
          ],
        }),
        tx({ id: "T3", accountId: "A1", envelopeId: "E2", amount: 7_00 }),
      ],
    };
    const next = apply(l, "envelope.delete", { id: "E1" });
    expect(next.envelopes.map((e) => e.id)).toEqual(["E2", "E3"]);
    expect(next.allocations.map((a) => a.envelopeId)).toEqual(["E2"]); // allocation cascade
    expect(next.accounts.map((account) => account.automaticEnvelopeId)).toEqual([null, "E2"]);
    const [t1, t2, t3] = next.transactions;
    expect(t1!.envelopeId).toBeNull();
    expect(t1!.allocationFromEnvelopeId).toBeNull();
    expect(t1!.allocationToEnvelopeId).toBeNull();
    expect(t2!.items).toEqual([{ id: "i2", envelopeId: "E2", categoryId: null, amount: 20_00 }]);
    expect(t2!.amount).toBe(50_00);
    expect(t3).toBe(l.transactions[2]!);
  });
});

describe("applyOp: group.*", () => {
  it("create with the sort=0 default and a partial update", () => {
    const created = apply(base(), "group.create", { id: "G9", name: "New group" });
    expect(created.groups[2]).toEqual({ id: "G9", name: "New group", sort: 0 });
    const updated = apply(created, "group.update", { id: "G9", sort: 3 });
    expect(updated.groups[2]).toEqual({ id: "G9", name: "New group", sort: 3 });
    const frozen = deepFreeze(updated);
    expect(applyOp(frozen, mkOp("group.update", { id: "MISSING", name: "x" }))).toBe(frozen);
  });

  it("delete: envelope.delete effects for all envelopes of the group, then the group", () => {
    const l: ClientLedger = {
      ...base(),
      accounts: base().accounts.map((account) => ({ ...account, automaticEnvelopeId: account.id === "A1" ? "E1" : "E3" })),
      allocations: [alloc("E1", "2026-06", 50_00), alloc("E3", "2026-06", 30_00)],
      transactions: [
        tx({ id: "T1", accountId: "A1", envelopeId: "E1", amount: 10_00 }),
        tx({
          id: "T2",
          accountId: "A1",
          amount: 50_00,
          items: [
            { id: "i1", envelopeId: "E2", categoryId: null, amount: 30_00 },
            { id: "i2", envelopeId: "E3", categoryId: null, amount: 20_00 },
          ],
        }),
      ],
    };
    const next = apply(l, "group.delete", { id: "G1" });
    expect(next.groups.map((g) => g.id)).toEqual(["G2"]);
    expect(next.envelopes.map((e) => e.id)).toEqual(["E3"]);
    expect(next.allocations.map((a) => a.envelopeId)).toEqual(["E3"]);
    expect(next.accounts.map((account) => account.automaticEnvelopeId)).toEqual([null, "E3"]);
    expect(next.transactions[0]!.envelopeId).toBeNull();
    expect(next.transactions[1]!.items).toEqual([{ id: "i2", envelopeId: "E3", categoryId: null, amount: 20_00 }]);
  });
});

describe("applyOp: category/place create", () => {
  it("appends dictionary rows, visible in entry until archived", () => {
    let l = apply(base(), "category.create", { id: "C9", name: "Fuel" });
    l = apply(l, "place.create", { id: "P9", name: "Prairie Fuel" });
    expect(l.categories[1]).toEqual({ id: "C9", name: "Fuel", archived: false });
    expect(l.places[1]).toEqual({ id: "P9", name: "Prairie Fuel", archived: false });
  });
});

describe("applyOp: dictionary upkeep", () => {
  it("archives and restores an entry without touching the transactions that carry it", () => {
    let l = apply(base(), "place.create", { id: "P9", name: "Prairie Fuel" });
    l = apply(l, "txn.create", { id: "T9", type: "expense", accountId: "A1", amount: 1000, date: "2026-08-19", placeId: "P9" });

    l = apply(l, "place.update", { id: "P9", archived: true });
    expect(l.places.find((p) => p.id === "P9")).toEqual({ id: "P9", name: "Prairie Fuel", archived: true });
    expect(l.transactions.find((t) => t.id === "T9")?.placeId).toBe("P9");

    l = apply(l, "place.update", { id: "P9", archived: false });
    expect(l.places.find((p) => p.id === "P9")?.archived).toBe(false);
  });

  it("deletes an unreferenced entry outright", () => {
    let l = apply(base(), "place.create", { id: "P9", name: "Typo" });
    l = apply(l, "place.delete", { id: "P9" });
    expect(l.places.some((p) => p.id === "P9")).toBe(false);
  });

  it("DEGRADES a delete to an archive once something references the entry", () => {
    let l = apply(base(), "place.create", { id: "P9", name: "Prairie Fuel" });
    l = apply(l, "txn.create", { id: "T9", type: "expense", accountId: "A1", amount: 1000, date: "2026-08-19", placeId: "P9" });

    l = apply(l, "place.delete", { id: "P9" });
    expect(l.places.find((p) => p.id === "P9")).toEqual({ id: "P9", name: "Prairie Fuel", archived: true });
    expect(l.transactions.find((t) => t.id === "T9")?.placeId).toBe("P9");
  });

  it("counts a SPLIT ITEM as a reference when deleting a category", () => {
    let l = apply(base(), "category.create", { id: "C9", name: "Coffee" });
    l = apply(l, "txn.create", {
      id: "T9",
      type: "expense",
      accountId: "A1",
      amount: 1000,
      date: "2026-08-19",
      items: [{ envelopeId: "E1", amount: 1000, categoryId: "C9" }],
    });

    l = apply(l, "category.delete", { id: "C9" });
    expect(l.categories.find((c) => c.id === "C9")).toEqual({ id: "C9", name: "Coffee", archived: true });
  });
});

/* ── create on an existing id — replay idempotency (fullResync) ─────── */

describe("applyOp: create on an existing id is a no-op", () => {
  // Server: PK violation → rejected + rollback, or the sync_ops guard →
  // "duplicate" without re-application — state never gets a second row.
  // Replaying a pending op over a snapshot that already absorbed the create
  // (lost push ack) must NOT duplicate the row.

  it("txn.create: replay over a snapshot with the same id does not duplicate the transaction", () => {
    const payload: OpPayload<"txn.create"> = {
      id: "T1",
      type: "expense",
      accountId: "A1",
      amount: 30_00,
      date: "2026-06-05",
      envelopeId: "E1",
      createdAt: "2026-06-05T10:00:00.000Z",
    };
    const once = apply(base(), "txn.create", payload);
    const twice = apply(once, "txn.create", payload);
    expect(twice).toBe(once);
    expect(twice.transactions.map((t) => t.id)).toEqual(["T1"]);
  });

  it("txn.create: does not overwrite the existing row (the server canon stays)", () => {
    const l = { ...base(), transactions: [tx({ id: "T1", accountId: "A1", amount: 99_00 })] };
    const next = apply(l, "txn.create", {
      id: "T1",
      type: "expense",
      accountId: "A2",
      amount: 1_00,
      date: "2026-06-06",
      createdAt: "2026-06-06T10:00:00.000Z",
    });
    expect(next.transactions).toHaveLength(1);
    expect(next.transactions[0]!.amount).toBe(99_00);
  });

  it("account/group/envelope/category/place.create: existing id ⇒ no-op", () => {
    const l = base();

    expect(apply(l, "account.create", { id: "A1", name: "Duplicate" })).toBe(l);
    expect(apply(l, "group.create", { id: "G1", name: "Duplicate" })).toBe(l);
    expect(apply(l, "envelope.create", { id: "E1", groupId: "G2", name: "Duplicate" })).toBe(l);
    expect(apply(l, "category.create", { id: "C1", name: "Duplicate" })).toBe(l);
    expect(apply(l, "place.create", { id: "P1", name: "Duplicate" })).toBe(l);
  });
});

describe("applyOp: unknown kind", () => {
  it("unknown op kind is a no-op (ops queued by an older/retired app version)", () => {
    const l = base();
    const out = applyOp(l, {
      opId: "x",
      kind: "legacy.retiredFeature",
      payload: { id: "R1" },
    } as never);
    expect(out).toBe(l); // same reference — pass-through, not a rebuild
  });
});

describe("applyOp: input immutability", () => {
  it("touched collections are fresh arrays, the input unchanged", () => {
    const l = { ...base(), transactions: [tx({ id: "T1", accountId: "A1" })] };
    deepFreeze(l);
    const next = applyOp(
      l,
      mkOp("txn.create", {
        id: "T2",
        type: "income",
        accountId: "A1",
        amount: 1_00,
        date: "2026-06-05",
        createdAt: "2026-06-05T10:00:00.000Z",
      }),
    );
    expect(next).not.toBe(l);
    expect(next.transactions).not.toBe(l.transactions);
    expect(l.transactions).toHaveLength(1);
    expect(next.transactions).toHaveLength(2);
    expect(next.accounts).toBe(l.accounts);
  });
});

/* ── Property: random op sequences hold invariant §2.3 ──────────────── */

describe("applyOp: invariant §2.3 (property-based)", () => {
  it("random sequences of valid ops hold Σ available + toBeBudgeted = Σ on-budget balances", () => {
    fc.assert(
      fc.property(ledgerArb(), fc.array(specArb, { maxLength: 25 }), (baseLedger, specs) => {
        let ledger = asClientLedger(baseLedger);
        let n = 0;
        const nextId = () => `N${n++}`;
        for (const s of specs) {
          const op = interpret(ledger, s, nextId);
          if (!op) continue;
          ledger = applyOp(deepFreeze(ledger), op);
          for (const m of MONTHS) {
            const st = computeBudgetState(ledger, m);
            expect(budgetedPlusToBeBudgeted(st)).toBe(totalOnBudget(st));
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("applyOp: dictionary merge", () => {
  it("repoints every reference and drops the source, leaving the transactions otherwise untouched", () => {
    let l = apply(base(), "place.create", { id: "P2", name: "Clover Market" });
    l = apply(l, "place.create", { id: "P3", name: "CLOVER MARKET" });
    l = apply(l, "txn.create", { id: "T1", type: "expense", accountId: "A1", amount: 1000, date: "2026-08-19", placeId: "P3" });
    l = apply(l, "txn.create", { id: "T2", type: "expense", accountId: "A1", amount: 2000, date: "2026-08-19", placeId: "P2" });

    l = apply(l, "place.merge", { fromId: "P3", intoId: "P2" });

    expect(l.places.map((p) => [p.id, p.name])).toEqual([
      ["P1", "Linden Market"],
      ["P2", "Clover Market"],
    ]);
    expect(l.transactions.find((t) => t.id === "T1")?.placeId).toBe("P2");
    expect(l.transactions.find((t) => t.id === "T2")?.placeId).toBe("P2");
    expect(l.transactions.find((t) => t.id === "T1")?.amount).toBe(1000);
  });

  it("repoints a category inside SPLIT ITEMS, not just the parent", () => {
    let l = apply(base(), "category.create", { id: "C2", name: "Coffee" });
    l = apply(l, "category.create", { id: "C3", name: "coffee" });
    l = apply(l, "txn.create", {
      id: "T1",
      type: "expense",
      accountId: "A1",
      amount: 1000,
      date: "2026-08-19",
      items: [{ envelopeId: "E1", amount: 1000, categoryId: "C3" }],
    });

    l = apply(l, "category.merge", { fromId: "C3", intoId: "C2" });

    expect(l.categories.map((c) => [c.id, c.name])).toEqual([
      ["C1", "Groceries"],
      ["C2", "Coffee"],
    ]);
    expect(l.transactions.find((t) => t.id === "T1")?.items[0]?.categoryId).toBe("C2");
  });

  it("is a no-op on replay, and when either side is already gone", () => {
    let l = apply(base(), "place.create", { id: "P2", name: "Clover Market" });
    l = apply(l, "place.create", { id: "P3", name: "CLOVER MARKET" });
    const merged = apply(l, "place.merge", { fromId: "P3", intoId: "P2" });

    expect(apply(merged, "place.merge", { fromId: "P3", intoId: "P2" })).toEqual(merged);
    expect(apply(merged, "place.merge", { fromId: "P2", intoId: "P-missing" })).toEqual(merged);
  });
});
