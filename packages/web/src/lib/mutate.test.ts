/**
 * `txnToPayload` is the pure txn→payload mapping `duplicateTxn` builds on (one field
 * list, not copy-pasted) — tested directly, since it's the part that would silently
 * drift if a new Transaction field were added later.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences, type Transaction, type TxnPayload } from "@enveo/shared";
import { accountFormPayload } from "./automaticEnvelopeAccountUi";
import { local, prepareDisplayedAllocation, prepareTxnCreate, prepareTxnUpdate, txnToDuplicatePayload, txnToPayload } from "./mutate";
import * as outbox from "./outbox";
import { store } from "./store";
import "./sync";

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

async function resetMutationSeam(ledger = flowLedger()): Promise<void> {
  outbox.clearAll();
  await outbox.flushed();
  store.replace(ledger, 0, ledger.budgets[0]!.id);
}

function emittedTxn(index: number) {
  const entry = outbox.snapshot()[index];
  if (!entry || entry.op.kind === "alloc.set" || !entry.op.kind.startsWith("txn.")) throw new Error(`expected transaction op ${index}`);
  return entry.op;
}

function emittedAllocation(index: number) {
  const entry = outbox.snapshot()[index];
  if (entry?.op.kind !== "alloc.set") throw new Error(`expected allocation op ${index}`);
  return entry.op;
}

beforeEach(() => resetMutationSeam());
afterEach(() => resetMutationSeam());

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

  it("skips the envelope leg of a transfer when the user opted out for this transaction", () => {
    expect(
      prepareTxnCreate(flowLedger(), txnPayload({ type: "transfer", toAccountId: PLACE, envelopeId: null }), { skipAutomaticAllocation: true }),
    ).toMatchObject({ allocationFromEnvelopeId: null, allocationToEnvelopeId: null });
  });

  it("keeps an opted-out transfer opted out when an edit does not reroute it", () => {
    const ledger = flowLedger();
    // stored WITHOUT a flow: the accounts are linked, but this transfer skipped the envelope leg
    ledger.transactions.push({
      ...splitTxn(),
      type: "transfer",
      accountId: ACC,
      toAccountId: PLACE,
      envelopeId: null,
      items: [],
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });

    expect(prepareTxnUpdate(ledger, TXN, txnPayload({ type: "transfer", toAccountId: PLACE, envelopeId: null, amount: 4200 }))).toMatchObject({
      amount: 4200,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });
  });

  it("re-enables the envelope leg on an edit that clears the opt-out", () => {
    const ledger = flowLedger();
    ledger.transactions.push({
      ...splitTxn(),
      type: "transfer",
      accountId: ACC,
      toAccountId: PLACE,
      envelopeId: null,
      items: [],
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });

    // explicit false = "the human re-ticked the box": preserving the stored NULLs would be a no-op
    expect(
      prepareTxnUpdate(ledger, TXN, txnPayload({ type: "transfer", toAccountId: PLACE, envelopeId: null }), { skipAutomaticAllocation: false }),
    ).toMatchObject({ allocationFromEnvelopeId: ENV1, allocationToEnvelopeId: ENV2 });
  });

  it("clears flow fields for expenses and refunds", () => {
    expect(
      prepareTxnCreate(flowLedger(), txnPayload({ type: "expense", isRefund: true, allocationFromEnvelopeId: ENV1, allocationToEnvelopeId: ENV2 })),
    ).toMatchObject({ allocationFromEnvelopeId: null, allocationToEnvelopeId: null });
  });
});

describe("displayed allocation mutation preparation", () => {
  it("removes positive automatic flow from the stored manual allocation", () => {
    const ledger = flowLedger();
    ledger.transactions.push({
      ...splitTxn(),
      id: crypto.randomUUID(),
      type: "income",
      accountId: ACC,
      amount: 500_00,
      date: "2026-08-14",
      envelopeId: null,
      allocationToEnvelopeId: ENV1,
    });

    expect(prepareDisplayedAllocation(ledger, { envelopeId: ENV1, month: "2026-08", amount: 900_00 })).toEqual({
      envelopeId: ENV1,
      month: "2026-08",
      amount: 400_00,
    });
  });

  it("adds negative automatic flow back to the stored manual allocation", () => {
    const ledger = flowLedger();
    ledger.transactions.push({
      ...splitTxn(),
      id: crypto.randomUUID(),
      type: "transfer",
      accountId: ACC,
      amount: 500_00,
      date: "2026-08-14",
      envelopeId: null,
      allocationFromEnvelopeId: ENV1,
    });

    expect(prepareDisplayedAllocation(ledger, { envelopeId: ENV1, month: "2026-08", amount: 900_00 })).toEqual({
      envelopeId: ENV1,
      month: "2026-08",
      amount: 1400_00,
    });
  });

  it("keeps the displayed amount when the envelope has no automatic flow", () => {
    expect(prepareDisplayedAllocation(flowLedger(), { envelopeId: ENV1, month: "2026-08", amount: 900_00 })).toEqual({
      envelopeId: ENV1,
      month: "2026-08",
      amount: 900_00,
    });
  });

  it("emits the manual amount when setting a displayed allocation", async () => {
    const ledger = flowLedger();
    ledger.transactions.push({
      ...splitTxn(),
      id: crypto.randomUUID(),
      type: "income",
      accountId: ACC,
      amount: 500_00,
      date: "2026-08-14",
      envelopeId: null,
      allocationToEnvelopeId: ENV1,
    });
    await resetMutationSeam(ledger);

    local.setDisplayedAllocation({ envelopeId: ENV1, month: "2026-08", amount: 900_00 });

    expect(emittedAllocation(0).payload).toEqual({ envelopeId: ENV1, month: "2026-08", amount: 400_00 });
  });
});

describe("local account mutations", () => {
  it("persists a non-zero starting balance and automatic envelope as one account operation", () => {
    // given: a new linked account with a non-zero starting balance
    const before = store.getLedger()!;

    // when: the account form creates it
    local.createAccount(
      accountFormPayload({
        name: "Everyday account",
        color: "#123456",
        icon: "bank",
        onBudget: true,
        automaticEnvelopeId: ENV1,
        initialBalance: 12_345,
        sort: 2,
      }),
    );

    // then: only the account operation is queued and ledger money history is untouched
    const queued = outbox.snapshot();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.op).toMatchObject({
      kind: "account.create",
      payload: { automaticEnvelopeId: ENV1, initialBalance: 12_345 },
    });
    expect(store.getLedger()!.transactions).toEqual(before.transactions);
    expect(store.getLedger()!.allocations).toEqual(before.allocations);
  });
});

describe("local transaction mutations", () => {
  it("emits captured account flows for new income and transfers", () => {
    local.createTxn(txnPayload());
    local.createTxn(txnPayload({ type: "transfer", toAccountId: PLACE, envelopeId: null }));

    expect(outbox.snapshot()).toHaveLength(2);
    expect(emittedTxn(0).payload).toMatchObject({
      type: "income",
      accountId: ACC,
      envelopeId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: ENV1,
    });
    expect(emittedTxn(1).payload).toMatchObject({
      type: "transfer",
      accountId: ACC,
      toAccountId: PLACE,
      allocationFromEnvelopeId: ENV1,
      allocationToEnvelopeId: ENV2,
    });
  });

  it("emits the recorded flow when an update keeps the route", async () => {
    const ledger = flowLedger();
    ledger.transactions.push({ ...splitTxn(), type: "income", accountId: ACC, envelopeId: null, allocationToEnvelopeId: ENV2 });
    await resetMutationSeam(ledger);

    local.updateTxn(TXN, txnPayload({ amount: 9999, date: "2026-08-15", envelopeId: ENV1 }));

    expect(outbox.snapshot()).toHaveLength(1);
    expect(emittedTxn(0).payload).toMatchObject({
      id: TXN,
      amount: 9999,
      date: "2026-08-15",
      envelopeId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: ENV2,
    });
  });

  it("recaptures current links when an update reroutes the transaction", async () => {
    const ledger = flowLedger();
    ledger.transactions.push({ ...splitTxn(), type: "income", accountId: ACC, envelopeId: null, allocationToEnvelopeId: ENV2 });
    await resetMutationSeam(ledger);

    local.updateTxn(TXN, txnPayload({ type: "transfer", accountId: PLACE, toAccountId: ACC, envelopeId: ENV1 }));

    expect(outbox.snapshot()).toHaveLength(1);
    expect(emittedTxn(0).payload).toMatchObject({
      id: TXN,
      type: "transfer",
      accountId: PLACE,
      toAccountId: ACC,
      envelopeId: ENV1,
      allocationFromEnvelopeId: ENV2,
      allocationToEnvelopeId: ENV1,
    });
  });

  it("duplicates with current captured links instead of the stored flow", () => {
    const stale = { ...splitTxn(), type: "income" as const, accountId: ACC, envelopeId: null, allocationToEnvelopeId: ENV2 };
    local.duplicateTxn(stale);

    expect(outbox.snapshot()).toHaveLength(1);
    expect(emittedTxn(0).payload).toMatchObject({
      type: "income",
      accountId: ACC,
      envelopeId: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: ENV1,
    });
  });

  it("throws before enqueueing when an update id is absent from the local ledger", () => {
    const missingId = crypto.randomUUID();
    expect(() => local.updateTxn(missingId, txnPayload())).toThrow(`local.updateTxn: transaction ${missingId} not found`);
    expect(outbox.snapshot()).toEqual([]);
  });
});
