import { isSupportedCurrency } from "../../packages/shared/src/currency";
import { type ImportReviewReason, importProposalBlockingReasons } from "../../packages/shared/src/importRecognition";

export type ImportRecognitionDirection = "debit" | "credit" | "unknown";
export type ImportRecognitionRowRole = "financial_event" | "supporting_detail" | "ui_metadata";
export type ImportRecognitionPostingStatus = "posted" | "pending" | "declined" | "unknown";
export type ImportRecognitionSafetyClass = "safe_auto" | "unsafe_auto" | "review_only" | "non_ledger";
export type ImportRecognitionDuplicateStatus = "new" | "probable" | "exists";

export interface ImportRecognitionRelation {
  kind: string;
  rowId: string;
}

export interface ImportRecognitionProposalTruth {
  type: "expense" | "income" | "transfer" | null;
  isRefund: boolean;
  toAccountId: string | null;
  envelopeId: string | null;
  categoryId: string | null;
  /** Omitted expectations preserve compatibility with existing private corpora. */
  name?: string;
  placeName?: string | null;
}

export interface ExpectedImportRecognitionRow {
  id: string;
  rowRole: ImportRecognitionRowRole;
  postingStatus: ImportRecognitionPostingStatus;
  safetyClass: ImportRecognitionSafetyClass;
  requiredSafetyReasons: string[];
  expectedDuplicateStatus: ImportRecognitionDuplicateStatus;
  date: string | null;
  amount: number | null;
  currency: string | null;
  direction: ImportRecognitionDirection;
  semanticKind: string;
  relation: ImportRecognitionRelation | null;
  expectedProposal: ImportRecognitionProposalTruth | null;
}

export interface ActualImportRecognitionProposal extends ImportRecognitionProposalTruth {
  selected: boolean;
  disposition: "candidate" | "supporting" | "pending" | "declined" | "unresolved";
  reviewReasons: string[];
  duplicateStatus: ImportRecognitionDuplicateStatus;
}

export interface ActualImportRecognitionRow {
  id: string;
  rowRole?: ImportRecognitionRowRole;
  postingStatus?: ImportRecognitionPostingStatus;
  date: string | null;
  amount: number | null;
  currency: string | null;
  direction: ImportRecognitionDirection;
  semanticKind: string;
  relation: ImportRecognitionRelation | null;
  proposal: ActualImportRecognitionProposal | null;
}

export interface ImportRecognitionRatio {
  correct: number;
  total: number;
  /** Null is deliberate: a zero denominator is unknown, never a perfect score. */
  rate: number | null;
}

export interface ImportRecognitionReviewBreakdown {
  unsafe: number;
  otherFinancial: number;
  /** Legacy output key; pending rows now count as ordinary financial reviews. */
  pendingOrDeclined: number;
  supportingOrUi: number;
  unexpected: number;
  total: number;
}

export interface ImportRecognitionUnexpectedRows {
  total: number;
  selected: number;
  unselected: number;
  withoutProposal: number;
}

export interface ImportRecognitionMetrics {
  rowRecall: ImportRecognitionRatio;
  financialRowRecall: ImportRecognitionRatio;
  factAccuracy: {
    amount: ImportRecognitionRatio;
    date: ImportRecognitionRatio;
    currency: ImportRecognitionRatio;
    direction: ImportRecognitionRatio;
    overall: ImportRecognitionRatio;
  };
  semanticKindAccuracy: ImportRecognitionRatio;
  postingStatusAccuracy: ImportRecognitionRatio;
  duplicateStatusAccuracy: ImportRecognitionRatio;
  relationPrecision: ImportRecognitionRatio;
  /** Expected relations are the denominator, so omitting every relation scores zero. */
  relationRecall: ImportRecognitionRatio;
  /** Null only when neither truth nor output contains a relation. */
  relationF1: number | null;
  inclusion: {
    missingFinancial: number;
    nonLedgerIncluded: number;
    exactDuplicateSelected: number;
  };
  interpretationErrors: number;
  reviewCoverage: ImportRecognitionRatio;
  unexpectedReviewReasons: number;
  /** Aggregate-only diagnostic; reason names contain no screenshot or model content. */
  unexpectedReviewReasonCounts: Record<string, number>;
  /** Release-relevant reviews only; declined/supporting/UI/unexpected rows are separate. */
  reviewRequired: number;
  reviewBreakdown: ImportRecognitionReviewBreakdown;
  missingRows: number;
  missingProposals: number;
  unexpectedRows: ImportRecognitionUnexpectedRows;
}

export interface ImportRecognitionGateDecision {
  passed: boolean;
  reasons: string[];
  baseline: ImportRecognitionMetrics;
  candidate: ImportRecognitionMetrics;
  transitions: {
    attributableSafety: number;
    unexplainedNewReviews: number;
    unsafeConstraintFailures: number;
  };
}

const ratio = (correct: number, total: number): ImportRecognitionRatio => ({ correct, total, rate: total === 0 ? null : correct / total });

const sameRelation = (left: ImportRecognitionRelation | null, right: ImportRecognitionRelation | null): boolean =>
  left?.kind === right?.kind && left?.rowId === right?.rowId;

const sameProposal = (left: ImportRecognitionProposalTruth, right: ImportRecognitionProposalTruth): boolean =>
  left.type === right.type &&
  left.isRefund === right.isRefund &&
  left.toAccountId === right.toAccountId &&
  left.envelopeId === right.envelopeId &&
  left.categoryId === right.categoryId &&
  (left.name === undefined || left.name === right.name) &&
  (left.placeName === undefined || left.placeName === right.placeName);

type ReviewBucket = Exclude<keyof ImportRecognitionReviewBreakdown, "total"> | null;

const reviewBucket = (truth: ExpectedImportRecognitionRow | undefined, actual: ActualImportRecognitionRow): ReviewBucket => {
  if (!actual.proposal || actual.proposal.selected || actual.proposal.duplicateStatus === "exists") return null;
  if (!truth) return "unexpected";
  if (truth.postingStatus === "declined") return "pendingOrDeclined";
  if (truth.rowRole !== "financial_event") return "supportingOrUi";
  return truth.safetyClass === "unsafe_auto" ? "unsafe" : "otherFinancial";
};

const requiredReviewReasons = (truth: ExpectedImportRecognitionRow): string[] => {
  if (truth.rowRole !== "financial_event") return [];
  if (truth.postingStatus === "declined") return ["pending_or_declined"];
  const required = new Set(truth.requiredSafetyReasons);
  if (truth.date === null || truth.amount === null) required.add("missing_fact");
  if (truth.currency === null) required.add("unsupported_currency");
  if (truth.semanticKind === "incoming_transfer" || truth.semanticKind === "account_topup") required.add("possible_transfer");
  if (truth.semanticKind === "internal_transfer") required.add("unknown_transfer_endpoint");
  if (truth.semanticKind === "unknown" || truth.semanticKind === "fx_conversion") required.add("unknown_kind");
  if (truth.postingStatus === "unknown") required.add("unknown_posting_status");
  return [...required];
};

const hasRequiredSafetyReview = (truth: ExpectedImportRecognitionRow, actual: ActualImportRecognitionRow | undefined): boolean =>
  requiredReviewReasons(truth).length > 0 &&
  actual?.proposal !== null &&
  actual?.proposal !== undefined &&
  requiredReviewReasons(truth).every((reason) => actual.proposal!.reviewReasons.includes(reason));

const truthShouldBeIncluded = (truth: ExpectedImportRecognitionRow): boolean =>
  truth.rowRole === "financial_event" && truth.postingStatus !== "declined" && truth.expectedDuplicateStatus !== "exists";

const duplicateStatusMatches = (truth: ImportRecognitionDuplicateStatus, actual: ImportRecognitionDuplicateStatus | undefined): boolean => actual === truth;

const semanticDirection = (kind: string): ImportRecognitionDirection | null => {
  if (["card_purchase", "cash_withdrawal", "fee", "outgoing_transfer"].includes(kind)) return "debit";
  if (["interest", "salary", "cashback_or_reward", "incoming_transfer", "account_topup", "cash_deposit", "merchant_refund", "chargeback"].includes(kind)) {
    return "credit";
  }
  return null;
};

const allowedReviewReasons = (truth: ExpectedImportRecognitionRow, actual: ActualImportRecognitionRow, relationTargetIds: ReadonlySet<string>): Set<string> => {
  const allowed = new Set(requiredReviewReasons(truth));
  const role = actual.rowRole ?? truth.rowRole;
  const postingStatus = actual.postingStatus ?? truth.postingStatus;
  if (role === "financial_event") {
    if (postingStatus === "declined") {
      allowed.add("pending_or_declined");
    } else {
      if (actual.date === null || actual.amount === null) allowed.add("missing_fact");
      if (actual.currency === null || !isSupportedCurrency(actual.currency)) allowed.add("unsupported_currency");
      const expectedDirection = semanticDirection(actual.semanticKind);
      if (expectedDirection && actual.direction !== expectedDirection) allowed.add("inconsistent_direction");
      if (actual.semanticKind === "incoming_transfer" || actual.semanticKind === "account_topup") allowed.add("possible_transfer");
      if (actual.semanticKind === "internal_transfer") allowed.add("unknown_transfer_endpoint");
      if (actual.semanticKind === "unknown" || actual.semanticKind === "fx_conversion") allowed.add("unknown_kind");
      if (postingStatus === "unknown") allowed.add("unknown_posting_status");
      if (actual.relation || relationTargetIds.has(actual.id)) allowed.add("relation_changes_ledger_shape");
    }
  }
  if (truth.expectedDuplicateStatus === "exists" || actual.proposal?.duplicateStatus === "exists") allowed.add("history_conflict");
  if (truth.expectedDuplicateStatus === "probable" || actual.proposal?.duplicateStatus === "probable") allowed.add("multiple_history_candidates");
  return allowed;
};

/** Scores fixture-aligned rows. Expected classifications, never model-provided roles, control safety accounting. */
export function scoreImportRecognition(
  expected: readonly ExpectedImportRecognitionRow[],
  actual: readonly ActualImportRecognitionRow[],
): ImportRecognitionMetrics {
  const actualById = new Map<string, ActualImportRecognitionRow>();
  for (const row of actual) {
    if (!actualById.has(row.id)) actualById.set(row.id, row);
  }
  const expectedById = new Map(expected.map((row) => [row.id, row]));
  const financial = expected.filter((row) => row.rowRole === "financial_event");
  const matched = expected.filter((row) => actualById.has(row.id)).length;
  const matchedFinancial = financial.filter((row) => actualById.has(row.id)).length;

  const factCorrect = {
    amount: financial.filter((row) => actualById.get(row.id)?.amount === row.amount).length,
    date: financial.filter((row) => actualById.get(row.id)?.date === row.date).length,
    currency: financial.filter((row) => actualById.get(row.id)?.currency === row.currency).length,
    direction: financial.filter((row) => actualById.get(row.id)?.direction === row.direction).length,
  };
  const factTotal = financial.length;
  const overallCorrect = factCorrect.amount + factCorrect.date + factCorrect.currency + factCorrect.direction;

  const actualRelations = actual.filter((row) => row.relation !== null);
  const relationTargetIds = new Set(actualRelations.map((row) => row.relation!.rowId));
  const expectedRelations = expected.filter((row) => row.relation !== null);
  const correctRelations = actualRelations.filter((row) => {
    const truth = actualById.get(row.id) === row ? expectedById.get(row.id) : undefined;
    return sameRelation(row.relation, truth?.relation ?? null);
  }).length;
  const reviewBreakdown: ImportRecognitionReviewBreakdown = {
    unsafe: 0,
    otherFinancial: 0,
    pendingOrDeclined: 0,
    supportingOrUi: 0,
    unexpected: 0,
    total: 0,
  };
  const unexpectedRows: ImportRecognitionUnexpectedRows = { total: 0, selected: 0, unselected: 0, withoutProposal: 0 };
  let missingProposals = 0;
  let missingFinancial = 0;
  let nonLedgerIncluded = 0;
  let exactDuplicateSelected = 0;
  let interpretationErrors = 0;
  let reviewedAsRequired = 0;
  let requiredReviews = 0;
  let unexpectedReviewReasons = 0;
  const unexpectedReviewReasonCounts: Record<string, number> = {};

  for (const truth of expected) {
    const actualRow = actualById.get(truth.id);
    const included = actualRow?.proposal?.selected === true;
    if (truthShouldBeIncluded(truth)) {
      if (!included) missingFinancial++;
    } else if (included) {
      if (truth.rowRole === "financial_event" && truth.expectedDuplicateStatus === "exists") exactDuplicateSelected++;
      else nonLedgerIncluded++;
    }
    const proposalBlocked =
      actualRow?.proposal && importProposalBlockingReasons({ reviewReasons: actualRow.proposal.reviewReasons as ImportReviewReason[] }).length > 0;
    if (truth.expectedProposal && actualRow?.proposal && !proposalBlocked && !sameProposal(truth.expectedProposal, actualRow.proposal)) interpretationErrors++;
    const requiredReasons = requiredReviewReasons(truth);
    if (requiredReasons.length > 0) {
      requiredReviews++;
      if (requiredReasons.every((reason) => actualRow?.proposal?.reviewReasons.includes(reason))) reviewedAsRequired++;
    }
    if (actualRow?.proposal) {
      const allowed = allowedReviewReasons(truth, actualRow, relationTargetIds);
      for (const reason of actualRow.proposal.reviewReasons) {
        if (allowed.has(reason)) continue;
        unexpectedReviewReasons++;
        unexpectedReviewReasonCounts[reason] = (unexpectedReviewReasonCounts[reason] ?? 0) + 1;
      }
    }
  }

  for (const row of actual) {
    const truth = actualById.get(row.id) === row ? expectedById.get(row.id) : undefined;
    if (!truth) {
      unexpectedRows.total++;
      if (!row.proposal) unexpectedRows.withoutProposal++;
      else if (row.proposal.selected) unexpectedRows.selected++;
      else unexpectedRows.unselected++;
    } else if (!row.proposal) {
      missingProposals++;
    }
    const bucket = reviewBucket(truth, row);
    if (bucket) {
      reviewBreakdown[bucket]++;
      reviewBreakdown.total++;
    }
  }

  return {
    rowRecall: ratio(matched, expected.length),
    financialRowRecall: ratio(matchedFinancial, financial.length),
    factAccuracy: {
      amount: ratio(factCorrect.amount, factTotal),
      date: ratio(factCorrect.date, factTotal),
      currency: ratio(factCorrect.currency, factTotal),
      direction: ratio(factCorrect.direction, factTotal),
      overall: ratio(overallCorrect, factTotal * 4),
    },
    semanticKindAccuracy: ratio(expected.filter((row) => actualById.get(row.id)?.semanticKind === row.semanticKind).length, expected.length),
    postingStatusAccuracy: ratio(expected.filter((row) => actualById.get(row.id)?.postingStatus === row.postingStatus).length, expected.length),
    duplicateStatusAccuracy: ratio(
      financial.filter((row) => duplicateStatusMatches(row.expectedDuplicateStatus, actualById.get(row.id)?.proposal?.duplicateStatus)).length,
      financial.length,
    ),
    relationPrecision: ratio(correctRelations, actualRelations.length),
    relationRecall: ratio(
      expectedRelations.filter((row) => sameRelation(actualById.get(row.id)?.relation ?? null, row.relation)).length,
      expectedRelations.length,
    ),
    relationF1: actualRelations.length + expectedRelations.length === 0 ? null : (2 * correctRelations) / (actualRelations.length + expectedRelations.length),
    inclusion: { missingFinancial, nonLedgerIncluded, exactDuplicateSelected },
    interpretationErrors,
    reviewCoverage: ratio(reviewedAsRequired, requiredReviews),
    unexpectedReviewReasons,
    unexpectedReviewReasonCounts,
    reviewRequired: reviewBreakdown.unsafe + reviewBreakdown.otherFinancial,
    reviewBreakdown,
    missingRows: expected.length - matched,
    missingProposals,
    unexpectedRows,
  };
}

/** Paired release decision over one expected corpus. Every reason is aggregate-only and safe to print. */
export function gateImportRecognition(
  expected: readonly ExpectedImportRecognitionRow[],
  baselineActual: readonly ActualImportRecognitionRow[],
  candidateActual: readonly ActualImportRecognitionRow[],
): ImportRecognitionGateDecision {
  const baseline = scoreImportRecognition(expected, baselineActual);
  const candidate = scoreImportRecognition(expected, candidateActual);
  const baselineById = new Map<string, ActualImportRecognitionRow>();
  const candidateById = new Map<string, ActualImportRecognitionRow>();
  for (const row of baselineActual) {
    if (!baselineById.has(row.id)) baselineById.set(row.id, row);
  }
  for (const row of candidateActual) {
    if (!candidateById.has(row.id)) candidateById.set(row.id, row);
  }
  let attributableSafety = 0;
  let unexplainedNewReviews = 0;
  let unsafeConstraintFailures = 0;
  let protectedFieldRegression = false;

  for (const truth of expected) {
    const requiredReasons = requiredReviewReasons(truth);
    const baselineRow = baselineById.get(truth.id);
    const candidateRow = candidateById.get(truth.id);
    // Aggregate gains cannot pay for a newly broken field, even on an already imperfect row.
    for (const field of ["date", "amount", "currency", "direction", "rowRole", "postingStatus", "semanticKind"] as const) {
      if (baselineRow?.[field] === truth[field] && candidateRow?.[field] !== truth[field]) protectedFieldRegression = true;
    }
    if (baselineRow && sameRelation(baselineRow.relation, truth.relation) && (!candidateRow || !sameRelation(candidateRow.relation, truth.relation))) {
      protectedFieldRegression = true;
    }
    if (truth.expectedProposal) {
      for (const field of ["type", "isRefund", "toAccountId", "envelopeId", "categoryId", "name", "placeName"] as const) {
        const expectedValue = truth.expectedProposal[field];
        if (expectedValue !== undefined && baselineRow?.proposal?.[field] === expectedValue && candidateRow?.proposal?.[field] !== expectedValue) {
          protectedFieldRegression = true;
        }
      }
    }

    const candidateRows = candidateActual.filter((row) => row.id === truth.id);
    const candidateHasRequiredSafetyReview = candidateRows.length === 1 && hasRequiredSafetyReview(truth, candidateRow);
    const baselineReleaseReview = baselineRow ? ["unsafe", "otherFinancial"].includes(reviewBucket(truth, baselineRow) ?? "") : false;
    const candidateReleaseReview = candidateRow ? ["unsafe", "otherFinancial"].includes(reviewBucket(truth, candidateRow) ?? "") : false;
    const baselineHasRequiredSafetyReview = hasRequiredSafetyReview(truth, baselineRow);
    const attributable = requiredReasons.length > 0 && !baselineHasRequiredSafetyReview && candidateHasRequiredSafetyReview;
    if (attributable) attributableSafety++;
    if (candidateReleaseReview && !baselineReleaseReview && !attributable) unexplainedNewReviews++;
    if (requiredReasons.length > 0 && !candidateHasRequiredSafetyReview) unsafeConstraintFailures++;
  }

  const reasons: string[] = [];
  if (protectedFieldRegression) reasons.push("protected_field_regression");
  if (candidate.rowRecall.correct < baseline.rowRecall.correct) reasons.push("row_recall_regression");
  if (candidate.financialRowRecall.correct < baseline.financialRowRecall.correct) reasons.push("financial_row_recall_regression");
  for (const fact of ["amount", "date", "currency", "direction"] as const) {
    if (candidate.factAccuracy[fact].correct < baseline.factAccuracy[fact].correct) reasons.push(`${fact}_accuracy_regression`);
  }
  if (candidate.semanticKindAccuracy.correct < baseline.semanticKindAccuracy.correct) reasons.push("semantic_kind_accuracy_regression");
  if (
    baseline.relationPrecision.rate !== null &&
    (candidate.relationPrecision.rate === null || candidate.relationPrecision.rate < baseline.relationPrecision.rate)
  ) {
    reasons.push("relation_precision_regression");
  }
  if (candidate.relationRecall.total > 0) {
    /* The legacy adapter cannot express relations, so a paired tie at zero is not
     * evidence of candidate quality. Relation-bearing truth requires strict
     * improvement over that zero-capability baseline; once the baseline is above
     * zero, the normal paired no-regression rule applies. */
    if (baseline.relationRecall.correct === 0) {
      if (candidate.relationRecall.correct === 0) reasons.push("relation_recall_not_improved_from_zero");
      /* A relation-blind legacy baseline supplies no useful paired denominator.
       * In that case truth-bearing corpora impose conservative absolute floors:
       * no invented relation is allowed, at least half of truth relations must be
       * recovered, and the corresponding F1 must reach two thirds. */
      if (candidate.relationPrecision.rate !== 1) reasons.push("relation_precision_below_absolute_floor");
      if ((candidate.relationRecall.rate ?? 0) < 0.5) reasons.push("relation_recall_below_absolute_floor");
      if ((candidate.relationF1 ?? 0) < 2 / 3) reasons.push("relation_f1_below_absolute_floor");
    } else if (candidate.relationRecall.correct < baseline.relationRecall.correct) {
      reasons.push("relation_recall_regression");
    }
    const baselineRelationF1 = baseline.relationF1 ?? 0;
    const candidateRelationF1 = candidate.relationF1 ?? 0;
    if (baselineRelationF1 === 0) {
      if (candidateRelationF1 === 0) reasons.push("relation_f1_not_improved_from_zero");
    } else if (candidateRelationF1 < baselineRelationF1) {
      reasons.push("relation_f1_regression");
    }
  }
  if (candidate.inclusion.missingFinancial > 0) reasons.push("financial_event_not_selected");
  if (candidate.inclusion.nonLedgerIncluded > 0) reasons.push("non_ledger_selected");
  if (candidate.inclusion.exactDuplicateSelected > 0) reasons.push("exact_duplicate_selected");
  if (candidate.unexpectedRows.selected > 0) reasons.push("unexpected_row_selected");
  if (candidate.postingStatusAccuracy.correct !== candidate.postingStatusAccuracy.total) reasons.push("posting_status_incorrect");
  if (candidate.duplicateStatusAccuracy.total > 0 && candidate.duplicateStatusAccuracy.rate !== 1) reasons.push("duplicate_status_incorrect");
  if (baseline.interpretationErrors === 0) {
    if (candidate.interpretationErrors !== 0) reasons.push("interpretation_error_regression_from_zero");
  } else if (candidate.interpretationErrors >= baseline.interpretationErrors) {
    reasons.push("interpretation_errors_not_strictly_lower");
  }
  if (candidate.reviewCoverage.total > 0 && candidate.reviewCoverage.rate !== 1) reasons.push("review_coverage_incomplete");
  if (candidate.unexpectedReviewReasons > 0) reasons.push("unexpected_review_reason");
  if (unsafeConstraintFailures > 0) reasons.push("required_review_reason_missing");

  return {
    passed: reasons.length === 0,
    reasons,
    baseline,
    candidate,
    transitions: { attributableSafety, unexplainedNewReviews, unsafeConstraintFailures },
  };
}
