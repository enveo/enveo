export type ImportRecognitionDirection = "debit" | "credit" | "unknown";

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
  /** Whether an incorrect ledger proposal for this row can change the user's budget. */
  material: boolean;
  date: string | null;
  amount: number | null;
  currency: string | null;
  direction: ImportRecognitionDirection;
  semanticKind: string;
  relation: ImportRecognitionRelation | null;
  /** Null means that this visible row must not be selected for the ledger automatically. */
  expectedProposal: ImportRecognitionProposalTruth | null;
}

export interface ActualImportRecognitionProposal extends ImportRecognitionProposalTruth {
  selected: boolean;
  disposition: "candidate" | "supporting" | "pending" | "declined" | "unresolved";
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

export interface ImportRecognitionMetrics {
  rowRecall: ImportRecognitionRatio;
  materialRowRecall: ImportRecognitionRatio;
  factAccuracy: {
    amount: ImportRecognitionRatio;
    date: ImportRecognitionRatio;
    currency: ImportRecognitionRatio;
    direction: ImportRecognitionRatio;
    overall: ImportRecognitionRatio;
  };
  semanticKindAccuracy: ImportRecognitionRatio;
  relationPrecision: ImportRecognitionRatio;
  harmfulSelected: number;
  reviewRequired: number;
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

/** Scores already-aligned, fixture-local rows. Missing rows remain in recall and accuracy denominators. */
export function scoreImportRecognition(
  expected: readonly ExpectedImportRecognitionRow[],
  actual: readonly ActualImportRecognitionRow[],
): ImportRecognitionMetrics {
  const actualById = new Map(actual.map((row) => [row.id, row]));
  const expectedById = new Map(expected.map((row) => [row.id, row]));
  const material = expected.filter((row) => row.material);
  const matched = expected.filter((row) => actualById.has(row.id)).length;
  const matchedMaterial = material.filter((row) => actualById.has(row.id)).length;

  const factCorrect = {
    amount: material.filter((row) => actualById.get(row.id)?.amount === row.amount).length,
    date: material.filter((row) => actualById.get(row.id)?.date === row.date).length,
    currency: material.filter((row) => actualById.get(row.id)?.currency === row.currency).length,
    direction: material.filter((row) => actualById.get(row.id)?.direction === row.direction).length,
  };
  const factTotal = material.length;
  const overallCorrect = factCorrect.amount + factCorrect.date + factCorrect.currency + factCorrect.direction;

  const actualRelations = actual.filter((row) => row.relation !== null);
  const correctRelations = actualRelations.filter((row) => sameRelation(row.relation, expectedById.get(row.id)?.relation ?? null)).length;

  let harmfulSelected = 0;
  let reviewRequired = 0;
  for (const row of actual) {
    const proposal = row.proposal;
    if (!proposal) continue;
    if (!proposal.selected) {
      reviewRequired++;
      continue;
    }
    const truth = expectedById.get(row.id);
    if ((!truth || truth.material) && (!truth?.expectedProposal || !sameProposal(truth.expectedProposal, proposal))) harmfulSelected++;
  }

  return {
    rowRecall: ratio(matched, expected.length),
    materialRowRecall: ratio(matchedMaterial, material.length),
    factAccuracy: {
      amount: ratio(factCorrect.amount, factTotal),
      date: ratio(factCorrect.date, factTotal),
      currency: ratio(factCorrect.currency, factTotal),
      direction: ratio(factCorrect.direction, factTotal),
      overall: ratio(overallCorrect, factTotal * 4),
    },
    semanticKindAccuracy: ratio(material.filter((row) => actualById.get(row.id)?.semanticKind === row.semanticKind).length, material.length),
    relationPrecision: ratio(correctRelations, actualRelations.length),
    harmfulSelected,
    reviewRequired,
  };
}
