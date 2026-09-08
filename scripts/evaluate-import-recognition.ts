import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImportRecognitionChatMeta } from "../packages/shared/src/aiPrompts";
import { AI_VISION_TIMEOUT_MS } from "../packages/shared/src/aiTransport";
import { SUPPORTED_CURRENCIES } from "../packages/shared/src/currency";
import { IMPORT_JOB_MAX_IMAGES } from "../packages/shared/src/importChunks";
import { IMPORT_REVIEW_REASONS } from "../packages/shared/src/importRecognition";
import {
  type ActualImportRecognitionProposal,
  type ActualImportRecognitionRow,
  type ExpectedImportRecognitionRow,
  gateImportRecognition,
  type ImportRecognitionDirection,
  type ImportRecognitionPostingStatus,
  type ImportRecognitionProposalTruth,
  type ImportRecognitionRelation,
  type ImportRecognitionRowRole,
  scoreImportRecognition,
} from "./lib/importRecognitionMetrics";

/**
 * Trust boundary: this evaluator is correctness evidence for reviewed source.
 * Immutable snapshots prevent revision drift, while the metric gate resists
 * output-strategy gaming; neither boundary sandboxes arbitrary hostile code in
 * the evaluated revision. An automated release authority must run this tool and
 * its scorer from a protected trusted ref against the bound candidate snapshot.
 */

export type EvaluationMode = "baseline" | "candidate" | "compare";
export type SourceAdapter = "legacy-transactions" | "recognition-rows";

export interface RecognitionManifestRow extends ExpectedImportRecognitionRow {
  /** Private matching anchor. Used for alignment only and never written to evaluator output. */
  matchText: string;
  candidatePosition: { imageIndex: number; visualOrder: number };
  /** Legacy extraction emitted transactions only, in this financial-row order. */
  baselineIndex: number | null;
}

interface RecognitionManifestFixture {
  id: string;
  images: string[];
  locale: string;
  today: string;
  budgetCurrency: string;
  formFactor: "mobile" | "desktop";
  overlap: boolean;
  context: RecognitionManifestContext;
  rows: RecognitionManifestRow[];
}

interface RecognitionManifestContext {
  accountId: string;
  accounts: Array<Record<string, unknown>>;
  envelopes: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  transactions: Array<Record<string, unknown>>;
  historyRecords: Array<{
    accountId: string;
    currency: string;
    sourceRef: string | null;
    tag: string | null;
    place: string | null;
    name: string | null;
    envelope: string | null;
    category: string | null;
    type: "expense" | "income" | "transfer";
    isRefund: boolean;
    toAccountId: string | null;
  }>;
}

interface RecognitionManifest {
  version: 1;
  fixtures: RecognitionManifestFixture[];
}

interface ChatRequest {
  messages: Array<{ role: "system" | "user"; content: string | Array<Record<string, unknown>> }>;
  responseFormat?: Record<string, unknown>;
  reasoningEffort?: "low" | "medium" | "high";
}

interface RecognitionSourceModule {
  IMPORT_EXTRACT_JSON_SCHEMA: unknown;
  buildImportExtractPrompt: (
    images: string[],
    refs: { envelopes: never[]; categories: never[] },
    today: string,
    locale: string,
    currency: string,
  ) => ChatRequest;
  parseImportExtractResponse: (raw: string, imageCount?: number) => unknown;
  languageName?: (locale: string) => string;
  languageDirectives?: (locale: string) => string;
  runImportRecognitionPipeline?: ImportPipelineModule["runImportRecognitionPipeline"];
}

interface ImportPipelineModule {
  runImportRecognitionPipeline: (input: Record<string, unknown>) => Promise<{
    rows: Array<Record<string, unknown>>;
    proposals: Array<Record<string, unknown>>;
  }>;
}

interface ImportHistoryModule {
  selectImportHistoryCandidates: unknown;
}

interface ImportRecognitionModule {
  validateImportExtraction: unknown;
}

interface BaselineItem {
  date: string;
  amount: number;
  currency: string;
  type: "expense" | "income" | "transfer";
  isRefund: boolean;
  rawPlace?: string;
  tag?: string;
  fxOriginal?: string;
  toAccountId?: string | null;
  envelopeId?: string | null;
  categoryId?: string | null;
}

interface BaselineRouteModule {
  extractImportForBudget: (input: {
    budgetId: string;
    images: string[];
    locale: string;
    chat: (request: ChatRequest, timeoutMs?: number) => Promise<string>;
  }) => Promise<BaselineItem[]>;
}

interface BaselineDbModule {
  db: {
    select: (...args: unknown[]) => unknown;
  };
}

interface BaselineSchemaModule {
  budgets: unknown;
  envelopes: unknown;
  categories: unknown;
  transactions: unknown;
  places: unknown;
}

interface BaselineProductionSeam {
  route: BaselineRouteModule;
  db: BaselineDbModule["db"];
  schema: BaselineSchemaModule;
}

interface CandidateRow {
  rowId: string;
  imageIndex: number;
  visualOrder: number;
  date: string | null;
  amount: number | null;
  currency: string | null;
  direction: ImportRecognitionDirection;
  postingStatus: ImportRecognitionPostingStatus;
  rowRole: ImportRecognitionRowRole;
  semanticKind: string;
  relation: ImportRecognitionRelation | null;
  rawTextLines?: string[];
  reviewReasons: string[];
}

interface CandidateProposal extends ActualImportRecognitionProposal {
  rowId: string;
  semanticKind?: string;
  relation?: ImportRecognitionRelation | null;
}

interface CandidateResult {
  rows: CandidateRow[];
  proposals: CandidateProposal[];
}

const ownObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const candidateResultError = (field: string): never => {
  throw new Error(`candidate production result ${field} is invalid`);
};

const candidateNullableString = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") return candidateResultError(field);
  return value;
};

const candidateNullableDate = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return candidateResultError(field);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) return candidateResultError(field);
  return value;
};

const candidateNullableAmount = (value: unknown, field: string): number | null => {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) <= 0) return candidateResultError(field);
  return value as number;
};

const candidateRelation = (value: unknown, field: string): ImportRecognitionRelation | null => {
  if (value === null) return null;
  if (!ownObject(value) || typeof value.kind !== "string" || !RELATION_KINDS.has(value.kind) || typeof value.rowId !== "string" || value.rowId.length === 0) {
    return candidateResultError(field);
  }
  return { kind: value.kind, rowId: value.rowId };
};

/** Runtime boundary for a pipeline imported from the candidate source tree. Scoring
 * never receives an unchecked dynamic module result. */
export function parseCandidateResult(value: unknown, imageCount: number): CandidateResult {
  if (!Number.isInteger(imageCount) || imageCount <= 0) return candidateResultError("imageCount");
  if (!ownObject(value) || !Array.isArray(value.rows) || !Array.isArray(value.proposals)) return candidateResultError("root");
  const rows: CandidateRow[] = value.rows.map((entry, index) => {
    const field = `rows[${index}]`;
    if (!ownObject(entry)) return candidateResultError(field);
    if (typeof entry.rowId !== "string" || entry.rowId.length === 0) return candidateResultError(`${field}.rowId`);
    if (!Number.isInteger(entry.imageIndex) || (entry.imageIndex as number) < 0 || (entry.imageIndex as number) >= imageCount) {
      return candidateResultError(`${field}.imageIndex`);
    }
    if (!Number.isInteger(entry.visualOrder) || (entry.visualOrder as number) < 0) return candidateResultError(`${field}.visualOrder`);
    const date = candidateNullableDate(entry.date, `${field}.date`);
    const amount = candidateNullableAmount(entry.amount, `${field}.amount`);
    if (entry.currency !== null && typeof entry.currency !== "string") return candidateResultError(`${field}.currency`);
    if (entry.direction !== "debit" && entry.direction !== "credit" && entry.direction !== "unknown") return candidateResultError(`${field}.direction`);
    if (entry.postingStatus !== "posted" && entry.postingStatus !== "pending" && entry.postingStatus !== "declined" && entry.postingStatus !== "unknown") {
      return candidateResultError(`${field}.postingStatus`);
    }
    if (entry.rowRole !== "financial_event" && entry.rowRole !== "supporting_detail" && entry.rowRole !== "ui_metadata") {
      return candidateResultError(`${field}.rowRole`);
    }
    if (typeof entry.semanticKind !== "string" || !SEMANTIC_KINDS.has(entry.semanticKind)) return candidateResultError(`${field}.semanticKind`);
    if (!Array.isArray(entry.rawTextLines) || entry.rawTextLines.some((line) => typeof line !== "string")) {
      return candidateResultError(`${field}.rawTextLines`);
    }
    if (entry.confidence !== "low" && entry.confidence !== "medium" && entry.confidence !== "high") {
      return candidateResultError(`${field}.confidence`);
    }
    if (!Array.isArray(entry.reviewReasons) || entry.reviewReasons.some((reason) => typeof reason !== "string" || !REVIEW_REASONS.has(reason))) {
      return candidateResultError(`${field}.reviewReasons`);
    }
    return {
      rowId: entry.rowId,
      imageIndex: entry.imageIndex as number,
      visualOrder: entry.visualOrder as number,
      date,
      amount,
      currency: entry.currency as string | null,
      direction: entry.direction,
      postingStatus: entry.postingStatus,
      rowRole: entry.rowRole,
      semanticKind: entry.semanticKind,
      relation: candidateRelation(entry.relation, `${field}.relation`),
      rawTextLines: entry.rawTextLines as string[],
      reviewReasons: entry.reviewReasons as string[],
    };
  });
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) return candidateResultError("rows duplicate rowId");
  if (new Set(rows.map((row) => `${row.imageIndex}:${row.visualOrder}`)).size !== rows.length) {
    return candidateResultError("rows duplicate visual position");
  }
  const rowIds = new Set(rows.map((row) => row.rowId));
  for (const [index, row] of rows.entries()) {
    if (row.relation && !rowIds.has(row.relation.rowId)) return candidateResultError(`rows[${index}].relation.rowId`);
  }
  const proposals: CandidateProposal[] = value.proposals.map((entry, index) => {
    const field = `proposals[${index}]`;
    if (!ownObject(entry) || typeof entry.rowId !== "string" || !rowIds.has(entry.rowId)) return candidateResultError(`${field}.rowId`);
    if (typeof entry.selected !== "boolean") return candidateResultError(`${field}.selected`);
    if (!["candidate", "supporting", "pending", "declined", "unresolved"].includes(String(entry.disposition))) {
      return candidateResultError(`${field}.disposition`);
    }
    if (!Array.isArray(entry.reviewReasons) || entry.reviewReasons.some((reason) => typeof reason !== "string" || !REVIEW_REASONS.has(reason))) {
      return candidateResultError(`${field}.reviewReasons`);
    }
    if (
      !Array.isArray(entry.sourceRows) ||
      entry.sourceRows.length === 0 ||
      entry.sourceRows.some((rowId) => typeof rowId !== "string" || !rowIds.has(rowId))
    ) {
      return candidateResultError(`${field}.sourceRows`);
    }
    candidateNullableDate(entry.date, `${field}.date`);
    candidateNullableAmount(entry.amount, `${field}.amount`);
    if (entry.currency !== null && typeof entry.currency !== "string") return candidateResultError(`${field}.currency`);
    if (entry.type !== null && entry.type !== "expense" && entry.type !== "income" && entry.type !== "transfer") return candidateResultError(`${field}.type`);
    if (typeof entry.isRefund !== "boolean") return candidateResultError(`${field}.isRefund`);
    if (typeof entry.semanticKind !== "string" || !SEMANTIC_KINDS.has(entry.semanticKind)) return candidateResultError(`${field}.semanticKind`);
    const relation = candidateRelation(entry.relation, `${field}.relation`);
    if (relation && !rowIds.has(relation.rowId)) return candidateResultError(`${field}.relation.rowId`);
    if (typeof entry.name !== "string") return candidateResultError(`${field}.name`);
    if (typeof entry.tag !== "string") return candidateResultError(`${field}.tag`);
    if (typeof entry.rawPlace !== "string") return candidateResultError(`${field}.rawPlace`);
    candidateNullableString(entry.placeName, `${field}.placeName`);
    if (entry.duplicateStatus !== "new" && entry.duplicateStatus !== "probable" && entry.duplicateStatus !== "exists") {
      return candidateResultError(`${field}.duplicateStatus`);
    }
    if (typeof entry.sourceAccountInvalid !== "boolean") return candidateResultError(`${field}.sourceAccountInvalid`);
    return {
      rowId: entry.rowId,
      selected: entry.selected,
      disposition: entry.disposition as CandidateProposal["disposition"],
      reviewReasons: entry.reviewReasons as string[],
      duplicateStatus: entry.duplicateStatus,
      type: entry.type as CandidateProposal["type"],
      isRefund: entry.isRefund,
      toAccountId: candidateNullableString(entry.toAccountId, `${field}.toAccountId`),
      envelopeId: candidateNullableString(entry.envelopeId, `${field}.envelopeId`),
      categoryId: candidateNullableString(entry.categoryId, `${field}.categoryId`),
      semanticKind: entry.semanticKind,
      relation,
    };
  });
  if (new Set(proposals.map((proposal) => proposal.rowId)).size !== proposals.length) return candidateResultError("proposals duplicate rowId");
  return { rows, proposals };
}

export type EvaluationArgs =
  | { manifestPath: string; mode: "baseline" | "candidate"; sourceTree: string; expectedRevision: string }
  | { manifestPath: string; mode: "compare"; baselineSourceTree: string; candidateSourceTree: string; expectedCandidateRevision: string };

export function parseEvalArgs(argv: readonly string[]): EvaluationArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`expected a value after ${flag ?? "argument"}`);
    if (
      ![
        "--manifest",
        "--mode",
        "--source-tree",
        "--baseline-source-tree",
        "--candidate-source-tree",
        "--expected-candidate-revision",
        "--expected-revision",
      ].includes(flag)
    ) {
      throw new Error(`unknown option ${flag}`);
    }
    if (values.has(flag)) throw new Error(`duplicate option ${flag}`);
    values.set(flag, value);
  }
  const manifestPath = values.get("--manifest");
  const mode = values.get("--mode");
  if (!manifestPath) throw new Error("--manifest is required");
  if (mode === "compare") {
    const baselineSourceTree = values.get("--baseline-source-tree");
    const candidateSourceTree = values.get("--candidate-source-tree");
    const expectedCandidateRevision = values.get("--expected-candidate-revision");
    if (!baselineSourceTree) throw new Error("--baseline-source-tree is required in compare mode");
    if (!candidateSourceTree) throw new Error("--candidate-source-tree is required in compare mode");
    if (!expectedCandidateRevision || !/^[0-9a-f]{40}$/.test(expectedCandidateRevision)) {
      throw new Error("--expected-candidate-revision must be an exact 40-character lowercase SHA in compare mode");
    }
    if (values.has("--source-tree")) throw new Error("--source-tree is not valid in compare mode");
    return { manifestPath, mode, baselineSourceTree, candidateSourceTree, expectedCandidateRevision };
  }
  if (mode !== "baseline" && mode !== "candidate") throw new Error("--mode must be baseline, candidate, or compare");
  const sourceTree = values.get("--source-tree");
  const expectedRevision = values.get("--expected-revision");
  if (!sourceTree) throw new Error("--source-tree is required");
  if (!expectedRevision || !/^[0-9a-f]{40}$/.test(expectedRevision)) throw new Error("--expected-revision must be an exact 40-character lowercase SHA");
  if (values.has("--baseline-source-tree") || values.has("--candidate-source-tree")) throw new Error("paired source options require compare mode");
  if (values.has("--expected-candidate-revision")) throw new Error("--expected-candidate-revision requires compare mode");
  return { manifestPath, mode, sourceTree, expectedRevision };
}

export function classifySourceAdapter(mode: Exclude<EvaluationMode, "compare">, schema: unknown): SourceAdapter {
  const properties = ownObject(schema) && ownObject(schema.schema) && ownObject(schema.schema.properties) ? schema.schema.properties : {};
  const hasTransactions = Object.hasOwn(properties, "transactions");
  const hasRows = Object.hasOwn(properties, "rows");
  if (mode === "baseline" && hasTransactions && !hasRows) return "legacy-transactions";
  if (mode === "candidate" && hasRows && !hasTransactions) return "recognition-rows";
  throw new Error(`${mode} source tree does not expose the required ${mode === "baseline" ? "transactions" : "rows"} contract`);
}

const prefixedRelation = (fixtureId: string, relation: ImportRecognitionRelation | null): ImportRecognitionRelation | null =>
  relation ? { ...relation, rowId: `${fixtureId}:${relation.rowId}` } : null;

const alignedId = (fixtureId: string, row: RecognitionManifestRow | undefined, fallback: string): string =>
  row ? `${fixtureId}:${row.id}` : `${fixtureId}:${fallback}`;

const normalizedMatchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const matchExpectedRow = (text: string | undefined, expected: readonly RecognitionManifestRow[]): RecognitionManifestRow | undefined => {
  const haystack = normalizedMatchText(text ?? "");
  if (!haystack) return undefined;
  const matches = expected
    .filter((row) => {
      const needle = normalizedMatchText(row.matchText);
      return needle.length > 0 && haystack.includes(needle);
    })
    .sort((left, right) => right.matchText.length - left.matchText.length || left.id.localeCompare(right.id));
  if (matches.length > 1 && normalizedMatchText(matches[0]!.matchText) === normalizedMatchText(matches[1]!.matchText)) return undefined;
  return matches[0];
};

const candidateAnchor = (
  text: string | undefined,
  expected: readonly RecognitionManifestRow[],
): { key: string; rows: RecognitionManifestRow[] } | undefined => {
  const haystack = normalizedMatchText(text ?? "");
  if (!haystack) return undefined;
  const matches = expected
    .map((row) => ({ row, key: normalizedMatchText(row.matchText) }))
    .filter(({ key }) => key.length > 0 && haystack.includes(key))
    .sort((left, right) => right.key.length - left.key.length || left.row.id.localeCompare(right.row.id));
  const key = matches[0]?.key;
  if (!key) return undefined;
  return { key, rows: expected.filter((row) => normalizedMatchText(row.matchText) === key) };
};

const byVisiblePosition = <T extends { imageIndex: number; visualOrder: number }>(left: T, right: T): number =>
  left.imageIndex - right.imageIndex || left.visualOrder - right.visualOrder;

export function normalizeBaselineRecognition(
  fixtureId: string,
  expected: readonly RecognitionManifestRow[],
  items: readonly BaselineItem[],
): ActualImportRecognitionRow[] {
  const byIndex = new Map(expected.filter((row) => row.baselineIndex !== null).map((row) => [row.baselineIndex, row]));
  return items.map((item, index) => {
    const truth = matchExpectedRow(item.rawPlace, expected) ?? byIndex.get(index);
    const isRefund = item.type === "expense" && item.isRefund;
    return {
      id: alignedId(fixtureId, truth, `unexpected-baseline-${index}`),
      rowRole: "financial_event",
      postingStatus: "posted",
      date: item.date,
      amount: item.amount,
      currency: item.currency.toUpperCase(),
      direction: item.type === "income" || isRefund ? "credit" : "debit",
      semanticKind: isRefund
        ? "merchant_refund"
        : item.type === "income"
          ? "incoming_transfer"
          : item.type === "transfer"
            ? "internal_transfer"
            : "card_purchase",
      relation: null,
      proposal: {
        selected: true,
        duplicateStatus: "new",
        disposition: "candidate",
        reviewReasons: [],
        type: item.type,
        isRefund,
        toAccountId: item.toAccountId ?? null,
        envelopeId: item.envelopeId ?? null,
        categoryId: item.categoryId ?? null,
      },
    };
  });
}

export function normalizeCandidateRecognition(
  fixtureId: string,
  expected: readonly RecognitionManifestRow[],
  result: CandidateResult,
): ActualImportRecognitionRow[] {
  const expectedByPosition = new Map(expected.map((row) => [`${row.candidatePosition.imageIndex}:${row.candidatePosition.visualOrder}`, row]));
  const proposalByRowId = new Map(result.proposals.map((proposal) => [proposal.rowId, proposal]));
  const truthByModelId = new Map<string, RecognitionManifestRow>();
  const anchorGroups = new Map<string, { truths: RecognitionManifestRow[]; actual: CandidateRow[] }>();
  for (const row of result.rows) {
    const anchor = candidateAnchor(row.rawTextLines?.join("\n"), expected);
    if (!anchor) continue;
    const group = anchorGroups.get(anchor.key) ?? { truths: anchor.rows, actual: [] };
    group.actual.push(row);
    anchorGroups.set(anchor.key, group);
  }
  const claimed = new Set<RecognitionManifestRow>();
  for (const group of anchorGroups.values()) {
    const remainingActual = new Set(group.actual);
    const remainingTruth = new Set(group.truths);
    const assignInOrder = (actualRows: CandidateRow[], truths: RecognitionManifestRow[]): void => {
      const orderedActual = actualRows.filter((row) => remainingActual.has(row)).sort(byVisiblePosition);
      const orderedTruth = truths
        .filter((truth) => remainingTruth.has(truth))
        .sort((left, right) => byVisiblePosition(left.candidatePosition, right.candidatePosition));
      for (let index = 0; index < Math.min(orderedActual.length, orderedTruth.length); index++) {
        const row = orderedActual[index]!;
        const truth = orderedTruth[index]!;
        truthByModelId.set(row.rowId, truth);
        claimed.add(truth);
        remainingActual.delete(row);
        remainingTruth.delete(truth);
      }
    };
    for (const role of ["financial_event", "supporting_detail", "ui_metadata"] as const) {
      assignInOrder(
        group.actual.filter((row) => row.rowRole === role),
        group.truths.filter((truth) => truth.rowRole === role),
      );
    }
  }
  for (const row of result.rows) {
    if (truthByModelId.has(row.rowId)) continue;
    const truth = expectedByPosition.get(`${row.imageIndex}:${row.visualOrder}`);
    if (truth && truth.rowRole === row.rowRole && !claimed.has(truth)) {
      truthByModelId.set(row.rowId, truth);
      claimed.add(truth);
    }
  }
  const remainingActual = result.rows.filter((row) => !truthByModelId.has(row.rowId));
  const remainingTruth = expected.filter((truth) => !claimed.has(truth));
  const semanticKeyFor = (row: CandidateRow): string => `${row.rowRole}:${proposalByRowId.get(row.rowId)?.semanticKind ?? row.semanticKind}`;
  for (const key of new Set(remainingActual.map(semanticKeyFor))) {
    const actualRows = remainingActual.filter((row) => !truthByModelId.has(row.rowId) && semanticKeyFor(row) === key).sort(byVisiblePosition);
    const truths = remainingTruth
      .filter((truth) => !claimed.has(truth) && `${truth.rowRole}:${truth.semanticKind}` === key)
      .sort((left, right) => byVisiblePosition(left.candidatePosition, right.candidatePosition));
    for (let index = 0; index < Math.min(actualRows.length, truths.length); index++) {
      const row = actualRows[index]!;
      const truth = truths[index]!;
      truthByModelId.set(row.rowId, truth);
      claimed.add(truth);
    }
  }
  const normalizedIdByModelId = new Map(
    result.rows.map((row, index) => {
      const truth = truthByModelId.get(row.rowId);
      return [row.rowId, alignedId(fixtureId, truth, `unexpected-candidate-${index}`)] as const;
    }),
  );
  return result.rows.map((row, index) => {
    const truth = truthByModelId.get(row.rowId);
    const proposal = proposalByRowId.get(row.rowId);
    return {
      id: alignedId(fixtureId, truth, `unexpected-candidate-${index}`),
      rowRole: row.rowRole,
      postingStatus: row.postingStatus,
      date: row.date,
      amount: row.amount,
      currency: row.currency?.toUpperCase() ?? null,
      direction: row.direction,
      semanticKind: proposal?.semanticKind ?? row.semanticKind,
      relation:
        (proposal?.relation ?? row.relation)
          ? {
              kind: (proposal?.relation ?? row.relation)!.kind,
              rowId: normalizedIdByModelId.get((proposal?.relation ?? row.relation)!.rowId) ?? `${fixtureId}:unexpected-relation-target`,
            }
          : null,
      proposal: proposal
        ? {
            selected: proposal.selected,
            disposition: proposal.disposition,
            reviewReasons: proposal.reviewReasons,
            duplicateStatus: proposal.duplicateStatus,
            type: proposal.type,
            isRefund: proposal.isRefund,
            toAccountId: proposal.toAccountId,
            envelopeId: proposal.envelopeId,
            categoryId: proposal.categoryId,
          }
        : null,
    };
  });
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`manifest ${field} must be a non-empty string`);
  return value;
};

const SEMANTIC_KINDS = new Set([
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
]);
const TRANSACTION_SEMANTIC_KINDS = new Set([
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
  "cash_deposit",
]);
const RELATION_KINDS = new Set(["fx_for", "refund_of", "pending_version_of", "fee_for", "duplicate_of", "counterpart_of", "continuation_of"]);
const REVIEW_REASONS = new Set<string>(IMPORT_REVIEW_REASONS);
const SUPPORTED_CURRENCY_SET = new Set<string>(SUPPORTED_CURRENCIES);

const assertOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[], field: string): void => {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`manifest ${field} contains unknown fields`);
};

const calendarDate = (value: unknown, field: string): string => {
  const date = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`manifest ${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new Error(`manifest ${field} is not a calendar date`);
  return date;
};

const currencyCode = (value: unknown, field: string): string => {
  const currency = requireString(value, field).toUpperCase();
  if (!SUPPORTED_CURRENCY_SET.has(currency)) throw new Error(`manifest ${field} is not a supported two-decimal currency`);
  return currency;
};

const nullableString = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  return requireString(value, field);
};

const nullableSourceRef = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`manifest ${field} must be a string or null`);
  return value;
};

const parseRelation = (value: unknown, field: string): ImportRecognitionRelation | null => {
  if (value === null) return null;
  if (!ownObject(value)) throw new Error(`manifest ${field} must be an object or null`);
  assertOnlyKeys(value, ["kind", "rowId"], field);
  const kind = requireString(value.kind, `${field}.kind`);
  if (!RELATION_KINDS.has(kind)) throw new Error(`manifest ${field}.kind is invalid`);
  return { kind, rowId: requireString(value.rowId, `${field}.rowId`) };
};

const parseProposalTruth = (value: unknown, field: string): ImportRecognitionProposalTruth | null => {
  if (value === null) return null;
  if (!ownObject(value)) throw new Error(`manifest ${field} must be an object or null`);
  assertOnlyKeys(value, ["type", "isRefund", "toAccountId", "envelopeId", "categoryId"], field);
  if (value.type !== null && value.type !== "expense" && value.type !== "income" && value.type !== "transfer") {
    throw new Error(`manifest ${field}.type is invalid`);
  }
  if (typeof value.isRefund !== "boolean") throw new Error(`manifest ${field}.isRefund must be boolean`);
  return {
    type: value.type,
    isRefund: value.isRefund,
    toAccountId: nullableString(value.toAccountId, `${field}.toAccountId`),
    envelopeId: nullableString(value.envelopeId, `${field}.envelopeId`),
    categoryId: nullableString(value.categoryId, `${field}.categoryId`),
  };
};

const parseManifestContext = (value: unknown, field: string, fixtureId: string): RecognitionManifestContext => {
  if (value === undefined) {
    const accountId = `${fixtureId}-account`;
    return {
      accountId,
      accounts: [
        {
          id: accountId,
          name: "Evaluation account",
          color: "#000000",
          icon: "wallet",
          type: "checking",
          onBudget: true,
          initialBalance: 0,
          archived: false,
          sort: 0,
          automaticEnvelopeId: null,
        },
      ],
      envelopes: [],
      categories: [],
      transactions: [],
      historyRecords: [],
    };
  }
  if (!ownObject(value)) throw new Error(`manifest ${field} must be an object`);
  assertOnlyKeys(value, ["accountId", "accounts", "envelopes", "categories", "transactions", "historyRecords"], field);
  const accountId = requireString(value.accountId, `${field}.accountId`);
  if (!Array.isArray(value.accounts) || !Array.isArray(value.envelopes) || !Array.isArray(value.categories)) {
    throw new Error(`manifest ${field} entity lists are invalid`);
  }
  if (!Array.isArray(value.transactions) || !Array.isArray(value.historyRecords)) throw new Error(`manifest ${field} history lists are invalid`);

  const accounts = value.accounts.map((entry, index) => {
    const itemField = `${field}.accounts[${index}]`;
    if (!ownObject(entry)) throw new Error(`manifest ${itemField} is invalid`);
    assertOnlyKeys(entry, ["id", "name", "archived"], itemField);
    return {
      id: requireString(entry.id, `${itemField}.id`),
      name: requireString(entry.name, `${itemField}.name`),
      color: "#000000",
      icon: "wallet",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: entry.archived === undefined ? false : entry.archived,
      sort: index,
      automaticEnvelopeId: null,
    };
  });
  if (accounts.some((account) => typeof account.archived !== "boolean")) throw new Error(`manifest ${field}.accounts archived flags are invalid`);
  if (!accounts.some((account) => account.id === accountId)) throw new Error(`manifest ${field}.accountId is not present in accounts`);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw new Error(`manifest ${field}.accounts contains duplicate ids`);

  const envelopes = value.envelopes.map((entry, index) => {
    const itemField = `${field}.envelopes[${index}]`;
    if (!ownObject(entry)) throw new Error(`manifest ${itemField} is invalid`);
    assertOnlyKeys(entry, ["id", "name", "archived"], itemField);
    const archived = entry.archived === undefined ? false : entry.archived;
    if (typeof archived !== "boolean") throw new Error(`manifest ${itemField}.archived is invalid`);
    return {
      id: requireString(entry.id, `${itemField}.id`),
      groupId: `${fixtureId}-group`,
      name: requireString(entry.name, `${itemField}.name`),
      color: "#000000",
      icon: "tag",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: index,
      archived,
    };
  });
  if (new Set(envelopes.map((envelope) => envelope.id)).size !== envelopes.length) throw new Error(`manifest ${field}.envelopes contains duplicate ids`);

  const categories = value.categories.map((entry, index) => {
    const itemField = `${field}.categories[${index}]`;
    if (!ownObject(entry)) throw new Error(`manifest ${itemField} is invalid`);
    assertOnlyKeys(entry, ["id", "name"], itemField);
    return { id: requireString(entry.id, `${itemField}.id`), name: requireString(entry.name, `${itemField}.name`) };
  });
  if (new Set(categories.map((category) => category.id)).size !== categories.length) throw new Error(`manifest ${field}.categories contains duplicate ids`);

  const transactions = value.transactions.map((entry, index) => {
    const itemField = `${field}.transactions[${index}]`;
    if (!ownObject(entry)) throw new Error(`manifest ${itemField} is invalid`);
    assertOnlyKeys(entry, ["accountId", "date", "amount", "sourceRef"], itemField);
    const amount = entry.amount;
    if (!Number.isInteger(amount) || (amount as number) <= 0) throw new Error(`manifest ${itemField}.amount is invalid`);
    return {
      accountId: requireString(entry.accountId, `${itemField}.accountId`),
      date: calendarDate(entry.date, `${itemField}.date`),
      amount: amount as number,
      sourceRef: nullableSourceRef(entry.sourceRef, `${itemField}.sourceRef`),
    };
  });

  const historyRecords = value.historyRecords.map((entry, index) => {
    const itemField = `${field}.historyRecords[${index}]`;
    if (!ownObject(entry)) throw new Error(`manifest ${itemField} is invalid`);
    assertOnlyKeys(entry, ["accountId", "currency", "sourceRef", "tag", "place", "name", "envelope", "category", "type", "isRefund", "toAccountId"], itemField);
    if (entry.type !== "expense" && entry.type !== "income" && entry.type !== "transfer") throw new Error(`manifest ${itemField}.type is invalid`);
    if (typeof entry.isRefund !== "boolean") throw new Error(`manifest ${itemField}.isRefund is invalid`);
    return {
      accountId: requireString(entry.accountId, `${itemField}.accountId`),
      currency: currencyCode(entry.currency, `${itemField}.currency`),
      sourceRef: nullableSourceRef(entry.sourceRef, `${itemField}.sourceRef`),
      tag: nullableString(entry.tag, `${itemField}.tag`),
      place: nullableString(entry.place, `${itemField}.place`),
      name: nullableString(entry.name, `${itemField}.name`),
      envelope: nullableString(entry.envelope, `${itemField}.envelope`),
      category: nullableString(entry.category, `${itemField}.category`),
      type: entry.type as "expense" | "income" | "transfer",
      isRefund: entry.isRefund,
      toAccountId: nullableString(entry.toAccountId, `${itemField}.toAccountId`),
    };
  });
  return { accountId, accounts, envelopes, categories, transactions, historyRecords };
};

const parseManifestRow = (value: unknown, field: string): RecognitionManifestRow => {
  if (!ownObject(value) || !ownObject(value.candidatePosition)) throw new Error(`manifest ${field} is invalid`);
  assertOnlyKeys(
    value,
    [
      "id",
      "rowRole",
      "postingStatus",
      "safetyClass",
      "requiredSafetyReasons",
      "expectedDuplicateStatus",
      "date",
      "amount",
      "currency",
      "direction",
      "semanticKind",
      "relation",
      "expectedProposal",
      "matchText",
      "candidatePosition",
      "baselineIndex",
    ],
    field,
  );
  assertOnlyKeys(value.candidatePosition, ["imageIndex", "visualOrder"], `${field}.candidatePosition`);
  const amount = value.amount;
  if (amount !== null && (!Number.isInteger(amount) || (amount as number) <= 0)) throw new Error(`manifest ${field}.amount is invalid`);
  if (value.direction !== "debit" && value.direction !== "credit" && value.direction !== "unknown") {
    throw new Error(`manifest ${field}.direction is invalid`);
  }
  const imageIndex = value.candidatePosition.imageIndex;
  const visualOrder = value.candidatePosition.visualOrder;
  if (!Number.isInteger(imageIndex) || (imageIndex as number) < 0 || !Number.isInteger(visualOrder) || (visualOrder as number) < 0) {
    throw new Error(`manifest ${field}.candidatePosition is invalid`);
  }
  if (value.baselineIndex !== null && (!Number.isInteger(value.baselineIndex) || (value.baselineIndex as number) < 0)) {
    throw new Error(`manifest ${field}.baselineIndex is invalid`);
  }
  const rowRole = value.rowRole;
  if (rowRole !== "financial_event" && rowRole !== "supporting_detail" && rowRole !== "ui_metadata") {
    throw new Error(`manifest ${field}.rowRole is invalid`);
  }
  const postingStatus = value.postingStatus;
  if (postingStatus !== "posted" && postingStatus !== "pending" && postingStatus !== "declined" && postingStatus !== "unknown") {
    throw new Error(`manifest ${field}.postingStatus is invalid`);
  }
  const safetyClass = value.safetyClass;
  if (safetyClass !== "safe_auto" && safetyClass !== "unsafe_auto" && safetyClass !== "review_only" && safetyClass !== "non_ledger") {
    throw new Error(`manifest ${field}.safetyClass is invalid`);
  }
  if (!Array.isArray(value.requiredSafetyReasons) || value.requiredSafetyReasons.some((reason) => typeof reason !== "string" || !REVIEW_REASONS.has(reason))) {
    throw new Error(`manifest ${field}.requiredSafetyReasons is invalid`);
  }
  const requiredSafetyReasons = [...new Set(value.requiredSafetyReasons as string[])];
  const expectedDuplicateStatus = value.expectedDuplicateStatus ?? "new";
  if (expectedDuplicateStatus !== "new" && expectedDuplicateStatus !== "probable" && expectedDuplicateStatus !== "exists") {
    throw new Error(`manifest ${field}.expectedDuplicateStatus is invalid`);
  }
  const semanticKind = requireString(value.semanticKind, `${field}.semanticKind`);
  if (!SEMANTIC_KINDS.has(semanticKind)) throw new Error(`manifest ${field}.semanticKind is invalid`);
  if (TRANSACTION_SEMANTIC_KINDS.has(semanticKind) && rowRole !== "financial_event") {
    throw new Error(`manifest ${field} transaction semantic kinds must be financial_event`);
  }
  if (rowRole === "supporting_detail" && semanticKind !== "fx_conversion") {
    throw new Error(`manifest ${field} supporting_detail semantic kind must be fx_conversion`);
  }
  if (rowRole === "ui_metadata" && semanticKind !== "unknown") {
    throw new Error(`manifest ${field} ui_metadata semantic kind must be unknown`);
  }
  const relation = parseRelation(value.relation, `${field}.relation`);
  const expectedProposal = parseProposalTruth(value.expectedProposal, `${field}.expectedProposal`);
  if (rowRole !== "financial_event" && (safetyClass !== "non_ledger" || expectedProposal !== null || requiredSafetyReasons.length > 0)) {
    throw new Error(`manifest ${field} non-financial rows must be non_ledger without a proposal or safety reasons`);
  }
  if (rowRole === "financial_event" && safetyClass === "non_ledger") throw new Error(`manifest ${field} financial rows cannot be non_ledger`);
  if ((safetyClass === "safe_auto" || safetyClass === "unsafe_auto") && (postingStatus !== "posted" || expectedProposal === null)) {
    throw new Error(`manifest ${field} automatic safety classes require a posted financial proposal`);
  }
  if (safetyClass === "unsafe_auto" && requiredSafetyReasons.length === 0) throw new Error(`manifest ${field} unsafe_auto requires a safety reason`);
  if (safetyClass === "safe_auto" && requiredSafetyReasons.length > 0) throw new Error(`manifest ${field} safe_auto cannot require review`);
  if (safetyClass === "review_only" && requiredSafetyReasons.length === 0) throw new Error(`manifest ${field} review_only requires a safety reason`);
  if (
    (postingStatus === "pending" || postingStatus === "declined") &&
    (safetyClass !== "review_only" || !requiredSafetyReasons.includes("pending_or_declined"))
  ) {
    throw new Error(`manifest ${field} pending or declined rows require review_only and pending_or_declined`);
  }
  if (postingStatus === "unknown" && (safetyClass !== "review_only" || !requiredSafetyReasons.includes("unknown_posting_status"))) {
    throw new Error(`manifest ${field} unknown posting status requires review_only and unknown_posting_status`);
  }
  if (
    rowRole === "financial_event" &&
    relation !== null &&
    (safetyClass !== "unsafe_auto" || !requiredSafetyReasons.includes("relation_changes_ledger_shape"))
  ) {
    throw new Error(`manifest ${field} financial relations require unsafe_auto and relation_changes_ledger_shape`);
  }
  if (
    (semanticKind === "incoming_transfer" || semanticKind === "account_topup") &&
    rowRole === "financial_event" &&
    postingStatus === "posted" &&
    (safetyClass !== "unsafe_auto" || !requiredSafetyReasons.includes("possible_transfer"))
  ) {
    throw new Error(`manifest ${field} incoming transfers and top-ups require unsafe_auto and possible_transfer`);
  }
  return {
    id: requireString(value.id, `${field}.id`),
    rowRole,
    postingStatus,
    safetyClass,
    requiredSafetyReasons,
    expectedDuplicateStatus,
    date: value.date === null ? null : calendarDate(value.date, `${field}.date`),
    amount: amount as number | null,
    currency: value.currency === null ? null : currencyCode(value.currency, `${field}.currency`),
    direction: value.direction,
    semanticKind,
    relation,
    expectedProposal,
    matchText: requireString(value.matchText, `${field}.matchText`),
    candidatePosition: { imageIndex: imageIndex as number, visualOrder: visualOrder as number },
    baselineIndex: value.baselineIndex as number | null,
  };
};

const assertRepresentativeCoverage = (manifest: RecognitionManifest): void => {
  const financialKinds = new Set(
    manifest.fixtures.flatMap((fixture) => fixture.rows.filter((row) => row.rowRole === "financial_event").map((row) => row.semanticKind)),
  );
  const kinds = new Set(manifest.fixtures.flatMap((fixture) => fixture.rows.map((row) => row.semanticKind)));
  const statuses = new Set(manifest.fixtures.flatMap((fixture) => fixture.rows.map((row) => row.postingStatus)));
  const duplicateStatuses = new Set(
    manifest.fixtures.flatMap((fixture) => fixture.rows.filter((row) => row.rowRole === "financial_event").map((row) => row.expectedDuplicateStatus)),
  );
  const forms = new Set(manifest.fixtures.map((fixture) => fixture.formFactor));
  const languages = new Set(manifest.fixtures.map((fixture) => new Intl.Locale(fixture.locale).language));
  const currencies = new Set(
    manifest.fixtures.flatMap((fixture) => [
      fixture.budgetCurrency,
      ...fixture.rows.map((row) => row.currency).filter((code): code is string => code !== null),
    ]),
  );
  const requiredFinancialKinds = [
    "card_purchase",
    "salary",
    "merchant_refund",
    "cashback_or_reward",
    "incoming_transfer",
    "outgoing_transfer",
    "account_topup",
  ];
  const missing = requiredFinancialKinds.filter((kind) => !financialKinds.has(kind));
  if (missing.length > 0) throw new Error("manifest corpus coverage is missing required transaction classes");
  if (!kinds.has("fx_conversion")) throw new Error("manifest corpus coverage requires FX evidence");
  if (!statuses.has("pending") || !statuses.has("declined")) throw new Error("manifest corpus coverage requires pending and declined rows");
  if (!duplicateStatuses.has("probable") || !duplicateStatuses.has("exists")) {
    throw new Error("manifest corpus duplicate coverage requires probable and exact matches");
  }
  if (!forms.has("mobile") || !forms.has("desktop")) throw new Error("manifest corpus coverage requires mobile and desktop fixtures");
  if (!manifest.fixtures.some((fixture) => fixture.overlap)) throw new Error("manifest corpus coverage requires overlap");
  if (currencies.size < 2) throw new Error("manifest corpus coverage requires multiple currencies");
  if (languages.size < 2) throw new Error("manifest corpus coverage requires multiple languages");
};

export function parseRecognitionManifest(value: unknown, requireCoverage = true): RecognitionManifest {
  if (!ownObject(value) || value.version !== 1 || !Array.isArray(value.fixtures) || value.fixtures.length === 0) {
    throw new Error("manifest must contain version 1 and at least one fixture");
  }
  assertOnlyKeys(value, ["version", "fixtures"], "root");
  const fixtureIds = new Set<string>();
  const fixtures = value.fixtures.map((fixture, fixtureIndex) => {
    const field = `fixtures[${fixtureIndex}]`;
    if (!ownObject(fixture) || !Array.isArray(fixture.images) || !Array.isArray(fixture.rows)) throw new Error(`manifest ${field} is invalid`);
    assertOnlyKeys(fixture, ["id", "images", "locale", "today", "budgetCurrency", "formFactor", "overlap", "context", "rows"], field);
    const id = requireString(fixture.id, `${field}.id`);
    if (fixtureIds.has(id)) throw new Error(`manifest has duplicate fixture id at ${field}`);
    fixtureIds.add(id);
    if (fixture.images.length === 0 || fixture.images.length > IMPORT_JOB_MAX_IMAGES) {
      throw new Error(`manifest ${field}.images must contain 1-${IMPORT_JOB_MAX_IMAGES} paths`);
    }
    const imageEntries = fixture.images;
    if (fixture.rows.length === 0) throw new Error(`manifest ${field}.rows must not be empty`);
    const rows = fixture.rows.map((row, rowIndex) => parseManifestRow(row, `${field}.rows[${rowIndex}]`));
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error(`manifest ${field} has duplicate row ids`);
    if (rows.some((row) => row.candidatePosition.imageIndex >= imageEntries.length)) {
      throw new Error(`manifest ${field} has a candidate imageIndex outside its images`);
    }
    if (new Set(rows.map((row) => `${row.candidatePosition.imageIndex}:${row.candidatePosition.visualOrder}`)).size !== rows.length) {
      throw new Error(`manifest ${field} has duplicate candidate positions`);
    }
    const baseline = rows.filter((row) => row.baselineIndex !== null).map((row) => row.baselineIndex);
    if (new Set(baseline).size !== baseline.length) throw new Error(`manifest ${field} has duplicate baseline indexes`);
    const orderedBaseline = [...baseline].sort((left, right) => left! - right!);
    if (orderedBaseline.some((value, index) => value !== index)) throw new Error(`manifest ${field} baseline indexes must be contiguous from zero`);
    const rowIds = new Set(rows.map((row) => row.id));
    if (rows.some((row) => row.relation && !rowIds.has(row.relation.rowId))) throw new Error(`manifest ${field} has an unknown relation target`);
    const locale = requireString(fixture.locale, `${field}.locale`);
    try {
      new Intl.Locale(locale);
    } catch {
      throw new Error(`manifest ${field}.locale is invalid`);
    }
    const formFactor = fixture.formFactor;
    const overlap = fixture.overlap;
    if (formFactor !== "mobile" && formFactor !== "desktop") throw new Error(`manifest ${field}.formFactor is invalid`);
    if (typeof overlap !== "boolean") throw new Error(`manifest ${field}.overlap must be boolean`);
    return {
      id,
      images: imageEntries.map((image, imageIndex) => requireString(image, `${field}.images[${imageIndex}]`)),
      locale,
      today: calendarDate(fixture.today, `${field}.today`),
      budgetCurrency: currencyCode(fixture.budgetCurrency, `${field}.budgetCurrency`),
      formFactor: formFactor as "mobile" | "desktop",
      overlap: overlap as boolean,
      context: parseManifestContext(fixture.context, `${field}.context`, id),
      rows,
    };
  });
  const manifest: RecognitionManifest = { version: 1, fixtures };
  if (requireCoverage) assertRepresentativeCoverage(manifest);
  return manifest;
}

const imageMime = (path: string): string => {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      throw new Error("manifest image must be PNG, JPEG, or WebP");
  }
};

interface LoadedCorpus {
  digest: string;
  images: Map<string, string[]>;
}

interface ChatTransportInput {
  side: "baseline" | "candidate";
  fixtureId: string;
  request: ChatRequest;
  apiKey: string;
  model: string;
  /** Which pipeline call this is (extract window, seam, enrichment batch); absent for a baseline adapter. */
  meta?: ImportRecognitionChatMeta;
}

type ChatTransport = (input: ChatTransportInput) => Promise<string>;

/** One model round-trip as observed by the OpenAI transport: timing and token counts only —
 * never the prompt, the screenshots or the answer. This is the only place the harness learns how
 * long a window takes, which is what sizes IMPORT_JOB_CHUNK_SIZE. */
interface TransportCallTelemetry {
  side: "baseline" | "candidate";
  fixtureId: string;
  stage: ImportRecognitionChatMeta["stage"] | "unknown";
  chunk: number | null;
  batch: number | null;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  outcome: "ok" | "error";
}

const transportTelemetry: TransportCallTelemetry[] = [];

function telemetrySummary(): {
  calls: TransportCallTelemetry[];
  totals: { calls: number; durationMs: number; promptTokens: number; completionTokens: number };
} {
  const calls = [...transportTelemetry];
  return {
    calls,
    totals: {
      calls: calls.length,
      durationMs: calls.reduce((total, call) => total + call.durationMs, 0),
      promptTokens: calls.reduce((total, call) => total + (call.promptTokens ?? 0), 0),
      completionTokens: calls.reduce((total, call) => total + (call.completionTokens ?? 0), 0),
    },
  };
}

const usageCount = (body: unknown, key: "prompt_tokens" | "completion_tokens"): number | null => {
  const usage = ownObject(body) ? body.usage : undefined;
  const value = ownObject(usage) ? usage[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
type TransportKind = "openai" | "injected-test";

export function comparisonReleaseStatus(
  transport: TransportKind,
  criteriaPassed: boolean,
  reasons: string[],
  identityBound: boolean,
): { releaseEligible: boolean; passed: boolean; reasons: string[]; exitCode: number } {
  const releaseEligible = transport === "openai" && criteriaPassed && identityBound;
  const safeReasons = identityBound ? reasons : [...reasons, "source_identity_unbound"];
  return {
    releaseEligible,
    passed: releaseEligible,
    reasons: transport === "injected-test" ? [...safeReasons, "non_live_transport"] : safeReasons,
    exitCode: releaseEligible ? 0 : transport === "injected-test" && criteriaPassed ? 2 : 1,
  };
}

interface SourceIdentity {
  expectedRevision: string;
  actualRevision: string;
  expectedModuleDigest: string;
  actualModuleDigest: string;
  clean: boolean;
  bound: boolean;
  adapter: SourceAdapter;
  moduleHashes: Record<string, string>;
  expectedTree: string;
}

interface SourcePreflight {
  root: string;
  identity: SourceIdentity;
  entries: Array<{ mode: string; object: string; path: string }>;
}

interface LoadedSource {
  root: string;
  prompts: RecognitionSourceModule;
  baseline: BaselineProductionSeam | null;
  identity: SourceIdentity;
}

interface HistorySafetyIdentity {
  passed: boolean;
  reasons: string[];
  sourceHashes: Record<string, string | null>;
  testHashes: Record<string, string | null>;
}

const sha256 = (parts: readonly (string | Uint8Array)[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};
const gitBlobId = (bytes: Uint8Array): string => {
  const hash = createHash("sha1");
  hash.update(`blob ${bytes.byteLength}\0`);
  hash.update(bytes);
  return hash.digest("hex");
};

const pathIsInside = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
};

const symlinkTargetIsConfined = async (root: string, path: string): Promise<boolean> => {
  try {
    const target = resolve(dirname(path), await readlink(path));
    return pathIsInside(root, target) && pathIsInside(root, await realpath(path));
  } catch {
    return false;
  }
};

const hashFile = async (path: string): Promise<string> => sha256([await readFile(path)]);
const BASELINE_REVISION = "a3676d8d8ff2273f40e10aadd79e5bad4594974f";
const moduleDigest = (hashes: Record<string, string>): string =>
  sha256(
    Object.entries(hashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, hash]) => [name, "\0", hash, "\0"]),
  );

const gitText = async (root: string, args: string[]): Promise<string | null> => {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? output : null;
};

const gitBytes = async (root: string, args: string[]): Promise<Uint8Array | null> => {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  const output = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  return (await child.exited) === 0 ? output : null;
};

export async function preflightSource(mode: "baseline" | "candidate", sourceTree: string, expectedCandidateRevision?: string): Promise<SourcePreflight> {
  const root = await realpath(resolve(sourceTree));
  const expectedRevision = expectedCandidateRevision ?? (mode === "baseline" ? BASELINE_REVISION : "unspecified");
  const topText = await gitText(root, ["rev-parse", "--show-toplevel"]);
  let gitRoot: string | null = null;
  if (topText) {
    try {
      gitRoot = await realpath(topText.trim());
    } catch {
      gitRoot = null;
    }
  }
  const revisionText = gitRoot === root ? await gitText(root, ["rev-parse", "HEAD"]) : null;
  const actualRevision = revisionText?.trim().match(/^[0-9a-f]{40}$/)?.[0] ?? "unversioned";
  const expectedTree = (await gitText(root, ["rev-parse", `${expectedRevision}^{tree}`]))?.trim() ?? "unavailable";
  const objectFormat = (await gitText(root, ["rev-parse", "--show-object-format"]))?.trim();
  const treeBytes = /^[0-9a-f]{40}$/.test(expectedRevision) ? await gitBytes(root, ["ls-tree", "-rz", expectedRevision]) : null;
  const entries = treeBytes
    ? new TextDecoder()
        .decode(treeBytes)
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
          return match ? { mode: match[1]!, type: match[2]!, object: match[3]!, path: match[4]! } : null;
        })
    : [];
  const moduleHashes: Record<string, string> = {};
  const expectedHashes: Record<string, string> = {};
  let modesMatch = entries.length > 0 && entries.every((entry) => entry !== null && entry.type === "blob");
  for (const entry of entries) {
    if (entry?.type !== "blob") continue;
    expectedHashes[entry.path] = sha256([entry.mode, "\0", entry.object]);
    try {
      const path = resolve(root, entry.path);
      const info = await lstat(path);
      let actual: Uint8Array;
      let actualMode: string;
      if (entry.mode === "120000") {
        actual = new TextEncoder().encode(await readlink(path));
        actualMode = info.isSymbolicLink() ? "120000" : "invalid";
        modesMatch &&= actualMode === "120000" && (await symlinkTargetIsConfined(root, path));
      } else {
        actual = new Uint8Array(await readFile(path));
        actualMode = info.isFile() ? ((info.mode & 0o111) !== 0 ? "100755" : "100644") : "invalid";
      }
      modesMatch &&= actualMode === entry.mode;
      moduleHashes[entry.path] = sha256([actualMode, "\0", gitBlobId(actual)]);
    } catch {
      modesMatch = false;
    }
  }
  const extras = gitRoot === root ? await gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"]) : null;
  const noExtras = extras !== null && extras.length === 0;
  const actualModuleDigest = moduleDigest(moduleHashes);
  const expectedModuleDigest = moduleDigest(expectedHashes);
  const clean = modesMatch && noExtras && Object.keys(moduleHashes).length === entries.length && actualModuleDigest === expectedModuleDigest;
  const bound = gitRoot === root && objectFormat === "sha1" && actualRevision === expectedRevision && clean && expectedTree !== "unavailable";
  return {
    root,
    identity: {
      expectedRevision,
      actualRevision,
      expectedModuleDigest,
      actualModuleDigest,
      clean,
      bound,
      adapter: mode === "baseline" ? "legacy-transactions" : "recognition-rows",
      moduleHashes,
      expectedTree,
    },
    entries: entries
      .filter((entry): entry is { mode: string; type: string; object: string; path: string } => entry !== null)
      .map(({ mode, object, path }) => ({ mode, object, path })),
  };
}

const assertSnapshotLinksConfined = async (root: string): Promise<void> => {
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      if (!(await symlinkTargetIsConfined(root, path))) throw new Error("snapshot dependency link escapes source root");
      let target: string;
      try {
        target = await realpath(path);
      } catch {
        throw new Error("snapshot dependency link is unresolved");
      }
      if (!pathIsInside(root, target)) throw new Error("snapshot dependency link resolves outside source root");
      return;
    }
    if (info.isDirectory()) for (const entry of await readdir(path)) await visit(resolve(path, entry));
  };
  await visit(root);
};

const installSnapshotDependencies = async (root: string): Promise<void> => {
  const install = Bun.spawn([process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile", "--cwd", root], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, BUN_INSTALL_BACKEND: "copyfile" },
  });
  if ((await install.exited) !== 0) throw new Error("snapshot dependency install failed");
  await assertSnapshotLinksConfined(root);
};

const setSnapshotWritable = async (root: string, writable: boolean): Promise<void> => {
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (writable) await chmod(path, 0o700);
      for (const entry of await readdir(path)) await visit(resolve(path, entry));
      if (!writable) await chmod(path, 0o500);
    } else {
      await chmod(path, writable ? 0o600 : (info.mode & 0o111) !== 0 ? 0o500 : 0o400);
    }
  };
  await visit(root);
};

export interface SourceSnapshot {
  cleanup(this: SourceSnapshot): Promise<void>;
}

interface SourceSnapshotState {
  root: string;
  identity: SourceIdentity;
  cleanupPromise: Promise<void> | null;
}

const snapshotStates = new WeakMap<SourceSnapshot, SourceSnapshotState>();
const cleanedSnapshots = new WeakSet<SourceSnapshot>();

async function cleanupSourceSnapshot(this: SourceSnapshot): Promise<void> {
  const state = snapshotStates.get(this);
  if (!state) {
    if (cleanedSnapshots.has(this)) return;
    throw new Error("snapshot cleanup requires a verified immutable snapshot");
  }
  state.cleanupPromise ??= (async () => {
    try {
      await setSnapshotWritable(state.root, true);
      await rm(state.root, { recursive: true, force: true });
    } finally {
      snapshotStates.delete(this);
      cleanedSnapshots.add(this);
    }
  })();
  await state.cleanupPromise;
}

export async function materializeSourceSnapshot(preflight: SourcePreflight): Promise<SourceSnapshot> {
  if (!preflight.identity.bound) throw new Error("source snapshot requires a bound preflight");
  const identity: SourceIdentity = Object.freeze({
    ...preflight.identity,
    moduleHashes: Object.freeze({ ...preflight.identity.moduleHashes }),
  });
  const entries = preflight.entries.map((entry) => ({ ...entry }));
  const root = await mkdtemp(resolve(tmpdir(), "enveo-import-eval-source-"));
  await chmod(root, 0o700);
  try {
    const archive = Bun.spawn(["git", "-C", preflight.root, "archive", preflight.identity.expectedRevision], { stdout: "pipe", stderr: "ignore" });
    const archiveBytes = new Uint8Array(await new Response(archive.stdout).arrayBuffer());
    if ((await archive.exited) !== 0) throw new Error("source snapshot could not be materialized");
    const extract = Bun.spawn(["tar", "-x", "-C", root], { stdin: archiveBytes, stdout: "ignore", stderr: "ignore" });
    if ((await extract.exited) !== 0) throw new Error("source snapshot could not be materialized");
    await installSnapshotDependencies(root);
    await setSnapshotWritable(root, false);
    const snapshotHashes: Record<string, string> = {};
    for (const entry of entries) {
      const path = resolve(root, entry.path);
      const info = await lstat(path);
      const bytes = entry.mode === "120000" ? new TextEncoder().encode(await readlink(path)) : new Uint8Array(await readFile(path));
      const mode =
        entry.mode === "120000"
          ? info.isSymbolicLink()
            ? "120000"
            : "invalid"
          : info.isFile()
            ? (info.mode & 0o111) !== 0
              ? "100755"
              : "100644"
            : "invalid";
      snapshotHashes[entry.path] = sha256([mode, "\0", gitBlobId(bytes)]);
    }
    if (moduleDigest(snapshotHashes) !== identity.expectedModuleDigest) throw new Error("source snapshot digest mismatch");
    const snapshot = Object.freeze({ cleanup: cleanupSourceSnapshot }) as SourceSnapshot;
    snapshotStates.set(snapshot, { root, identity, cleanupPromise: null });
    return snapshot;
  } catch (error) {
    try {
      await setSnapshotWritable(root, true);
    } catch {}
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const requireRegularFile = async (path: string, label: string): Promise<void> => {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} is missing`);
  }
};

async function loadCorpus(manifestPath: string, manifestText: string, manifest: RecognitionManifest): Promise<LoadedCorpus> {
  const root = await realpath(dirname(manifestPath));
  const images = new Map<string, string[]>();
  const digestParts: Array<string | Uint8Array> = [manifestText];
  for (const fixture of manifest.fixtures) {
    const encoded: string[] = [];
    for (const entry of fixture.images) {
      if (isAbsolute(entry)) throw new Error(`fixture ${fixture.id} image path must be relative`);
      let path: string;
      try {
        path = await realpath(resolve(root, entry));
      } catch {
        throw new Error(`fixture ${fixture.id} image is missing`);
      }
      const fromRoot = relative(root, path);
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || !(await stat(path)).isFile()) {
        throw new Error(`fixture ${fixture.id} image path escapes the corpus`);
      }
      const bytes = await readFile(path);
      digestParts.push(fixture.id, entry, bytes);
      encoded.push(`data:${imageMime(path)};base64,${bytes.toString("base64")}`);
    }
    images.set(fixture.id, encoded);
  }
  return { digest: sha256(digestParts), images };
}

async function modelChat({ request, fixtureId, apiKey, model, side, meta }: ChatTransportInput): Promise<string> {
  const startedAt = performance.now();
  const record = (outcome: "ok" | "error", body?: unknown) =>
    transportTelemetry.push({
      side,
      fixtureId,
      stage: meta?.stage ?? "unknown",
      chunk: meta?.stage === "extract" ? meta.chunk : null,
      batch: meta?.stage === "enrich" ? meta.batch : null,
      durationMs: Math.round(performance.now() - startedAt),
      promptTokens: usageCount(body, "prompt_tokens"),
      completionTokens: usageCount(body, "completion_tokens"),
      outcome,
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), meta?.stage === "extract" ? AI_VISION_TIMEOUT_MS : 120_000);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: request.messages,
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });
  } catch {
    record("error");
    throw new Error(`fixture ${fixtureId}: OpenAI request failed before a response`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    record("error");
    throw new Error(`fixture ${fixtureId}: OpenAI returned status ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    record("error");
    throw new Error(`fixture ${fixtureId}: OpenAI returned an unreadable response`);
  }
  const content =
    ownObject(body) && Array.isArray(body.choices) && ownObject(body.choices[0]) && ownObject(body.choices[0].message) ? body.choices[0].message.content : null;
  if (typeof content !== "string") {
    record("error", body);
    throw new Error(`fixture ${fixtureId}: OpenAI response had no text result`);
  }
  record("ok", body);
  return content;
}

async function resolveTransport(): Promise<{ kind: TransportKind; chat: ChatTransport }> {
  const injected = process.env.ENVEO_IMPORT_EVAL_TEST_TRANSPORT;
  if (!injected) return { kind: "openai", chat: modelChat };
  if (process.env.ENVEO_IMPORT_EVAL_TEST_MODE !== "1" || process.env.ENVEO_TEST_RUNNER !== "run-tests") {
    throw new Error("injected evaluator transport is test-only");
  }
  let module: { chat?: ChatTransport };
  try {
    const path = await realpath(resolve(injected));
    module = (await import(pathToFileURL(path).href)) as { chat?: ChatTransport };
  } catch {
    throw new Error("injected evaluator transport could not be loaded");
  }
  if (typeof module.chat !== "function") throw new Error("injected evaluator transport has no chat function");
  return { kind: "injected-test", chat: module.chat };
}

async function loadSourceRoot(mode: "baseline" | "candidate", root: string, identity: SourceIdentity): Promise<LoadedSource> {
  const promptsPath = resolve(root, "packages/shared/src/aiPrompts.ts");
  await requireRegularFile(promptsPath, "source aiPrompts module");
  const prompts = (await import(pathToFileURL(promptsPath).href)) as RecognitionSourceModule;
  const adapter = classifySourceAdapter(mode, prompts.IMPORT_EXTRACT_JSON_SCHEMA);
  let baseline: BaselineProductionSeam | null = null;
  if (mode === "candidate") {
    if (typeof prompts.runImportRecognitionPipeline !== "function") throw new Error("candidate production recognition pipeline is missing");
    const candidateModules = {
      importRecognition: resolve(root, "packages/shared/src/importRecognition.ts"),
      importHistory: resolve(root, "packages/shared/src/importHistory.ts"),
      apiAdapter: resolve(root, "packages/api/src/routes/import.ts"),
      e2eeAdapter: resolve(root, "packages/web/src/lib/aiProvider/e2eeByok.ts"),
    };
    for (const [name, path] of Object.entries(candidateModules)) {
      await requireRegularFile(path, `candidate ${name} module`);
    }
  } else {
    const matchingPath = resolve(root, "packages/api/src/routes/import-match.ts");
    const routePath = resolve(root, "packages/api/src/routes/import.ts");
    const dbPath = resolve(root, "packages/api/src/db/client.ts");
    const schemaPath = resolve(root, "packages/api/src/db/schema.ts");
    await requireRegularFile(matchingPath, "baseline import matching module");
    await requireRegularFile(routePath, "baseline production import route");
    await requireRegularFile(dbPath, "baseline database client module");
    await requireRegularFile(schemaPath, "baseline database schema module");
    const route = (await import(pathToFileURL(routePath).href)) as Partial<BaselineRouteModule>;
    const database = (await import(pathToFileURL(dbPath).href)) as Partial<BaselineDbModule>;
    const schema = (await import(pathToFileURL(schemaPath).href)) as Partial<BaselineSchemaModule>;
    if (typeof route.extractImportForBudget !== "function") throw new Error("baseline production import route export is missing");
    if (!database.db || typeof database.db.select !== "function") throw new Error("baseline production database query seam is missing");
    if (!schema.budgets || !schema.envelopes || !schema.categories || !schema.transactions || !schema.places) {
      throw new Error("baseline production database schema seam is missing");
    }
    const tables = [schema.budgets, schema.envelopes, schema.categories, schema.transactions, schema.places];
    if (new Set(tables).size !== tables.length) throw new Error("baseline production database schema tables are ambiguous");
    baseline = { route: route as BaselineRouteModule, db: database.db, schema: schema as BaselineSchemaModule };
  }
  return { root, prompts, baseline, identity: { ...identity, adapter } };
}

export async function loadSnapshotSource(mode: "baseline" | "candidate", snapshot: SourceSnapshot): Promise<LoadedSource> {
  const state = snapshotStates.get(snapshot);
  if (!state || state.cleanupPromise) throw new Error("source load requires a verified immutable snapshot");
  return loadSourceRoot(mode, state.root, state.identity);
}

export async function runHistorySafetyGate(candidateRoot: string): Promise<HistorySafetyIdentity> {
  const sourceFiles = {
    sharedPipeline: resolve(candidateRoot, "packages/shared/src/aiPrompts.ts"),
    sharedHistory: resolve(candidateRoot, "packages/shared/src/importHistory.ts"),
    sharedRecognition: resolve(candidateRoot, "packages/shared/src/importRecognition.ts"),
    apiAdapter: resolve(candidateRoot, "packages/api/src/routes/import.ts"),
    e2eeAdapter: resolve(candidateRoot, "packages/web/src/lib/aiProvider/e2eeByok.ts"),
  };
  const testFiles = {
    sharedPipeline: resolve(candidateRoot, "packages/shared/src/aiPrompts.test.ts"),
    sharedHistory: resolve(candidateRoot, "packages/shared/src/importHistory.test.ts"),
    apiE2eeParity: resolve(candidateRoot, "packages/web/src/lib/aiProvider/e2eeByok.test.ts"),
  };
  const optionalHash = async (path: string): Promise<string | null> => {
    try {
      return (await stat(path)).isFile() ? await hashFile(path) : null;
    } catch {
      return null;
    }
  };
  const identity: HistorySafetyIdentity = {
    passed: false,
    reasons: [],
    sourceHashes: Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([name, path]) => [name, await optionalHash(path)]))),
    testHashes: Object.fromEntries(await Promise.all(Object.entries(testFiles).map(async ([name, path]) => [name, await optionalHash(path)]))),
  };
  if ([...Object.values(identity.sourceHashes), ...Object.values(identity.testHashes)].some((hash) => hash === null)) {
    identity.reasons.push("history_safety_file_missing");
    return identity;
  }

  let pipeline: ImportPipelineModule;
  let history: ImportHistoryModule;
  let recognition: ImportRecognitionModule;
  try {
    pipeline = (await import(pathToFileURL(sourceFiles.sharedPipeline).href)) as ImportPipelineModule;
    history = (await import(pathToFileURL(sourceFiles.sharedHistory).href)) as ImportHistoryModule;
    recognition = (await import(pathToFileURL(sourceFiles.sharedRecognition).href)) as ImportRecognitionModule;
  } catch {
    identity.reasons.push("history_safety_module_load_failed");
    return identity;
  }
  if (
    typeof pipeline.runImportRecognitionPipeline !== "function" ||
    typeof history.selectImportHistoryCandidates !== "function" ||
    typeof recognition.validateImportExtraction !== "function"
  ) {
    identity.reasons.push("history_safety_production_seam_missing");
    return identity;
  }

  const account = {
    id: "account-a",
    name: "Checking",
    color: "#000000",
    icon: "wallet",
    type: "checking",
    onBudget: true,
    initialBalance: 0,
    archived: false,
    sort: 0,
    automaticEnvelopeId: null,
  };
  const envelopes = [
    {
      id: "envelope-model",
      groupId: "group-a",
      name: "Model envelope",
      color: "#000000",
      icon: "tag",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: 0,
      archived: false,
    },
  ];
  const categories = [{ id: "category-model", name: "Model category" }];
  const historyRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    accountId: account.id,
    currency: "PLN",
    sourceRef: "BANK FUEL 123",
    tag: "FUEL",
    place: "History place",
    name: "History name",
    envelope: "History envelope",
    category: "History category",
    type: "expense",
    isRefund: false,
    toAccountId: null,
    ...overrides,
  });
  const scenarios = [
    { rawPlace: "BANK FUEL 123", records: [historyRecord()], match: "exact_source_ref", conflict: false },
    { rawPlace: "BANK FUEL 123 WARSAW", records: [historyRecord()], match: "source_similarity", conflict: false },
    {
      rawPlace: "BANK FUEL 123",
      records: [historyRecord({ sourceRef: null, tag: null, place: "BNK FUEL 123" })],
      match: "fuzzy_similarity",
      conflict: false,
    },
    {
      rawPlace: "BANK FUEL 123",
      records: [historyRecord(), historyRecord({ envelope: "Other history envelope", category: "Other history category" })],
      match: "exact_source_ref",
      conflict: true,
    },
    {
      rawPlace: "BANK FUEL 123",
      records: [historyRecord({ type: "income" }), historyRecord({ isRefund: true })],
      match: null,
      conflict: false,
    },
  ] as const;

  let safe = true;
  for (const scenario of scenarios) {
    let cycle = 0;
    const captured: { cycleTwoContext?: Record<string, unknown> } = {};
    const result = await pipeline.runImportRecognitionPipeline({
      images: ["data:image/png;base64,AA=="],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "PLN",
      accountId: account.id,
      accounts: [account],
      envelopes,
      categories,
      transactions: [],
      historyRecords: scenario.records,
      chat: async (request: { messages?: Array<{ content?: unknown }> }) => {
        cycle++;
        if (cycle === 1) {
          return JSON.stringify({
            rows: [
              {
                rowId: "row-a",
                imageIndex: 0,
                visualOrder: 0,
                rawTextLines: [scenario.rawPlace],
                date: "2026-08-15",
                amount: 1234,
                currency: "PLN",
                direction: "debit",
                postingStatus: "unknown",
                rowRole: "financial_event",
                semanticKind: "card_purchase",
                relation: null,
                confidence: "medium",
                reviewReasons: [],
              },
            ],
          });
        }
        const content = request.messages?.[1]?.content;
        if (typeof content === "string") {
          const parsed: unknown = JSON.parse(content);
          if (ownObject(parsed)) captured.cycleTwoContext = parsed;
        }
        return JSON.stringify({
          rows: [
            {
              rowId: "row-a",
              name: "Model name",
              place: "Model place",
              envelopeId: "envelope-model",
              categoryId: "category-model",
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: [],
              type: "income",
              isRefund: true,
            },
          ],
        });
      },
    });
    const contextRows = Array.isArray(captured.cycleTwoContext?.rows) ? captured.cycleTwoContext.rows : [];
    const contextRow = ownObject(contextRows[0]) ? contextRows[0] : {};
    const contextProposal = ownObject(contextRow.proposal) ? contextRow.proposal : {};
    const candidates = Array.isArray(contextRow.historyCandidates) ? contextRow.historyCandidates : [];
    const firstCandidate = ownObject(candidates[0]) ? candidates[0] : {};
    const outputRow = ownObject(result.rows[0]) ? result.rows[0] : {};
    const proposal = ownObject(result.proposals[0]) ? result.proposals[0] : {};
    const reviewReasons = Array.isArray(proposal.reviewReasons) ? proposal.reviewReasons : [];
    safe &&=
      cycle === 2 &&
      contextRow.date === "2026-08-15" &&
      contextRow.amount === 1234 &&
      contextRow.currency === "PLN" &&
      contextRow.direction === "debit" &&
      contextProposal.date === "2026-08-15" &&
      contextProposal.amount === 1234 &&
      contextProposal.currency === "PLN" &&
      contextProposal.type === "expense" &&
      contextProposal.isRefund === false &&
      contextRow.historyConflict === scenario.conflict &&
      candidates.length === (scenario.conflict ? 2 : scenario.match === null ? 0 : 1) &&
      (scenario.match === null || firstCandidate.match === scenario.match) &&
      outputRow.date === "2026-08-15" &&
      outputRow.amount === 1234 &&
      outputRow.currency === "PLN" &&
      outputRow.direction === "debit" &&
      proposal.date === "2026-08-15" &&
      proposal.amount === 1234 &&
      proposal.currency === "PLN" &&
      proposal.type === "expense" &&
      proposal.isRefund === false &&
      proposal.envelopeId === "envelope-model" &&
      proposal.categoryId === "category-model" &&
      proposal.name === "Model name" &&
      proposal.placeName === "Model place" &&
      reviewReasons.includes("unknown_posting_status") &&
      reviewReasons.includes("fact_correction") &&
      (!scenario.conflict || (reviewReasons.includes("history_conflict") && reviewReasons.includes("multiple_history_candidates")));
  }
  if (!safe) {
    identity.reasons.push("history_safety_semantic_check_failed");
    return identity;
  }

  const child = Bun.spawn([process.execPath, "test", ...Object.values(testFiles)], {
    cwd: candidateRoot,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, OPENAI_API_KEY: "", TEST_DATABASE_URL: "" },
  });
  if ((await child.exited) !== 0) {
    identity.reasons.push("history_safety_test_failed");
    return identity;
  }
  identity.passed = true;
  return identity;
}

const expectedForFixture = (fixture: RecognitionManifestFixture): ExpectedImportRecognitionRow[] =>
  fixture.rows.map((row) => ({
    id: `${fixture.id}:${row.id}`,
    rowRole: row.rowRole,
    postingStatus: row.postingStatus,
    safetyClass: row.safetyClass,
    requiredSafetyReasons: row.requiredSafetyReasons,
    expectedDuplicateStatus: row.expectedDuplicateStatus,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    direction: row.direction,
    semanticKind: row.semanticKind,
    relation: prefixedRelation(fixture.id, row.relation),
    expectedProposal: row.expectedProposal,
  }));

let baselineDbSeamTail = Promise.resolve();

const serializeBaselineDbSeam = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = baselineDbSeamTail;
  let release = (): void => {};
  baselineDbSeamTail = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

const baselineFixtureRows = (seam: BaselineProductionSeam, fixture: RecognitionManifestFixture): ((table: unknown, selection: unknown) => unknown[]) => {
  const envelopeIdByName = new Map(fixture.context.envelopes.map((entry) => [String(entry.name), String(entry.id)]));
  const categoryIdByName = new Map(fixture.context.categories.map((entry) => [String(entry.name), String(entry.id)]));
  const placeIdByName = new Map<string, string>();
  for (const record of fixture.context.historyRecords) {
    if (record.place !== null && !placeIdByName.has(record.place)) placeIdByName.set(record.place, `evaluation-place-${placeIdByName.size}`);
  }
  const places = [...placeIdByName].map(([name, id]) => ({ id, name }));
  const transactions = fixture.context.historyRecords.map((record) => ({
    name: record.name,
    envelopeId: record.envelope === null ? null : (envelopeIdByName.get(record.envelope) ?? null),
    categoryId: record.category === null ? null : (categoryIdByName.get(record.category) ?? null),
    placeId: record.place === null ? null : (placeIdByName.get(record.place) ?? null),
    tag: record.tag,
    sourceRef: record.sourceRef,
    type: record.type,
    isRefund: record.isRefund,
    toAccountId: record.toAccountId,
  }));
  return (table, selection) => {
    if (table === seam.schema.budgets) return [{ currency: fixture.budgetCurrency }];
    if (table === seam.schema.envelopes) {
      return selection === undefined ? fixture.context.envelopes : fixture.context.envelopes.filter((entry) => entry.archived !== true);
    }
    if (table === seam.schema.categories) return fixture.context.categories;
    if (table === seam.schema.transactions) return transactions;
    if (table === seam.schema.places) return places;
    throw new Error("baseline production route queried an unexpected table");
  };
};

export async function runBaselineProductionAdapter(input: {
  source: LoadedSource;
  fixture: RecognitionManifestFixture;
  images: string[];
  chat: (request: ChatRequest) => Promise<string>;
}): Promise<BaselineItem[]> {
  const { source, fixture, images, chat } = input;
  if (!source.baseline) throw new Error("baseline production route seam is unavailable");
  return serializeBaselineDbSeam(async () => {
    const originalSelect = source.baseline!.db.select;
    const originalConsoleLog = console.log;
    const OriginalDate = globalThis.Date;
    const fixedNow = OriginalDate.parse(`${fixture.today}T12:00:00.000Z`);
    const FixtureDate = new Proxy(OriginalDate, {
      apply(target, thisArg, args) {
        return args.length === 0 ? new OriginalDate(fixedNow).toString() : Reflect.apply(target, thisArg, args);
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, args.length === 0 ? [fixedNow] : args, newTarget);
      },
      get(target, property, receiver) {
        return property === "now" ? () => fixedNow : Reflect.get(target, property, receiver);
      },
    });
    const rowsFor = baselineFixtureRows(source.baseline!, fixture);
    const fixtureSelect = (selection?: unknown): unknown => ({
      from: (table: unknown) => ({ where: async () => structuredClone(rowsFor(table, selection)) }),
    });
    source.baseline!.db.select = fixtureSelect;
    if (source.baseline!.db.select !== fixtureSelect) throw new Error("baseline production database seam could not be installed");
    let routeFailed = false;
    let routeFailure: unknown;
    let items: BaselineItem[] | undefined;
    try {
      globalThis.Date = FixtureDate as DateConstructor;
      console.log = () => {};
      items = await source.baseline!.route.extractImportForBudget({
        budgetId: `evaluation:${fixture.id}`,
        images,
        locale: fixture.locale,
        chat,
      });
    } catch (error) {
      routeFailed = true;
      routeFailure = error;
    } finally {
      globalThis.Date = OriginalDate;
      console.log = originalConsoleLog;
      source.baseline!.db.select = originalSelect;
    }
    if (globalThis.Date !== OriginalDate) throw new Error("baseline production clock seam was not restored");
    if (console.log !== originalConsoleLog) throw new Error("baseline production log seam was not restored");
    if (source.baseline!.db.select !== originalSelect) throw new Error("baseline production database seam was not restored");
    if (routeFailed) throw routeFailure;
    if (!Array.isArray(items)) throw new Error("baseline production route returned an invalid result");
    return items;
  });
}

interface SideRunResult {
  actual: ActualImportRecognitionRow[];
  contractFailures: string[];
}

class EvaluationTransportFailure extends Error {
  constructor(readonly reason: unknown) {
    super("evaluation_transport_failed");
  }
}

const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    if (typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    current = record.reason ?? record.cause;
  }
  return chain;
};

const MODEL_CONTRACT_ERROR_MESSAGES = new Set(["import row imageIndex is outside the supplied images"]);

const isModelContractFailure = (error: unknown): boolean =>
  errorChain(error).some(
    (entry) =>
      entry instanceof SyntaxError ||
      (typeof entry === "object" &&
        entry !== null &&
        ((entry as { name?: unknown }).name === "ZodError" || MODEL_CONTRACT_ERROR_MESSAGES.has(String((entry as { message?: unknown }).message ?? "")))),
  );

async function runSide(
  mode: "baseline" | "candidate",
  source: LoadedSource,
  manifest: RecognitionManifest,
  corpus: LoadedCorpus,
  transport: ChatTransport,
  apiKey: string,
  model: string,
): Promise<SideRunResult> {
  const actual: ActualImportRecognitionRow[] = [];
  const contractFailures: string[] = [];
  for (const fixture of manifest.fixtures) {
    const images = corpus.images.get(fixture.id);
    if (!images) throw new Error(`fixture ${fixture.id}: loaded images are missing`);
    const chat = async (request: ChatRequest, _timeoutMs?: number, meta?: ImportRecognitionChatMeta): Promise<string> => {
      try {
        return await transport({ side: mode, fixtureId: fixture.id, request, apiKey, model, meta });
      } catch (error) {
        throw new EvaluationTransportFailure(error);
      }
    };
    try {
      if (mode === "baseline") {
        const result = await runBaselineProductionAdapter({ source, fixture, images, chat });
        actual.push(...normalizeBaselineRecognition(fixture.id, fixture.rows, result));
      } else {
        if (!source.prompts.runImportRecognitionPipeline) throw new Error("missing candidate production pipeline");
        const result = await source.prompts.runImportRecognitionPipeline({
          images,
          locale: fixture.locale,
          today: fixture.today,
          budgetCurrency: fixture.budgetCurrency,
          accountId: fixture.context.accountId,
          accounts: fixture.context.accounts,
          envelopes: fixture.context.envelopes,
          categories: fixture.context.categories,
          transactions: fixture.context.transactions,
          historyRecords: fixture.context.historyRecords,
          chat,
        });
        actual.push(...normalizeCandidateRecognition(fixture.id, fixture.rows, parseCandidateResult(result, images.length)));
      }
    } catch (error) {
      if (errorChain(error).some((entry) => entry instanceof EvaluationTransportFailure)) {
        throw new Error(`fixture ${fixture.id}: ${mode} model transport failed`);
      }
      if (isModelContractFailure(error)) {
        contractFailures.push(fixture.id);
        continue;
      }
      throw new Error(`fixture ${fixture.id}: model output did not satisfy the ${mode} contract`);
    }
  }
  return { actual, contractFailures };
}

async function runEvaluation(args: EvaluationArgs): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey?.trim() || !model?.trim()) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are both required; no live evaluation was run");

  const snapshots: SourceSnapshot[] = [];
  let pairedSources: { baseline: LoadedSource; candidate: LoadedSource } | null = null;
  let diagnosticSource: LoadedSource | null = null;
  try {
    if (args.mode === "compare") {
      const baselinePreflight = await preflightSource("baseline", args.baselineSourceTree);
      const candidatePreflight = await preflightSource("candidate", args.candidateSourceTree, args.expectedCandidateRevision);
      if (!baselinePreflight.identity.bound || !candidatePreflight.identity.bound) {
        process.stdout.write(
          `${JSON.stringify(
            {
              mode: "compare",
              releaseEligible: false,
              identity: { model, transport: "not_loaded", sources: { baseline: baselinePreflight.identity, candidate: candidatePreflight.identity } },
              metrics: null,
              decision: { passed: false, criteriaPassed: false, reasons: ["source_identity_unbound"], transitions: null },
            },
            null,
            2,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const baselineSnapshot = await materializeSourceSnapshot(baselinePreflight);
      snapshots.push(baselineSnapshot);
      const candidateSnapshot = await materializeSourceSnapshot(candidatePreflight);
      snapshots.push(candidateSnapshot);
      if (
        process.env.ENVEO_IMPORT_EVAL_TEST_MODE === "1" &&
        process.env.ENVEO_TEST_RUNNER === "run-tests" &&
        process.env.ENVEO_IMPORT_EVAL_TEST_MUTATE_PATH &&
        process.env.ENVEO_IMPORT_EVAL_TEST_MUTATE_CONTENT !== undefined
      ) {
        const target = await realpath(process.env.ENVEO_IMPORT_EVAL_TEST_MUTATE_PATH);
        const fromCandidate = relative(candidatePreflight.root, target);
        if (fromCandidate.startsWith("..") || isAbsolute(fromCandidate)) throw new Error("test mutation target escapes candidate source");
        await Bun.write(target, process.env.ENVEO_IMPORT_EVAL_TEST_MUTATE_CONTENT);
      }
      pairedSources = {
        baseline: await loadSnapshotSource("baseline", baselineSnapshot),
        candidate: await loadSnapshotSource("candidate", candidateSnapshot),
      };
    } else {
      const preflight = await preflightSource(args.mode, args.sourceTree, args.expectedRevision);
      if (!preflight.identity.bound) {
        process.stdout.write(
          `${JSON.stringify(
            {
              mode: args.mode,
              releaseEligible: false,
              identity: { model, transport: "not_loaded", source: preflight.identity },
              metrics: null,
              diagnosticOnly: true,
              decision: { passed: false, reasons: ["source_identity_unbound"] },
            },
            null,
            2,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const snapshot = await materializeSourceSnapshot(preflight);
      snapshots.push(snapshot);
      diagnosticSource = await loadSnapshotSource(args.mode, snapshot);
    }

    if (
      process.env.ENVEO_IMPORT_EVAL_TEST_MODE === "1" &&
      process.env.ENVEO_TEST_RUNNER === "run-tests" &&
      process.env.ENVEO_IMPORT_EVAL_TEST_CORPUS_READ_SENTINEL
    ) {
      await Bun.write(process.env.ENVEO_IMPORT_EVAL_TEST_CORPUS_READ_SENTINEL, "read");
    }
    const manifestPath = await realpath(resolve(args.manifestPath));
    const manifestText = await readFile(manifestPath, "utf8");
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(manifestText);
    } catch {
      throw new Error("manifest is not valid JSON");
    }
    const manifest = parseRecognitionManifest(manifestValue);
    const corpus = await loadCorpus(manifestPath, manifestText, manifest);
    const expected = manifest.fixtures.flatMap(expectedForFixture);
    const fixtureIds = manifest.fixtures.map((fixture) => fixture.id);
    const transport = await resolveTransport();

    if (args.mode === "compare") {
      if (!pairedSources) throw new Error("paired sources were not loaded");
      const { baseline: baselineSource, candidate: candidateSource } = pairedSources;
      const historySafety = await runHistorySafetyGate(candidateSource.root);
      if (!historySafety.passed) {
        process.stdout.write(
          `${JSON.stringify(
            {
              mode: "compare",
              releaseEligible: false,
              identity: {
                model,
                transport: transport.kind,
                corpusDigest: corpus.digest,
                fixtureIds,
                sources: { baseline: baselineSource.identity, candidate: candidateSource.identity },
                historySafety,
              },
              metrics: null,
              decision: { passed: false, criteriaPassed: false, reasons: [...historySafety.reasons, "paired_runs_missing"], transitions: null },
            },
            null,
            2,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      let baselineRun: SideRunResult;
      let candidateRun: SideRunResult;
      try {
        baselineRun = await runSide("baseline", baselineSource, manifest, corpus, transport.chat, apiKey, model);
        candidateRun = await runSide("candidate", candidateSource, manifest, corpus, transport.chat, apiKey, model);
      } catch {
        process.stdout.write(
          `${JSON.stringify(
            {
              mode: "compare",
              releaseEligible: false,
              identity: {
                model,
                transport: transport.kind,
                corpusDigest: corpus.digest,
                fixtureIds,
                sources: { baseline: baselineSource.identity, candidate: candidateSource.identity },
                historySafety,
              },
              metrics: null,
              decision: { passed: false, criteriaPassed: false, reasons: ["paired_runs_missing"], transitions: null },
            },
            null,
            2,
          )}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const decision = gateImportRecognition(expected, baselineRun.actual, candidateRun.actual);
      const finalBaselineIdentity = await preflightSource("baseline", args.baselineSourceTree);
      const finalCandidateIdentity = await preflightSource("candidate", args.candidateSourceTree, args.expectedCandidateRevision);
      const identityBound =
        baselineSource.identity.bound && candidateSource.identity.bound && finalBaselineIdentity.identity.bound && finalCandidateIdentity.identity.bound;
      const release = comparisonReleaseStatus(transport.kind, decision.passed, decision.reasons, identityBound);
      const output = {
        mode: "compare",
        releaseEligible: release.releaseEligible,
        identity: {
          model,
          transport: transport.kind,
          corpusDigest: corpus.digest,
          fixtureIds,
          sources: { baseline: baselineSource.identity, candidate: candidateSource.identity },
          finalSources: { baseline: finalBaselineIdentity.identity, candidate: finalCandidateIdentity.identity },
          historySafety,
          contractFailures: { baseline: baselineRun.contractFailures, candidate: candidateRun.contractFailures },
        },
        metrics: { baseline: decision.baseline, candidate: decision.candidate },
        decision: { passed: release.passed, criteriaPassed: decision.passed, reasons: release.reasons, transitions: decision.transitions },
        telemetry: telemetrySummary(),
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      if (release.exitCode !== 0) process.exitCode = release.exitCode;
      return;
    }

    if (!diagnosticSource) throw new Error("diagnostic source was not loaded");
    const source = diagnosticSource;
    const historySafety = args.mode === "candidate" ? await runHistorySafetyGate(source.root) : null;
    if (historySafety && !historySafety.passed) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: args.mode,
            releaseEligible: false,
            identity: { model, transport: transport.kind, corpusDigest: corpus.digest, fixtureIds, source: source.identity, historySafety },
            metrics: null,
            diagnosticOnly: true,
            decision: { passed: false, reasons: [...historySafety.reasons, "diagnostic_only"] },
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const run = await runSide(args.mode, source, manifest, corpus, transport.chat, apiKey, model);
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: args.mode,
          releaseEligible: false,
          identity: {
            model,
            transport: transport.kind,
            corpusDigest: corpus.digest,
            fixtureIds,
            source: source.identity,
            historySafety,
            contractFailures: run.contractFailures,
          },
          metrics: scoreImportRecognition(expected, run.actual),
          diagnosticOnly: true,
          decision: { passed: false, reasons: ["diagnostic_only"] },
          telemetry: telemetrySummary(),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 2;
  } finally {
    for (const snapshot of snapshots.reverse()) await snapshot.cleanup();
  }
}

if (import.meta.main) {
  runEvaluation(parseEvalArgs(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown evaluator failure";
    process.stderr.write(`import recognition evaluation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
