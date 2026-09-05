import { describe, expect, it } from "bun:test";
import {
  buildImportBalanceArbiterPrompt,
  buildImportSeamPrompt,
  type ChatRequest,
  IMPORT_BALANCE_ARBITER_JSON_SCHEMA,
  IMPORT_SEAM_JSON_SCHEMA,
  ImportChunksPendingError,
  ImportExtractionFailedError,
  type ImportRecognitionChatMeta,
  type ImportRecognitionPipelineInput,
  parseImportBalanceArbiterResponse,
  parseImportSeamResponse,
  runImportRecognitionPipeline,
} from "./aiPrompts";
import { IMPORT_ENRICH_BATCH_SIZE } from "./importChunks";
import type { ImportExtractRow, ImportRecognitionResult } from "./importRecognition";
import type { Account } from "./types";

const account: Account = {
  id: "account-1",
  name: "Checking",
  color: "#000",
  icon: "wallet",
  type: "checking",
  onBudget: true,
  initialBalance: 0,
  archived: false,
  sort: 0,
  automaticEnvelopeId: null,
};

const modelRow = (rowId: string, imageIndex: number, over: Partial<ImportExtractRow> = {}) => ({
  rowId,
  imageIndex,
  visualOrder: 0,
  rawTextLines: [`LIDL ${rowId}`],
  date: "2026-08-07",
  amount: 1234,
  currency: "PLN",
  direction: "debit",
  postingStatus: "posted",
  rowRole: "financial_event",
  semanticKind: "card_purchase",
  relation: null,
  confidence: "high",
  reviewReasons: [],
  ...over,
});

const images = (count: number) => Array.from({ length: count }, (_, index) => `data:image/png;base64,${index}`);

const base = {
  locale: "pl",
  today: "2026-08-16",
  budgetCurrency: "PLN",
  accountId: account.id,
  accounts: [account],
  envelopes: [],
  categories: [],
  transactions: [],
  historyRecords: [],
} satisfies Partial<ImportRecognitionPipelineInput>;

/** Counts images in one extract request and answers with one row per image. */
const extractAnswer = (request: ChatRequest, rowsPerImage: (imageIndex: number) => Array<ReturnType<typeof modelRow>>) => {
  const content = request.messages[1]!.content as Array<Record<string, unknown>>;
  const count = content.filter((part) => part.type === "image_url").length;
  return JSON.stringify({ rows: Array.from({ length: count }, (_, imageIndex) => rowsPerImage(imageIndex)).flat() });
};

describe("chunked cycle one", () => {
  it("reads eight screenshots as two parallel windows and merges them in screenshot order", async () => {
    // given: eight screenshots and a transport that records when each window starts and ends
    const started: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      images: images(8),
      chat: async (request, _timeout, meta) => {
        if (meta?.stage !== "extract") throw new Error(`unexpected stage ${meta?.stage}`);
        started.push(meta.chunk);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        return extractAnswer(request, (imageIndex) => [modelRow(`r${imageIndex}`, imageIndex, { amount: 100 + imageIndex + meta.chunk * 10 })]);
      },
    });

    // then: both windows ran concurrently, rowIds are namespaced and imageIndex is absolute; window 1
    // re-read image 5 for context only, so its rows for that image are not repeated
    expect(started.sort()).toEqual([0, 1]);
    expect(peak).toBe(2);
    expect(result.rows.map((row) => [row.rowId, row.imageIndex])).toEqual([
      ["c0:r0", 0],
      ["c0:r1", 1],
      ["c0:r2", 2],
      ["c0:r3", 3],
      ["c0:r4", 4],
      ["c0:r5", 5],
      ["c1:r1", 6],
      ["c1:r2", 7],
    ]);
    expect(result.proposals.every((proposal) => proposal.selected)).toBe(true);
  });

  it("keeps a job of at most one window on the model's own rowIds and makes no seam call", async () => {
    const stages: string[] = [];
    const result = await runImportRecognitionPipeline({
      ...base,
      images: images(6),
      chat: async (request, _timeout, meta) => {
        stages.push(meta?.stage ?? "none");
        return extractAnswer(request, (imageIndex) => [modelRow(`r${imageIndex}`, imageIndex, { amount: 100 + imageIndex })]);
      },
    });

    expect(stages).toEqual(["extract"]);
    expect(result.rows.map((row) => row.rowId)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
  });
});

describe("seam between windows", () => {
  const overlapping = (request: ChatRequest, meta: ImportRecognitionChatMeta | undefined) =>
    extractAnswer(request, (imageIndex) => {
      // The last row of window 0 (image 5) and the first row of window 1's own screenshot (image 6,
      // window-relative 1 behind the shared context image) are the same entry captured twice with
      // different truncation; window 1 also repeats an identical-text row.
      if (meta?.stage === "extract" && meta.chunk === 0 && imageIndex === 5) return [modelRow("last", 5, { rawTextLines: ["ŻABKA Z1234 K.1 WARSZ"] })];
      if (meta?.stage === "extract" && meta.chunk === 1 && imageIndex === 0) return [modelRow("ctx", 0, { rawTextLines: ["ŻABKA Z1234 K.1 WARSZ"] })];
      if (meta?.stage === "extract" && meta.chunk === 1 && imageIndex === 1) {
        return [
          modelRow("first", 1, { rawTextLines: ["ŻABKA Z1234 K.1 WARSZAWA"] }),
          modelRow("same", 1, { visualOrder: 1, rawTextLines: ["ŻABKA Z1234 K.1 WARSZ"] }),
        ];
      }
      return [modelRow(`r${imageIndex}`, imageIndex, { amount: 500 + imageIndex + (meta?.stage === "extract" ? meta.chunk * 10 : 0) })];
    });

  it("asks the model only about same-fact pairs with different text and links confirmed duplicates", async () => {
    const seamRequests: ChatRequest[] = [];
    const result = await runImportRecognitionPipeline({
      ...base,
      images: images(7),
      chat: async (request, _timeout, meta) => {
        if (meta?.stage === "seam") {
          seamRequests.push(request);
          const pairs = JSON.parse(request.messages[1]!.content as string).pairs as Array<{ pairId: string }>;
          return JSON.stringify({ pairs: pairs.map((pair) => ({ pairId: pair.pairId, sameEntry: true })) });
        }
        return overlapping(request, meta);
      },
    });

    expect(seamRequests).toHaveLength(1);
    const asked = JSON.parse(seamRequests[0]!.messages[1]!.content as string).pairs;
    expect(asked).toEqual([
      expect.objectContaining({ pairId: "1", earlier: expect.objectContaining({ imageIndex: 5 }), later: expect.objectContaining({ imageIndex: 6 }) }),
    ]);
    const later = result.rows.find((row) => row.rowId === "c1:first")!;
    expect(later.relation).toEqual({ kind: "duplicate_of", rowId: "c0:last" });
    // Identical text needs no model: reconciliation already declines the later occurrence.
    const identical = result.proposals.find((proposal) => proposal.rowId === "c1:same")!;
    expect(identical.duplicateStatus).toBe("exists");
    expect(identical.selected).toBe(false);
  });

  it("turns a failed seam call into review evidence instead of failing the job", async () => {
    const result = await runImportRecognitionPipeline({
      ...base,
      images: images(7),
      chat: async (request, _timeout, meta) => {
        if (meta?.stage === "seam") throw new Error("seam unavailable");
        return overlapping(request, meta);
      },
    });

    const later = result.proposals.find((proposal) => proposal.rowId === "c1:first")!;
    expect(later.reviewReasons).toContain("possible_duplicate");
    expect(later.selected).toBe(true);
    expect(result.proposals.find((proposal) => proposal.rowId === "c0:last")!.reviewReasons).not.toContain("possible_duplicate");
  });

  it("re-applies unresolved seam evidence when resuming from the checkpoint", async () => {
    let saved: ImportRecognitionResult | null = null;
    const lifecycle = {
      saveExtraction: async (result: ImportRecognitionResult) => {
        saved = result;
      },
      saveResult: async () => {},
    };
    await runImportRecognitionPipeline({
      ...base,
      images: images(7),
      pipelineMode: "durable",
      cycleTwoFailureMode: "strict",
      lifecycle,
      chat: async (request, _timeout, meta) => {
        if (meta?.stage === "seam") throw new Error("seam unavailable");
        if (meta?.stage === "enrich") throw new Error("enrichment must not run: only possible_duplicate is a non-blocking reason");
        return overlapping(request, meta);
      },
    }).catch((error: Error) => {
      // Enrichment does run because possible_duplicate is a review reason; assert on the checkpoint instead.
      expect(error.message).toContain("enrichment must not run");
    });
    expect(saved!.seam).toEqual({ unresolved: [{ earlierRowId: "c0:last", laterRowId: "c1:first" }] });

    const resumed = await runImportRecognitionPipeline({
      ...base,
      images: Array.from({ length: 7 }, () => null),
      checkpoint: saved!,
      pipelineMode: "durable",
      cycleTwoFailureMode: "fallback",
      lifecycle: { saveResult: async () => {} },
      chat: async () => {
        throw new Error("no enrichment in this test");
      },
    });
    expect(resumed.proposals.find((proposal) => proposal.rowId === "c1:first")!.reviewReasons).toContain("possible_duplicate");
  });
});

describe("durable window resume and failure", () => {
  const rowsFor = (request: ChatRequest, meta: ImportRecognitionChatMeta | undefined) =>
    extractAnswer(request, (imageIndex) => [
      modelRow(`r${imageIndex}`, imageIndex, { amount: 100 + imageIndex + (meta?.stage === "extract" ? meta.chunk * 10 : 0) }),
    ]);

  it("reads only windows without a checkpoint and reports permanently failed ones with the extraction", async () => {
    const chunkCalls: number[] = [];
    const stored: number[] = [];
    let failedChunks: number[] | null = null;
    // Thirteen screenshots: windows [0,6), [5,11), [10,13). Window 0 is checkpointed, so only its
    // shared screenshot (5) is still retained for window 1; window 2 exhausted its attempts.
    const result = await runImportRecognitionPipeline({
      ...base,
      images: [null, null, null, null, null, ...images(8)],
      chunks: [
        { index: 0, start: 0, end: 6, extraction: { rows: [modelRow("c0:r0", 0, { amount: 77 })] }, permanentlyFailed: false },
        { index: 1, start: 5, end: 11, extraction: null, permanentlyFailed: false },
        { index: 2, start: 10, end: 13, extraction: null, permanentlyFailed: true },
      ],
      pipelineMode: "durable",
      lifecycle: {
        saveChunkExtraction: async (index) => {
          stored.push(index);
        },
        saveExtraction: async (_result, failed) => {
          failedChunks = failed;
        },
        saveResult: async () => {},
      },
      chat: async (request, _timeout, meta) => {
        if (meta?.stage === "extract") chunkCalls.push(meta.chunk);
        return rowsFor(request, meta);
      },
    });

    expect(chunkCalls).toEqual([1]);
    expect(stored).toEqual([1]);
    expect(failedChunks).toEqual([2]);
    expect(result.rows.map((row) => [row.rowId, row.imageIndex])).toEqual([
      ["c0:r0", 0],
      ["c1:r1", 6],
      ["c1:r2", 7],
      ["c1:r3", 8],
      ["c1:r4", 9],
      ["c1:r5", 10],
    ]);
  });

  it("lets the runner judge each failed window and waits when any of them may retry", async () => {
    const failed: number[] = [];
    const run = runImportRecognitionPipeline({
      ...base,
      images: images(13),
      pipelineMode: "durable",
      lifecycle: {
        saveChunkExtraction: async () => {},
        failChunk: async (index) => {
          failed.push(index);
          return index === 2 ? "retry" : "permanent";
        },
      },
      chat: async (request, _timeout, meta) => {
        if (meta?.stage === "extract" && meta.chunk > 0) throw new Error(`window ${meta.chunk} down`);
        return rowsFor(request, meta);
      },
    });

    await expect(run).rejects.toBeInstanceOf(ImportChunksPendingError);
    await run.catch((error: ImportChunksPendingError) => expect(error.pendingChunks).toEqual([2]));
    expect(failed.sort()).toEqual([1, 2]);
  });

  it("fails the extraction only when no window could be read", async () => {
    const run = runImportRecognitionPipeline({
      ...base,
      images: images(7),
      pipelineMode: "durable",
      lifecycle: { failChunk: async () => "permanent" },
      chat: async () => {
        throw new Error("everything down");
      },
    });

    await expect(run).rejects.toBeInstanceOf(ImportExtractionFailedError);
    await run.catch((error: ImportExtractionFailedError) => expect(error.reasons).toHaveLength(2));
  });

  it("propagates the runner's own fence failure raised inside failChunk", async () => {
    class LeaseLost extends Error {}
    const run = runImportRecognitionPipeline({
      ...base,
      images: images(7),
      pipelineMode: "durable",
      lifecycle: {
        failChunk: async () => {
          throw new LeaseLost("lease lost");
        },
      },
      chat: async (request, _timeout, meta) => {
        if (meta?.stage === "extract" && meta.chunk === 1) throw new Error("window down");
        return rowsFor(request, meta);
      },
    });

    await expect(run).rejects.toBeInstanceOf(LeaseLost);
  });

  it("rethrows a window failure for an interactive caller exactly as before chunking", async () => {
    await expect(
      runImportRecognitionPipeline({
        ...base,
        images: images(7),
        chat: async (request, _timeout, meta) => {
          if (meta?.stage === "extract" && meta.chunk === 1) throw new Error("window down");
          return rowsFor(request, meta);
        },
      }),
    ).rejects.toThrow("window down");
  });
});

describe("batched enrichment", () => {
  it("enriches a large result in bounded requests and merges every annotation", async () => {
    const rowCount = IMPORT_ENRICH_BATCH_SIZE + 5;
    const enrichBatches: number[] = [];
    const result = await runImportRecognitionPipeline({
      ...base,
      images: images(1),
      chat: async (request, _timeout, meta) => {
        if (meta?.stage === "extract") {
          return JSON.stringify({
            rows: Array.from({ length: rowCount }, (_, index) =>
              modelRow(`r${index}`, 0, { visualOrder: index, semanticKind: "incoming_transfer", direction: "credit" }),
            ),
          });
        }
        if (meta?.stage === "enrich") {
          enrichBatches.push(meta.batch);
          const rows = JSON.parse(request.messages[1]!.content as string).rows as Array<{ rowId: string }>;
          return JSON.stringify({
            rows: rows.map((row) => ({
              rowId: row.rowId,
              name: `Named ${row.rowId}`,
              place: null,
              envelopeId: null,
              categoryId: null,
              semanticKind: "incoming_transfer",
              relation: null,
              reviewReasons: ["possible_transfer"],
            })),
          });
        }
        throw new Error(`unexpected stage ${meta?.stage}`);
      },
    });

    expect(enrichBatches).toEqual([0, 1]);
    expect(result.proposals).toHaveLength(rowCount);
    expect(result.proposals.every((proposal) => proposal.name.startsWith("Named "))).toBe(true);
  });
});

describe("seam prompt contract", () => {
  it("builds a text-only strict json_schema request at low reasoning effort", () => {
    const request = buildImportSeamPrompt(
      [
        {
          pairId: "1",
          earlier: modelRow("a", 5) as unknown as ImportExtractRow,
          later: modelRow("b", 6, { rawTextLines: ["x"] }) as unknown as ImportExtractRow,
        },
      ],
      "pl",
    );

    expect(request.responseFormat).toEqual({ type: "json_schema", json_schema: IMPORT_SEAM_JSON_SCHEMA });
    expect(request.reasoningEffort).toBe("low");
    expect(typeof request.messages[1]!.content).toBe("string");
    expect(request.messages[1]!.content as string).not.toContain("rowId");
    expect(JSON.parse(request.messages[1]!.content as string).pairs[0].later.rawTextLines).toEqual(["x"]);
  });

  it("requires exactly one verdict per pair", () => {
    expect(parseImportSeamResponse('{"pairs":[{"pairId":"1","sameEntry":true}]}', ["1"])).toEqual(new Map([["1", true]]));
    expect(() => parseImportSeamResponse('{"pairs":[]}', ["1"])).toThrow("missing seam verdict");
    expect(() => parseImportSeamResponse('{"pairs":[{"pairId":"1","sameEntry":true},{"pairId":"1","sameEntry":false}]}', ["1"])).toThrow(
      "duplicate seam pairId",
    );
    expect(() => parseImportSeamResponse('{"pairs":[{"pairId":"1","sameEntry":"yes"}]}', ["1"])).toThrow();
  });
});

describe("balance arbiter prompt contract", () => {
  const row = {
    rowId: "c1:first",
    rawTextLines: ["NOTINO.PL BRNO"],
    date: null,
    amount: 30850,
    currency: "PLN",
    direction: "unknown" as const,
    postingStatus: "pending" as const,
    semanticKind: "card_purchase" as const,
    reviewReasons: ["possible_duplicate" as const],
    duplicateStatus: "probable" as const,
  };

  it("sends only the found solutions with row facts as a strict json_schema request", () => {
    const request = buildImportBalanceArbiterPrompt(
      { difference: 30850, currency: "PLN", solutions: [{ index: 0, changes: [{ action: "exclude", row }] }] },
      "pl",
    );

    expect(request.responseFormat).toEqual({ type: "json_schema", json_schema: IMPORT_BALANCE_ARBITER_JSON_SCHEMA });
    expect(request.reasoningEffort).toBe("low");
    expect(JSON.parse(request.messages[1]!.content as string)).toEqual({
      difference: 30850,
      currency: "PLN",
      solutions: [{ index: 0, changes: [{ action: "exclude", row }] }],
    });
  });

  it("accepts an index inside the offered solutions or an explicit null, nothing else", () => {
    expect(parseImportBalanceArbiterResponse('{"choice":1,"rationale":" second "}', 2)).toEqual({ choice: 1, rationale: "second" });
    expect(parseImportBalanceArbiterResponse('{"choice":null,"rationale":"none"}', 2)).toEqual({ choice: null, rationale: "none" });
    expect(() => parseImportBalanceArbiterResponse('{"choice":2,"rationale":"x"}', 2)).toThrow("unknown solution");
    expect(() => parseImportBalanceArbiterResponse('{"choice":"0","rationale":"x"}', 2)).toThrow();
  });
});
