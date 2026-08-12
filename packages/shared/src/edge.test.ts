/**
 * Edge tests guarding the two RISKIEST local-first invariants:
 *
 * 1. CASCADE PARITY applyOp ↔ server FKs. The `applyOp` reducers are the local
 *    mirror of server writes; they must faithfully reproduce the foreign-key
 *    cascades from the schema (packages/api/src/db/schema.ts). The fixtures
 *    below ENCODE the EXPECTED server behavior — if the reducer diverges, we
 *    fix the reducer (it is the mirror), we do NOT weaken the test. FK rules
 *    from the schema:
 *      - transactions.envelope_id      → ON DELETE SET NULL
 *      - transactions.category_id      → ON DELETE SET NULL
 *      - transactions.account_id       → ON DELETE CASCADE
 *      - transactions.to_account_id    → ON DELETE CASCADE
 *      - txn_items.envelope_id         → ON DELETE CASCADE  (removes the item)
 *      - txn_items.transaction_id      → ON DELETE CASCADE  (with the parent)
 *      - allocations.envelope_id       → ON DELETE CASCADE
 *      - envelopes.group_id            → ON DELETE CASCADE  (group → envelopes)
 *
 * 2. REPLAY IDEMPOTENCY (fullResync). fullResync = fresh snapshot + replay of
 *    the REMAINING outbox ops. When a push succeeded but the ACK got lost, the
 *    snapshot ALREADY contains the entities those ops create — replay MUST be
 *    idempotent (create-guard by id, update = full replacement, delete = no-op),
 *    otherwise fullResync would duplicate rows.
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { applyOp } from "./applyOp";
import { acc, alloc, asClientLedger, deepFreeze, env, grp, interpret, ledgerArb, mkOp, specArb, tx } from "./ledger.test-support";
import type { ClientLedger, SyncOp } from "./index";

/* ── 1a. envelope.delete: FK cascades in one fixture ────────────────── */

describe("FK cascade parity: envelope.delete", () => {
  /**
   * Envelope E1 referenced in ALL the ways the server catches:
   *  - direct expense (T1.envelope_id)              → SET NULL
   *  - split item (T2 items[0].envelope_id)         → CASCADE (item disappears)
   *  - income (T3.envelope_id)                      → SET NULL (also for income)
   *  - split whose ALL items are on E1 (T5)         → items []=∅, parent amount unchanged
   *  - allocation (allocations.envelope_id)         → CASCADE
   * E2/E3 + their allocations/items/expenses MUST survive untouched.
   */
  function fixture(): ClientLedger {
    const g1 = grp({ id: "G1" });
    const g2 = grp({ id: "G2" });
    const a1 = acc({ id: "A1", initialBalance: 100_00 });
    const e1 = env("G1", { id: "E1" }); // deletion target
    const e2 = env("G1", { id: "E2" });
    const e3 = env("G2", { id: "E3" });
    return {
      accounts: [a1],
      groups: [g1, g2],
      envelopes: [e1, e2, e3],
      allocations: [
        alloc("E1", "2026-06", 40_00), // → CASCADE (disappears)
        alloc("E2", "2026-06", 25_00), // survives
      ],
      transactions: [
        tx({ id: "T1", accountId: "A1", type: "expense", envelopeId: "E1", amount: 10_00 }),
        tx({
          id: "T2",
          accountId: "A1",
          type: "expense",
          amount: 50_00,
          items: [
            { id: "i-e1", envelopeId: "E1", categoryId: null, amount: 30_00 }, // → CASCADE (disappears)
            { id: "i-e2", envelopeId: "E2", categoryId: null, amount: 20_00 }, // survives
          ],
        }),
        tx({ id: "T3", accountId: "A1", type: "income", envelopeId: "E1", amount: 100_00 }),
        tx({ id: "T4", accountId: "A1", type: "expense", envelopeId: "E2", amount: 5_00 }),
        tx({
          id: "T5",
          accountId: "A1",
          type: "expense",
          amount: 30_00,
          items: [{ id: "i-only", envelopeId: "E1", categoryId: null, amount: 30_00 }],
        }),
      ],
      categories: [],
      places: [],
    };
  }

  it("removes the envelope + its allocation + the split item; SET NULL on expense and income; parent amounts unchanged", () => {
    const l = deepFreeze(fixture());
    const next = applyOp(l, mkOp("envelope.delete", { id: "E1" }));

    // envelope removed, E2/E3 stay
    expect(next.envelopes.map((e) => e.id)).toEqual(["E2", "E3"]);
    // E1 allocation deleted (CASCADE); E2 allocation untouched
    expect(next.allocations).toEqual([{ id: next.allocations[0]!.id, envelopeId: "E2", month: "2026-06", amount: 25_00 }]);

    const byId = Object.fromEntries(next.transactions.map((t) => [t.id, t]));
    // T1 expense — SET NULL
    expect(byId.T1!.envelopeId).toBeNull();
    // T2 split — the E1 item disappears (CASCADE), the E2 item stays, parent amount unchanged
    expect(byId.T2!.items).toEqual([{ id: "i-e2", envelopeId: "E2", categoryId: null, amount: 20_00 }]);
    expect(byId.T2!.amount).toBe(50_00);
    // T3 income — SET NULL (parity: the FK is shared by all types)
    expect(byId.T3!.envelopeId).toBeNull();
    // T4 expense on E2 — untouched (shared reference)
    expect(byId.T4).toBe(l.transactions[3]!);
    // T5 split with the ONLY item on E1 — items empty, parent amount unchanged
    expect(byId.T5!.items).toEqual([]);
    expect(byId.T5!.amount).toBe(30_00);
  });
});

/* ── 1b. account.delete: CASCADE by account_id OR to_account_id ──────── */

describe("FK cascade parity: account.delete", () => {
  it("removes the account AND entire transactions (with their items) referencing it via account_id or to_account_id", () => {
    const l = deepFreeze<ClientLedger>({
      accounts: [acc({ id: "A1" }), acc({ id: "A2" })],
      groups: [grp({ id: "G1" })],
      envelopes: [env("G1", { id: "E1" }), env("G1", { id: "E2" })],
      allocations: [],
      transactions: [
        // account_id == A1 → CASCADE (removes the row + its items)
        tx({
          id: "T1",
          accountId: "A1",
          type: "expense",
          amount: 40_00,
          items: [
            { id: "i1", envelopeId: "E1", categoryId: null, amount: 20_00 },
            { id: "i2", envelopeId: "E2", categoryId: null, amount: 20_00 },
          ],
        }),
        // to_account_id == A1 → CASCADE
        tx({ id: "T2", accountId: "A2", type: "transfer", toAccountId: "A1", amount: 5_00 }),
        // account_id == A1 (transfer the OTHER way) → CASCADE
        tx({ id: "T3", accountId: "A1", type: "transfer", toAccountId: "A2", amount: 7_00 }),
        // does not touch A1 → survives
        tx({ id: "T4", accountId: "A2", type: "expense", envelopeId: "E1", amount: 9_00 }),
      ],
      categories: [],
      places: [],
    });
    const next = applyOp(l, mkOp("account.delete", { id: "A1" }));
    expect(next.accounts.map((a) => a.id)).toEqual(["A2"]);
    expect(next.transactions.map((t) => t.id)).toEqual(["T4"]);
    // the orphaned row's items disappear with the parent (txn_items.transaction_id CASCADE)
    expect(next.transactions[0]!.items).toEqual([]);
  });
});

/* ── 1c. group.delete: CASCADE group → envelopes → (allocations, items, SET NULL) ─ */

describe("FK cascade parity: group.delete", () => {
  it("removes the group + all its envelopes, cascading envelope.delete effects onto each; the other group untouched", () => {
    const l = deepFreeze<ClientLedger>({
      accounts: [acc({ id: "A1" })],
      groups: [grp({ id: "G1" }), grp({ id: "G2" })],
      // G1: E1, E2 (to be removed); G2: E3 (survives)
      envelopes: [env("G1", { id: "E1" }), env("G1", { id: "E2" }), env("G2", { id: "E3" })],
      allocations: [
        alloc("E1", "2026-06", 30_00), // CASCADE
        alloc("E2", "2026-06", 15_00), // CASCADE
        alloc("E3", "2026-06", 60_00), // survives
      ],
      transactions: [
        tx({ id: "T1", accountId: "A1", type: "expense", envelopeId: "E1", amount: 10_00 }), // SET NULL
        tx({
          id: "T2",
          accountId: "A1",
          type: "expense",
          amount: 40_00,
          items: [
            { id: "i-e2", envelopeId: "E2", categoryId: null, amount: 20_00 }, // CASCADE (disappears)
            { id: "i-e3", envelopeId: "E3", categoryId: null, amount: 20_00 }, // survives
          ],
        }),
        tx({ id: "T3", accountId: "A1", type: "expense", envelopeId: "E3", amount: 8_00 }), // untouched
      ],
      categories: [],
      places: [],
    });
    const next = applyOp(l, mkOp("group.delete", { id: "G1" }));
    expect(next.groups.map((g) => g.id)).toEqual(["G2"]);
    expect(next.envelopes.map((e) => e.id)).toEqual(["E3"]);
    expect(next.allocations.map((a) => a.envelopeId)).toEqual(["E3"]);

    const byId = Object.fromEntries(next.transactions.map((t) => [t.id, t]));
    expect(byId.T1!.envelopeId).toBeNull(); // SET NULL
    expect(byId.T2!.items).toEqual([{ id: "i-e3", envelopeId: "E3", categoryId: null, amount: 20_00 }]);
    expect(byId.T2!.amount).toBe(40_00); // parent amount unchanged
    expect(byId.T3).toBe(l.transactions[2]!); // untouched
  });
});

/* ── 2. fullResync replay idempotency (property) ─────────────────────── */

describe("fullResync: outbox replay idempotency", () => {
  /** Replay ops in order — exactly what sync.replayOutbox / store.applyLocal does. */
  const replay = (l: ClientLedger, ops: readonly SyncOp[]): ClientLedger => ops.reduce((accL, op) => applyOp(accL, op), l);

  /**
   * Create-guard: no collection has duplicate ids, and items within a
   * transaction are unique too. Evidence that replay injected no duplicate.
   */
  const assertUniqueIds = (l: ClientLedger): void => {
    const uniq = (ids: string[], label: string) => expect(new Set(ids).size, `duplicate ids in ${label}`).toBe(ids.length);
    uniq(
      l.accounts.map((a) => a.id),
      "accounts",
    );
    uniq(
      l.groups.map((g) => g.id),
      "groups",
    );
    uniq(
      l.envelopes.map((e) => e.id),
      "envelopes",
    );
    uniq(
      l.categories.map((c) => c.id),
      "categories",
    );
    uniq(
      l.places.map((p) => p.id),
      "places",
    );
    uniq(
      l.transactions.map((t) => t.id),
      "transactions",
    );
    uniq(
      l.allocations.map((a) => a.id),
      "allocations",
    );
    for (const t of l.transactions)
      uniq(
        t.items.map((i) => i.id),
        `items(${t.id})`,
      );
  };

  it("replaying the same ops over a state that already reflects them changes nothing and duplicates no rows", () => {
    fc.assert(
      fc.property(ledgerArb(), fc.array(specArb, { maxLength: 30 }), (baseLedger, specs) => {
        // 1. Materialize concrete ops against the EVOLVING ledger (like the outbox
        //    queues them over the optimistic mirror) and remember them as a durable
        //    SyncOp sequence — exactly the outbox contents carried into fullResync.
        let l = asClientLedger(baseLedger);
        const ops: SyncOp[] = [];
        let n = 0;
        const nextId = () => `N${n++}`;
        for (const s of specs) {
          const op = interpret(l, s, nextId);
          if (!op) continue;
          ops.push(op);
          l = applyOp(l, op);
        }
        // L1 = "the server absorbed all of O" = the state a fullResync snapshot returns.
        const L1 = deepFreeze(l);

        // Trivial part of the invariant: replaying an EMPTY list = identity.
        expect(replay(L1, [])).toBe(L1);

        // fullResync applies the SAME ops once more onto a fresh snapshot.
        const L2 = replay(L1, ops);
        expect(L2).toEqual(L1); // idempotent: no changes, no duplicates
        assertUniqueIds(L1);
      }),
      { numRuns: 300 },
    );
  });
});
