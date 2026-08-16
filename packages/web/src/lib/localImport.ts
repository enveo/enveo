import { buildImportDupIndex, type ClientLedger, classifyImportDup, type TxnPayload } from "@enveo/shared";
import type { EditedImportItem, ImportApplyItem, ImportApplyResponse, ImportItem } from "./api";
import { expenseEnvelopeSelectionForImport } from "./automaticEnvelopeUi";
import { local } from "./mutate";

export type LocalImportReviewItem = ImportItem & {
  status: "added" | "exists" | "probable";
  include: boolean;
  automaticEnvelopeDefault: boolean;
};

interface PlannedTransaction {
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
            placeName: edited.placeName,
            note: edited.note,
            automaticEnvelopeDefault: args.editedAutomaticDefaults[index] ?? false,
            force: item.status === "exists", // editing a duplicate is a deliberate add
            rawPlace: item.rawPlace, // extraction source stays untouched for learning/dedupe
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
      item.type === "transfer"
        ? null
        : item.automaticEnvelopeDefault !== undefined
          ? item.envelopeId
          : (item.envelopeId ?? (namedEnvelope ? envelopeByName.get(namedEnvelope.toLowerCase())?.id : null) ?? null);
    const automaticEnvelopeId = accountById.get(accountId)?.automaticEnvelopeId;
    const envelopeId =
      item.type === "expense" && item.automaticEnvelopeDefault === true
        ? (automaticEnvelopeId ?? null)
        : item.type === "expense" && item.automaticEnvelopeDefault === false
          ? importedEnvelopeId
          : expenseEnvelopeSelectionForImport(item.type, importedEnvelopeId, automaticEnvelopeId).envelopeId;
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
    return { item: { ...item, envelopeId }, payload, placeName: placeId ? null : placeName, categoryName };
  });

  const dupIndex = buildImportDupIndex(ledger.transactions.map((row) => ({ date: row.date, amount: row.amount, sourceRef: row.sourceRef })));
  const results: ImportApplyResponse["results"] = [];
  const transactions: PlannedTransaction[] = [];
  let added = 0;
  let skipped = 0;
  for (const candidate of normalized) {
    const status = candidate.item.force
      ? "new"
      : classifyImportDup({ date: candidate.item.date, amount: candidate.item.amount, rawPlace: candidate.item.rawPlace }, dupIndex);
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
    if (!dryRun) transactions.push({ payload: candidate.payload, placeName: candidate.placeName, categoryName: candidate.categoryName });
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
