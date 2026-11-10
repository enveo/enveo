import { isSupportedCurrency } from "./currency";
import { isCalendarDate } from "./dates";
import { printedAmountIn } from "./importAmounts";
import { settleImportDuplicates } from "./importChunks";
import { buildImportDupIndex, classifyImportDup, existingImportRowsForAccount, type ImportDupStatus, importCandidateDirection } from "./importDedupe";
import type { ImportReceipt } from "./importReceipt";
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
  "possible_duplicate",
  "inferred_date",
  "suspicious_text",
  "fx_converted",
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

  suspiciousText?: boolean;
  /** The date was filled in deterministically from overlapping screenshots, not read from the row. */
  dateInferred?: boolean;
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

/** Cross-chunk pairs the seam pass could not settle (model call failed or the pair was beyond
 *  the judged window). Carried in the checkpoint so re-validation keeps flagging them. */
export interface ImportSeamOutcome {
  unresolved: Array<{ earlierRowId: string; laterRowId: string }>;
}

export interface ImportRecognitionResult {
  receipt?: ImportReceipt;
  rows: ImportExtractRow[];
  proposals: ImportProposal[];
  seam?: ImportSeamOutcome;
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

  factCorrectionAttempt?: boolean;
}

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

export function needsImportEnrichment(result: ImportRecognitionResult, categories: readonly Category[] = []): boolean {
  return result.proposals.some(
    (proposal) =>
      proposal.reviewReasons.length > 0 ||
      proposal.disposition === "unresolved" ||
      (proposal.disposition === "candidate" &&
        (!proposal.name.trim() ||
          (proposal.type === "expense" &&
            (proposal.envelopeId === null || (proposal.categoryId === null && categories.some((category) => !category.archived)))))),
  );
}

/** Surfaces unsettled seam pairs as review evidence on the later occurrence. Pure and
 *  idempotent, so every re-validation from a checkpoint reaches the same proposals. */
export function applyImportSeamReviewReasons(result: ImportRecognitionResult): ImportRecognitionResult {
  const unresolved = result.seam?.unresolved ?? [];
  if (unresolved.length === 0) return result;
  const rowIds = new Set(result.rows.map((row) => row.rowId));
  const flagged = new Set(unresolved.filter((pair) => rowIds.has(pair.earlierRowId) && rowIds.has(pair.laterRowId)).map((pair) => pair.laterRowId));
  if (flagged.size === 0) return result;
  return {
    ...result,
    proposals: result.proposals.map((proposal) =>
      flagged.has(proposal.rowId) ? { ...proposal, reviewReasons: addReasons(proposal.reviewReasons, "possible_duplicate"), selected: false } : proposal,
    ),
  };
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

const hasPositiveMinorAmount = (amount: number | null): amount is number => amount !== null && Number.isInteger(amount) && amount > 0;

const samePostingFacts = (left: ImportExtractRow, right: ImportExtractRow): boolean =>
  left.date === right.date && left.amount === right.amount && left.currency === right.currency && left.direction === right.direction;

const hasComparablePostingFacts = (row: ImportExtractRow): boolean =>
  isCalendarDate(row.date) && hasPositiveMinorAmount(row.amount) && row.currency !== null && row.direction !== "unknown";

const isTransferKind = (kind: ImportSemanticKind): boolean =>
  kind === "incoming_transfer" || kind === "outgoing_transfer" || kind === "account_topup" || kind === "internal_transfer";

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
      return (
        isCalendarDate(row.date) &&
        row.date === target.date &&
        hasPositiveMinorAmount(row.amount) &&
        row.amount === target.amount &&
        row.currency !== null &&
        row.currency === target.currency &&
        (row.direction === "unknown" || target.direction === "unknown" || row.direction === target.direction)
      );
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
      // On a statement an exchange is its own settlement entry (the foreign purchase it paid
      // for never appears separately): money out is an expense, money in is income.
      return {
        type: direction === "debit" ? "expense" : direction === "credit" ? "income" : null,
        isRefund: false,
        expectedDirection: null,
        reviewReasons: [],
      };
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
  const duplicates = settleImportDuplicates(rows);
  const possibleDuplicates = new Set(duplicates.possible.map((pair) => pair.laterRowId));
  for (const [rowId, targetRowId] of duplicates.links) {
    if (rowsById.get(rowId)!.relation) continue;
    acceptedRelations.set(rowId, { kind: "duplicate_of", rowId: targetRowId });
    shapeChangingRelations.add(rowId);
  }
  for (const row of rows) {
    if (!row.relation) continue;
    const target = rowsById.get(row.relation.rowId);
    if (!target || target.rowId === row.rowId) {
      invalidRelations.add(row.rowId);
      continue;
    }
    if (row.relation.kind === "duplicate_of" && duplicates.links.get(row.rowId) !== target.rowId) continue;
    if (!relationSupportedByFacts(row, target)) continue;
    acceptedRelations.set(row.rowId, row.relation);
    shapeChangingRelations.add(row.rowId);

    if (row.relation.kind !== "duplicate_of") shapeChangingRelations.add(target.rowId);
  }

  const budgetCurrencySupported = isSupportedCurrency(budgetCurrency);
  const foreign = foreignAmountsInBudgetCurrency(rows, rowsById, budgetCurrency);
  const proposals = rows.map((row) => {
    const mapping = mappingFor(row.semanticKind, row.direction);
    const relation = acceptedRelations.get(row.rowId) ?? null;

    if (row.rowRole !== "financial_event" || foreign.exchangeLines.has(row.rowId)) {
      return proposalFrom(row, { disposition: "supporting", type: null, relation, reviewReasons: [], selected: false });
    }
    // A pending entry has already left the account: the bank shows it and the money is spent, so
    // it is an ordinary transaction dated when it happened (that is how the ledger sees it too).
    // Only a declined or cancelled entry never moves money.
    if (row.postingStatus === "declined") {
      return proposalFrom(row, {
        disposition: "declined",
        type: mapping.type,
        isRefund: mapping.isRefund,
        relation,
        reviewReasons: ["pending_or_declined"],
        selected: false,
      });
    }
    const converted = foreign.converted.get(row.rowId);

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
    if (mapping.expectedDirection && row.direction !== "unknown" && row.direction !== mapping.expectedDirection) {
      reasons = addReasons(reasons, "inconsistent_direction");
    }
    if (converted !== undefined) reasons = addReasons(reasons, "fx_converted");

    if (row.postingStatus === "unknown") reasons = addReasons(reasons, "unknown_posting_status");
    if (row.dateInferred) reasons = addReasons(reasons, "inferred_date");
    // Suspicious content never blocks a row (the facts may still be right) but it is never
    // pre-selected: whatever the text asked for, the human decides with the flag in view.
    if (row.suspiciousText) reasons = addReasons(reasons, "suspicious_text");
    if (possibleDuplicates.has(row.rowId)) reasons = addReasons(reasons, "possible_duplicate");

    return proposalFrom(row, {
      disposition,
      type,
      isRefund: mapping.isRefund,
      relation,
      reviewReasons: reasons,
      selected: !row.suspiciousText && !reasons.includes("inconsistent_direction") && !reasons.includes("possible_duplicate"),
      ...(converted !== undefined ? { amount: converted, currency: budgetCurrency } : {}),
    });
  });

  return { rows, proposals };
}

interface ForeignAmounts {
  /** Foreign-currency event → its printed account-currency figure. */
  converted: Map<string, number>;
  /** Exchange entries whose figure was taken: evidence only, never booked a second time. */
  exchangeLines: Set<string>;
}

/**
 * A foreign-currency payment takes the account-currency figure PRINTED for it, never a computed
 * rate. The figure is tied to the payment by the exact foreign amount, not by a layout or by the
 * model's labels, so it works for any bank or wallet:
 *  1. a linked exchange line (`fx_for` in either direction, as the model reported it);
 *  2. an adjacent entry (same screenshot, nothing but supporting text between them) that prints
 *     the payment's foreign amount AND one account-currency figure — a wallet that books the
 *     exchange as its own entry next to the purchase. That entry becomes evidence; one read as a
 *     payment of its own (any kind but an exchange or unknown) never does;
 *  3. the payment's own lines, when they print one account-currency figure next to its amount.
 * Anything ambiguous (two candidates, two figures, a candidate claimed by two payments) leaves
 * the amount as read, with the currency warning, for the human.
 */
function foreignAmountsInBudgetCurrency(
  rows: ReadonlyArray<ImportExtractRow>,
  rowsById: ReadonlyMap<string, ImportExtractRow>,
  budgetCurrency: string,
): ForeignAmounts {
  const converted = new Map<string, number>();
  const exchangeLines = new Set<string>();
  const isForeignEvent = (row: ImportExtractRow | undefined): row is ImportExtractRow =>
    row !== undefined && row.rowRole === "financial_event" && row.currency !== null && row.currency !== budgetCurrency && hasPositiveMinorAmount(row.amount);
  const isFx = (row: ImportExtractRow | undefined): row is ImportExtractRow =>
    row !== undefined && row.rowRole === "supporting_detail" && row.semanticKind === "fx_conversion";
  for (const row of rows) {
    if (row.relation?.kind !== "fx_for") continue;
    const target = rowsById.get(row.relation.rowId);
    const [fx, event] = isFx(row) ? [row, target] : isFx(target) ? [target, row] : [undefined, undefined];
    if (!fx || !isForeignEvent(event)) continue;
    const figure = printedAmountIn(fx.rawTextLines, budgetCurrency);
    if (figure !== null && figure > 0) converted.set(event.rowId, figure);
  }

  const byImage = new Map<number, ImportExtractRow[]>();
  for (const row of rows) byImage.set(row.imageIndex, [...(byImage.get(row.imageIndex) ?? []), row]);
  for (const imageRows of byImage.values()) imageRows.sort((left, right) => left.visualOrder - right.visualOrder);
  // The rows between a payment and the next entry on each side: supporting text belongs to the
  // nearest entry, and a divider or other interface text ends the search.
  const adjacent = (row: ImportExtractRow): ImportExtractRow[] => {
    const imageRows = byImage.get(row.imageIndex)!;
    const at = imageRows.indexOf(row);
    const found: ImportExtractRow[] = [];
    for (const step of [-1, 1]) {
      for (let index = at + step; index >= 0 && index < imageRows.length; index += step) {
        const other = imageRows[index]!;
        if (other.rowRole === "ui_metadata") break;
        found.push(other);
        if (other.rowRole === "financial_event") break;
      }
    }
    return found;
  };
  const printsPair = (row: ImportExtractRow, event: ImportExtractRow): number | null =>
    printedAmountIn(row.rawTextLines, event.currency!) === event.amount ? printedAmountIn(row.rawTextLines, budgetCurrency) : null;
  // A neighbour read as a payment of its own (a bank entry printing both of ITS amounts) is never
  // another payment's exchange line, even when the two foreign amounts happen to be equal.
  const mayBeExchange = (row: ImportExtractRow): boolean =>
    row.rowRole !== "financial_event" || row.semanticKind === "fx_conversion" || row.semanticKind === "unknown";

  const pairs = new Map<string, { exchange: string; figure: number }>();
  const claims = new Map<string, number>();
  for (const event of rows) {
    if (!isForeignEvent(event) || converted.has(event.rowId)) continue;
    if (printedAmountIn(event.rawTextLines, budgetCurrency) !== null) continue;
    const matches = adjacent(event).flatMap((other) => {
      const figure = mayBeExchange(other) ? printsPair(other, event) : null;
      return figure === null ? [] : [{ exchange: other.rowId, figure }];
    });
    if (matches.length !== 1) continue;
    pairs.set(event.rowId, matches[0]!);
    claims.set(matches[0]!.exchange, (claims.get(matches[0]!.exchange) ?? 0) + 1);
  }
  for (const [eventId, pair] of pairs) {
    if (claims.get(pair.exchange) !== 1) continue;
    converted.set(eventId, pair.figure);
    exchangeLines.add(pair.exchange);
  }

  for (const event of rows) {
    if (!isForeignEvent(event) || converted.has(event.rowId) || exchangeLines.has(event.rowId)) continue;
    const figure = printsPair(event, event);
    if (figure !== null) converted.set(event.rowId, figure);
  }
  return { converted, exchangeLines };
}

/** Only an entry that could become a transaction stands for a recorded one. Evidence rows and
 *  entries the bank itself declined never take a ledger row away from a real entry. */
const claimsLedgerRow = (proposal: ImportProposal): boolean =>
  proposal.disposition !== "supporting" && !(proposal.disposition === "declined" && proposal.reviewReasons.includes("pending_or_declined"));

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
  const duplicates = buildImportDupIndex(existingImportRowsForAccount(input.transactions, input.selectedAccountId));

  return input.proposals.map((proposal) => {
    // Income destinations come from account settings, never model/history annotations.
    const envelopeId = proposal.type !== "income" && proposal.envelopeId && envelopeIds.has(proposal.envelopeId) ? proposal.envelopeId : null;
    const categoryId = proposal.categoryId && categoryIds.has(proposal.categoryId) ? proposal.categoryId : null;
    let disposition = proposal.disposition;
    let selected = proposal.selected;
    const reviewReasons = proposal.reviewReasons;
    let duplicateStatus: ImportDupStatus = "new";

    if (proposal.relation?.kind === "duplicate_of" && proposal.disposition === "candidate") {
      // A repeat of another captured row (validated against its facts) is that row, not a new one.
      duplicateStatus = "exists";
      disposition = "declined";
      selected = false;
    } else if (claimsLedgerRow(proposal) && isCalendarDate(proposal.date) && hasPositiveMinorAmount(proposal.amount)) {
      duplicateStatus = classifyImportDup(
        {
          date: proposal.date,
          amount: proposal.amount,
          rawPlace: proposal.rawPlace,
          direction: proposal.type
            ? importCandidateDirection(
                { type: proposal.type, isRefund: proposal.isRefund, accountId: input.selectedAccountId, toAccountId: proposal.toAccountId },
                input.selectedAccountId,
              )
            : undefined,
        },
        duplicates,
      );
      if (duplicateStatus === "exists") {
        if (proposal.disposition === "candidate") {
          disposition = "declined";
          selected = false;
        }
      } else if (duplicateStatus === "probable") {
        selected = false;
      }
    }
    if (sourceAccountInvalid) {
      disposition = "unresolved";
      selected = false;
    }

    return { ...proposal, envelopeId, categoryId, disposition, selected, reviewReasons, duplicateStatus, sourceAccountInvalid };
  });
}
