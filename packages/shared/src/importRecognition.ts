import { isSupportedCurrency } from "./currency";
import { buildImportDupIndex, classifyImportDup, type ImportDupStatus } from "./importDedupe";
import type { Account, Category, Envelope, Transaction } from "./types";

export const IMPORT_SEMANTIC_KINDS = [
  "card_purchase",
  "cash_withdrawal",
  "fee",
  "interest",
  "salary",
  "cashback_or_reward",
  "merchant_refund",
  "chargeback",
  "incoming_transfer",
  "outgoing_transfer",
  "account_topup",
  "internal_transfer",
  "fx_conversion",
  "cash_deposit",
  "unknown",
] as const;
export const IMPORT_RELATION_KINDS = ["fx_for", "refund_of", "pending_version_of", "fee_for", "duplicate_of", "counterpart_of", "continuation_of"] as const;
export const IMPORT_REVIEW_REASONS = [
  "missing_fact",
  "unsupported_currency",
  "inconsistent_direction",
  "possible_transfer",
  "unknown_transfer_endpoint",
  "possible_ocr_error",
  "history_conflict",
  "multiple_history_candidates",
  "invalid_relation",
  "impossible_fx",
  "relation_changes_ledger_shape",
  "fact_correction",
  "pending_or_declined",
  "unknown_posting_status",
  "unknown_kind",
] as const;

export type ImportSemanticKind = (typeof IMPORT_SEMANTIC_KINDS)[number];
export type ImportRelationKind = (typeof IMPORT_RELATION_KINDS)[number];
export type ImportPostingStatus = "posted" | "pending" | "declined" | "unknown";
export type ImportRowRole = "financial_event" | "supporting_detail" | "ui_metadata";
export type ImportDirection = "debit" | "credit" | "unknown";
export type ImportReviewReason = (typeof IMPORT_REVIEW_REASONS)[number];

export interface ImportRowRelation {
  kind: ImportRelationKind;
  rowId: string;
}

export interface ImportExtractRow {
  rowId: string;
  imageIndex: number;
  visualOrder: number;
  rawTextLines: string[];
  date: string | null;
  amount: number | null;
  currency: string | null;
  direction: ImportDirection;
  postingStatus: ImportPostingStatus;
  rowRole: ImportRowRole;
  semanticKind: ImportSemanticKind;
  relation: ImportRowRelation | null;
  confidence: "low" | "medium" | "high";
  reviewReasons: ImportReviewReason[];
}

export interface ImportExtractBatch {
  rows: ImportExtractRow[];
}

export interface ImportProposal {
  rowId: string;
  sourceRows: string[];
  disposition: "candidate" | "supporting" | "pending" | "declined" | "unresolved";
  date: string | null;
  amount: number | null;
  currency: string | null;
  type: "expense" | "income" | "transfer" | null;
  isRefund: boolean;
  toAccountId: string | null;
  semanticKind: ImportSemanticKind;
  relation: ImportRowRelation | null;
  name: string;
  tag: string;
  rawPlace: string;
  envelopeId: string | null;
  categoryId: string | null;
  placeName: string | null;
  reviewReasons: ImportReviewReason[];
  selected: boolean;
}

export interface ImportRecognitionResult {
  rows: ImportExtractRow[];
  proposals: ImportProposal[];
}

export interface ImportEnrichmentRow {
  rowId: string;
  name: string;
  place: string | null;
  envelopeId: string | null;
  categoryId: string | null;
  semanticKind: ImportSemanticKind;
  relation: ImportRowRelation | null;
  reviewReasons: ImportReviewReason[];
  /** Parser-only evidence that the model attempted to rewrite an extraction fact. */
  factCorrectionAttempt?: boolean;
}

/** Parsed model annotations plus the current ids that bounded that model call. */
export interface ImportEnrichmentAnswer {
  rows: ImportEnrichmentRow[];
  allowedEnvelopeIds: readonly string[];
  allowedCategoryIds: readonly string[];
  allowedAccountIds: readonly string[];
}

export interface ReconciledImportProposal extends ImportProposal {
  duplicateStatus: ImportDupStatus;
  sourceAccountInvalid: boolean;
}

/** Final production/wire result after current-ledger reconciliation. */
export interface ReconciledImportRecognitionResult extends Omit<ImportRecognitionResult, "proposals"> {
  proposals: ReconciledImportProposal[];
}

const BLOCKING_REVIEW_REASONS = new Set<ImportReviewReason>(["missing_fact", "unsupported_currency", "invalid_relation", "unknown_kind"]);

/** Review is independent from inclusion. These reasons mean a selected event
 * cannot become a valid ledger transaction until the user acts. */
export function importProposalBlockingReasons(proposal: Pick<ImportProposal, "reviewReasons">): ImportReviewReason[] {
  return proposal.reviewReasons.filter((reason) => BLOCKING_REVIEW_REASONS.has(reason));
}

const addReasons = (current: ImportReviewReason[], ...added: ImportReviewReason[]): ImportReviewReason[] => {
  const unique = new Set<ImportReviewReason>(current);
  for (const reason of added) unique.add(reason);
  return [...unique];
};

/** Cycle two is reserved for rows carrying deterministic uncertainty or review risk. */
export function needsImportEnrichment(result: ImportRecognitionResult): boolean {
  return result.proposals.some((proposal) => proposal.reviewReasons.length > 0 || proposal.disposition === "unresolved");
}

const ENRICHMENT_ROW_KEYS = new Set([
  "rowId",
  "name",
  "place",
  "envelopeId",
  "categoryId",
  "semanticKind",
  "relation",
  "reviewReasons",
  "factCorrectionAttempt",
]);

/**
 * Applies model annotations without allowing them to rewrite extraction facts.
 * Unknown current-entity ids and relation targets are ignored and made visible
 * as fact_correction review evidence.
 */
export function applyImportEnrichment(result: ImportRecognitionResult, answer: ImportEnrichmentAnswer): ImportRecognitionResult {
  const envelopeIds = new Set(answer.allowedEnvelopeIds);
  const categoryIds = new Set(answer.allowedCategoryIds);
  const rowIds = new Set(result.rows.map((row) => row.rowId));
  const answerRowIds = new Set<string>();
  const invalidAnswerIdentity = answer.rows.some((row) => {
    if (!rowIds.has(row.rowId) || answerRowIds.has(row.rowId)) return true;
    answerRowIds.add(row.rowId);
    return false;
  });
  const annotations = new Map(answer.rows.map((row) => [row.rowId, row]));

  return {
    rows: result.rows,
    proposals: result.proposals.map((proposal) => {
      const annotation = annotations.get(proposal.rowId);
      if (!annotation) {
        return invalidAnswerIdentity ? { ...proposal, reviewReasons: addReasons(proposal.reviewReasons, "fact_correction") } : proposal;
      }

      let factCorrection =
        invalidAnswerIdentity ||
        annotation.factCorrectionAttempt === true ||
        Object.keys(annotation as unknown as Record<string, unknown>).some((key) => !ENRICHMENT_ROW_KEYS.has(key));
      const envelopeId = annotation.envelopeId === null || envelopeIds.has(annotation.envelopeId) ? annotation.envelopeId : proposal.envelopeId;
      const categoryId = annotation.categoryId === null || categoryIds.has(annotation.categoryId) ? annotation.categoryId : proposal.categoryId;
      if (annotation.envelopeId !== null && !envelopeIds.has(annotation.envelopeId)) factCorrection = true;
      if (annotation.categoryId !== null && !categoryIds.has(annotation.categoryId)) factCorrection = true;

      let relation = annotation.relation;
      if (relation && (!rowIds.has(relation.rowId) || relation.rowId === proposal.rowId)) {
        relation = proposal.relation;
        factCorrection = true;
      }
      const relationChanged = JSON.stringify(relation) !== JSON.stringify(proposal.relation);
      let reviewReasons = [...proposal.reviewReasons];
      if (relationChanged) reviewReasons = addReasons(reviewReasons, "relation_changes_ledger_shape");
      if (factCorrection) reviewReasons = addReasons(reviewReasons, "fact_correction");

      return {
        ...proposal,
        name: annotation.name.trim(),
        placeName: annotation.place?.trim() || null,
        envelopeId,
        categoryId,
        semanticKind: annotation.semanticKind,
        relation,
        reviewReasons,
        selected: proposal.selected,
      };
    }),
  };
}

const isCalendarDate = (value: string | null): value is string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
};

const hasPositiveMinorAmount = (amount: number | null): amount is number => amount !== null && Number.isInteger(amount) && amount > 0;

const samePostingFacts = (left: ImportExtractRow, right: ImportExtractRow): boolean =>
  left.date === right.date && left.amount === right.amount && left.currency === right.currency && left.direction === right.direction;

const hasComparablePostingFacts = (row: ImportExtractRow): boolean =>
  isCalendarDate(row.date) && hasPositiveMinorAmount(row.amount) && row.currency !== null && row.direction !== "unknown";

const isTransferKind = (kind: ImportSemanticKind): boolean =>
  kind === "incoming_transfer" || kind === "outgoing_transfer" || kind === "account_topup" || kind === "internal_transfer";

/** Model relations are hypotheses. Keep only links whose kind is supported by
 * the independently extracted facts of both visible rows. */
const relationSupportedByFacts = (row: ImportExtractRow, target: ImportExtractRow): boolean => {
  switch (row.relation?.kind) {
    case "fx_for":
      return (
        row.rowRole === "supporting_detail" &&
        row.semanticKind === "fx_conversion" &&
        target.rowRole === "financial_event" &&
        target.semanticKind !== "fx_conversion" &&
        hasPositiveMinorAmount(row.amount) &&
        hasPositiveMinorAmount(target.amount) &&
        row.currency !== null &&
        target.currency !== null &&
        row.currency !== target.currency
      );
    case "duplicate_of":
      return hasComparablePostingFacts(row) && hasComparablePostingFacts(target) && samePostingFacts(row, target);
    case "refund_of":
      return (
        (row.semanticKind === "merchant_refund" || row.semanticKind === "chargeback") &&
        target.rowRole === "financial_event" &&
        row.currency === target.currency &&
        row.amount === target.amount &&
        row.direction === "credit" &&
        target.direction === "debit"
      );
    case "pending_version_of":
      return (
        row.postingStatus === "pending" &&
        target.postingStatus === "posted" &&
        hasComparablePostingFacts(row) &&
        hasComparablePostingFacts(target) &&
        samePostingFacts(row, target)
      );
    case "fee_for":
      return row.semanticKind === "fee" && target.rowRole === "financial_event" && target.semanticKind !== "fee";
    case "counterpart_of":
      return (
        isTransferKind(row.semanticKind) &&
        isTransferKind(target.semanticKind) &&
        row.amount === target.amount &&
        row.currency === target.currency &&
        ((row.direction === "credit" && target.direction === "debit") || (row.direction === "debit" && target.direction === "credit"))
      );
    case "continuation_of":
      return row.rowRole === "supporting_detail" && target.rowRole !== "ui_metadata";
    case undefined:
      return false;
  }
};

const mappingFor = (
  semanticKind: ImportSemanticKind,
  direction: ImportDirection,
): { type: ImportProposal["type"]; isRefund: boolean; expectedDirection: ImportDirection | null; reviewReasons: ImportReviewReason[] } => {
  switch (semanticKind) {
    case "card_purchase":
    case "cash_withdrawal":
    case "fee":
    case "outgoing_transfer":
      return { type: "expense", isRefund: false, expectedDirection: "debit", reviewReasons: [] };
    case "interest":
    case "salary":
    case "cashback_or_reward":
    case "incoming_transfer":
    case "account_topup":
    case "cash_deposit":
      return {
        type: "income",
        isRefund: false,
        expectedDirection: "credit",
        reviewReasons: semanticKind === "incoming_transfer" || semanticKind === "account_topup" ? ["possible_transfer"] : [],
      };
    case "merchant_refund":
    case "chargeback":
      return { type: "expense", isRefund: true, expectedDirection: "credit", reviewReasons: [] };
    case "internal_transfer":
      return {
        type: direction === "debit" ? "expense" : direction === "credit" ? "income" : null,
        isRefund: false,
        expectedDirection: null,
        reviewReasons: ["unknown_transfer_endpoint"],
      };
    case "fx_conversion":
      return { type: null, isRefund: false, expectedDirection: null, reviewReasons: [] };
    case "unknown":
      return { type: null, isRefund: false, expectedDirection: null, reviewReasons: ["unknown_kind"] };
  }
};

const proposalFrom = (row: ImportExtractRow, overrides: Partial<ImportProposal> = {}): ImportProposal => ({
  rowId: row.rowId,
  sourceRows: [row.rowId],
  disposition: "candidate",
  date: row.date,
  amount: row.amount,
  currency: row.currency,
  type: null,
  isRefund: false,
  toAccountId: null,
  semanticKind: row.semanticKind,
  relation: row.relation,
  name: "",
  tag: "",
  rawPlace: row.rawTextLines.join("\n"),
  envelopeId: null,
  categoryId: null,
  placeName: null,
  reviewReasons: row.reviewReasons,
  selected: false,
  ...overrides,
});

/** Converts strict extraction facts into conservative, still-reviewable ledger proposals. */
export function validateImportExtraction(input: { batch: ImportExtractBatch; budgetCurrency: string }): ImportRecognitionResult {
  const { batch, budgetCurrency } = input;
  const rows = batch.rows.map((row) => ({ ...row, reviewReasons: [] }));
  const rowsById = new Map<string, ImportExtractRow>();
  for (const row of rows) {
    if (rowsById.has(row.rowId)) throw new Error(`duplicate rowId: ${row.rowId}`);
    rowsById.set(row.rowId, row);
  }

  const invalidRelations = new Set<string>();
  const acceptedRelations = new Map<string, ImportRowRelation>();
  const shapeChangingRelations = new Set<string>();
  for (const row of rows) {
    if (!row.relation) continue;
    const target = rowsById.get(row.relation.rowId);
    if (!target || target.rowId === row.rowId) {
      invalidRelations.add(row.rowId);
      continue;
    }
    if (!relationSupportedByFacts(row, target)) continue;
    acceptedRelations.set(row.rowId, row.relation);
    shapeChangingRelations.add(row.rowId);
    shapeChangingRelations.add(target.rowId);
  }

  const budgetCurrencySupported = isSupportedCurrency(budgetCurrency);
  const proposals = rows.map((row) => {
    const mapping = mappingFor(row.semanticKind, row.direction);
    const relation = acceptedRelations.get(row.rowId) ?? null;

    if (row.rowRole !== "financial_event") {
      return proposalFrom(row, { disposition: "supporting", type: null, relation, reviewReasons: [], selected: false });
    }
    if (row.postingStatus === "pending" || row.postingStatus === "declined") {
      return proposalFrom(row, {
        disposition: row.postingStatus,
        type: mapping.type,
        isRefund: mapping.isRefund,
        relation,
        reviewReasons: ["pending_or_declined"],
        selected: false,
      });
    }

    let disposition: ImportProposal["disposition"] = "candidate";
    let type = mapping.type;
    let reasons = addReasons([], ...mapping.reviewReasons);

    const validFacts =
      isCalendarDate(row.date) && hasPositiveMinorAmount(row.amount) && row.currency !== null && isSupportedCurrency(row.currency) && budgetCurrencySupported;
    if (!validFacts) {
      disposition = "unresolved";
      reasons = addReasons(
        reasons,
        row.currency === null || !isSupportedCurrency(row.currency) || !budgetCurrencySupported ? "unsupported_currency" : "missing_fact",
      );
    }
    if (invalidRelations.has(row.rowId)) {
      disposition = "unresolved";
      type = null;
      reasons = addReasons(reasons, "invalid_relation");
    }
    if (shapeChangingRelations.has(row.rowId)) {
      reasons = addReasons(reasons, "relation_changes_ledger_shape");
    }
    if (validFacts && mapping.type === null) {
      disposition = "unresolved";
      reasons = addReasons(reasons, "unknown_kind");
    }
    if (mapping.expectedDirection && row.direction !== mapping.expectedDirection) {
      reasons = addReasons(reasons, "inconsistent_direction");
    }

    if (row.postingStatus === "unknown") reasons = addReasons(reasons, "unknown_posting_status");

    return proposalFrom(row, { disposition, type, isRefund: mapping.isRefund, relation, reviewReasons: reasons, selected: true });
  });

  return { rows, proposals };
}

/** Applies current-ledger evidence without mutating model facts or creating transaction destinations. */
export function reconcileImportProposals(input: {
  proposals: ImportProposal[];
  transactions: Transaction[];
  accounts: Account[];
  envelopes: Envelope[];
  categories: Category[];
  selectedAccountId: string;
}): ReconciledImportProposal[] {
  const sourceAccount = input.accounts.find((account) => account.id === input.selectedAccountId);
  const sourceAccountInvalid = !sourceAccount || sourceAccount.archived;
  const envelopeIds = new Set(input.envelopes.filter((envelope) => !envelope.archived).map((envelope) => envelope.id));
  const categoryIds = new Set(input.categories.map((category) => category.id));
  const duplicates = buildImportDupIndex(
    input.transactions
      .filter((transaction) => transaction.accountId === input.selectedAccountId)
      .map(({ date, amount, sourceRef }) => ({ date, amount, sourceRef })),
  );

  return input.proposals.map((proposal) => {
    const envelopeId = proposal.envelopeId && envelopeIds.has(proposal.envelopeId) ? proposal.envelopeId : null;
    const categoryId = proposal.categoryId && categoryIds.has(proposal.categoryId) ? proposal.categoryId : null;
    let disposition = proposal.disposition;
    let selected = proposal.selected;
    let reviewReasons = proposal.reviewReasons;
    let duplicateStatus: ImportDupStatus = "new";

    if (isCalendarDate(proposal.date) && hasPositiveMinorAmount(proposal.amount)) {
      duplicateStatus = classifyImportDup({ date: proposal.date, amount: proposal.amount, rawPlace: proposal.rawPlace }, duplicates);
      if (duplicateStatus === "exists") {
        if (proposal.disposition === "candidate") {
          disposition = "declined";
          selected = false;
        }
        reviewReasons = addReasons(reviewReasons, "history_conflict");
      } else if (duplicateStatus === "probable") {
        reviewReasons = addReasons(reviewReasons, "multiple_history_candidates");
      } else if (proposal.disposition === "candidate") {
        duplicates.markSeen({ date: proposal.date, amount: proposal.amount, rawPlace: proposal.rawPlace });
      }
    }
    if (sourceAccountInvalid) {
      disposition = "unresolved";
      selected = false;
    }

    return { ...proposal, envelopeId, categoryId, disposition, selected, reviewReasons, duplicateStatus, sourceAccountInvalid };
  });
}
