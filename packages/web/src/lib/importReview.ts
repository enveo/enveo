import type { ClientLedger, ImportProposal, ImportRecognitionResult, ImportReviewReason, ImportSemanticKind } from "@enveo/shared";
import type { EditedImportItem, ImportApplyItem, ImportApplyResponse } from "./api";
import { type Message, msg } from "./i18n";
import { importReviewItem, type LocalImportReviewItem, reviewedImportItemsForApply } from "./localImport";

export type ImportReviewDisposition = ImportProposal["disposition"];

export interface ImportReviewRow {
  rowId: string;
  disposition: ImportReviewDisposition;
  semanticKind: ImportSemanticKind;
  relation: ImportProposal["relation"];
  reviewReasons: ImportReviewReason[];
  sourceRef: string;
  rawTextLines: string[];
  date: string | null;
  amount: number | null;
  currency: string | null;
  include: boolean;
  editable: boolean;
  item: LocalImportReviewItem | null;
}

const REASON_MESSAGES: Record<ImportReviewReason, Message> = {
  missing_fact: msg("Missing date or amount"),
  unsupported_currency: msg("Unsupported currency"),
  inconsistent_direction: msg("Direction needs review"),
  possible_transfer: msg("Possible transfer"),
  unknown_transfer_endpoint: msg("Transfer account is unknown"),
  possible_ocr_error: msg("Possible recognition error"),
  history_conflict: msg("Conflicts with transaction history"),
  multiple_history_candidates: msg("Probable duplicate"),
  invalid_relation: msg("Related row is invalid"),
  impossible_fx: msg("FX amounts do not match"),
  relation_changes_ledger_shape: msg("Related rows could change the ledger"),
  fact_correction: msg("AI suggested changing an extracted fact"),
  pending_or_declined: msg("Pending or declined"),
  unknown_kind: msg("Unknown transaction type"),
};

export function importReviewReasonMessage(reason: string): Message {
  return REASON_MESSAGES[reason as ImportReviewReason] ?? msg("Needs review");
}

export interface ImportReviewBadge {
  label: Message;
  tone: "neutral" | "positive" | "warning";
}

const dispositionBadge = (disposition: ImportReviewDisposition): ImportReviewBadge | null => {
  switch (disposition) {
    case "pending":
      return { label: msg("Pending — not added"), tone: "neutral" };
    case "declined":
      return { label: msg("Declined — not added"), tone: "neutral" };
    case "supporting":
      return { label: msg("Supporting detail — not a transaction"), tone: "neutral" };
    case "unresolved":
      return { label: msg("Unresolved — needs review"), tone: "warning" };
    case "candidate":
      return null;
  }
};

/** Concise, exhaustive display facts. Duplicate labels collapse without hiding reasons. */
export function reviewBadges(row: ImportReviewRow): ImportReviewBadge[] {
  const badges: ImportReviewBadge[] = [];
  const disposition = dispositionBadge(row.disposition);
  if (disposition) badges.push(disposition);
  if (row.relation?.kind === "fx_for" || row.semanticKind === "fx_conversion") badges.push({ label: msg("FX relation"), tone: "warning" });
  if (row.item?.isRefund || row.semanticKind === "merchant_refund" || row.semanticKind === "chargeback") {
    badges.push({ label: msg("Refund"), tone: "positive" });
  }
  if (row.semanticKind === "cashback_or_reward") badges.push({ label: msg("Reward / income"), tone: "positive" });
  if (row.item?.status === "exists") badges.push({ label: msg("Already exists"), tone: "neutral" });
  if (row.item?.status === "probable") badges.push({ label: msg("Probable duplicate"), tone: "warning" });
  for (const reason of row.reviewReasons) {
    const label = importReviewReasonMessage(reason);
    badges.push({ label, tone: reason === "pending_or_declined" ? "neutral" : "warning" });
  }
  const unique = new Map<Message, ImportReviewBadge>();
  for (const badge of badges) unique.set(badge.label, badge);
  return [...unique.values()];
}

const inferredStatus = (proposal: ImportProposal): LocalImportReviewItem["status"] => {
  if (proposal.reviewReasons.includes("history_conflict")) return "exists";
  if (proposal.reviewReasons.includes("multiple_history_candidates")) return "probable";
  return "added";
};

function completeCandidateItem(args: {
  proposal: ImportProposal;
  recognition: ImportRecognitionResult;
  ledger: ClientLedger;
  dryResult?: ImportApplyResponse["results"][number];
  automaticEnvelopeId: string | null | undefined;
  budgetCurrency: string;
}): LocalImportReviewItem | null {
  const { proposal } = args;
  if (proposal.disposition !== "candidate" || proposal.date === null || proposal.amount === null || proposal.type === null) return null;
  const rowsById = new Map(args.recognition.rows.map((row) => [row.rowId, row]));
  const sourceRef = proposal.sourceRows
    .flatMap((rowId) => rowsById.get(rowId)?.rawTextLines ?? [])
    .join("\n")
    .trim();
  const envelopeNames = new Map(args.ledger.envelopes.map((envelope) => [envelope.id, envelope.name]));
  const categoryNames = new Map(args.ledger.categories.map((category) => [category.id, category.name]));
  const result: ImportApplyResponse["results"][number] = args.dryResult ?? {
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
    status: inferredStatus(proposal),
  };
  const item = importReviewItem({ ...result, rawPlace: sourceRef || null }, args.automaticEnvelopeId, args.budgetCurrency);
  return { ...item, include: proposal.selected && item.include };
}

/** Joins dry-run verdicts back onto recognition without dropping any raw row. */
export function buildImportReviewRows(args: {
  recognition: ImportRecognitionResult;
  ledger: ClientLedger;
  dryRunResults: ImportApplyResponse["results"];
  automaticEnvelopeId: string | null | undefined;
  budgetCurrency: string;
}): ImportReviewRow[] {
  const proposals = new Map(args.recognition.proposals.map((proposal) => [proposal.rowId, proposal]));
  let dryIndex = 0;
  return args.recognition.rows.map((rawRow) => {
    const proposal = proposals.get(rawRow.rowId);
    const sourceRef = (proposal?.sourceRows ?? [rawRow.rowId])
      .flatMap((rowId) => args.recognition.rows.find((row) => row.rowId === rowId)?.rawTextLines ?? [])
      .join("\n")
      .trim();
    if (!proposal) {
      return {
        rowId: rawRow.rowId,
        disposition: "unresolved",
        semanticKind: rawRow.semanticKind,
        relation: rawRow.relation,
        reviewReasons: ["missing_fact"],
        sourceRef,
        rawTextLines: rawRow.rawTextLines,
        date: rawRow.date,
        amount: rawRow.amount,
        currency: rawRow.currency,
        include: false,
        editable: false,
        item: null,
      };
    }
    const receivesDryResult =
      proposal.selected && proposal.disposition === "candidate" && proposal.date !== null && proposal.amount !== null && proposal.type !== null;
    const item = completeCandidateItem({
      proposal,
      recognition: args.recognition,
      ledger: args.ledger,
      dryResult: receivesDryResult ? args.dryRunResults[dryIndex++] : undefined,
      automaticEnvelopeId: args.automaticEnvelopeId,
      budgetCurrency: args.budgetCurrency,
    });
    return {
      rowId: rawRow.rowId,
      disposition: proposal.disposition,
      semanticKind: proposal.semanticKind,
      relation: proposal.relation,
      reviewReasons: proposal.reviewReasons,
      sourceRef,
      rawTextLines: rawRow.rawTextLines,
      date: proposal.date,
      amount: proposal.amount,
      currency: proposal.currency,
      include: item?.include ?? false,
      editable: item !== null,
      item: item ? { ...item, include: item.include } : null,
    };
  });
}

/** The final allowlist boundary before TxnPayload planning. */
export function reviewedImportRowsForApply(args: {
  rows: ImportReviewRow[];
  edited: Record<number, EditedImportItem>;
  editedAutomaticDefaults: Record<number, boolean>;
}): ImportApplyItem[] {
  const candidates = args.rows.flatMap((row) => {
    if (row.disposition !== "candidate" || !row.item) return [];
    return [{ ...row.item, include: row.include }];
  });
  const edits: Record<number, EditedImportItem> = {};
  const automatic: Record<number, boolean> = {};
  let candidateIndex = 0;
  args.rows.forEach((row, rowIndex) => {
    if (row.disposition !== "candidate" || !row.item) return;
    if (args.edited[rowIndex]) edits[candidateIndex] = args.edited[rowIndex]!;
    if (args.editedAutomaticDefaults[rowIndex] !== undefined) automatic[candidateIndex] = args.editedAutomaticDefaults[rowIndex]!;
    candidateIndex++;
  });
  return reviewedImportItemsForApply({ items: candidates, edited: edits, editedAutomaticDefaults: automatic });
}
