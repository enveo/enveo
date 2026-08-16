import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_CURRENCIES } from "../packages/shared/src/currency";
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
  rows: RecognitionManifestRow[];
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
  parseImportExtractResponse: (raw: string) => unknown;
}

interface CandidateValidationModule {
  validateImportExtraction: (input: { batch: unknown; budgetCurrency: string }) => unknown;
}

interface ImportHistoryModule {
  selectImportHistoryCandidates: (
    query: Record<string, unknown>,
    records: Array<Record<string, unknown>>,
  ) => {
    candidates: Array<Record<string, unknown>>;
    conflict: boolean;
  };
}

interface AssignmentModule {
  decideAssignment: (rawPlace: string, model: Record<string, string | null> | undefined) => Record<string, string | null>;
}

interface BaselineItem {
  date: string;
  amount: number;
  currency: string;
  type: "expense" | "income";
  isRefund: boolean;
  rawPlace?: string;
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
}

interface CandidateResult {
  rows: CandidateRow[];
  proposals: CandidateProposal[];
}

const ownObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export type EvaluationArgs =
  | { manifestPath: string; mode: "baseline" | "candidate"; sourceTree: string }
  | { manifestPath: string; mode: "compare"; baselineSourceTree: string; candidateSourceTree: string };

export function parseEvalArgs(argv: readonly string[]): EvaluationArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`expected a value after ${flag ?? "argument"}`);
    if (!["--manifest", "--mode", "--source-tree", "--baseline-source-tree", "--candidate-source-tree"].includes(flag)) {
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
    if (!baselineSourceTree) throw new Error("--baseline-source-tree is required in compare mode");
    if (!candidateSourceTree) throw new Error("--candidate-source-tree is required in compare mode");
    if (values.has("--source-tree")) throw new Error("--source-tree is not valid in compare mode");
    return { manifestPath, mode, baselineSourceTree, candidateSourceTree };
  }
  if (mode !== "baseline" && mode !== "candidate") throw new Error("--mode must be baseline, candidate, or compare");
  const sourceTree = values.get("--source-tree");
  if (!sourceTree) throw new Error("--source-tree is required");
  if (values.has("--baseline-source-tree") || values.has("--candidate-source-tree")) throw new Error("paired source options require compare mode");
  return { manifestPath, mode, sourceTree };
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
      date: item.date,
      amount: item.amount,
      currency: item.currency.toUpperCase(),
      direction: item.type === "income" || isRefund ? "credit" : "debit",
      semanticKind: isRefund ? "merchant_refund" : item.type === "income" ? "incoming_transfer" : "card_purchase",
      relation: null,
      proposal: {
        selected: true,
        disposition: "candidate",
        reviewReasons: [],
        type: item.type,
        isRefund,
        toAccountId: null,
        envelopeId: null,
        categoryId: null,
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
  const truthByModelId = new Map(
    result.rows.map((row) => [
      row.rowId,
      matchExpectedRow(row.rawTextLines?.join("\n"), expected) ?? expectedByPosition.get(`${row.imageIndex}:${row.visualOrder}`),
    ]),
  );
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
      date: row.date,
      amount: row.amount,
      currency: row.currency?.toUpperCase() ?? null,
      direction: row.direction,
      semanticKind: row.semanticKind,
      relation: row.relation
        ? { kind: row.relation.kind, rowId: normalizedIdByModelId.get(row.relation.rowId) ?? `${fixtureId}:unexpected-relation-target` }
        : null,
      proposal: proposal
        ? {
            selected: proposal.selected,
            disposition: proposal.disposition,
            reviewReasons: proposal.reviewReasons,
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
const RELATION_KINDS = new Set(["fx_for", "refund_of", "pending_version_of", "fee_for", "duplicate_of", "counterpart_of", "continuation_of"]);
const REVIEW_REASONS = new Set([
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
  "unknown_kind",
]);
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
  const semanticKind = requireString(value.semanticKind, `${field}.semanticKind`);
  if (!SEMANTIC_KINDS.has(semanticKind)) throw new Error(`manifest ${field}.semanticKind is invalid`);
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
  const kinds = new Set(manifest.fixtures.flatMap((fixture) => fixture.rows.map((row) => row.semanticKind)));
  const statuses = new Set(manifest.fixtures.flatMap((fixture) => fixture.rows.map((row) => row.postingStatus)));
  const forms = new Set(manifest.fixtures.map((fixture) => fixture.formFactor));
  const languages = new Set(manifest.fixtures.map((fixture) => new Intl.Locale(fixture.locale).language));
  const currencies = new Set(
    manifest.fixtures.flatMap((fixture) => [
      fixture.budgetCurrency,
      ...fixture.rows.map((row) => row.currency).filter((code): code is string => code !== null),
    ]),
  );
  const requiredKinds = [
    "card_purchase",
    "salary",
    "merchant_refund",
    "cashback_or_reward",
    "incoming_transfer",
    "outgoing_transfer",
    "account_topup",
    "fx_conversion",
  ];
  const missing = requiredKinds.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) throw new Error("manifest corpus coverage is missing required transaction classes");
  if (!statuses.has("pending") || !statuses.has("declined")) throw new Error("manifest corpus coverage requires pending and declined rows");
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
    assertOnlyKeys(fixture, ["id", "images", "locale", "today", "budgetCurrency", "formFactor", "overlap", "rows"], field);
    const id = requireString(fixture.id, `${field}.id`);
    if (fixtureIds.has(id)) throw new Error(`manifest has duplicate fixture id at ${field}`);
    fixtureIds.add(id);
    if (fixture.images.length === 0 || fixture.images.length > 6) throw new Error(`manifest ${field}.images must contain 1-6 paths`);
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
}

type ChatTransport = (input: ChatTransportInput) => Promise<string>;

interface SourceIdentity {
  revision: string;
  adapter: SourceAdapter;
  moduleHashes: Record<string, string>;
}

interface LoadedSource {
  root: string;
  prompts: RecognitionSourceModule;
  validation: CandidateValidationModule | null;
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

const hashFile = async (path: string): Promise<string> => sha256([await readFile(path)]);

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

async function modelChat({ request, fixtureId, apiKey, model }: ChatTransportInput): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
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
    throw new Error(`fixture ${fixtureId}: OpenAI request failed before a response`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`fixture ${fixtureId}: OpenAI returned status ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`fixture ${fixtureId}: OpenAI returned an unreadable response`);
  }
  const content =
    ownObject(body) && Array.isArray(body.choices) && ownObject(body.choices[0]) && ownObject(body.choices[0].message) ? body.choices[0].message.content : null;
  if (typeof content !== "string") throw new Error(`fixture ${fixtureId}: OpenAI response had no text result`);
  return content;
}

async function resolveTransport(): Promise<{ kind: "openai" | "injected-test"; chat: ChatTransport }> {
  const injected = process.env.ENVEO_IMPORT_EVAL_TEST_TRANSPORT;
  if (!injected) return { kind: "openai", chat: modelChat };
  if (process.env.ENVEO_IMPORT_EVAL_TEST_MODE !== "1") throw new Error("injected evaluator transport is test-only");
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

async function sourceRevision(root: string): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 && /^[0-9a-f]{40}\n?$/.test(output) ? output.trim() : "unversioned";
}

async function loadSource(mode: "baseline" | "candidate", sourceTree: string): Promise<LoadedSource> {
  const root = await realpath(resolve(sourceTree));
  const promptsPath = resolve(root, "packages/shared/src/aiPrompts.ts");
  await requireRegularFile(promptsPath, "source aiPrompts module");
  const prompts = (await import(pathToFileURL(promptsPath).href)) as RecognitionSourceModule;
  const adapter = classifySourceAdapter(mode, prompts.IMPORT_EXTRACT_JSON_SCHEMA);
  const moduleHashes: Record<string, string> = { aiPrompts: await hashFile(promptsPath) };
  let validation: CandidateValidationModule | null = null;
  if (mode === "candidate") {
    const validationPath = resolve(root, "packages/shared/src/importRecognition.ts");
    await requireRegularFile(validationPath, "candidate importRecognition module");
    validation = (await import(pathToFileURL(validationPath).href)) as CandidateValidationModule;
    moduleHashes.importRecognition = await hashFile(validationPath);
  }
  return { root, prompts, validation, identity: { revision: await sourceRevision(root), adapter, moduleHashes } };
}

async function runHistorySafetyGate(candidateRoot: string): Promise<HistorySafetyIdentity> {
  const sourceFiles = {
    importHistory: resolve(candidateRoot, "packages/shared/src/importHistory.ts"),
    importAssignment: resolve(candidateRoot, "packages/api/src/routes/import-match.ts"),
  };
  const testFiles = {
    importHistory: resolve(candidateRoot, "packages/shared/src/importHistory.test.ts"),
    importAssignment: resolve(candidateRoot, "packages/api/src/routes/import-match.test.ts"),
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
    sourceHashes: {
      importHistory: await optionalHash(sourceFiles.importHistory),
      importAssignment: await optionalHash(sourceFiles.importAssignment),
    },
    testHashes: {
      importHistory: await optionalHash(testFiles.importHistory),
      importAssignment: await optionalHash(testFiles.importAssignment),
    },
  };
  if ([...Object.values(identity.sourceHashes), ...Object.values(identity.testHashes)].some((hash) => hash === null)) {
    identity.reasons.push("history_safety_file_missing");
    return identity;
  }

  let history: ImportHistoryModule;
  let assignment: AssignmentModule;
  try {
    history = (await import(pathToFileURL(sourceFiles.importHistory).href)) as ImportHistoryModule;
    assignment = (await import(pathToFileURL(sourceFiles.importAssignment).href)) as AssignmentModule;
  } catch {
    identity.reasons.push("history_safety_module_load_failed");
    return identity;
  }
  if (typeof history.selectImportHistoryCandidates !== "function" || typeof assignment.decideAssignment !== "function") {
    identity.reasons.push("history_safety_production_seam_missing");
    return identity;
  }
  const visibleProposal = {
    rawPlace: "BANK FUEL 123",
    tag: "FUEL",
    currency: "PLN",
    type: "expense",
    isRefund: false,
    semanticKind: "card_purchase",
    toAccountId: null,
  };
  const query = { accountId: "account-a", ownedAccountIds: ["account-a", "account-b"], proposal: visibleProposal };
  const record = {
    accountId: "account-a",
    currency: "PLN",
    sourceRef: "BANK FUEL 123",
    tag: "FUEL",
    place: "Fuel station",
    name: "Fuel",
    envelope: "Car",
    category: "Fuel",
    type: "expense",
    isRefund: false,
    toAccountId: null,
  };
  const before = JSON.stringify(query);
  const exact = history.selectImportHistoryCandidates(query, [record]);
  const contained = history.selectImportHistoryCandidates({ ...query, proposal: { ...visibleProposal, rawPlace: "BANK FUEL 123 WARSAW" } }, [record]);
  const fuzzy = history.selectImportHistoryCandidates({ ...query, proposal: { ...visibleProposal, rawPlace: "BNK FUEL 123" } }, [record]);
  const incompatible = history.selectImportHistoryCandidates(query, [
    { ...record, type: "income" },
    { ...record, isRefund: true },
  ]);
  const conflict = history.selectImportHistoryCandidates(query, [record, { ...record, envelope: "Other", category: "Other" }]);
  const modelAssignment = { name: "Visible", place: "Visible", envelope: "Visible", category: "Visible" };
  const assigned = assignment.decideAssignment("BANK FUEL 123", modelAssignment);
  const fallback = assignment.decideAssignment("BANK FUEL 123", undefined);
  const safe =
    JSON.stringify(query) === before &&
    exact.candidates.length > 0 &&
    contained.candidates.length > 0 &&
    fuzzy.candidates.length > 0 &&
    incompatible.candidates.length === 0 &&
    conflict.conflict === true &&
    conflict.candidates.length > 1 &&
    JSON.stringify(assigned) === JSON.stringify(modelAssignment) &&
    fallback.name === "BANK FUEL 123" &&
    fallback.place === null &&
    fallback.envelope === null &&
    fallback.category === null;
  if (!safe) {
    identity.reasons.push("history_safety_semantic_check_failed");
    return identity;
  }

  const child = Bun.spawn([process.execPath, "test", testFiles.importHistory, testFiles.importAssignment], {
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
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    direction: row.direction,
    semanticKind: row.semanticKind,
    relation: prefixedRelation(fixture.id, row.relation),
    expectedProposal: row.expectedProposal,
  }));

async function runSide(
  mode: "baseline" | "candidate",
  source: LoadedSource,
  manifest: RecognitionManifest,
  corpus: LoadedCorpus,
  transport: ChatTransport,
  apiKey: string,
  model: string,
): Promise<ActualImportRecognitionRow[]> {
  const actual: ActualImportRecognitionRow[] = [];
  for (const fixture of manifest.fixtures) {
    const images = corpus.images.get(fixture.id);
    if (!images) throw new Error(`fixture ${fixture.id}: loaded images are missing`);
    const request = source.prompts.buildImportExtractPrompt(images, { envelopes: [], categories: [] }, fixture.today, fixture.locale, fixture.budgetCurrency);
    let raw: string;
    try {
      raw = await transport({ side: mode, fixtureId: fixture.id, request, apiKey, model });
    } catch {
      throw new Error(`fixture ${fixture.id}: model transport failed`);
    }
    try {
      const parsed = source.prompts.parseImportExtractResponse(raw);
      if (mode === "baseline") {
        if (!Array.isArray(parsed)) throw new Error("wrong legacy shape");
        actual.push(...normalizeBaselineRecognition(fixture.id, fixture.rows, parsed as BaselineItem[]));
      } else {
        if (!source.validation) throw new Error("missing candidate validation");
        const result = source.validation.validateImportExtraction({ batch: parsed, budgetCurrency: fixture.budgetCurrency });
        actual.push(...normalizeCandidateRecognition(fixture.id, fixture.rows, result as CandidateResult));
      }
    } catch {
      throw new Error(`fixture ${fixture.id}: model output did not satisfy the ${mode} contract`);
    }
  }
  return actual;
}

async function runEvaluation(args: EvaluationArgs): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey?.trim() || !model?.trim()) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are both required; no live evaluation was run");

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
    const baselineSource = await loadSource("baseline", args.baselineSourceTree);
    const candidateSource = await loadSource("candidate", args.candidateSourceTree);
    const historySafety = await runHistorySafetyGate(candidateSource.root);
    if (!historySafety.passed) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: "compare",
            identity: {
              model,
              transport: transport.kind,
              corpusDigest: corpus.digest,
              fixtureIds,
              sources: { baseline: baselineSource.identity, candidate: candidateSource.identity },
              historySafety,
            },
            metrics: null,
            decision: { passed: false, reasons: [...historySafety.reasons, "paired_runs_missing"], transitions: null },
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
      return;
    }
    let baselineActual: ActualImportRecognitionRow[];
    let candidateActual: ActualImportRecognitionRow[];
    try {
      baselineActual = await runSide("baseline", baselineSource, manifest, corpus, transport.chat, apiKey, model);
      candidateActual = await runSide("candidate", candidateSource, manifest, corpus, transport.chat, apiKey, model);
    } catch {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: "compare",
            identity: {
              model,
              transport: transport.kind,
              corpusDigest: corpus.digest,
              fixtureIds,
              sources: { baseline: baselineSource.identity, candidate: candidateSource.identity },
              historySafety,
            },
            metrics: null,
            decision: { passed: false, reasons: ["paired_runs_missing"], transitions: null },
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const decision = gateImportRecognition(expected, baselineActual, candidateActual);
    const output = {
      mode: "compare",
      identity: {
        model,
        transport: transport.kind,
        corpusDigest: corpus.digest,
        fixtureIds,
        sources: { baseline: baselineSource.identity, candidate: candidateSource.identity },
        historySafety,
      },
      metrics: { baseline: decision.baseline, candidate: decision.candidate },
      decision: { passed: decision.passed, reasons: decision.reasons, transitions: decision.transitions },
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!decision.passed) process.exitCode = 1;
    return;
  }

  const source = await loadSource(args.mode, args.sourceTree);
  const historySafety = args.mode === "candidate" ? await runHistorySafetyGate(source.root) : null;
  if (historySafety && !historySafety.passed) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: args.mode,
          identity: { model, transport: transport.kind, corpusDigest: corpus.digest, fixtureIds, source: source.identity, historySafety },
          metrics: null,
          diagnosticOnly: true,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const actual = await runSide(args.mode, source, manifest, corpus, transport.chat, apiKey, model);
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: args.mode,
        identity: { model, transport: transport.kind, corpusDigest: corpus.digest, fixtureIds, source: source.identity, historySafety },
        metrics: scoreImportRecognition(expected, actual),
        diagnosticOnly: true,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  runEvaluation(parseEvalArgs(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown evaluator failure";
    process.stderr.write(`import recognition evaluation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
