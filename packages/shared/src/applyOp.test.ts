import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { applyOp, MISSING_CREATED_AT } from "./applyOp";
import { budgetedPlusToBeBudgeted, computeBudgetState, totalOnBudget } from "./budget";
import { acc, alloc, asClientLedger, deepFreeze, env, grp, interpret, ledgerArb, MONTHS, mkOp, specArb, tx } from "./ledger.test-support";
import type { OpKind, OpPayload } from "./ops";
import type { ClientLedger, Transaction } from "./types";

/** Applies an op on a DEEP-FROZEN ledger — any input mutation will throw. */
const apply = <K extends OpKind>(l: ClientLedger, kind: K, payload: OpPayload<K>) => applyOp(deepFreeze(l), mkOp(kind, payload));

/** Base ledger for the unit tests. */
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
    categories: [{ id: "C1", name: "Jedzenie" }],
    places: [{ id: "P1", name: "Lidl" }],
  };
}

/* ── txn.create ─────────────────────────────────────────────────────── */

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
      createdAt: "2026-06-05T10:00:00.000Z",
    });
    expect(next.transactions.map((t) => t.id)).toEqual(["T0", "T1"]); // appended
    expect(next.transactions[1]).toEqual({
      id: "T1",
      type: "expense",
      accountId: "A1",
      toAccountId: null,
      amount: 30_00,
      date: "2026-06-05",
      isRefund: false, // DB default
      envelopeId: "E1",
      placeId: null,
      categoryId: null,
      name: null,
      note: null,
      tag: null,
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
      envelopeId: "E1", // the server ignores it for transfers
      categoryId: "C1",
      createdAt: "2026-06-05T10:00:00.000Z",
    });
    const t = next.transactions[0]!;
    expect(t.toAccountId).toBe("A2");
    expect(t.envelopeId).toBeNull();
    // parity with the server: applyTxnCreate clears categoryId ONLY for splits
    expect(t.categoryId).toBe("C1");
  });

  it("split: parent envelopeId/categoryId null, items with synthetic ids", () => {
    const next = apply(base(), "txn.create", {
      id: "T1",
      type: "expense",
      accountId: "A1",
      amount: 50_00,
      date: "2026-06-05",
      envelopeId: "E1", // the server clears it when items>0
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

/* ── txn.update ─────────────────────────────────────────────────────── */

describe("applyOp: txn.update", () => {
  const existing = (): Transaction =>
    tx({
      id: "T1",
      accountId: "A1",
      envelopeId: "E1",
      amount: 30_00,
      note: "stara notatka",
      tag: "LIDL",
      createdAt: "2026-06-01T08:00:00.000Z",
      items: [{ id: "srv-item-1", envelopeId: "E1", categoryId: null, amount: 30_00 }],
    });

  it("full field replacement: fields missing from the payload revert to defaults (except tag/createdAt)", () => {
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
      tag: "LIDL", // tag undefined → kept
      items: [], // delete+reinsert: payload without items ⇒ empty
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
    expect(upd(undefined)).toBe("LIDL");
    expect(upd(null)).toBeNull();
    expect(upd("BIEDRONKA")).toBe("BIEDRONKA");
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
    expect(next.transactions[0]!.envelopeId).toBeNull(); // split ⇒ parent without an envelope
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
    // parity with the server: applyTxnUpdate clears categoryId ONLY for splits
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

/* ── txn.delete ─────────────────────────────────────────────────────── */

describe("applyOp: txn.delete", () => {
  it("removes the row; missing row = no-op (idempotent)", () => {
    const l = { ...base(), transactions: [tx({ id: "T1", accountId: "A1" })] };
    const next = apply(l, "txn.delete", { id: "T1" });
    expect(next.transactions).toEqual([]);
    const frozen = deepFreeze(next);
    expect(applyOp(frozen, mkOp("txn.delete", { id: "T1" }))).toBe(frozen);
  });
});

/* ── alloc.set ──────────────────────────────────────────────────────── */

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
    // different month = different row
    const other = apply(l, "alloc.set", { envelopeId: "E1", month: "2026-07", amount: 10_00 });
    expect(other.allocations).toHaveLength(2);
  });
});

/* ── account.* ──────────────────────────────────────────────────────── */

describe("applyOp: account.*", () => {
  it("create: DB defaults for omitted fields", () => {
    const next = apply(base(), "account.create", { id: "A9", name: "Nowe" });
    expect(next.accounts[2]).toEqual({
      id: "A9",
      name: "Nowe",
      color: "#54c6bd",
      icon: "wallet",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
    });
  });

  it("update: partial merge — only the fields sent", () => {
    const next = apply(base(), "account.update", { id: "A1", name: "Zmienione", sort: 5 });
    const a = next.accounts[0]!;
    expect(a.name).toBe("Zmienione");
    expect(a.sort).toBe(5);
    expect(a.initialBalance).toBe(100_00); // untouched
    expect(a.onBudget).toBe(true);
    // missing id → no-op
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
    expect(next.transactions.map((t) => t.id)).toEqual(["T3"]); // T1 (from), T2 (to) — whole rows
  });
});

/* ── envelope.* ─────────────────────────────────────────────────────── */

describe("applyOp: envelope.*", () => {
  it("create: DB defaults for omitted fields", () => {
    const next = apply(base(), "envelope.create", { id: "E9", groupId: "G1", name: "Nowa" });
    expect(next.envelopes[3]).toEqual({
      id: "E9",
      groupId: "G1",
      name: "Nowa",
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
    const next = apply(base(), "envelope.update", { id: "E1", note: "notka", archived: true });
    expect(next.envelopes[0]!.note).toBe("notka");
    expect(next.envelopes[0]!.archived).toBe(true);
    expect(next.envelopes[0]!.name).toBe("Koperta");
    const frozen = deepFreeze(next);
    expect(applyOp(frozen, mkOp("envelope.update", { id: "MISSING", name: "x" }))).toBe(frozen);
  });

  it("delete: removes the envelope + its allocations, SET NULL on transactions, cuts split items", () => {
    const l: ClientLedger = {
      ...base(),
      allocations: [alloc("E1", "2026-06", 50_00), alloc("E2", "2026-06", 20_00)],
      transactions: [
        tx({ id: "T1", accountId: "A1", envelopeId: "E1", amount: 10_00 }),
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
    const [t1, t2, t3] = next.transactions;
    expect(t1!.envelopeId).toBeNull(); // SET NULL
    expect(t2!.items).toEqual([{ id: "i2", envelopeId: "E2", categoryId: null, amount: 20_00 }]);
    expect(t2!.amount).toBe(50_00); // parent amount unchanged
    expect(t3).toBe(l.transactions[2]!); // untouched — shared reference
  });
});

/* ── group.* ────────────────────────────────────────────────────────── */

describe("applyOp: group.*", () => {
  it("create with the sort=0 default and a partial update", () => {
    const created = apply(base(), "group.create", { id: "G9", name: "Nowa grupa" });
    expect(created.groups[2]).toEqual({ id: "G9", name: "Nowa grupa", sort: 0 });
    const updated = apply(created, "group.update", { id: "G9", sort: 3 });
    expect(updated.groups[2]).toEqual({ id: "G9", name: "Nowa grupa", sort: 3 });
    const frozen = deepFreeze(updated);
    expect(applyOp(frozen, mkOp("group.update", { id: "MISSING", name: "x" }))).toBe(frozen);
  });

  it("delete: envelope.delete effects for all envelopes of the group, then the group", () => {
    const l: ClientLedger = {
      ...base(), // G1: E1,E2; G2: E3
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
    expect(next.transactions[0]!.envelopeId).toBeNull();
    expect(next.transactions[1]!.items).toEqual([{ id: "i2", envelopeId: "E3", categoryId: null, amount: 20_00 }]);
  });
});

/* ── dictionaries ──────────────────────────────────────────────────── */

describe("applyOp: category/place create", () => {
  it("appends dictionary rows", () => {
    let l = apply(base(), "category.create", { id: "C9", name: "Paliwo" });
    l = apply(l, "place.create", { id: "P9", name: "Orlen" });
    expect(l.categories[1]).toEqual({ id: "C9", name: "Paliwo" });
    expect(l.places[1]).toEqual({ id: "P9", name: "Orlen" });
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
    expect(twice).toBe(once); // no-op — same reference
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

    expect(apply(l, "account.create", { id: "A1", name: "Dubel" })).toBe(l);
    expect(apply(l, "group.create", { id: "G1", name: "Dubel" })).toBe(l);
    expect(apply(l, "envelope.create", { id: "E1", groupId: "G2", name: "Dubel" })).toBe(l);
    expect(apply(l, "category.create", { id: "C1", name: "Dubel" })).toBe(l);
    expect(apply(l, "place.create", { id: "P1", name: "Dubel" })).toBe(l);
  });
});

/* ── unknown kind ───────────────────────────────────────────────────── */

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

/* ── immutability ───────────────────────────────────────────────────── */

describe("applyOp: input immutability", () => {
  it("touched collections are fresh arrays, the input unchanged", () => {
    const l = { ...base(), transactions: [tx({ id: "T1", accountId: "A1" })] };
    deepFreeze(l); // a mutation would throw TypeError
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
    expect(next.accounts).toBe(l.accounts); // an untouched collection may be shared
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
          ledger = applyOp(deepFreeze(ledger), op); // freeze: mutation = TypeError
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
