import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ActualImportRecognitionProposal,
  type ActualImportRecognitionRow,
  type ExpectedImportRecognitionRow,
  type ImportRecognitionDirection,
  type ImportRecognitionProposalTruth,
  type ImportRecognitionRelation,
  scoreImportRecognition,
} from "./lib/importRecognitionMetrics";

export type EvaluationMode = "baseline" | "candidate";
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
  semanticKind: string;
  relation: ImportRecognitionRelation | null;
  rawTextLines?: string[];
}

interface CandidateProposal extends ActualImportRecognitionProposal {
  rowId: string;
}

interface CandidateResult {
  rows: CandidateRow[];
  proposals: CandidateProposal[];
}

const ownObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseEvalArgs(argv: readonly string[]): { manifestPath: string; mode: EvaluationMode; sourceTree: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`expected a value after ${flag ?? "argument"}`);
    if (!["--manifest", "--mode", "--source-tree"].includes(flag)) throw new Error(`unknown option ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate option ${flag}`);
    values.set(flag, value);
  }
  const manifestPath = values.get("--manifest");
  const mode = values.get("--mode");
  const sourceTree = values.get("--source-tree");
  if (!manifestPath) throw new Error("--manifest is required");
  if (mode !== "baseline" && mode !== "candidate") throw new Error("--mode must be baseline or candidate");
  if (!sourceTree) throw new Error("--source-tree is required");
  return { manifestPath, mode, sourceTree };
}

export function classifySourceAdapter(mode: EvaluationMode, schema: unknown): SourceAdapter {
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

const nullableString = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  return requireString(value, field);
};

const parseRelation = (value: unknown, field: string): ImportRecognitionRelation | null => {
  if (value === null) return null;
  if (!ownObject(value)) throw new Error(`manifest ${field} must be an object or null`);
  return { kind: requireString(value.kind, `${field}.kind`), rowId: requireString(value.rowId, `${field}.rowId`) };
};

const parseProposalTruth = (value: unknown, field: string): ImportRecognitionProposalTruth | null => {
  if (value === null) return null;
  if (!ownObject(value)) throw new Error(`manifest ${field} must be an object or null`);
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
  if (typeof value.material !== "boolean") throw new Error(`manifest ${field}.material must be boolean`);
  return {
    id: requireString(value.id, `${field}.id`),
    material: value.material,
    date: nullableString(value.date, `${field}.date`),
    amount: amount as number | null,
    currency: nullableString(value.currency, `${field}.currency`)?.toUpperCase() ?? null,
    direction: value.direction,
    semanticKind: requireString(value.semanticKind, `${field}.semanticKind`),
    relation: parseRelation(value.relation, `${field}.relation`),
    expectedProposal: parseProposalTruth(value.expectedProposal, `${field}.expectedProposal`),
    matchText: requireString(value.matchText, `${field}.matchText`),
    candidatePosition: { imageIndex: imageIndex as number, visualOrder: visualOrder as number },
    baselineIndex: value.baselineIndex as number | null,
  };
};

export function parseRecognitionManifest(value: unknown): RecognitionManifest {
  if (!ownObject(value) || value.version !== 1 || !Array.isArray(value.fixtures) || value.fixtures.length === 0) {
    throw new Error("manifest must contain version 1 and at least one fixture");
  }
  const fixtureIds = new Set<string>();
  const fixtures = value.fixtures.map((fixture, fixtureIndex) => {
    const field = `fixtures[${fixtureIndex}]`;
    if (!ownObject(fixture) || !Array.isArray(fixture.images) || !Array.isArray(fixture.rows)) throw new Error(`manifest ${field} is invalid`);
    const id = requireString(fixture.id, `${field}.id`);
    if (fixtureIds.has(id)) throw new Error(`manifest has duplicate fixture id at ${field}`);
    fixtureIds.add(id);
    if (fixture.images.length === 0 || fixture.images.length > 6) throw new Error(`manifest ${field}.images must contain 1-6 paths`);
    const imageEntries = fixture.images;
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
    return {
      id,
      images: imageEntries.map((image, imageIndex) => requireString(image, `${field}.images[${imageIndex}]`)),
      locale: requireString(fixture.locale, `${field}.locale`),
      today: requireString(fixture.today, `${field}.today`),
      budgetCurrency: requireString(fixture.budgetCurrency, `${field}.budgetCurrency`).toUpperCase(),
      rows,
    };
  });
  return { version: 1, fixtures };
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

async function loadImages(manifestPath: string, fixture: RecognitionManifestFixture): Promise<string[]> {
  const root = await realpath(dirname(manifestPath));
  return Promise.all(
    fixture.images.map(async (entry) => {
      if (isAbsolute(entry)) throw new Error(`fixture ${fixture.id} image path must be relative`);
      const path = await realpath(resolve(root, entry));
      const fromRoot = relative(root, path);
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || !(await stat(path)).isFile())
        throw new Error(`fixture ${fixture.id} image path escapes the corpus`);
      const bytes = await readFile(path);
      return `data:${imageMime(path)};base64,${bytes.toString("base64")}`;
    }),
  );
}

async function modelChat(request: ChatRequest, fixtureId: string, apiKey: string, model: string): Promise<string> {
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

const expectedForFixture = (fixture: RecognitionManifestFixture): ExpectedImportRecognitionRow[] =>
  fixture.rows.map((row) => ({
    id: `${fixture.id}:${row.id}`,
    material: row.material,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    direction: row.direction,
    semanticKind: row.semanticKind,
    relation: prefixedRelation(fixture.id, row.relation),
    expectedProposal: row.expectedProposal,
  }));

async function runEvaluation(args: ReturnType<typeof parseEvalArgs>): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey?.trim() || !model?.trim()) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are both required; no live evaluation was run");

  const manifestPath = await realpath(resolve(args.manifestPath));
  const manifest = parseRecognitionManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const sourceTree = await realpath(resolve(args.sourceTree));
  const aiPromptsPath = resolve(sourceTree, "packages/shared/src/aiPrompts.ts");
  if (!(await stat(aiPromptsPath)).isFile()) throw new Error("source tree is missing packages/shared/src/aiPrompts.ts");
  const source = (await import(pathToFileURL(aiPromptsPath).href)) as RecognitionSourceModule;
  const adapter = classifySourceAdapter(args.mode, source.IMPORT_EXTRACT_JSON_SCHEMA);
  let candidateValidation: CandidateValidationModule | null = null;
  if (adapter === "recognition-rows") {
    const validationPath = resolve(sourceTree, "packages/shared/src/importRecognition.ts");
    if (!(await stat(validationPath)).isFile()) throw new Error("candidate source tree is missing importRecognition.ts");
    candidateValidation = (await import(pathToFileURL(validationPath).href)) as CandidateValidationModule;
  }

  const expected: ExpectedImportRecognitionRow[] = [];
  const actual: ActualImportRecognitionRow[] = [];
  const fixtureIds: string[] = [];
  for (const fixture of manifest.fixtures) {
    fixtureIds.push(fixture.id);
    expected.push(...expectedForFixture(fixture));
    const images = await loadImages(manifestPath, fixture);
    const request = source.buildImportExtractPrompt(images, { envelopes: [], categories: [] }, fixture.today, fixture.locale, fixture.budgetCurrency);
    const raw = await modelChat(request, fixture.id, apiKey, model);
    try {
      const parsed = source.parseImportExtractResponse(raw);
      if (adapter === "legacy-transactions") {
        if (!Array.isArray(parsed)) throw new Error("wrong legacy shape");
        actual.push(...normalizeBaselineRecognition(fixture.id, fixture.rows, parsed as BaselineItem[]));
      } else {
        if (!candidateValidation) throw new Error("missing candidate validation");
        const result = candidateValidation.validateImportExtraction({ batch: parsed, budgetCurrency: fixture.budgetCurrency });
        actual.push(...normalizeCandidateRecognition(fixture.id, fixture.rows, result as CandidateResult));
      }
    } catch {
      throw new Error(`fixture ${fixture.id}: model output did not satisfy the ${args.mode} contract`);
    }
  }

  process.stdout.write(`${JSON.stringify({ mode: args.mode, adapter, fixtureIds, metrics: scoreImportRecognition(expected, actual) }, null, 2)}\n`);
}

if (import.meta.main) {
  runEvaluation(parseEvalArgs(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown evaluator failure";
    process.stderr.write(`import recognition evaluation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
