import { describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences } from "@enveo/shared";
import type { EditedImportItem, ImportApplyItem } from "./api";
import { applyLocalImport, type LocalImportMutationPort, planLocalImport, reviewedImportItemsForApply } from "./localImport";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ledger = (): ClientLedger => ({
  budgets: [{ id: U(1), name: "Budget", currency: "EUR", preferences: createDefaultBudgetPreferences() }],
  accounts: [
    {
      id: U(2),
      name: "Main",
      color: "#fff",
      icon: "bank",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: U(5),
    },
    {
      id: U(3),
      name: "Savings",
      color: "#fff",
      icon: "bank",
      type: "savings",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 1,
      automaticEnvelopeId: U(9),
    },
  ],
  groups: [{ id: U(4), name: "Living", sort: 0 }],
  envelopes: [
    { id: U(5), groupId: U(4), name: "Food", color: "#fff", icon: "food", note: null, monthlyTarget: null, isSavings: false, sort: 0, archived: false },
    { id: U(9), groupId: U(4), name: "Travel", color: "#fff", icon: "plane", note: null, monthlyTarget: null, isSavings: false, sort: 1, archived: false },
  ],
  categories: [{ id: U(6), name: "Groceries" }],
  places: [{ id: U(7), name: "Lidl" }],
  allocations: [],
  transactions: [
    {
      id: U(8),
      type: "expense",
      accountId: U(2),
      toAccountId: null,
      amount: 1000,
      date: "2026-08-01",
      isRefund: false,
      envelopeId: U(5),
      placeId: U(7),
      categoryId: U(6),
      name: "Old",
      note: null,
      tag: "OLD",
      sourceRef: "LIDL RAW",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ],
});

const item = (over: Partial<ImportApplyItem> = {}): ImportApplyItem => ({
  date: "2026-08-02",
  amount: 2500,
  type: "expense",
  name: "Shopping",
  tag: "SHOP",
  rawPlace: "SHOP RAW",
  envelopeId: U(5),
  categoryId: U(6),
  placeName: "LIDL",
  ...over,
});

const editedItem = (over: Partial<EditedImportItem> = {}): EditedImportItem => ({
  type: "expense",
  accountId: U(2),
  toAccountId: null,
  isRefund: false,
  amount: 2500,
  date: "2026-08-02",
  name: "Shopping",
  envelopeId: U(5),
  categoryId: U(6),
  placeName: "LIDL",
  note: "",
  ...over,
});

function mutationSpy() {
  const created = { categories: [] as string[], places: [] as string[], transactions: [] as unknown[] };
  const mutations: LocalImportMutationPort = {
    createCategory: (name) => {
      created.categories.push(name);
      return { id: U(20) };
    },
    createPlace: (name) => {
      created.places.push(name);
      return { id: U(21) };
    },
    createTxn: (payload) => {
      created.transactions.push(payload);
      return U(22);
    },
  };
  return { created, mutations };
}

describe("local E2EE import planning", () => {
  it("matches sure/probable/new and strong-deduplicates within a batch", () => {
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      dryRun: true,
      items: [item({ date: "2026-08-01", amount: 1000, rawPlace: "lidl raw" }), item({ date: "2026-08-01", amount: 1000, rawPlace: "OTHER" }), item(), item()],
    });
    expect(plan.results.map((row) => row.status)).toEqual(["exists", "probable", "added", "exists"]);
    expect(plan).toMatchObject({ added: 1, skipped: 2, transactions: [] });
  });

  it("a forced edited duplicate is planned as a new transaction", () => {
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      dryRun: false,
      items: [item({ date: "2026-08-01", amount: 1000, rawPlace: "LIDL RAW", force: true })],
    });
    expect(plan.results[0]!.status).toBe("added");
    expect(plan.transactions).toHaveLength(1);
  });

  it("validates the whole batch before the first mutation", () => {
    const spy = mutationSpy();
    expect(() =>
      planLocalImport({ ledger: ledger(), globalAccountId: U(2), dryRun: false, items: [item(), item({ type: "transfer", toAccountId: U(2) })] }),
    ).toThrow("transfer_invalid:1");
    expect(spy.created).toEqual({ categories: [], places: [], transactions: [] });
  });

  it("preserves per-item account, refund, ids, sourceRef and reuses place names case-insensitively", () => {
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      dryRun: false,
      items: [item({ accountId: U(3), isRefund: true, rawPlace: "  BANK RAW  ", placeName: "lIdL" })],
    });
    const spy = mutationSpy();
    applyLocalImport(plan, spy.mutations);
    expect(spy.created.places).toEqual([]);
    expect(spy.created.transactions).toHaveLength(1);
    expect(spy.created.transactions[0]).toMatchObject({
      accountId: U(3),
      isRefund: true,
      envelopeId: U(5),
      categoryId: U(6),
      placeId: U(7),
      sourceRef: "BANK RAW",
    });
  });

  it("creates missing category/place once through local mutations and validates transfers/FKs", () => {
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      dryRun: false,
      items: [
        item({ categoryId: null, categoryName: "Subscriptions", placeName: "Netflix" }),
        item({ type: "transfer", toAccountId: U(3), envelopeId: U(5), categoryId: U(6), amount: 5000, rawPlace: "TRANSFER RAW" }),
      ],
    });
    const spy = mutationSpy();
    applyLocalImport(plan, spy.mutations);
    expect(spy.created.categories).toEqual(["Subscriptions"]);
    expect(spy.created.places).toEqual(["Netflix"]);
    expect(spy.created.transactions).toHaveLength(2);
    expect(spy.created.transactions[0]).toMatchObject({
      type: "expense",
      accountId: U(2),
      envelopeId: U(5),
      categoryId: U(20),
      placeId: U(21),
    });
    expect(spy.created.transactions[1]).toMatchObject({ type: "transfer", toAccountId: U(3), envelopeId: null, categoryId: null, isRefund: false });
    expect(() => planLocalImport({ ledger: ledger(), globalAccountId: U(2), dryRun: false, items: [item({ envelopeId: U(99) })] })).toThrow("foreign_ref");
  });

  it("defaults only missing imported expenses from each item's account link", () => {
    // given: two expenses without an imported envelope use different source accounts
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      dryRun: false,
      items: [
        item({ envelopeId: null }),
        item({ accountId: U(3), envelopeId: null, rawPlace: "SECOND RAW" }),
        item({ envelopeId: U(9), rawPlace: "EXPLICIT RAW" }),
      ],
    });

    // when: the review/result and write payloads are prepared
    const plannedEnvelopeIds = plan.transactions.map((transaction) => transaction.payload.envelopeId);

    // then: missing values follow their accounts while an explicit imported envelope wins
    expect(plan.results.map((result) => result.envelopeId)).toEqual([U(5), U(9), U(9)]);
    expect(plannedEnvelopeIds).toEqual([U(5), U(9), U(9)]);
  });

  it("sends each accepted import exactly once through the transaction mutation port without pre-stamping flow", () => {
    // given: one accepted linked-account income will be stamped by the real local.createTxn boundary
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      dryRun: false,
      items: [item({ type: "income", envelopeId: null })],
    });
    const spy = mutationSpy();

    // when: the local import is applied
    applyLocalImport(plan, spy.mutations);

    // then: the port receives one route payload and no competing allocation-flow stamp
    expect(spy.created.transactions).toHaveLength(1);
    expect(spy.created.transactions[0]).toMatchObject({ type: "income", accountId: U(2) });
    expect(spy.created.transactions[0]).not.toHaveProperty("allocationFromEnvelopeId");
    expect(spy.created.transactions[0]).not.toHaveProperty("allocationToEnvelopeId");
  });

  it("preserves automatic, explicit-empty, and explicit-ID provenance from editor review through local apply", () => {
    // given: review has a stale automatic value, an editor-cleared value, and an explicit ID
    const reviewed = [
      { ...item({ envelopeId: U(9), envelopeName: "Travel", rawPlace: "AUTO RAW" }), status: "added" as const, include: true, automaticEnvelopeDefault: true },
      {
        ...item({ amount: 2600, envelopeId: U(5), envelopeName: "Food", rawPlace: "EMPTY RAW" }),
        status: "added" as const,
        include: true,
        automaticEnvelopeDefault: true,
      },
      {
        ...item({ amount: 2700, envelopeId: U(5), envelopeName: "Food", rawPlace: "EXPLICIT RAW" }),
        status: "added" as const,
        include: true,
        automaticEnvelopeDefault: true,
      },
    ];
    const edited = {
      1: editedItem({ amount: 2600, envelopeId: null }),
      2: editedItem({ amount: 2700, envelopeId: U(9) }),
    };
    // when: editor results are merged, planned against the current E5 account link, and applied
    const chosen = reviewedImportItemsForApply({
      items: reviewed,
      edited,
      editedAutomaticDefaults: { 1: false, 2: false },
    });
    const plan = planLocalImport({ ledger: ledger(), globalAccountId: U(2), items: chosen, dryRun: false });
    const spy = mutationSpy();
    applyLocalImport(plan, spy.mutations);

    // then: automatic follows current E5, explicit empty stays empty, explicit E9 wins, and each writes once
    expect(plan.transactions.map((transaction) => transaction.payload.envelopeId)).toEqual([U(5), null, U(9)]);
    expect(spy.created.transactions).toHaveLength(3);
  });
});
