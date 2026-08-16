import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const evaluator = resolve(import.meta.dir, "evaluate-import-recognition.ts");
let root = "";
let manifestPath = "";
let baselineRoot = "";
let candidateRoot = "";
let transportPath = "";

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
  await mkdir(resolve(candidateRoot, "packages/shared/src"), { recursive: true });
  await mkdir(resolve(candidateRoot, "packages/api/src/routes"), { recursive: true });
  await mkdir(resolve(candidateRoot, "packages/web/src/lib/aiProvider"), { recursive: true });
  await mkdir(resolve(corpusRoot, "images"), { recursive: true });

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
  await writeFile(resolve(baselineRoot, "packages/api/src/routes/import.ts"), "export const baselineProductionImportRoute = true;\n");
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
    `${promptModule("rows")}
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
      reviewReasons: item.requiredSafetyReasons,
    }));
  const candidateProposals = (fixtureRows: typeof mobileRows) =>
    fixtureRows.map((item) => {
      const selected = item.safetyClass === "safe_auto";
      return {
        rowId: item.id,
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
        semanticKind: item.semanticKind,
        relation: item.relation,
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
        type: item.id === "outgoing" ? "expense" : item.expectedProposal?.type === "income" ? "income" : "expense",
        isRefund: item.expectedProposal?.isRefund ?? false,
        rawPlace: item.matchText,
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
    `const data = ${JSON.stringify(data)};
export async function chat(input) {
  const serialized = JSON.stringify(input.request);
  const system = String(input.request.messages[0]?.content || "");
  const enrichment = system.includes("enrich") || system.includes("assign bank-statement");
  if (!enrichment && (!serialized.includes("data:image/png;base64,") || !serialized.includes("json_schema"))) throw new Error("request serialization missing");
  if (process.env.TEST_EVAL_MISSING === input.side && !enrichment) return JSON.stringify({ missing: true });
  if (input.side === "baseline") {
    if (!enrichment) return JSON.stringify(data.baseline[input.fixtureId]);
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
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const runGate = async (fail = false, missing = "", historyFail = false, runnerMarker = "run-tests", historyUnsafe = false, historyImmutableUnsafe = false) => {
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
      candidateRoot,
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
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
};

const runDiagnostic = async (mode: "baseline" | "candidate") => {
  const child = Bun.spawn(
    [process.execPath, evaluator, "--manifest", manifestPath, "--mode", mode, "--source-tree", mode === "baseline" ? baselineRoot : candidateRoot],
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
      },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
};

describe("paired import recognition CLI", () => {
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
    expect(output.identity.sources.baseline.moduleHashes.aiPrompts).toHaveLength(64);
    expect(output.identity.sources.baseline.moduleHashes.importMatch).toHaveLength(64);
    expect(output.identity.sources.baseline.moduleHashes.apiAdapter).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes.importRecognition).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes.importHistory).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes.apiAdapter).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes.e2eeAdapter).toHaveLength(64);
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
    expect(output.identity.sources.baseline.moduleHashes.aiPrompts).toHaveLength(64);
    expect(output.identity.sources.candidate.moduleHashes.aiPrompts).toHaveLength(64);
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

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.metrics).toBeNull();
    expect(output.releaseEligible).toBe(false);
    expect(output.decision.reasons).toEqual(["history_safety_semantic_check_failed", "paired_runs_missing"]);
    expect(output.identity.historySafety.sourceHashes.sharedPipeline).toHaveLength(64);
    expect(result.stderr).toBe("");
  });
});
