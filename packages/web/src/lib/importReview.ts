import {
  type ClientLedger,
  type ImportDupStatus,
  type ImportProposal,
  type ImportReviewReason,
  type ImportSemanticKind,
  importProposalBlockingReasons,
  type ReconciledImportProposal,
  type ReconciledImportRecognitionResult,
} from "@enveo/shared";
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
  requiresReview: boolean;
  blockingIssues: ImportBlockingIssue[];
  duplicateStatus: ImportDupStatus;
  alreadyApplied: boolean;
  sourceRef: string;
  rawTextLines: string[];
  date: string | null;
  amount: number | null;
  currency: string | null;
  include: boolean;
  editable: boolean;
  item: LocalImportReviewItem | null;
}

export function visibleImportReviewRows<T extends Pick<ImportReviewRow, "disposition">>(rows: readonly T[]): { row: T; index: number; position: number }[] {
  const visible: { row: T; index: number; position: number }[] = [];
  rows.forEach((row, index) => {
    if (row.disposition !== "supporting") visible.push({ row, index, position: visible.length });
  });
  return visible;
}

export type ImportBlockingIssue = ImportReviewReason | "currency_mismatch" | "assignment_unavailable";

/** Every selected review row needs an explicit edit acknowledgement. Rows with
 * incomplete ledger facts remain blocked after editing and must be unchecked. */
export function importReviewBlockingCount(rows: readonly ImportReviewRow[], edited: Readonly<Record<number, EditedImportItem>>): number {
  return rows.filter((row, index) => {
    const hasUnresolvableIssue = row.blockingIssues.some((issue) => issue !== "assignment_unavailable");
    return row.include && (hasUnresolvableIssue || (row.requiresReview && !edited[index]));
  }).length;
}

const REASON_MESSAGES: Record<ImportReviewReason, Message> = {
  missing_fact: msg("Missing date or amount"),
  unsupported_currency: msg("Unsupported currency"),
  inconsistent_direction: msg("Direction needs review"),
  possible_transfer: msg("Possible transfer"),
  unknown_transfer_endpoint: msg("Transfer account is unknown"),
  possible_ocr_error: msg("Possible recognition error"),
  history_conflict: msg("Conflicts with transaction history"),
  multiple_history_candidates: msg("Several history matches"),
  invalid_relation: msg("Related row is invalid"),
  impossible_fx: msg("FX amounts do not match"),
  relation_changes_ledger_shape: msg("Related rows could change the ledger"),
  fact_correction: msg("AI suggested changing an extracted fact"),
  pending_or_declined: msg("Pending or declined"),
  unknown_posting_status: msg("Posting status is unknown"),
  unknown_kind: msg("Unknown transaction type"),
};

export function importReviewReasonMessage(reason: string): Message {
  return REASON_MESSAGES[reason as ImportReviewReason] ?? msg("Needs review");
}

export interface ImportReviewBadge {
  label: Message;
  tone: "neutral" | "positive" | "warning";
}

export interface ImportReviewControlLabel {
  message: Message;
  values: { n: number };
}

/** Localizable, row-specific names for the native controls rendered by ImportSheet. */
export function reviewRowControlLabels(
  row: ImportReviewRow,
  index: number,
): { select: ImportReviewControlLabel | null; edit: ImportReviewControlLabel | null } {
  const canSelect = row.item !== null || (row.disposition === "unresolved" && row.blockingIssues.length > 0);
  if (row.duplicateStatus === "exists" || !canSelect) return { select: null, edit: null };
  const values = { n: index + 1 };
  return {
    select: { message: msg("Select recognized row {n}"), values },
    edit: row.item && row.editable ? { message: msg("Edit item {n}"), values } : null,
  };
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
  const disposition = row.duplicateStatus === "exists" ? null : dispositionBadge(row.disposition);
  if (disposition) badges.push(disposition);
  if (row.relation?.kind === "fx_for" || row.semanticKind === "fx_conversion") badges.push({ label: msg("FX relation"), tone: "warning" });
  if (row.item?.isRefund || row.semanticKind === "merchant_refund" || row.semanticKind === "chargeback") {
    badges.push({ label: msg("Refund"), tone: "positive" });
  }
  if (row.semanticKind === "cashback_or_reward") badges.push({ label: msg("Reward / income"), tone: "positive" });
  if (row.alreadyApplied) badges.push({ label: msg("Already added by this import"), tone: "neutral" });
  else if (row.duplicateStatus === "exists") badges.push({ label: msg("Already exists"), tone: "neutral" });
  if (row.duplicateStatus === "probable") badges.push({ label: msg("Probable duplicate"), tone: "warning" });
  if (row.blockingIssues.includes("assignment_unavailable")) badges.push({ label: msg("Saved assignment is unavailable"), tone: "warning" });
  for (const reason of row.reviewReasons) {
    const label = importReviewReasonMessage(reason);
    badges.push({ label, tone: reason === "pending_or_declined" ? "neutral" : "warning" });
  }
  const unique = new Map<Message, ImportReviewBadge>();
  for (const badge of badges) unique.set(badge.label, badge);
  return [...unique.values()];
}

function completeCandidateItem(args: {
  proposal: ReconciledImportProposal;
  recognition: ReconciledImportRecognitionResult;
  ledger: ClientLedger;
  dryResult?: ImportApplyResponse["results"][number];
  duplicateStatus: ImportDupStatus;
  automaticEnvelopeId: string | null | undefined;
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
  const status = args.duplicateStatus === "new" ? "added" : args.duplicateStatus;
  const result: ImportApplyResponse["results"][number] = args.dryResult
    ? { ...args.dryResult, status }
    : {
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
        status,
      };
  const item = importReviewItem({ ...result, rawPlace: sourceRef || null }, args.automaticEnvelopeId);
  return { ...item, include: proposal.selected && item.include };
}

const effectiveDuplicateStatus = (
  recognitionStatus: ImportDupStatus,
  dryRunStatus: ImportApplyResponse["results"][number]["status"] | undefined,
): ImportDupStatus => {
  if (recognitionStatus === "exists" || dryRunStatus === "exists") return "exists";
  if (recognitionStatus === "probable" || dryRunStatus === "probable") return "probable";
  return "new";
};

/** Joins dry-run verdicts back onto recognition without dropping any raw row. */
export function buildImportReviewRows(args: {
  recognition: ReconciledImportRecognitionResult;
  ledger: ClientLedger;
  dryRunResults: ImportApplyResponse["results"];
  automaticEnvelopeId: string | null | undefined;
  budgetCurrency: string;
  appliedRowIds?: readonly string[];
  skippedRowIds?: readonly string[];
}): ImportReviewRow[] {
  const proposals = new Map(args.recognition.proposals.map((proposal) => [proposal.rowId, proposal]));
  const appliedRowIds = new Set(args.appliedRowIds ?? []);
  const skippedRowIds = new Set(args.skippedRowIds ?? []);
  let dryIndex = 0;
  return args.recognition.rows.map((rawRow) => {
    const proposal = proposals.get(rawRow.rowId);
    const alreadyApplied = appliedRowIds.has(rawRow.rowId);
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
        requiresReview: true,
        blockingIssues: ["missing_fact"],
        duplicateStatus: alreadyApplied ? "exists" : "new",
        alreadyApplied,
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
    const dryResult = receivesDryResult ? args.dryRunResults[dryIndex++] : undefined;
    const duplicateStatus = alreadyApplied ? "exists" : effectiveDuplicateStatus(proposal.duplicateStatus, dryResult?.status);
    const item = completeCandidateItem({
      proposal,
      recognition: args.recognition,
      ledger: args.ledger,
      dryResult,
      duplicateStatus,
      automaticEnvelopeId: args.automaticEnvelopeId,
    });
    const reviewItem = duplicateStatus === "exists" ? null : item;
    const blockingIssues: ImportBlockingIssue[] = importProposalBlockingReasons(proposal);
    if ((proposal as ReconciledImportProposal & { assignmentUnavailable?: boolean }).assignmentUnavailable) blockingIssues.push("assignment_unavailable");
    if (proposal.currency && proposal.currency !== args.budgetCurrency) blockingIssues.push("currency_mismatch");
    return {
      rowId: rawRow.rowId,
      disposition: proposal.disposition,
      semanticKind: proposal.semanticKind,
      relation: proposal.relation,
      reviewReasons: proposal.reviewReasons,
      requiresReview: proposal.reviewReasons.length > 0 || duplicateStatus === "probable" || blockingIssues.length > 0,
      blockingIssues,
      duplicateStatus,
      alreadyApplied,
      sourceRef,
      rawTextLines: rawRow.rawTextLines,
      date: proposal.date,
      amount: proposal.amount,
      currency: proposal.currency,
      include: duplicateStatus !== "exists" && !skippedRowIds.has(rawRow.rowId) && (reviewItem !== null || proposal.selected),
      editable: reviewItem !== null,
      item: reviewItem ? { ...reviewItem, include: reviewItem.include } : null,
    };
  });
}

/** The final allowlist boundary before TxnPayload planning. */
export function reviewedImportRowsForApply(args: {
  rows: ImportReviewRow[];
  edited: Record<number, EditedImportItem>;
  editedAutomaticDefaults: Record<number, boolean>;
}): ImportApplyItem[] {
  if (importReviewBlockingCount(args.rows, args.edited) > 0) throw new Error("import_review_blocked");
  const candidates = args.rows.flatMap((row) => {
    if (row.disposition !== "candidate" || !row.item) return [];
    return [{ ...row.item, importRowId: row.rowId, include: row.include }];
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

/** Truthful completion totals: each extracted exact duplicate is one skipped row, while
 * apply-time skips cover rows that became duplicates while the review remained open. */
export function importReviewDoneStats(rows: ImportReviewRow[], result: { added: number; skipped: number }): { added: number; dup: number } {
  return {
    added: result.added,
    dup: rows.filter((row) => row.duplicateStatus === "exists").length + result.skipped,
  };
}
