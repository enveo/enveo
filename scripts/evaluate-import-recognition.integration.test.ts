import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { access, appendFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const evaluator = resolve(import.meta.dir, "evaluate-import-recognition.ts");
setDefaultTimeout(120_000);
const BASE_REVISION = "864c47f98c27bb7bf238e636b34f89dfa3dcc63c";
let root = "";
let manifestPath = "";
let baselineRoot = "";
let candidateRoot = "";
let transportPath = "";
let candidateRevision = "";
let exactBaselineRoot = "";
let sourceImportSentinel = "";
let transportImportSentinel = "";
let corpusReadSentinel = "";

async function linkPackageDependencies(packageName: "api" | "shared", targetRoot: string): Promise<void> {
  const source = resolve(import.meta.dir, `../packages/${packageName}/node_modules`);
  const target = resolve(targetRoot, `packages/${packageName}/node_modules`);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (packageName === "api" && entry.name === "@enveo") continue;
    await symlink(await realpath(resolve(source, entry.name)), resolve(target, entry.name));
  }
}

const proposal = (type: "expense" | "income" | "transfer" | null, isRefund = false) => ({
  type,
  isRefund,
  toAccountId: null,
  envelopeId: null,
  categoryId: null,
});

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "enveo-import-eval-"));
  baselineRoot = resolve(root, "baseline");
  candidateRoot = resolve(root, "candidate");
  const corpusRoot = resolve(root, "corpus");
  await mkdir(resolve(baselineRoot, "packages/shared/src"), { recursive: true });
  await mkdir(resolve(baselineRoot, "packages/api/src/routes"), { recursive: true });
  await mkdir(resolve(baselineRoot, "packages/api/src/db"), { recursive: true });
  await mkdir(resolve(candidateRoot, "packages/shared/src"), { recursive: true });
  await mkdir(resolve(candidateRoot, "packages/api/src/routes"), { recursive: true });
  await mkdir(resolve(candidateRoot, "packages/web/src/lib/aiProvider"), { recursive: true });
  await mkdir(resolve(corpusRoot, "images"), { recursive: true });
  for (const file of [".gitignore", "package.json", "bun.lock"]) {
    await cp(resolve(import.meta.dir, `../${file}`), resolve(candidateRoot, file));
  }
  for (const packageName of ["api", "shared", "web"] as const) {
    await cp(resolve(import.meta.dir, `../packages/${packageName}/package.json`), resolve(candidateRoot, `packages/${packageName}/package.json`));
  }

  const row = (id: string, semanticKind: string, visualOrder: number, overrides: Record<string, unknown> = {}) => ({
    id,
    rowRole: "financial_event",
    postingStatus: "posted",
    safetyClass: "safe_auto",
    requiredSafetyReasons: [],
    date: "2026-08-15",
    amount: 1000 + visualOrder,
    currency: "EUR",
    direction: "debit",
    semanticKind,
    relation: null,
    expectedProposal: proposal("expense"),
    matchText: `PRIVATE_VISIBLE_SENTINEL_${id.toUpperCase()}`,
    candidatePosition: { imageIndex: 0, visualOrder },
    baselineIndex: visualOrder,
    ...overrides,
  });
  const mobileRows = [
    row("purchase", "card_purchase", 0, { expectedProposal: { ...proposal("expense"), envelopeId: "envelope-food", categoryId: "category-daily" } }),
    row("salary", "salary", 1, { direction: "credit", expectedProposal: proposal("income") }),
    row("refund", "merchant_refund", 2, { direction: "credit", expectedProposal: proposal("expense", true) }),
    row("reward", "cashback_or_reward", 3, { direction: "credit", expectedProposal: proposal("income") }),
    row("incoming", "incoming_transfer", 4, {
      direction: "credit",
      safetyClass: "unsafe_auto",
      requiredSafetyReasons: ["possible_transfer"],
      expectedProposal: proposal("income"),
    }),
    row("outgoing", "outgoing_transfer", 5, {
      safetyClass: "unsafe_auto",
      requiredSafetyReasons: ["possible_transfer"],
      expectedProposal: proposal("transfer"),
    }),
    row("topup", "account_topup", 6, {
      direction: "credit",
      safetyClass: "unsafe_auto",
      requiredSafetyReasons: ["possible_transfer"],
      expectedProposal: proposal("income"),
    }),
    row("fx", "fx_conversion", 7, {
      rowRole: "supporting_detail",
      safetyClass: "non_ledger",
      currency: "USD",
      relation: { kind: "fx_for", rowId: "purchase" },
      expectedProposal: null,
      baselineIndex: null,
    }),
    row("pending", "card_purchase", 8, {
      postingStatus: "pending",
      safetyClass: "review_only",
      requiredSafetyReasons: ["pending_or_declined"],
      baselineIndex: null,
    }),
    row("declined", "card_purchase", 9, {
      postingStatus: "declined",
      safetyClass: "review_only",
      requiredSafetyReasons: ["pending_or_declined"],
      baselineIndex: null,
    }),
  ];
  const desktopRows = [row("desktop-purchase", "card_purchase", 0, { currency: "USD" })];
  const manifest = {
    version: 1,
    fixtures: [
      {
        id: "synthetic-mobile",
        images: ["images/mobile.png"],
        locale: "en",
        today: "2026-08-16",
        budgetCurrency: "EUR",
        formFactor: "mobile",
        overlap: true,
        context: {
          accountId: "account-1",
          accounts: [
            { id: "account-1", name: "Checking" },
            { id: "account-2", name: "Savings" },
          ],
          envelopes: [{ id: "envelope-food", name: "Food" }],
          categories: [{ id: "category-daily", name: "Daily" }],
          transactions: [],
          historyRecords: [
            {
              accountId: "account-2",
              currency: "EUR",
              sourceRef: "PRIVATE_HISTORY_SENTINEL",
              tag: "PRIVATE_TAG_SENTINEL",
              place: "Private history place",
              name: "Private history name",
              envelope: null,
              category: null,
              type: "expense",
              isRefund: false,
              toAccountId: null,
            },
          ],
        },
        rows: mobileRows,
      },
      {
        id: "synthetic-desktop",
        images: ["images/desktop.png"],
        locale: "es",
        today: "2026-08-16",
        budgetCurrency: "USD",
        formFactor: "desktop",
        overlap: false,
        context: {
          accountId: "account-1",
          accounts: [{ id: "account-1", name: "Checking" }],
          envelopes: [],
          categories: [],
          transactions: [],
          historyRecords: [],
        },
        rows: desktopRows,
      },
    ],
  };
  manifestPath = resolve(corpusRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(resolve(corpusRoot, "images/mobile.png"), png);
  await writeFile(resolve(corpusRoot, "images/desktop.png"), png);

  const promptModule = (rootProperty: "transactions" | "rows") => `
export const IMPORT_EXTRACT_JSON_SCHEMA = { schema: { properties: { ${rootProperty}: {} } } };
export function buildImportExtractPrompt(images, _refs, today, locale, currency) {
  return { messages: [{ role: "system", content: "PRIVATE_PROMPT_SENTINEL" }, { role: "user", content: [{ type: "text", text: today + locale + currency }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] }], responseFormat: { type: "json_schema" } };
}
export const languageName = (locale) => locale;
export const languageDirectives = (locale) => "Answer in " + locale + ". ";
export const parseImportExtractResponse = (raw) => JSON.parse(raw);
  `;
  await writeFile(resolve(baselineRoot, "packages/shared/src/aiPrompts.ts"), promptModule("transactions"));
  await writeFile(
    resolve(baselineRoot, "packages/api/src/db/client.ts"),
    'export const db = { select() { throw new Error("fixture DB seam was not installed"); } };\n',
  );
  await writeFile(
    resolve(baselineRoot, "packages/api/src/db/schema.ts"),
    "export const budgets = {}; export const envelopes = {}; export const categories = {}; export const transactions = {}; export const places = {};\n",
  );
  await writeFile(
    resolve(baselineRoot, "packages/api/src/routes/import.ts"),
    `import { buildImportExtractPrompt, parseImportExtractResponse } from "../../../shared/src/aiPrompts";
import { db } from "../db/client";
import * as s from "../db/schema";

const ENRICH_JSON_SCHEMA = {
  name: "enriched_transactions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      transactions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "integer", description: "Index of the transaction from the input" },
            name: { type: "string", description: "Short name in the user's language of WHAT it was — NOT the store name" },
            envelope: { type: ["string", "null"], description: "Envelope name from the list or null" },
            category: { type: ["string", "null"], description: "Category name from the list or null" },
            place: { type: ["string", "null"], description: "Readable place name" },
          },
          required: ["index", "name", "envelope", "category", "place"],
        },
      },
    },
    required: ["transactions"],
  },
};

export async function extractImportForBudget({ budgetId, images, locale, chat }) {
  const [budget] = await db.select({ currency: true }).from(s.budgets).where({ budgetId });
  const found = parseImportExtractResponse(await chat(buildImportExtractPrompt(images, { envelopes: [], categories: [] }, "2026-08-16", locale, budget?.currency || "EUR")));
  if (found.length === 0) return [];
  const [envelopes, categories] = await Promise.all([
    db.select({ id: true, name: true }).from(s.envelopes).where({ budgetId }),
    db.select({ id: true, name: true }).from(s.categories).where({ budgetId }),
  ]);
  const raw = await chat({
    messages: [
      { role: "system", content: "assign bank-statement transactions from production history" },
      { role: "user", content: JSON.stringify({ transactions: found.map((item, index) => ({ index, date: item.date, amount: item.amount, type: item.type, rawPlace: item.rawPlace, tag: item.tag, patterns: [] })) }) },
    ],
    responseFormat: { type: "json_schema", json_schema: ENRICH_JSON_SCHEMA },
    reasoningEffort: "low",
  });
  const enriched = new Map(JSON.parse(raw).transactions.map((item) => [item.index, item]));
  const envelopeByName = new Map(envelopes.map((item) => [item.name.toLowerCase(), item]));
  const categoryByName = new Map(categories.map((item) => [item.name.toLowerCase(), item]));
  return found.map((item, index) => {
    const assignment = enriched.get(index);
    return {
      ...item,
      name: assignment?.name || item.rawPlace,
      envelopeId: assignment?.envelope ? envelopeByName.get(assignment.envelope.toLowerCase())?.id || null : null,
      categoryId: assignment?.category ? categoryByName.get(assignment.category.toLowerCase())?.id || null : null,
      placeName: assignment?.place || null,
      toAccountId: null,
    };
  });
}
`,
  );
  await writeFile(
    resolve(baselineRoot, "packages/api/src/routes/import-match.ts"),
    `export const rankPatterns = () => [];
export const confidentSourceRef = () => null;
export function decideAssignment(raw, _top, model) {
  return { name: model?.name || raw, place: model?.place || null, envelope: model?.envelope || null, category: model?.category || null };
}
`,
  );
  await writeFile(
    resolve(candidateRoot, "packages/shared/src/aiPrompts.ts"),
    `import { z } from "zod";
z.string().parse("snapshot dependency");
if (process.env.TEST_SOURCE_IMPORT_SENTINEL) await Bun.write(process.env.TEST_SOURCE_IMPORT_SENTINEL, "imported");
${promptModule("rows")}
export async function runImportRecognitionPipeline(input) {
  const extracted = JSON.parse(await input.chat(buildImportExtractPrompt(input.images, { envelopes: [], categories: [] }, input.today, input.locale, input.budgetCurrency)));
  if (input.accountId !== "account-a") {
    const enriched = JSON.parse(await input.chat({ messages: [{ role: "system", content: "enrich" }, { role: "user", content: JSON.stringify({ rows: extracted.rows }) }] }));
    return { rows: extracted.rows, proposals: enriched.proposals };
  }
  const row = extracted.rows[0];
  const rawPlace = row.rawTextLines.join(" ");
  const unsafe = process.env.TEST_HISTORY_UNSAFE === "1";
  const immutableUnsafe = process.env.TEST_HISTORY_IMMUTABLE_UNSAFE === "1";
  const compatible = unsafe ? [] : input.historyRecords.filter((record) => record.type === "expense" && record.isRefund === false);
  const candidates = compatible.flatMap((record) => {
    let match = null;
    if (record.sourceRef === rawPlace) match = "exact_source_ref";
    else if (record.sourceRef && (rawPlace.includes(record.sourceRef) || record.sourceRef.includes(rawPlace))) match = "source_similarity";
    else if (!record.sourceRef && record.place === "BNK FUEL 123") match = "fuzzy_similarity";
    return match ? [{ ...record, match, count: 1 }] : [];
  });
  const conflict = new Set(candidates.map((item) => JSON.stringify([item.envelope, item.category]))).size > 1;
  const proposal = { rowId: row.rowId, rawPlace, date: row.date, amount: row.amount, currency: row.currency, type: unsafe ? "income" : "expense", isRefund: unsafe, envelopeId: null, categoryId: null };
  const context = { rows: [{ ...row, proposal, historyCandidates: candidates, historyConflict: conflict }] };
  const enriched = JSON.parse(await input.chat({ messages: [{ role: "system", content: "enrich" }, { role: "user", content: JSON.stringify(context) }] }));
  const answer = enriched.rows[0];
  const reviewReasons = [...new Set([...(row.reviewReasons || []), ...(conflict ? ["history_conflict", "multiple_history_candidates"] : []), "fact_correction"] )];
  const outputRow = immutableUnsafe ? { ...row, date: "2026-08-14", amount: 9999, currency: "EUR", direction: "credit" } : row;
  const outputProposal = immutableUnsafe ? { ...proposal, date: "2026-08-14", amount: 9999, currency: "EUR" } : proposal;
  return { rows: [outputRow], proposals: [{ ...outputProposal, name: answer.name, placeName: answer.place, envelopeId: answer.envelopeId, categoryId: answer.categoryId, reviewReasons, selected: false }] };
}
`,
  );
  await writeFile(resolve(candidateRoot, "packages/shared/src/importRecognition.ts"), "export const validateImportExtraction = ({ batch }) => batch;\n");

  await writeFile(
    resolve(candidateRoot, "packages/shared/src/importHistory.ts"),
    `export function selectImportHistoryCandidates(query, records) {
      const compatible = records.filter((record) => record.accountId === query.accountId && record.currency === query.proposal.currency && record.type === query.proposal.type && record.isRefund === query.proposal.isRefund);
      const candidates = compatible.map((record) => ({ ...record, match: record.sourceRef === query.proposal.rawPlace ? "exact_source_ref" : "source_similarity", count: 1 }));
      return { candidates, conflict: new Set(candidates.map((item) => JSON.stringify([item.envelope, item.category]))).size > 1 };
    }\n`,
  );
  await writeFile(
    resolve(candidateRoot, "packages/api/src/routes/import.ts"),
    'export { runImportRecognitionPipeline as runServerImportRecognitionAdapter } from "../../../shared/src/aiPrompts";\n',
  );
  await writeFile(
    resolve(candidateRoot, "packages/web/src/lib/aiProvider/e2eeByok.ts"),
    'export { runImportRecognitionPipeline } from "../../../../shared/src/aiPrompts";\n',
  );
  await writeFile(
    resolve(candidateRoot, "packages/shared/src/aiPrompts.test.ts"),
    `import { expect, test } from "bun:test"; import { runImportRecognitionPipeline } from "./aiPrompts"; test("pipeline exists", () => { if (process.env.TEST_HISTORY_FAIL === "1") throw new Error("forced"); expect(typeof runImportRecognitionPipeline).toBe("function"); });\n`,
  );
  await writeFile(
    resolve(candidateRoot, "packages/shared/src/importHistory.test.ts"),
    `import { expect, test } from "bun:test"; import { selectImportHistoryCandidates } from "./importHistory"; test("history safety", () => { if (process.env.TEST_HISTORY_FAIL === "1") throw new Error("forced"); expect(selectImportHistoryCandidates({accountId:"a",proposal:{currency:"EUR",type:"expense",isRefund:false,rawPlace:"x"}},[{accountId:"a",currency:"EUR",type:"income",isRefund:false}]).candidates).toEqual([]); });\n`,
  );
  await writeFile(
    resolve(candidateRoot, "packages/web/src/lib/aiProvider/e2eeByok.test.ts"),
    `import { expect, test } from "bun:test"; import { runImportRecognitionPipeline } from "./e2eeByok"; test("API E2EE parity seam", () => expect(typeof runImportRecognitionPipeline).toBe("function"));\n`,
  );

  const candidateRows = (fixtureRows: typeof mobileRows) =>
    fixtureRows.map((item) => ({
      rowId: item.id,
      imageIndex: 0,
      visualOrder: item.candidatePosition.visualOrder,
      rawTextLines: [item.matchText],
      date: item.date,
      amount: item.amount,
      currency: item.currency,
      direction: item.direction,
      postingStatus: item.postingStatus,
      rowRole: item.rowRole,
      semanticKind: item.id === "purchase" ? "unknown" : item.semanticKind,
      relation: null,
      confidence: "high",
      reviewReasons: item.requiredSafetyReasons,
    }));
  const candidateProposals = (fixtureRows: typeof mobileRows) =>
    fixtureRows.map((item) => {
      const selected = item.safetyClass === "safe_auto";
      return {
        rowId: item.id,
        sourceRows: [item.id],
        selected,
        disposition:
          item.rowRole === "supporting_detail"
            ? "supporting"
            : item.postingStatus === "pending"
              ? "pending"
              : item.postingStatus === "declined"
                ? "declined"
                : "candidate",
        reviewReasons: item.requiredSafetyReasons,
        date: item.date,
        amount: item.amount,
        currency: item.currency,
        semanticKind: item.semanticKind,
        relation: item.relation,
        name: `name ${item.id}`,
        tag: "",
        rawPlace: item.matchText,
        placeName: null,
        duplicateStatus: "new",
        sourceAccountInvalid: false,
        ...(item.expectedProposal ?? proposal(null)),
      };
    });
  const baselineItems = (fixtureRows: typeof mobileRows) =>
    fixtureRows
      .filter((item) => item.baselineIndex !== null)
      .map((item) => ({
        date: item.date,
        amount: item.amount,
        currency: item.currency,
        type: item.id === "refund" ? "refund" : item.id === "outgoing" ? "expense" : item.expectedProposal?.type === "income" ? "income" : "expense",
        isRefund: item.expectedProposal?.isRefund ?? false,
        rawPlace: item.matchText,
        tag: item.id.toUpperCase(),
        fxOriginal: "",
      }));
  const data = {
    baseline: {
      "synthetic-mobile": baselineItems(mobileRows),
      "synthetic-desktop": baselineItems(desktopRows as typeof mobileRows),
    },
    candidate: {
      "synthetic-mobile": { extraction: { rows: candidateRows(mobileRows) }, enrichment: { proposals: candidateProposals(mobileRows) } },
      "synthetic-desktop": {
        extraction: { rows: candidateRows(desktopRows as typeof mobileRows) },
        enrichment: { proposals: candidateProposals(desktopRows as typeof mobileRows) },
      },
    },
  };
  transportPath = resolve(root, "transport.ts");
  await writeFile(
    transportPath,
    `if (process.env.TEST_TRANSPORT_IMPORT_SENTINEL) await Bun.write(process.env.TEST_TRANSPORT_IMPORT_SENTINEL, "imported");
const data = ${JSON.stringify(data)};
export async function chat(input) {
  const serialized = JSON.stringify(input.request);
  const system = String(input.request.messages[0]?.content || "");
  const enrichment = system.includes("enrich") || system.includes("assign bank-statement") || serialized.includes("enriched_transactions");
  if (!enrichment && (!serialized.includes("data:image/png;base64,") || !serialized.includes("json_schema"))) throw new Error("request serialization missing");
  if (process.env.TEST_EVAL_MISSING === input.side && !enrichment) return JSON.stringify({ missing: true });
  if (input.side === "baseline") {
    if (!enrichment) return JSON.stringify({ transactions: data.baseline[input.fixtureId] });
    return JSON.stringify({ transactions: data.baseline[input.fixtureId].map((item, index) => ({
      index,
      name: item.rawPlace,
      envelope: input.fixtureId === "synthetic-mobile" && index === 0 ? "Food" : null,
      category: input.fixtureId === "synthetic-mobile" && index === 0 ? "Daily" : null,
      place: null,
    })) });
  }
  const value = structuredClone(enrichment ? data.candidate[input.fixtureId].enrichment : data.candidate[input.fixtureId].extraction);
  if (process.env.TEST_EVAL_FAIL === "1" && enrichment && input.fixtureId === "synthetic-mobile") {
    for (const proposal of value.proposals.filter((item) => ["incoming", "outgoing", "topup"].includes(item.rowId))) {
      proposal.selected = true;
      proposal.type = "expense";
    }
  }
  return JSON.stringify(value);
}\n`,
  );
  exactBaselineRoot = resolve(root, "baseline-exact");
  const worktree = Bun.spawn(["git", "worktree", "add", "--detach", exactBaselineRoot, BASE_REVISION], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await worktree.exited) !== 0) throw new Error("could not materialize exact baseline fixture");
  await linkPackageDependencies("api", exactBaselineRoot);
  await linkPackageDependencies("shared", exactBaselineRoot);
  await mkdir(resolve(exactBaselineRoot, "packages/api/node_modules/@enveo"), { recursive: true });
  await symlink(resolve(exactBaselineRoot, "packages/shared"), resolve(exactBaselineRoot, "packages/api/node_modules/@enveo/shared"));
  baselineRoot = exactBaselineRoot;

  for (const args of [
    ["init"],
    ["config", "user.email", "evaluation@example.invalid"],
    ["config", "user.name", "Evaluation Fixture"],
    ["add", "."],
    ["commit", "-m", "test: candidate fixture"],
  ]) {
    const child = Bun.spawn(["git", "-C", candidateRoot, ...args], { stdout: "ignore", stderr: "pipe" });
    if ((await child.exited) !== 0) throw new Error(`could not version candidate fixture: ${args[0]}`);
  }
  const revision = Bun.spawn(["git", "-C", candidateRoot, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  candidateRevision = (await new Response(revision.stdout).text()).trim();
  if ((await revision.exited) !== 0 || !/^[0-9a-f]{40}$/.test(candidateRevision)) throw new Error("could not identify candidate fixture");
  await linkPackageDependencies("shared", candidateRoot);
  sourceImportSentinel = resolve(root, "source-imported");
  transportImportSentinel = resolve(root, "transport-imported");
  corpusReadSentinel = resolve(root, "corpus-read");
});

afterAll(async () => {
  if (exactBaselineRoot) {
    const remove = Bun.spawn(["git", "worktree", "remove", "--force", exactBaselineRoot], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "ignore",
    });
    await remove.exited;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

const runGate = async (
  fail = false,
  missing = "",
  historyFail = false,
  runnerMarker = "run-tests",
  historyUnsafe = false,
  historyImmutableUnsafe = false,
  expectedRevision = candidateRevision,
  assertNoImports = false,
  candidateSourceTree = candidateRoot,
  mutatePath = "",
  mutateContent = "",
) => {
  const child = Bun.spawn(
    [
      process.execPath,
      evaluator,
      "--manifest",
      manifestPath,
      "--mode",
      "compare",
      "--baseline-source-tree",
      baselineRoot,
      "--candidate-source-tree",
      candidateSourceTree,
      "--expected-candidate-revision",
      expectedRevision,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test-private-sentinel",
        OPENAI_MODEL: "test-model-safe-id",
        ENVEO_IMPORT_EVAL_TEST_MODE: "1",
        ENVEO_IMPORT_EVAL_TEST_TRANSPORT: transportPath,
        ENVEO_TEST_RUNNER: runnerMarker,
        TEST_EVAL_FAIL: fail ? "1" : "0",
        TEST_EVAL_MISSING: missing,
        TEST_HISTORY_FAIL: historyFail ? "1" : "0",
        TEST_HISTORY_UNSAFE: historyUnsafe ? "1" : "0",
        TEST_HISTORY_IMMUTABLE_UNSAFE: historyImmutableUnsafe ? "1" : "0",
        TEST_SOURCE_IMPORT_SENTINEL: assertNoImports ? sourceImportSentinel : "",
        TEST_TRANSPORT_IMPORT_SENTINEL: assertNoImports ? transportImportSentinel : "",
        ENVEO_IMPORT_EVAL_TEST_CORPUS_READ_SENTINEL: assertNoImports ? corpusReadSentinel : "",
        ENVEO_IMPORT_EVAL_TEST_MUTATE_PATH: mutatePath,
        ENVEO_IMPORT_EVAL_TEST_MUTATE_CONTENT: mutateContent,
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
};

const runDiagnostic = async (
  mode: "baseline" | "candidate",
  sourceTree = mode === "baseline" ? baselineRoot : candidateRoot,
  expectedRevision = mode === "baseline" ? BASE_REVISION : candidateRevision,
  selectedManifest = manifestPath,
  assertNoImports = false,
) => {
  const child = Bun.spawn(
    [process.execPath, evaluator, "--manifest", selectedManifest, "--mode", mode, "--source-tree", sourceTree, "--expected-revision", expectedRevision],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test-private-sentinel",
        OPENAI_MODEL: "test-model-safe-id",
        ENVEO_IMPORT_EVAL_TEST_MODE: "1",
        ENVEO_IMPORT_EVAL_TEST_TRANSPORT: transportPath,
        ENVEO_TEST_RUNNER: "run-tests",
        TEST_HISTORY_FAIL: "0",
        TEST_SOURCE_IMPORT_SENTINEL: assertNoImports ? sourceImportSentinel : "",
        TEST_TRANSPORT_IMPORT_SENTINEL: assertNoImports ? transportImportSentinel : "",
        ENVEO_IMPORT_EVAL_TEST_CORPUS_READ_SENTINEL: assertNoImports ? corpusReadSentinel : "",
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
};

const expectPreflightOnly = async (result: Awaited<ReturnType<typeof runGate>>): Promise<void> => {
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    releaseEligible: false,
    identity: { transport: "not_loaded" },
    metrics: null,
    decision: { passed: false, criteriaPassed: false, reasons: ["source_identity_unbound"], transitions: null },
  });
  await expect(access(sourceImportSentinel)).rejects.toThrow();
  await expect(access(transportImportSentinel)).rejects.toThrow();
  await expect(access(corpusReadSentinel)).rejects.toThrow();
};

describe("paired import recognition CLI", () => {
  test("does not expose a helper that can preflight and import a mutable source root", async () => {
    const module = (await import("./evaluate-import-recognition")) as Record<string, unknown>;
    expect(module.loadSource).toBeUndefined();
  });

  test("installs dependencies inside the snapshot instead of loading a replaced original package", async () => {
    const originalLink = resolve(candidateRoot, "packages/shared/node_modules/zod");
    const originalTarget = await realpath(originalLink);
    const malicious = resolve(candidateRoot, "node_modules/malicious-zod");
    const sentinel = resolve(root, "mutable-original-dependency-loaded");
    await mkdir(malicious, { recursive: true });
    await writeFile(resolve(malicious, "package.json"), JSON.stringify({ name: "zod", type: "module", exports: "./index.js" }));
    await writeFile(resolve(malicious, "index.js"), `await Bun.write(${JSON.stringify(sentinel)}, "loaded"); throw new Error("mutable dependency loaded");\n`);
    await rm(originalLink);
    await symlink(malicious, originalLink);
    try {
      const result = await runGate(
        false,
        "",
        false,
        "run-tests",
        false,
        false,
        candidateRevision,
        false,
        candidateRoot,
        resolve(malicious, "index.js"),
        `await Bun.write(${JSON.stringify(sentinel)}, "loaded after preflight"); throw new Error("mutable dependency loaded after preflight");\n`,
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).metrics.candidate.semanticKindAccuracy.rate).toBe(1);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await rm(originalLink);
      await symlink(originalTarget, originalLink);
      await rm(malicious, { recursive: true, force: true });
    }
  });

  test("rejects a bound source with an invalid lock before corpus or transport loading", async () => {
    const invalidRoot = resolve(root, "invalid-lock-candidate");
    await cp(candidateRoot, invalidRoot, { recursive: true, filter: (path) => !path.includes("/.git") && !path.includes("/node_modules") });
    await writeFile(resolve(invalidRoot, "bun.lock"), "not a bun lockfile\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "evaluation@example.invalid"],
      ["config", "user.name", "Evaluation Fixture"],
      ["add", "."],
      ["commit", "-m", "invalid lock"],
    ]) {
      const child = Bun.spawn(["git", "-C", invalidRoot, ...args], { stdout: "ignore", stderr: "ignore" });
      expect(await child.exited).toBe(0);
    }
    const revision = Bun.spawn(["git", "-C", invalidRoot, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const expected = (await new Response(revision.stdout).text()).trim();
    expect(await revision.exited).toBe(0);
    const module = await import("./evaluate-import-recognition");
    const preflight = await module.preflightSource("candidate", invalidRoot, expected);
    expect(preflight.identity.bound).toBe(true);
    await expect(module.materializeSourceSnapshot(preflight)).rejects.toThrow("snapshot dependency install failed");
    const result = await runDiagnostic("candidate", invalidRoot, expected, resolve(root, "unread-corpus.json"), true);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("snapshot dependency install failed");
    await expect(access(transportImportSentinel)).rejects.toThrow();
    await expect(access(corpusReadSentinel)).rejects.toThrow();
  });

  test("rejects a tracked symlink whose target escapes the source root", async () => {
    const symlinkRoot = resolve(root, "escaping-symlink-candidate");
    await cp(candidateRoot, symlinkRoot, { recursive: true, filter: (path) => !path.includes("/.git") && !path.includes("/node_modules") });
    await symlink("../outside-source", resolve(symlinkRoot, "escaped"));
    for (const args of [
      ["init"],
      ["config", "user.email", "evaluation@example.invalid"],
      ["config", "user.name", "Evaluation Fixture"],
      ["add", "."],
      ["commit", "-m", "escaping symlink"],
    ]) {
      const child = Bun.spawn(["git", "-C", symlinkRoot, ...args], { stdout: "ignore", stderr: "ignore" });
      expect(await child.exited).toBe(0);
    }
    const revision = Bun.spawn(["git", "-C", symlinkRoot, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const expected = (await new Response(revision.stdout).text()).trim();
    expect(await revision.exited).toBe(0);
    const result = await runDiagnostic("candidate", symlinkRoot, expected, resolve(root, "unread-symlink-corpus.json"), true);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).identity.source).toMatchObject({ bound: false, clean: false });
    await expect(access(transportImportSentinel)).rejects.toThrow();
  });

  test("loads both sides but marks deterministic injected metrics as non-release evidence", async () => {
    const result = await runGate();

    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      mode: "compare",
      releaseEligible: false,
      identity: {
        model: "test-model-safe-id",
        transport: "injected-test",
        historySafety: { passed: true },
      },
      decision: {
        passed: false,
        criteriaPassed: true,
        reasons: ["non_live_transport"],
        transitions: { attributableSafety: 3, unexplainedNewReviews: 0 },
      },
    });
    expect(output.identity.sources.baseline.moduleHashes["packages/shared/src/aiPrompts.ts"]).toHaveLength(64);
    expect(output.identity.sources.baseline.moduleHashes["packages/api/src/routes/import-match.ts"]).toHaveLength(64);
    expect(output.identity.sources.baseline.moduleHashes["packages/api/src/routes/import.ts"]).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes["packages/shared/src/importRecognition.ts"]).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes["packages/shared/src/importHistory.ts"]).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes["packages/api/src/routes/import.ts"]).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes["packages/web/src/lib/aiProvider/e2eeByok.ts"]).toHaveLength(64);
    expect(output.identity.sources.candidate).toMatchObject({
      expectedRevision: candidateRevision,
      actualRevision: candidateRevision,
      bound: true,
    });
    expect(output.identity.sources.candidate.actualModuleDigest).toHaveLength(64);
    expect(output.identity.sources.candidate.expectedModuleDigest).toHaveLength(64);
    // Cycle one deliberately labels the purchase as unknown, omits the FX relation,
    // and has no assignments. Only the production pipeline's cycle-two result can pass.
    expect(output.metrics.candidate.semanticKindAccuracy).toEqual({ correct: 11, total: 11, rate: 1 });
    expect(output.metrics.candidate.relationRecall).toEqual({ correct: 1, total: 1, rate: 1 });
    expect(output.metrics.candidate.missingProposals).toBe(0);
    expect(output.metrics.candidate.harmfulSelected).toBe(0);
    expect(output.identity.corpusDigest).toHaveLength(64);
    expect(output.identity.historySafety.sourceHashes.sharedPipeline).toHaveLength(64);
    expect(output.identity.historySafety.testHashes.sharedPipeline).toHaveLength(64);
    expect(result.stdout).not.toContain("PRIVATE_VISIBLE_SENTINEL");
    expect(result.stdout).not.toContain("PRIVATE_PROMPT_SENTINEL");
    expect(result.stdout).not.toContain("PRIVATE_HISTORY_SENTINEL");
    expect(result.stdout).not.toContain("sk-test-private-sentinel");
    expect(result.stdout).not.toContain("data:image");
    expect(result.stderr).toBe("");
  });

  test("refuses the injected transport without the repository test-runner marker", async () => {
    const result = await runGate(false, "", false, "");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("injected evaluator transport is test-only");
    expect(result.stderr).not.toContain("PRIVATE_VISIBLE_SENTINEL");
  });

  test("fails closed when the explicit candidate revision does not match the loaded tree", async () => {
    const expectedRevision = "0123456789abcdef0123456789abcdef01234567";
    const result = await runGate(false, "", false, "run-tests", false, false, expectedRevision, true);

    await expectPreflightOnly(result);
    const output = JSON.parse(result.stdout);
    expect(output.identity.sources.candidate).toMatchObject({ expectedRevision, actualRevision: candidateRevision, bound: false });
  });

  test("preflight rejects dirty tracked and untracked candidate roots before imports or transport", async () => {
    const sourcePath = resolve(candidateRoot, "packages/shared/src/importHistory.ts");
    const original = await readFile(sourcePath);
    try {
      await appendFile(sourcePath, "\n// tracked drift\n");
      await expectPreflightOnly(await runGate(false, "", false, "run-tests", false, false, candidateRevision, true));
    } finally {
      await writeFile(sourcePath, original);
    }

    const untracked = resolve(candidateRoot, "unexpected-source.txt");
    try {
      await writeFile(untracked, "untracked");
      await expectPreflightOnly(await runGate(false, "", false, "run-tests", false, false, candidateRevision, true));
    } finally {
      await rm(untracked, { force: true });
    }
  });

  test("full-tree bytes reject index-hidden drift in a baseline transitive dependency", async () => {
    const sourcePath = resolve(baselineRoot, "packages/api/src/context.ts");
    const original = await readFile(sourcePath, "utf8");
    const baselineSentinel = resolve(root, "baseline-hidden-drift-imported");
    const indexFlag = async (flag: "--assume-unchanged" | "--no-assume-unchanged"): Promise<void> => {
      const child = Bun.spawn(["git", "-C", baselineRoot, "update-index", flag, "packages/api/src/context.ts"], { stdout: "ignore", stderr: "pipe" });
      if ((await child.exited) !== 0) throw new Error(`could not apply ${flag}`);
    };
    await indexFlag("--assume-unchanged");
    try {
      await writeFile(sourcePath, `await Bun.write(${JSON.stringify(baselineSentinel)}, "imported");\n${original}`);
      const result = await runGate(false, "", false, "run-tests", false, false, candidateRevision, true);
      await expectPreflightOnly(result);
      expect(JSON.parse(result.stdout).identity.sources.baseline).toMatchObject({ actualRevision: BASE_REVISION, clean: false, bound: false });
      await expect(access(baselineSentinel)).rejects.toThrow();
    } finally {
      await writeFile(sourcePath, original);
      await indexFlag("--no-assume-unchanged");
    }
  });

  test("preflight rejects unversioned and ignored nested source copies with transitive drift", async () => {
    const unversioned = resolve(root, "candidate-unversioned");
    await mkdir(unversioned, { recursive: true });
    await cp(resolve(candidateRoot, "packages"), resolve(unversioned, "packages"), { recursive: true });
    await expectPreflightOnly(await runGate(false, "", false, "run-tests", false, false, candidateRevision, true, unversioned));

    const nested = resolve(candidateRoot, "ignored-source-copy");
    await appendFile(resolve(candidateRoot, ".git/info/exclude"), "\nignored-source-copy/\n");
    try {
      await mkdir(nested, { recursive: true });
      await cp(resolve(candidateRoot, "packages"), resolve(nested, "packages"), { recursive: true });
      await appendFile(resolve(nested, "packages/shared/src/importHistory.ts"), "\n// transitive drift\n");
      await expectPreflightOnly(await runGate(false, "", false, "run-tests", false, false, candidateRevision, true, nested));
      const output = JSON.parse((await runGate(false, "", false, "run-tests", false, false, candidateRevision, true, nested)).stdout);
      expect(output.identity.sources.candidate.bound).toBe(false);
    } finally {
      await rm(nested, { recursive: true, force: true });
    }
  });

  test("single-side baseline and candidate diagnostics can never return the release-success exit", async () => {
    for (const mode of ["baseline", "candidate"] as const) {
      const result = await runDiagnostic(mode);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode,
        releaseEligible: false,
        diagnosticOnly: true,
        decision: { passed: false, reasons: ["diagnostic_only"] },
      });
      expect(result.stderr).toBe("");
    }
  });

  test("unbound diagnostics preflight before source, transport, or private corpus reads", async () => {
    const missingPrivateManifest = resolve(root, "must-not-read-private-manifest.json");
    for (const mode of ["baseline", "candidate"] as const) {
      const source = mode === "baseline" ? baselineRoot : candidateRoot;
      const revision = "0123456789abcdef0123456789abcdef01234567";
      const result = await runDiagnostic(mode, source, revision, missingPrivateManifest, true);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode,
        identity: { transport: "not_loaded", source: { expectedRevision: revision, bound: false } },
        metrics: null,
        decision: { passed: false, reasons: ["source_identity_unbound"] },
      });
      await expect(access(sourceImportSentinel)).rejects.toThrow();
      await expect(access(transportImportSentinel)).rejects.toThrow();
      await expect(access(missingPrivateManifest)).rejects.toThrow();
    }
  });

  test("executes the immutable snapshot when the original source mutates after preflight", async () => {
    const sourcePath = resolve(candidateRoot, "packages/shared/src/aiPrompts.ts");
    const original = await readFile(sourcePath, "utf8");
    const mutationSentinel = resolve(root, "original-race-source-imported");
    const mutated = `await Bun.write(${JSON.stringify(mutationSentinel)}, "imported"); throw new Error("mutable original imported");\n${original}`;
    const snapshotsBefore = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith("enveo-import-eval-source-")));
    try {
      const result = await runGate(false, "", false, "run-tests", false, false, candidateRevision, false, candidateRoot, sourcePath, mutated);
      expect(result.exitCode).toBe(2);
      const output = JSON.parse(result.stdout);
      expect(output.metrics.candidate.semanticKindAccuracy).toEqual({ correct: 11, total: 11, rate: 1 });
      expect(output.identity.sources.candidate).toMatchObject({ bound: true, actualRevision: candidateRevision });
      expect(output.identity.finalSources.candidate.bound).toBe(false);
      expect(output.decision.reasons).toEqual(["source_identity_unbound", "non_live_transport"]);
      await expect(access(mutationSentinel)).rejects.toThrow();
    } finally {
      await writeFile(sourcePath, original);
    }
    const status = Bun.spawn(["git", "-C", candidateRoot, "status", "--porcelain", "--untracked-files=all"], { stdout: "pipe", stderr: "pipe" });
    expect((await new Response(status.stdout).text()).trim()).toBe("");
    expect(await status.exited).toBe(0);
    expect(new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith("enveo-import-eval-source-")))).toEqual(snapshotsBefore);
  });

  test("prints a safe failed decision and exits nonzero when paired acceptance fails", async () => {
    const result = await runGate(true);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.decision.passed).toBe(false);
    expect(output.decision.reasons).toContain("harmful_selected_not_strictly_lower");
    expect(output.decision.reasons).toContain("unsafe_row_constraint_failed");
    expect(result.stdout).not.toContain("PRIVATE_VISIBLE_SENTINEL");
    expect(result.stderr).toBe("");
  });

  test("fails nonzero with a safe identity and explicit decision when either paired run is missing", async () => {
    const result = await runGate(false, "candidate");

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.metrics).toBeNull();
    expect(output.decision).toEqual({ passed: false, criteriaPassed: false, reasons: ["paired_runs_missing"], transitions: null });
    expect(output.identity.sources.baseline.moduleHashes["packages/shared/src/aiPrompts.ts"]).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes["packages/shared/src/aiPrompts.ts"]).toHaveLength(64);
    expect(result.stdout).not.toContain("PRIVATE_VISIBLE_SENTINEL");
    expect(result.stderr).toBe("");
  });

  test("fails before model runs while retaining safe source and test hashes when history safety fails", async () => {
    const result = await runGate(false, "", true);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.metrics).toBeNull();
    expect(output.decision.reasons).toEqual(["history_safety_test_failed", "paired_runs_missing"]);
    expect(output.identity.historySafety.sourceHashes.sharedPipeline).toHaveLength(64);
    expect(output.identity.historySafety.testHashes.sharedPipeline).toHaveLength(64);
    expect(result.stdout).not.toContain("PRIVATE_VISIBLE_SENTINEL");
  });

  test("fails the mandatory gate when a candidate pipeline ignores captured history and visible facts", async () => {
    const result = await runGate(false, "", false, "run-tests", true);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.metrics).toBeNull();
    expect(output.releaseEligible).toBe(false);
    expect(output.decision.reasons).toEqual(["history_safety_semantic_check_failed", "paired_runs_missing"]);
    expect(output.identity.historySafety.sourceHashes.sharedPipeline).toHaveLength(64);
    expect(result.stderr).toBe("");
  });

  test("fails the mandatory gate when a candidate pipeline mutates extracted immutable facts", async () => {
    const result = await runGate(false, "", false, "run-tests", false, true);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.metrics).toBeNull();
    expect(output.releaseEligible).toBe(false);
    expect(output.decision.reasons).toEqual(["history_safety_semantic_check_failed", "paired_runs_missing"]);
    expect(output.identity.historySafety.sourceHashes.sharedPipeline).toHaveLength(64);
    expect(result.stderr).toBe("");
  });
});
