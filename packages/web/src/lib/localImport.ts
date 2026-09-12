import {
  buildImportDupIndex,
  type ClientLedger,
  classifyImportDup,
  existingImportRowsForAccount,
  type ImportRecognitionResult,
  importCandidateDirection,
  type ReconciledImportProposal,
  type ReconciledImportRecognitionResult,
  reconcileImportProposals,
  type TxnPayload,
} from "@enveo/shared";
import type { EditedImportItem, ImportApplyItem, ImportApplyResponse, ImportItem } from "./api";
import { expenseEnvelopeSelectionForImport } from "./automaticEnvelopeUi";
import { local } from "./mutate";

export type LocalImportReviewItem = ImportItem & {
  status: "added" | "exists" | "probable";
  include: boolean;
  automaticEnvelopeDefault: boolean;
};

interface PlannedTransaction {
  rowId: string;
  payload: TxnPayload;
  placeName: string | null;
  categoryName: string | null;
}

export interface LocalImportPlan {
  dryRun: boolean;
  added: number;
  skipped: number;
  results: ImportApplyResponse["results"];
  transactions: PlannedTransaction[];
}

export interface LocalImportMutationPort {
  createCategory(name: string): { id: string };
  createPlace(name: string): { id: string };
  createTxn(payload: TxnPayload): string;
  createTxnWithId?(id: string, payload: TxnPayload): string;
}

export type CurrentImportProposal = ReconciledImportProposal & { assignmentUnavailable: boolean };
export type CurrentImportRecognitionResult = Omit<ReconciledImportRecognitionResult, "proposals"> & { proposals: CurrentImportProposal[] };

/** Reconcile durable raw proposals against the ledger that exists now. The local
 * assignment marker survives repeated reconciliation without entering job storage/wire data. */
export function reconcileImportJobResult(args: {
  result: ImportRecognitionResult | CurrentImportRecognitionResult;
  ledger: ClientLedger;
  accountId: string;
}): CurrentImportRecognitionResult {
  const activeEnvelopes = args.ledger.envelopes.filter((envelope) => !envelope.archived);
  const activeCategories = args.ledger.categories.filter((category) => !category.archived);
  const proposals = reconcileImportProposals({
    proposals: args.result.proposals,
    transactions: args.ledger.transactions,
    accounts: args.ledger.accounts,
    envelopes: activeEnvelopes,
    categories: activeCategories,
    selectedAccountId: args.accountId,
  }).map((proposal, index) => {
    const previous = args.result.proposals[index] as ImportRecognitionResult["proposals"][number] & { assignmentUnavailable?: boolean };
    return {
      ...proposal,
      assignmentUnavailable:
        previous.assignmentUnavailable === true ||
        (proposal.type !== "income" && previous.envelopeId !== null && proposal.envelopeId === null) ||
        (previous.categoryId !== null && proposal.categoryId === null),
    };
  });
  return { rows: args.result.rows, proposals };
}

/** Complete, explicitly selected ledger candidates eligible for duplicate dry-run.
 * Raw screenshot lines — never model copy — become the persisted sourceRef evidence. */
export function recognitionCandidatesForDryRun(result: ReconciledImportRecognitionResult, ledger: ClientLedger): ImportApplyItem[] {
  const envelopeNames = new Map(ledger.envelopes.map((envelope) => [envelope.id, envelope.name]));
  const categoryNames = new Map(ledger.categories.map((category) => [category.id, category.name]));
  const rowsById = new Map(result.rows.map((row) => [row.rowId, row]));
  return result.proposals.flatMap((proposal) => {
    if (!proposal.selected || proposal.disposition !== "candidate" || proposal.date === null || proposal.amount === null || proposal.type === null) return [];
    const sourceRef = proposal.sourceRows
      .flatMap((rowId) => rowsById.get(rowId)?.rawTextLines ?? [])
      .join("\n")
      .trim();
    return [
      {
        date: proposal.date,
        amount: proposal.amount,
        type: proposal.type,
        isRefund: proposal.isRefund,
        toAccountId: proposal.toAccountId,
        name: proposal.name,
        tag: proposal.tag,
        rawPlace: sourceRef || null,
        envelopeId: proposal.envelopeId,
        envelopeName: proposal.envelopeId ? (envelopeNames.get(proposal.envelopeId) ?? null) : null,
        categoryId: proposal.categoryId,
        categoryName: proposal.categoryId ? (categoryNames.get(proposal.categoryId) ?? null) : null,
        placeName: proposal.placeName,
        currency: proposal.currency ?? undefined,
      },
    ];
  });
}

/** Convert either server or local dry-run output without erasing local provenance. */
export function importReviewItem(result: ImportApplyResponse["results"][number], automaticEnvelopeId: string | null | undefined): LocalImportReviewItem {
  const selection =
    result.type === "expense" && result.automaticEnvelopeDefault === true
      ? { envelopeId: automaticEnvelopeId ?? null, provenance: "automatic" as const }
      : result.automaticEnvelopeDefault === false
        ? { envelopeId: result.envelopeId, provenance: "explicit" as const }
        : expenseEnvelopeSelectionForImport(result.type, result.envelopeId, automaticEnvelopeId);
  return {
    ...result,
    envelopeId: selection.envelopeId,
    automaticEnvelopeDefault: selection.provenance === "automatic",
    include: result.status === "added",
  };
}

/** Merge the accepted review rows with editor corrections without losing envelope provenance. */
export function reviewedImportItemsForApply(args: {
  items: LocalImportReviewItem[];
  edited: Record<number, EditedImportItem>;
  editedAutomaticDefaults: Record<number, boolean>;
}): ImportApplyItem[] {
  return args.items
    .map((item, index) => ({ item, edited: args.edited[index], index }))
    .filter(({ item, edited }) => item.include && (item.status !== "exists" || !!edited))
    .map(({ item, edited, index }) =>
      !edited
        ? item
        : {
            ...item,
            type: edited.type,
            accountId: edited.accountId,
            toAccountId: edited.toAccountId,
            isRefund: edited.isRefund,
            amount: edited.amount,
            date: edited.date,
            name: edited.name,
            envelopeId: edited.envelopeId,
            categoryId: edited.categoryId,
            categoryName: null, // An explicitly cleared category must not be restored by its old name.
            placeName: edited.placeName,
            note: edited.note,
            automaticEnvelopeDefault: args.editedAutomaticDefaults[index] ?? false,
            force: item.status === "exists", // editing a duplicate is a deliberate add
            rawPlace: item.rawPlace, // visible source evidence stays untouched for account-scoped history/dedupe
          },
    );
}

const byName = <T extends { name: string }>(rows: T[]): Map<string, T> => new Map(rows.map((row) => [row.name.trim().toLowerCase(), row]));
const cleanName = (value: string | null | undefined): string | null => value?.trim() || null;

/** Validate and classify the complete batch before any optimistic mutation is allowed. */
export function planLocalImport(args: { ledger: ClientLedger; globalAccountId: string; items: ImportApplyItem[]; dryRun: boolean }): LocalImportPlan {
  const { ledger, globalAccountId, items, dryRun } = args;
  const accountById = new Map(ledger.accounts.map((row) => [row.id, row]));
  const envelopeIds = new Set(ledger.envelopes.map((row) => row.id));
  const categoryIds = new Set(ledger.categories.map((row) => row.id));
  const envelopeByName = byName(ledger.envelopes);
  const categoryByName = byName(ledger.categories);
  const placeByName = byName(ledger.places);
  if (!accountById.has(globalAccountId)) throw new Error("foreign_ref");

  const normalized = items.map((item, index) => {
    const accountId = item.accountId ?? globalAccountId;
    if (!accountById.has(accountId)) throw new Error("foreign_ref");
    if (item.type === "transfer" && (!item.toAccountId || item.toAccountId === accountId)) throw new Error(`transfer_invalid:${index}`);
    if (item.toAccountId && !accountById.has(item.toAccountId)) throw new Error("foreign_ref");

    const namedEnvelope = cleanName(item.envelopeName);
    const importedEnvelopeId =
      item.type !== "expense"
        ? null
        : item.automaticEnvelopeDefault !== undefined
          ? item.envelopeId
          : (item.envelopeId ?? (namedEnvelope ? envelopeByName.get(namedEnvelope.toLowerCase())?.id : null) ?? null);
    const automaticEnvelopeId = accountById.get(accountId)?.automaticEnvelopeId;
    const envelopeSelection =
      item.type === "expense" && item.automaticEnvelopeDefault === true
        ? { envelopeId: automaticEnvelopeId ?? null, provenance: "automatic" as const }
        : item.automaticEnvelopeDefault === false
          ? { envelopeId: importedEnvelopeId, provenance: "explicit" as const }
          : expenseEnvelopeSelectionForImport(item.type, importedEnvelopeId, automaticEnvelopeId);
    const { envelopeId } = envelopeSelection;
    if (envelopeId && !envelopeIds.has(envelopeId)) throw new Error("foreign_ref");

    const namedCategory = cleanName(item.categoryName);
    const categoryId =
      item.type === "transfer" ? null : (item.categoryId ?? (namedCategory ? categoryByName.get(namedCategory.toLowerCase())?.id : null) ?? null);
    if (categoryId && !categoryIds.has(categoryId)) throw new Error("foreign_ref");

    const placeName = cleanName(item.placeName);
    const placeId = placeName ? (placeByName.get(placeName.toLowerCase())?.id ?? null) : null;
    const categoryName = !categoryId && namedCategory ? namedCategory : null;
    const payload: TxnPayload = {
      type: item.type,
      accountId,
      toAccountId: item.type === "transfer" ? (item.toAccountId ?? null) : null,
      amount: item.amount,
      date: item.date,
      isRefund: item.type === "expense" ? (item.isRefund ?? false) : false,
      envelopeId,
      placeId,
      categoryId,
      name: item.name || null,
      note: item.note?.trim() ? item.note : null,
      tag: item.tag.trim(),
      sourceRef: item.rawPlace?.trim() || null,
      items: [],
    };
    return {
      item: { ...item, envelopeId, automaticEnvelopeDefault: envelopeSelection.provenance === "automatic" },
      payload,
      placeName: placeId ? null : placeName,
      categoryName,
    };
  });

  const duplicateIndexes = new Map<string, ReturnType<typeof buildImportDupIndex>>();
  const duplicateIndexFor = (accountId: string) => {
    let index = duplicateIndexes.get(accountId);
    if (!index) {
      index = buildImportDupIndex(existingImportRowsForAccount(ledger.transactions, accountId));
      duplicateIndexes.set(accountId, index);
    }
    return index;
  };
  const results: ImportApplyResponse["results"] = [];
  const transactions: PlannedTransaction[] = [];
  let added = 0;
  let skipped = 0;
  for (const candidate of normalized) {
    const dupIndex = duplicateIndexFor(candidate.payload.accountId);
    const status = candidate.item.force
      ? "new"
      : classifyImportDup(
          {
            date: candidate.item.date,
            amount: candidate.item.amount,
            rawPlace: candidate.item.rawPlace,
            direction: importCandidateDirection(candidate.payload, candidate.payload.accountId),
          },
          dupIndex,
        );
    if (status === "exists") {
      skipped++;
      results.push({ ...candidate.item, status: "exists" });
      continue;
    }
    if (dryRun && status === "probable") {
      results.push({ ...candidate.item, status: "probable" });
      continue;
    }
    dupIndex.markSeen({ date: candidate.item.date, amount: candidate.item.amount, rawPlace: candidate.item.rawPlace });
    if (!dryRun) {
      transactions.push({
        rowId: candidate.item.importRowId ?? candidate.item.rawPlace?.trim() ?? `${candidate.item.date}:${candidate.item.amount}`,
        payload: candidate.payload,
        placeName: candidate.placeName,
        categoryName: candidate.categoryName,
      });
    }
    added++;
    results.push({ ...candidate.item, status: "added" });
  }
  return { dryRun, added, skipped, results, transactions };
}

export function applyLocalImport(plan: LocalImportPlan, mutations: LocalImportMutationPort = local): { added: number; skipped: number } {
  if (!plan.dryRun) {
    for (const transaction of plan.transactions) {
      const categoryId = transaction.categoryName ? mutations.createCategory(transaction.categoryName).id : transaction.payload.categoryId;
      const placeId = transaction.placeName ? mutations.createPlace(transaction.placeName).id : transaction.payload.placeId;
      mutations.createTxn({ ...transaction.payload, categoryId, placeId });
    }
  }
  return { added: plan.added, skipped: plan.skipped };
}

export interface LocalImportApplyProgress {
  appliedRowIds: string[];
  appliedCount: number;
  skippedCount: number;
}

export class PartialImportApplyError extends Error {
  constructor(
    cause: unknown,
    readonly progress: LocalImportApplyProgress,
  ) {
    super(cause instanceof Error ? cause.message : "import_apply_failed", { cause });
    this.name = "PartialImportApplyError";
  }
}

/** Applies one planned transaction at a time and durably records its row identity before
 * another transaction may cross the local mutation boundary. */
export async function applyLocalImportRecoverably(
  plan: LocalImportPlan,
  mutations: LocalImportMutationPort = local,
  durability: {
    apply(rowId: string, mutation: (transactionId: string | undefined) => void): Promise<void>;
  } = { apply: async (_rowId, mutation) => mutation(undefined) },
): Promise<LocalImportApplyProgress> {
  const progress: LocalImportApplyProgress = { appliedRowIds: [], appliedCount: 0, skippedCount: plan.skipped };
  if (plan.dryRun) return progress;
  for (const transaction of plan.transactions) {
    try {
      await durability.apply(transaction.rowId, (transactionId) => {
        const categoryId = transaction.categoryName ? mutations.createCategory(transaction.categoryName).id : transaction.payload.categoryId;
        const placeId = transaction.placeName ? mutations.createPlace(transaction.placeName).id : transaction.payload.placeId;
        const payload = { ...transaction.payload, categoryId, placeId };
        if (transactionId) {
          if (!mutations.createTxnWithId) throw new Error("import_transaction_identity_unsupported");
          mutations.createTxnWithId(transactionId, payload);
        } else mutations.createTxn(payload);
        progress.appliedRowIds.push(transaction.rowId);
        progress.appliedCount++;
      });
    } catch (error) {
      throw new PartialImportApplyError(error, progress);
    }
  }
  return progress;
}
