import { type ImportReviewReason, importReviewRequiresExplicitOptIn } from "../../packages/shared/src/importRecognition";

export type ImportRecognitionDirection = "debit" | "credit" | "unknown";
export type ImportRecognitionRowRole = "financial_event" | "supporting_detail" | "ui_metadata";
export type ImportRecognitionPostingStatus = "posted" | "pending" | "declined" | "unknown";
export type ImportRecognitionSafetyClass = "safe_auto" | "unsafe_auto" | "review_only" | "non_ledger";

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
}

export interface ExpectedImportRecognitionRow {
  id: string;
  rowRole: ImportRecognitionRowRole;
  postingStatus: ImportRecognitionPostingStatus;
  safetyClass: ImportRecognitionSafetyClass;
  requiredSafetyReasons: string[];
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
}

export interface ActualImportRecognitionRow {
  id: string;
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
  relationPrecision: ImportRecognitionRatio;
  /** Expected relations are the denominator, so omitting every relation scores zero. */
  relationRecall: ImportRecognitionRatio;
  /** Null only when neither truth nor output contains a relation. */
  relationF1: number | null;
  harmfulSelected: number;
  /** Release-relevant reviews only; pending/declined/supporting/UI/unexpected rows are separate. */
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
  left.categoryId === right.categoryId;

const isHarmfulSelection = (truth: ExpectedImportRecognitionRow | undefined, actual: ActualImportRecognitionRow): boolean => {
  const proposal = actual.proposal;
  if (!proposal?.selected) return false;
  if (truth?.safetyClass !== "safe_auto" || !truth.expectedProposal) return true;
  return !sameProposal(truth.expectedProposal, proposal);
};

type ReviewBucket = Exclude<keyof ImportRecognitionReviewBreakdown, "total"> | null;

const reviewBucket = (truth: ExpectedImportRecognitionRow | undefined, actual: ActualImportRecognitionRow): ReviewBucket => {
  if (!actual.proposal || actual.proposal.selected) return null;
  if (!truth) return "unexpected";
  if (truth.postingStatus === "pending" || truth.postingStatus === "declined") return "pendingOrDeclined";
  if (truth.rowRole !== "financial_event") return "supportingOrUi";
  return truth.safetyClass === "unsafe_auto" ? "unsafe" : "otherFinancial";
};

const hasRequiredSafetyReview = (truth: ExpectedImportRecognitionRow, actual: ActualImportRecognitionRow | undefined): boolean =>
  truth.safetyClass === "unsafe_auto" &&
  importReviewRequiresExplicitOptIn({ reviewReasons: truth.requiredSafetyReasons as ImportReviewReason[] }) &&
  actual?.proposal !== null &&
  actual?.proposal !== undefined &&
  !actual.proposal.selected &&
  truth.requiredSafetyReasons.every((reason) => actual.proposal!.reviewReasons.includes(reason));

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
  let harmfulSelected = 0;
  let missingProposals = 0;

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
    if (isHarmfulSelection(truth, row)) harmfulSelected++;
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
    relationPrecision: ratio(correctRelations, actualRelations.length),
    relationRecall: ratio(
      expectedRelations.filter((row) => sameRelation(actualById.get(row.id)?.relation ?? null, row.relation)).length,
      expectedRelations.length,
    ),
    relationF1: actualRelations.length + expectedRelations.length === 0 ? null : (2 * correctRelations) / (actualRelations.length + expectedRelations.length),
    harmfulSelected,
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

  for (const truth of expected) {
    const baselineRow = baselineById.get(truth.id);
    const candidateRow = candidateById.get(truth.id);
    const candidateRows = candidateActual.filter((row) => row.id === truth.id);
    const candidateHasRequiredSafetyReview = candidateRows.length === 1 && hasRequiredSafetyReview(truth, candidateRow);
    const baselineReleaseReview = baselineRow ? ["unsafe", "otherFinancial"].includes(reviewBucket(truth, baselineRow) ?? "") : false;
    const candidateReleaseReview = candidateRow ? ["unsafe", "otherFinancial"].includes(reviewBucket(truth, candidateRow) ?? "") : false;
    const attributable =
      truth.safetyClass === "unsafe_auto" && baselineRow !== undefined && isHarmfulSelection(truth, baselineRow) && candidateHasRequiredSafetyReview;
    if (attributable) attributableSafety++;
    if (candidateReleaseReview && !baselineReleaseReview && !attributable) unexplainedNewReviews++;
    if (truth.safetyClass === "unsafe_auto" && !candidateHasRequiredSafetyReview) unsafeConstraintFailures++;
  }

  const reasons: string[] = [];
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
  if (baseline.harmfulSelected === 0) {
    if (candidate.harmfulSelected !== 0) reasons.push("harmful_selected_regression_from_zero");
  } else if (candidate.harmfulSelected >= baseline.harmfulSelected) {
    reasons.push("harmful_selected_not_strictly_lower");
  }
  if (unsafeConstraintFailures > 0) reasons.push("unsafe_row_constraint_failed");
  if (unexplainedNewReviews > 0) reasons.push("unexplained_review_transition");

  return {
    passed: reasons.length === 0,
    reasons,
    baseline,
    candidate,
    transitions: { attributableSafety, unexplainedNewReviews, unsafeConstraintFailures },
  };
}
