/**
 * `local.confirmTxn` — the "confirm transaction" flow (Task p2): flips an unconfirmed
 * screenshot-import row's `confirmed` to true via the EXISTING txn.update op, full-field
 * replacement, everything else verbatim.
 *
 * `txnToPayload` is the pure txn→payload mapping `confirmTxn` and `duplicateTxn` both build
 * on (one field list, not copy-pasted) — tested directly first, since it's the part that
 * would silently drift if a new Transaction field were added later.
 *
 * The enqueue path (store.applyLocal + outbox.add + poke()) is exercised the same way
 * sync.test.ts drives it: under bun there's no window/indexedDB, so store/outbox run in
 * their in-memory mode and can be driven directly. `poke()` schedules a debounced real
 * network cycle (POKE_DEBOUNCE_MS) — fetch is stubbed and `__resetBackoff` is called in
 * afterEach so a scheduled retry can't fire into a later test (same guard sync.test.ts uses).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account, ClientLedger, Transaction, TxnPayload } from "@enveo/shared";
import { local, txnToPayload } from "./mutate";
import * as outbox from "./outbox";
import { store } from "./store";
import { __resetBackoff } from "./sync";

const ACC = crypto.randomUUID();
const ENV1 = crypto.randomUUID();
const ENV2 = crypto.randomUUID();
const CAT1 = crypto.randomUUID();
const PLACE = crypto.randomUUID();
const TXN = crypto.randomUUID();

const emptyLedger = (): ClientLedger => ({
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  budgets: [],
});

const account = (): Account => ({
  id: ACC,
  name: "Konto",
  color: "#fff",
  icon: "wallet",
  type: "checking",
  onBudget: true,
  initialBalance: 0,
  archived: false,
  sort: 0,
});

/**
 * An unconfirmed SPLIT expense (screenshot-import "to confirm" shape) exercising every field
 * txnToPayload/confirmTxn must carry through: a refund, a place, a tag (import idempotency
 * key), a note distinct from the name, and a balanced split with a per-item category.
 */
const splitTxn = (): Transaction => ({
  id: TXN,
  type: "expense",
  accountId: ACC,
  toAccountId: null,
  amount: 5000,
  date: "2026-07-01",
  confirmed: false,
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
      confirmed: false,
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

describe("local.confirmTxn", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // confirmTxn's enqueue schedules a debounced network push (poke) — stub fetch so that
    // debounced cycle (if it fires before the process moves on) hits a harmless 200, not a
    // real network call or a parse-error throw from a relative URL.
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    outbox.clearAll();
    store.replace({ ...emptyLedger(), accounts: [account()], transactions: [splitTxn()] }, 0, "budget-test");
  });

  afterEach(() => {
    __resetBackoff(); // a scheduled retry must not fire into a LATER test's fetch stub
    globalThis.fetch = realFetch;
  });

  it("flips confirmed to true and preserves every other field, including the split", () => {
    local.confirmTxn(TXN);
    const updated = store.getLedger()!.transactions.find((t) => t.id === TXN)!;
    expect(updated.confirmed).toBe(true);
    expect(updated.isRefund).toBe(true);
    expect(updated.tag).toBe("merchant:biedronka");
    expect(updated.name).toBe("Zakupy");
    expect(updated.note).toBe("z paragonu");
    expect(updated.placeId).toBe(PLACE);
    expect(updated.amount).toBe(5000);
    // txnFromUpdate rebuilds item ids as local synthetic ids (same as ANY manual edit —
    // txn.update is full-field replacement) — envelopeId/categoryId/amount survive verbatim.
    expect(updated.items.map((i) => ({ envelopeId: i.envelopeId, categoryId: i.categoryId, amount: i.amount }))).toEqual([
      { envelopeId: ENV1, categoryId: null, amount: 2000 },
      { envelopeId: ENV2, categoryId: CAT1, amount: 3000 },
    ]);
  });

  it("enqueues exactly one txn.update op carrying the full payload with confirmed:true", () => {
    local.confirmTxn(TXN);
    const entries = outbox.snapshot();
    expect(entries.length).toBe(1);
    expect(entries[0]!.op.kind).toBe("txn.update");
    const payload = entries[0]!.op.payload as TxnPayload & { id: string };
    expect(payload.id).toBe(TXN);
    expect(payload.confirmed).toBe(true);
    expect(payload.isRefund).toBe(true);
    expect(payload.tag).toBe("merchant:biedronka");
    expect(payload.amount).toBe(5000);
  });

  it("is a silent no-op for a transaction that no longer exists (delete raced the tap)", () => {
    local.confirmTxn("00000000-0000-4000-8000-000000000000");
    expect(outbox.snapshot().length).toBe(0);
    expect(store.getLedger()!.transactions).toHaveLength(1); // unchanged
  });
});
