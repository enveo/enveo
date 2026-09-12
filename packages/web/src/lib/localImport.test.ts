import { describe, expect, it } from "bun:test";
import {
  applyOp,
  type ClientLedger,
  computeBudgetState,
  createDefaultBudgetPreferences,
  type ImportExtractRow,
  type ImportProposal,
  type ImportRecognitionResult,
  type ReconciledImportRecognitionResult,
  runImportRecognitionPipeline,
} from "@enveo/shared";
import type { EditedImportItem, ImportApplyItem } from "./api";
import {
  applyLocalImport,
  applyLocalImportRecoverably,
  importReviewItem,
  type LocalImportMutationPort,
  PartialImportApplyError,
  planLocalImport,
  recognitionCandidatesForDryRun,
  reconcileImportJobResult,
  reviewedImportItemsForApply,
} from "./localImport";
import { prepareTxnCreate } from "./mutate";

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
  categories: [{ id: U(6), name: "Groceries", archived: false }],
  places: [{ id: U(7), name: "Lidl", archived: false }],
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

const recognitionRow = (rowId: string, over: Partial<ImportExtractRow> = {}): ImportExtractRow => ({
  rowId,
  imageIndex: 0,
  visualOrder: 0,
  rawTextLines: [`RAW ${rowId}`],
  date: "2026-08-02",
  amount: 2500,
  currency: "EUR",
  direction: "debit",
  postingStatus: "posted",
  rowRole: "financial_event",
  semanticKind: "card_purchase",
  relation: null,
  confidence: "high",
  reviewReasons: [],
  ...over,
});

const recognitionProposal = (rowId: string, over: Partial<ImportProposal> = {}): ImportProposal => ({
  rowId,
  sourceRows: [rowId],
  disposition: "candidate",
  date: "2026-08-02",
  amount: 2500,
  currency: "EUR",
  type: "expense",
  isRefund: false,
  toAccountId: null,
  semanticKind: "card_purchase",
  relation: null,
  name: rowId,
  tag: "",
  rawPlace: `RAW ${rowId}`,
  envelopeId: U(5),
  categoryId: U(6),
  placeName: null,
  reviewReasons: [],
  selected: true,
  ...over,
});

const recognitionResult = (...proposals: ImportProposal[]): ImportRecognitionResult => ({
  rows: proposals.map((proposal) => recognitionRow(proposal.rowId, { date: proposal.date, amount: proposal.amount, rawTextLines: [proposal.rawPlace] })),
  proposals,
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
  it("reconciles a ready job against current duplicates, accounts, and active assignments idempotently", () => {
    // given: recognition was ready before the ledger gained duplicate evidence and lost assignments
    const current = ledger();
    current.transactions.push(
      { ...current.transactions[0]!, id: U(30), date: "2026-08-02", amount: 2500, sourceRef: "RAW exact" },
      { ...current.transactions[0]!, id: U(31), date: "2026-08-03", amount: 2600, sourceRef: null },
    );
    current.envelopes[0]!.archived = true;
    current.categories[0]!.archived = true;
    const ready = recognitionResult(
      recognitionProposal("exact"),
      recognitionProposal("probable", { date: "2026-08-03", amount: 2600, rawPlace: "RAW probable" }),
      recognitionProposal("assignment", { date: "2026-08-04", amount: 2700, rawPlace: "RAW assignment" }),
    );

    // when: the ready result is opened against the current ledger, then reconciled again
    const once = reconcileImportJobResult({ result: ready, ledger: current, accountId: U(2) });
    const twice = reconcileImportJobResult({ result: once, ledger: current, accountId: U(2) });

    // then: current evidence wins, unsafe assignments are explicit, and replay is stable
    expect(once.proposals[0]).toMatchObject({ duplicateStatus: "exists", disposition: "declined", selected: false });
    expect(once.proposals[1]).toMatchObject({
      duplicateStatus: "probable",
      selected: false,
      reviewReasons: [],
    });
    expect(once.proposals[2]).toMatchObject({
      envelopeId: null,
      categoryId: null,
      assignmentUnavailable: true,
      selected: true,
    });
    expect(twice).toEqual(once);

    // and: deleting or archiving the selected source account blocks every proposal
    const deletedAccount = reconcileImportJobResult({ result: ready, ledger: { ...current, accounts: [] }, accountId: U(2) });
    expect(deletedAccount.proposals.every((proposal) => proposal.sourceAccountInvalid && !proposal.selected)).toBe(true);
  });

  it("records each successful row before attempting the next mutation", async () => {
    // given: two selected rows are planned, while the mutation port fails on the second write
    const firstItem = item({ importRowId: "row-one", rawPlace: "ROW ONE" });
    const secondItem = item({ importRowId: "row-two", date: "2026-08-03", amount: 2600, rawPlace: "ROW TWO" });
    const firstPlan = planLocalImport({ ledger: ledger(), globalAccountId: U(2), items: [firstItem, secondItem], dryRun: false });
    let writes = 0;
    const created: Array<{ id: string; payload: Parameters<LocalImportMutationPort["createTxn"]>[0] }> = [];
    const mutations: LocalImportMutationPort = {
      createCategory: () => ({ id: U(20) }),
      createPlace: () => ({ id: U(21) }),
      createTxn: (payload) => {
        writes++;
        if (writes === 2) throw new Error("disk_full");
        created.push({ id: U(30), payload });
        return U(30);
      },
    };

    const durableRows: string[] = [];

    // when: applying stops after the first durable local mutation
    let partial: PartialImportApplyError | null = null;
    try {
      await applyLocalImportRecoverably(firstPlan, mutations, {
        apply: async (rowId, mutation) => {
          mutation(undefined);
          durableRows.push(rowId);
        },
      });
    } catch (error) {
      if (error instanceof PartialImportApplyError) partial = error;
      else throw error;
    }

    // then: the ready job can report exactly what crossed the mutation boundary
    expect(partial?.progress).toEqual({ appliedRowIds: ["row-one"], appliedCount: 1, skippedCount: 0 });
    expect(durableRows).toEqual(["row-one"]);
    expect(created).toHaveLength(1);

    // and: current-ledger retry sees that write as exact and writes only the remaining row
    const live = ledger();
    live.transactions.push({
      ...live.transactions[0]!,
      id: created[0]!.id,
      date: created[0]!.payload.date,
      amount: created[0]!.payload.amount,
      sourceRef: created[0]!.payload.sourceRef ?? null,
    });
    const retry = planLocalImport({ ledger: live, globalAccountId: U(2), items: [firstItem, secondItem], dryRun: false });
    const retrySpy = mutationSpy();
    const completed = await applyLocalImportRecoverably(retry, retrySpy.mutations);

    expect(retry.results.map((result) => result.status)).toEqual(["exists", "added"]);
    expect(retrySpy.created.transactions).toHaveLength(1);
    expect(completed).toEqual({ appliedRowIds: ["row-two"], appliedCount: 1, skippedCount: 1 });
  });

  it("stops before the next transaction when durable row progress is interrupted", async () => {
    // given: two blank-source rows cannot be recovered through source_ref duplicate matching
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      items: [item({ importRowId: "blank-one", rawPlace: null }), item({ importRowId: "blank-two", rawPlace: null, date: "2026-08-03", amount: 2600 })],
      dryRun: false,
    });
    const spy = mutationSpy();

    // when: persisting the identity after the first local write is interrupted
    let partial: PartialImportApplyError | null = null;
    try {
      await applyLocalImportRecoverably(plan, spy.mutations, {
        apply: async (_rowId, mutation) => {
          mutation(undefined);
          throw new Error("progress_write_interrupted");
        },
      });
    } catch (error) {
      if (error instanceof PartialImportApplyError) partial = error;
      else throw error;
    }

    // then: the successful identity is exposed and no second transaction can cross the boundary
    expect(partial?.progress.appliedRowIds).toEqual(["blank-one"]);
    expect(spy.created.transactions).toHaveLength(1);
  });

  it("does not project an unsafe unselected recognition proposal into the legacy review", () => {
    const recognition: ReconciledImportRecognitionResult = {
      rows: [
        {
          rowId: "unsafe-row",
          imageIndex: 0,
          visualOrder: 0,
          rawTextLines: ["CARD PURCHASE", "25.00 EUR"],
          date: "2026-08-02",
          amount: 2500,
          currency: "EUR",
          direction: "debit",
          postingStatus: "posted",
          rowRole: "financial_event",
          semanticKind: "card_purchase",
          relation: { kind: "counterpart_of", rowId: "other-row" },
          confidence: "medium",
          reviewReasons: ["relation_changes_ledger_shape"],
        },
      ],
      proposals: [
        {
          rowId: "unsafe-row",
          sourceRows: ["unsafe-row"],
          disposition: "candidate",
          date: "2026-08-02",
          amount: 2500,
          currency: "EUR",
          type: "expense",
          isRefund: false,
          toAccountId: null,
          semanticKind: "card_purchase",
          relation: { kind: "counterpart_of", rowId: "other-row" },
          name: "Card purchase",
          tag: "",
          rawPlace: "CARD PURCHASE\n25.00 EUR",
          envelopeId: U(5),
          categoryId: U(6),
          placeName: null,
          reviewReasons: ["relation_changes_ledger_shape"],
          selected: false,
          duplicateStatus: "new",
          sourceAccountInvalid: false,
        },
      ],
    };

    const adapted = recognitionCandidatesForDryRun(recognition, ledger());
    const dry = planLocalImport({ ledger: ledger(), globalAccountId: U(2), items: adapted, dryRun: true });
    const review = dry.results.map((result) => importReviewItem(result, U(5)));

    expect(adapted).toEqual([]);
    expect(review).toEqual([]);
  });

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

  it("scopes exact and probable duplicate evidence to each item's effective source account", () => {
    const current = ledger();
    current.transactions.push({ ...current.transactions[0]!, id: U(31), sourceRef: null });

    const plan = planLocalImport({
      ledger: current,
      globalAccountId: U(2),
      dryRun: true,
      items: [
        item({ date: "2026-08-01", amount: 1000, rawPlace: "LIDL RAW" }),
        item({ accountId: U(3), date: "2026-08-01", amount: 1000, rawPlace: "LIDL RAW" }),
        item({ date: "2026-08-01", amount: 1000, rawPlace: "OTHER" }),
        item({ accountId: U(3), date: "2026-08-01", amount: 1000, rawPlace: "OTHER" }),
      ],
    });

    expect(plan.results.map((result) => result.status)).toEqual(["exists", "added", "probable", "added"]);
  });

  it("deduplicates within a batch only when effective source accounts match", () => {
    const plan = planLocalImport({
      ledger: ledger(),
      globalAccountId: U(2),
      dryRun: true,
      items: [
        item({ date: "2026-08-03", rawPlace: "BATCH RAW" }),
        item({ accountId: U(3), date: "2026-08-03", rawPlace: "BATCH RAW" }),
        item({ date: "2026-08-03", rawPlace: "BATCH RAW" }),
        item({ accountId: U(3), date: "2026-08-03", rawPlace: "BATCH RAW" }),
      ],
    });

    expect(plan.results.map((result) => result.status)).toEqual(["added", "added", "exists", "exists"]);
  });

  it("rechecks duplicates in review and again against the live ledger immediately before mutation", () => {
    // given: extraction saw a new row and the first dry run exposes it for review
    const first = planLocalImport({ ledger: ledger(), globalAccountId: U(2), dryRun: true, items: [item({ rawPlace: "LATE RAW" })] });
    expect(first.results[0]!.status).toBe("added");

    // and: another write lands while the review sheet remains open
    const live = ledger();
    live.transactions.push({ ...live.transactions[0]!, id: U(30), date: "2026-08-02", amount: 2500, sourceRef: "LATE RAW" });

    // when: apply planning is recomputed from the live ledger
    const final = planLocalImport({ ledger: live, globalAccountId: U(2), dryRun: false, items: [item({ rawPlace: "LATE RAW" })] });
    const spy = mutationSpy();
    applyLocalImport(final, spy.mutations);

    // then: the stale review selection cannot create the newly duplicated transaction
    expect(final).toMatchObject({ added: 0, skipped: 1 });
    expect(spy.created.transactions).toEqual([]);
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

  it.each(["unchanged", "edited", "cleared"] as const)("carries historical metadata through review and ledger application with %s fields", async (mode) => {
    // given: a known merchant on an account without an automatic envelope
    const current = ledger();
    current.accounts[0]!.automaticEnvelopeId = null;
    const recognized = await runImportRecognitionPipeline({
      images: ["data:image/png;base64,AA=="],
      locale: "en",
      today: "2026-08-02",
      budgetCurrency: "EUR",
      accountId: U(2),
      accounts: current.accounts,
      envelopes: current.envelopes,
      categories: current.categories,
      transactions: current.transactions,
      historyRecords: [
        {
          accountId: U(2),
          currency: "EUR",
          sourceRef: "LIDL RAW",
          tag: "LIDL",
          place: "Lidl",
          name: "Groceries",
          envelope: "Food",
          category: "Groceries",
          type: "expense",
          isRefund: false,
          toAccountId: null,
        },
      ],
      chat: async () => JSON.stringify({ rows: [recognitionRow("new", { rawTextLines: ["25.00 EUR", "LIDL RAW", "CARD 9876"], postingStatus: "pending" })] }),
    });
    const dry = planLocalImport({ ledger: current, globalAccountId: U(2), items: recognitionCandidatesForDryRun(recognized, current), dryRun: true });
    const items = dry.results.map((row) => importReviewItem(row, null));
    const correction: EditedImportItem = {
      type: "expense",
      accountId: U(2),
      toAccountId: null,
      isRefund: false,
      amount: 2500,
      date: "2026-08-02",
      name: mode === "cleared" ? "" : "My correction",
      envelopeId: mode === "cleared" ? null : U(9),
      categoryId: null,
      placeName: "Lidl",
      note: "",
    };
    // when: the user accepts, changes, or explicitly clears the learned fields
    const accepted = reviewedImportItemsForApply({ items, edited: mode === "unchanged" ? {} : { 0: correction }, editedAutomaticDefaults: {} });
    const plan = planLocalImport({ ledger: current, globalAccountId: U(2), items: accepted, dryRun: false });
    expect(plan.transactions).toHaveLength(1);
    expect(plan.transactions[0]!.placeName).toBeNull();
    expect(plan.transactions[0]!.categoryName).toBeNull();
    const payload = prepareTxnCreate(current, plan.transactions[0]!.payload);
    const after = applyOp(current, { opId: U(21), kind: "txn.create", payload: { ...payload, id: U(20) } });
    // then: the existing place is reused and the exact account/envelope effects follow the reviewed assignment
    expect(after.places).toEqual(current.places);
    expect(after.transactions.find((t) => t.id === U(20))).toMatchObject({
      name: mode === "unchanged" ? "Groceries" : mode === "cleared" ? null : "My correction",
      placeId: U(7),
      envelopeId: mode === "unchanged" ? U(5) : mode === "cleared" ? null : U(9),
      categoryId: mode === "unchanged" ? U(6) : null,
      sourceRef: "25.00 EUR\nLIDL RAW\nCARD 9876",
    });
    const budget = computeBudgetState(after, "2026-08");
    expect(budget.accounts[0]!.balance).toBe(-3500);
    expect(budget.envelopes.find((row) => row.envelope.id === U(5))!.available).toBe(mode === "unchanged" ? -3500 : -1000);
    expect(budget.envelopes.find((row) => row.envelope.id === U(9))!.available).toBe(mode === "edited" ? -2500 : 0);
    expect(budget.toBeBudgeted).toBe(mode === "cleared" ? -2500 : 0);
    expect(planLocalImport({ ledger: after, globalAccountId: U(2), items: accepted, dryRun: false }).added).toBe(0);
  });

  it("reuses one existing place for different truncated branch descriptions without history", async () => {
    const current = ledger();
    current.transactions = [];
    const descriptors = ["LIDL Gdansk...", "LIDL Wroclaw...", "LIDL..."];
    const rows = descriptors.map((text, i) => recognitionRow(`new-${i}`, { amount: 2500 + i, rawTextLines: [text] }));
    const result = await runImportRecognitionPipeline({
      images: [],
      checkpoint: { rows, proposals: [] },
      locale: "en",
      today: "2026-08-02",
      budgetCurrency: "EUR",
      accountId: U(2),
      accounts: current.accounts,
      envelopes: current.envelopes,
      categories: current.categories,
      places: current.places,
      transactions: [],
      historyRecords: [],
      chat: async () =>
        JSON.stringify({
          rows: rows.map((row, i) => ({
            rowId: row.rowId,
            name: "Groceries",
            place: descriptors[i],
            envelopeId: U(5),
            categoryId: U(6),
            semanticKind: "card_purchase",
            relation: null,
            reviewReasons: [],
          })),
        }),
    });
    expect(result.proposals.map((row) => row.placeName)).toEqual(["Lidl", "Lidl", "Lidl"]);
    const plan = planLocalImport({ ledger: current, globalAccountId: U(2), items: recognitionCandidatesForDryRun(result, current), dryRun: false });
    const spy = mutationSpy();
    applyLocalImport(plan, spy.mutations);
    expect(spy.created.places).toEqual([]);
    expect(spy.created.transactions).toEqual(descriptors.map((sourceRef) => expect.objectContaining({ placeId: U(7), sourceRef })));
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

  it.each([
    { type: "income" as const, linked: false, refund: false, assigned: 0, ready: 1290 },
    { type: "income" as const, linked: true, refund: false, assigned: 1290, ready: 0 },
    { type: "expense" as const, linked: false, refund: true, assigned: 1290, ready: 0 },
  ])("routes new $type with linked=$linked and refund=$refund", ({ type, linked, refund, assigned, ready }) => {
    const current = ledger();
    current.transactions = [];
    current.accounts[0]!.automaticEnvelopeId = linked ? U(9) : null;
    const before = structuredClone(current);
    const plan = planLocalImport({
      ledger: current,
      globalAccountId: U(2),
      dryRun: false,
      items: [item({ type, isRefund: refund, amount: 1290, envelopeId: U(5), envelopeName: "Food" })],
    });
    expect(plan.results[0]!.envelopeId).toBe(type === "income" ? null : U(5));
    const payload = prepareTxnCreate(current, plan.transactions[0]!.payload);
    const after = applyOp(current, { opId: U(21), kind: "txn.create", payload: { ...payload, id: U(20) } });
    const budget = computeBudgetState(after, "2026-08");
    expect(budget.accounts[0]!.balance).toBe(1290);
    expect(budget.toBeBudgeted).toBe(ready);
    expect(budget.envelopes.find((row) => row.envelope.id === (linked ? U(9) : U(5)))!.available).toBe(assigned);
    expect(budget.monthIncome).toBe(type === "income" ? 1290 : 0);
    expect(budget.monthExpense).toBe(refund ? -1290 : 0);
    expect(current).toEqual(before);
  });

  it("does not flag a discarded income envelope as an unavailable assignment", () => {
    const proposal = recognitionProposal("cashback", { type: "income", isRefund: false, envelopeId: U(5), categoryId: null });
    const result = reconcileImportJobResult({ result: { rows: [], proposals: [proposal] }, ledger: ledger(), accountId: U(2) });
    expect(result.proposals[0]).toMatchObject({ envelopeId: null, assignmentUnavailable: false });
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

  it("carries dry-run provenance through review so account changes and relinks are resolved only at apply", () => {
    const cases: Array<{ input: ImportApplyItem; expected: string | null }> = [
      { input: item({ envelopeId: null, rawPlace: "AUTO THROUGH REVIEW" }), expected: U(10) },
      { input: item({ envelopeId: null, automaticEnvelopeDefault: false, rawPlace: "EXPLICIT EMPTY THROUGH REVIEW" }), expected: null },
      { input: item({ envelopeId: U(9), rawPlace: "EXPLICIT ID THROUGH REVIEW" }), expected: U(9) },
    ];

    for (const { input, expected } of cases) {
      // given: dry-run used Main/E5, then review changes the account to Savings
      const dry = planLocalImport({ ledger: ledger(), globalAccountId: U(2), items: [input], dryRun: true });
      const review = importReviewItem(dry.results[0]!, U(5));
      const edited = editedItem({ accountId: U(3), envelopeId: review.envelopeId });
      const chosen = reviewedImportItemsForApply({
        items: [review],
        edited: { 0: edited },
        editedAutomaticDefaults: { 0: review.automaticEnvelopeDefault },
      });

      // and: Savings is relinked again while review remains open
      const live = ledger();
      live.envelopes.push({
        id: U(10),
        groupId: U(4),
        name: "Current automatic",
        color: "#fff",
        icon: "tag",
        note: null,
        monthlyTarget: null,
        isSavings: false,
        sort: 2,
        archived: false,
      });
      live.accounts[1]!.automaticEnvelopeId = U(10);

      // when: the reviewed item is planned and applied against live state
      const plan = planLocalImport({ ledger: live, globalAccountId: U(2), items: chosen, dryRun: false });
      const spy = mutationSpy();
      applyLocalImport(plan, spy.mutations);

      // then: provenance wins, and this accepted item crosses the mutation boundary exactly once
      expect((spy.created.transactions[0] as { envelopeId: string | null }).envelopeId).toBe(expected);
      expect(spy.created.transactions).toHaveLength(1);
    }
  });
});
