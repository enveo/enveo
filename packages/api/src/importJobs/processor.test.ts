import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ImportChunksPendingError,
  ImportEnrichmentMalformedError,
  type ImportExtractBatch,
  ImportExtractionFailedError,
  type ImportJobErrorCode,
  type ImportRecognitionResult,
} from "@enveo/shared";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ByokInvalidBodyError, ByokUpstreamError } from "../aiCredentials/transport";
import { SpendDenied } from "../aiSpend/transport";
import * as schema from "../db/schema";
import { UpstreamNetworkError, UpstreamTimeoutError } from "../openaiHttp";
import {
  classifyImportJobFailure,
  createDatabaseImportRecognition,
  createImportJobChat,
  ImportJobAccountUnavailable,
  ImportJobBudgetMismatch,
  ImportJobInvalidKey,
  ImportJobMalformedResponse,
  ImportJobModelUnavailable,
  ImportJobTierMismatch,
  type ImportRecognitionRunInput,
  processClaimedImportJob,
} from "./processor";
import type { ClaimedImportJob, ImportChunkFailure, ImportJobClaimContext } from "./repository";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const EMPTY_RESULT: ImportRecognitionResult = { rows: [], proposals: [] };

const claimedJob = (over: Partial<ClaimedImportJob> = {}): ClaimedImportJob => ({
  id: "018f7c89-4d76-7b8a-9a3e-4d6bf4a99811",
  userId: "11111111-1111-4111-8111-111111111111",
  budgetId: "22222222-2222-4222-8222-222222222222",
  accountId: "33333333-3333-4333-8333-333333333333",
  provider: { provider: "enveo", model: "gpt-test" },
  locale: "en",
  tier: "plain",
  epoch: 0,
  phase: "extracting",
  resumePhase: null,
  attempt: 1,
  cancelRequested: false,
  leaseToken: "44444444-4444-4444-8444-444444444444",
  leaseExpiresAt: new Date("2026-08-24T12:05:00.000Z"),
  extraction: null,
  images: [{ position: 0, mimeType: "image/png", sha256: "a".repeat(64), byteLength: 2, content: new Uint8Array([1, 2]) }],
  screenshotTotal: 1,
  chunks: [{ index: 0, start: 0, end: 1, attempt: 0, status: "pending", errorCode: null, retryAt: null, extraction: null }],
  ...over,
});

function processorFixture(options: { cancelledAfterUpstream?: boolean; enrichment?: boolean; recognitionError?: unknown } = {}) {
  const events: string[] = [];
  let cancelRequested = false;
  const repository = {
    validateClaimContext: async (): Promise<ImportJobClaimContext> => (cancelRequested ? "cancel_requested" : "valid"),
    heartbeat: async (_id: string, _lease: string, _now: Date) => {
      events.push("heartbeat");
      return true;
    },
    getForUser: async () => ({ cancelRequested }),
    saveChunkExtraction: async (_id: string, _lease: string, chunkIndex: number, _batch: ImportExtractBatch) => {
      events.push(`chunk-stored:${chunkIndex}`);
      return true;
    },
    failChunk: async (_id: string, _lease: string, chunkIndex: number, failure: ImportChunkFailure) => {
      events.push(`chunk-failed:${chunkIndex}:${failure.errorCode}:${failure.retryAt ? "retry" : "permanent"}`);
      return true;
    },
    saveExtractionAndDeleteImages: async (_id: string, _lease: string, result: ImportRecognitionResult) => {
      expect(result).toEqual(EMPTY_RESULT);
      events.push("extraction-stored");
      events.push("images-deleted");
      return true;
    },
    advancePhase: async (_id: string, _lease: string, phase: "enriching" | "reconciling") => {
      events.push(phase);
      return true;
    },
    saveReadyResult: async () => {
      events.push("ready");
      return true;
    },
    scheduleRetry: async (_id: string, _lease: string, code: ImportJobErrorCode, retryAt: Date) => {
      events.push(`retry:${code}:${retryAt.toISOString()}`);
      return true;
    },
    failPermanently: async (_id: string, _lease: string, code: ImportJobErrorCode) => {
      events.push(`failed:${code}`);
      return true;
    },
    finishCancellation: async () => {
      events.push("cancelled");
      return true;
    },
  };
  const recognize = async (input: ImportRecognitionRunInput) => {
    if (options.recognitionError) throw options.recognitionError;
    expect(input.checkpoint).toBeNull();
    await input.beforeUpstream();
    events.push("extracting");
    if (options.cancelledAfterUpstream) cancelRequested = true;
    await input.afterUpstream();
    await input.saveExtraction(EMPTY_RESULT);
    events.push("validating");
    if (options.enrichment) await input.advancePhase("enriching");
    await input.advancePhase("reconciling");
    await input.saveResult(EMPTY_RESULT);
    return EMPTY_RESULT;
  };
  return { events, repository, recognize };
}

describe("plain import job processor", () => {
  test("persists extraction before image deletion and records optional enrichment in phase order", async () => {
    // given: a claimed plain job whose Stage A result needs enrichment
    const fixture = processorFixture({ enrichment: true });

    // when: the worker processes the claim
    const outcome = await processClaimedImportJob(claimedJob(), { ...fixture, now: () => NOW });

    // then: durable phases describe the real work and the job stops at review
    expect(outcome).toEqual({ kind: "ready" });
    expect(fixture.events.filter((event) => event !== "heartbeat")).toEqual([
      "extracting",
      "extraction-stored",
      "images-deleted",
      "validating",
      "enriching",
      "reconciling",
      "ready",
    ]);
  });

  test("skips enrichment for a low-risk Stage A result", async () => {
    const fixture = processorFixture();

    await processClaimedImportJob(claimedJob(), { ...fixture, now: () => NOW });

    expect(fixture.events).not.toContain("enriching");
  });

  test("discards a late upstream answer when cancellation was requested", async () => {
    const fixture = processorFixture({ cancelledAfterUpstream: true });

    const outcome = await processClaimedImportJob(claimedJob(), { ...fixture, now: () => NOW });

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(fixture.events).toContain("cancelled");
    expect(fixture.events).not.toContain("extraction-stored");
    expect(fixture.events).not.toContain("ready");
  });

  test("stops between model cycles when the budget tier ceremony revokes the claim", async () => {
    const fixture = processorFixture();
    let checks = 0;
    fixture.repository.validateClaimContext = async () => (++checks < 3 ? "valid" : "tier_mismatch");
    const recognize = async (input: Parameters<typeof fixture.recognize>[0]) => {
      await input.beforeUpstream();
      fixture.events.push("cycle-one");
      await input.afterUpstream();
      await input.beforeUpstream();
      fixture.events.push("cycle-two");
      return EMPTY_RESULT;
    };

    const outcome = await processClaimedImportJob(claimedJob(), { ...fixture, recognize, now: () => NOW });

    expect(outcome).toEqual({ kind: "lease_expired", errorCode: "expired" });
    expect(fixture.events).toContain("cycle-one");
    expect(fixture.events).not.toContain("cycle-two");
    expect(fixture.events).not.toContain("ready");
  });

  test("resumes from persisted extraction without requiring screenshots", async () => {
    const events: string[] = [];
    const fixture = processorFixture();
    const job = claimedJob({ phase: "validating", extraction: EMPTY_RESULT, images: [] });
    const recognize = async (input: Parameters<typeof fixture.recognize>[0]) => {
      expect(input.checkpoint).toEqual(EMPTY_RESULT);
      events.push("resumed-without-images");
      await input.advancePhase("reconciling");
      await input.saveResult(EMPTY_RESULT);
      return EMPTY_RESULT;
    };

    const outcome = await processClaimedImportJob(job, { ...fixture, recognize, now: () => NOW });

    expect(outcome).toEqual({ kind: "ready" });
    expect(events).toEqual(["resumed-without-images"]);
  });

  test("reports an expired lease without mutating the stale claim", async () => {
    const fixture = processorFixture();
    fixture.repository.heartbeat = async () => false;

    const outcome = await processClaimedImportJob(claimedJob(), { ...fixture, now: () => NOW });

    expect(outcome).toEqual({ kind: "lease_expired", errorCode: "expired" });
    expect(fixture.events).not.toContain("ready");
  });

  test("terminally expires a live claim whose retained input has already been cleaned", async () => {
    const fixture = processorFixture();

    const outcome = await processClaimedImportJob(claimedJob({ images: [], extraction: null }), { ...fixture, now: () => NOW });

    expect(outcome).toEqual({ kind: "failed", errorCode: "expired" });
    expect(fixture.events).toContain("failed:expired");
  });

  test("reports a safe failure class without provider payloads", async () => {
    const diagnostics: unknown[] = [];
    const fixture = processorFixture({ recognitionError: new UpstreamNetworkError(new Error("private network detail")) });

    await processClaimedImportJob(claimedJob(), { ...fixture, now: () => NOW, logFailure: (metadata) => diagnostics.push(metadata) });

    expect(diagnostics).toEqual([{ jobId: claimedJob().id, attempt: 1, errorType: "UpstreamNetworkError" }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private network detail");
  });

  test("renews the lease before and during a slow upstream call so another worker cannot duplicate the provider request", async () => {
    let current = new Date("2026-08-24T12:00:00.000Z");
    let leaseExpiresAt = new Date("2026-08-24T12:05:00.000Z");
    let providerCalls = 0;
    let secondWorkerCouldClaim = true;
    const fixture = processorFixture();
    fixture.repository.heartbeat = async (_id: string, _lease: string, heartbeatAt: Date) => {
      if (heartbeatAt >= leaseExpiresAt) return false;
      leaseExpiresAt = new Date(heartbeatAt.getTime() + 5 * 60 * 1_000);
      return true;
    };
    const recognize = async (input: Parameters<typeof fixture.recognize>[0]) => {
      await input.beforeUpstream();
      providerCalls++;
      current = new Date("2026-08-24T12:04:00.000Z");
      await Bun.sleep(20);
      current = new Date("2026-08-24T12:06:00.000Z");
      secondWorkerCouldClaim = current >= leaseExpiresAt;
      await input.afterUpstream();
      await input.saveExtraction(EMPTY_RESULT);
      await input.advancePhase("reconciling");
      await input.saveResult(EMPTY_RESULT);
      return EMPTY_RESULT;
    };

    const outcome = await processClaimedImportJob(claimedJob(), {
      ...fixture,
      recognize,
      now: () => current,
      heartbeatIntervalMs: 5,
    });

    expect(outcome).toEqual({ kind: "ready" });
    expect(providerCalls).toBe(1);
    expect(secondWorkerCouldClaim).toBe(false);
  });

  test("discards a slow upstream answer when periodic renewal discovers that the lease was lost", async () => {
    const fixture = processorFixture();
    let heartbeats = 0;
    fixture.repository.heartbeat = async () => ++heartbeats === 1;
    const recognize = async (input: Parameters<typeof fixture.recognize>[0]) => {
      await input.beforeUpstream();
      await Bun.sleep(20);
      await input.afterUpstream();
      await input.saveExtraction(EMPTY_RESULT);
      return EMPTY_RESULT;
    };

    const outcome = await processClaimedImportJob(claimedJob(), {
      ...fixture,
      recognize,
      now: () => NOW,
      heartbeatIntervalMs: 5,
    });

    expect(outcome).toEqual({ kind: "lease_expired", errorCode: "expired" });
    expect(fixture.events).not.toContain("extraction-stored");
    expect(fixture.events).not.toContain("ready");
  });

  test.each([
    [new UpstreamNetworkError(new Error("offline")), { kind: "retry", errorCode: "network" }],
    [new UpstreamTimeoutError(1_000), { kind: "retry", errorCode: "ai_timeout" }],
    [new ByokUpstreamError(429), { kind: "retry", errorCode: "network" }],
    [new SpendDenied(77), { kind: "retry", errorCode: "ai_budget_exhausted" }],
    [new ImportJobInvalidKey(), { kind: "failed", errorCode: "ai_key_invalid" }],
    [new ImportJobModelUnavailable(), { kind: "failed", errorCode: "ai_model_unavailable" }],
    [new ByokInvalidBodyError(), { kind: "retry", errorCode: "malformed_model_response" }],
    [new ImportEnrichmentMalformedError(new Error("bad rows")), { kind: "retry", errorCode: "malformed_model_response" }],
  ] as const)("persists the worker disposition when strict recognition propagates %s", async (error, expected) => {
    const fixture = processorFixture({ recognitionError: error });

    const outcome = await processClaimedImportJob(claimedJob(), { ...fixture, now: () => NOW });

    expect(outcome).toMatchObject(expected);
  });
});

describe("plain import provider dispatch", () => {
  test("loads unused place names only from the claimed job budget into recognition", async () => {
    const job = claimedJob();
    const places = [
      { id: "place-own", budgetId: job.budgetId, name: "Northstar Cafe", archived: false },
      { id: "place-foreign", budgetId: "foreign-budget", name: "Private foreign place", archived: false },
    ];
    const placeQueries: Array<{ sql: string; params: unknown[] }> = [];
    const database = {
      select: () => ({
        from: (table: unknown) => ({
          where: async (predicate: SQL) => {
            const query = new PgDialect().sqlToQuery(predicate);
            if (table === schema.places) {
              placeQueries.push(query);
              return places.filter((place) => place.budgetId === query.params[0]);
            }
            if (table === schema.budgets) return [{ userId: job.userId, currency: "EUR", tier: "plain", epoch: job.epoch }];
            if (table === schema.accounts) return [{ id: job.accountId, name: "Checking", type: "checking", archived: false }];
            return [];
          },
        }),
      }),
    };
    let context: { entities: { places: Array<{ id: string; name: string }> }; rows: Array<{ historyCandidates: unknown[] }> } | undefined;
    const recognize = createDatabaseImportRecognition(job, {
      database: database as never,
      credentials: { withServerCredentialForWorker: async (_database, _owner, _budgetId, use) => use("unused") },
      operatorChat: async ({ payload }) => {
        const messages = payload.messages as Array<{ content: string }>;
        context = JSON.parse(messages[1]!.content);
        return {
          kind: "ok",
          json: {},
          requestId: null,
          content: JSON.stringify({
            rows: [
              {
                rowId: "r1",
                name: "Coffee",
                place: "Northstar Cafe",
                envelopeId: null,
                categoryId: null,
                semanticKind: "card_purchase",
                relation: null,
                reviewReasons: [],
              },
            ],
          }),
        };
      },
      logUpstreamCall: () => {},
    });
    const noop = async () => {};
    const result = await recognize({
      checkpoint: {
        rows: [
          {
            rowId: "r1",
            imageIndex: 0,
            visualOrder: 0,
            rawTextLines: ["NORTHSTAR CAFE"],
            date: "2026-08-24",
            amount: 1250,
            currency: "EUR",
            direction: "debit",
            postingStatus: "posted",
            rowRole: "financial_event",
            semanticKind: "card_purchase",
            relation: null,
            confidence: "high",
            reviewReasons: [],
          },
        ],
        proposals: [],
      },
      chunks: undefined,
      beforeUpstream: noop,
      afterUpstream: noop,
      saveChunkExtraction: noop,
      failChunk: async () => "permanent",
      saveExtraction: noop,
      advancePhase: noop,
      saveResult: noop,
    });

    expect(placeQueries.length).toBeGreaterThan(0);
    for (const query of placeQueries) expect(query).toMatchObject({ sql: '"places"."budget_id" = $1', params: [job.budgetId] });
    expect(context?.entities.places).toEqual([{ id: "place-own", name: "Northstar Cafe" }]);
    expect(context?.rows[0]?.historyCandidates).toEqual([]);
    expect(result.proposals[0]).toMatchObject({ placeName: "Northstar Cafe", amount: 1250, date: "2026-08-24" });
  });

  test("selects the explicit durable shared-pipeline ordering instead of changing the default", () => {
    const source = readFileSync(new URL("./processor.ts", import.meta.url), "utf8");

    expect(source).toContain('pipelineMode: "durable"');
    expect(source).toContain('cycleTwoFailureMode: "strict"');
  });

  test("routes Enveo AI through the metered operator transport with the captured user and model", async () => {
    const calls: unknown[] = [];
    const chat = createImportJobChat(claimedJob(), {
      database: {} as never,
      credentials: { withServerCredentialForWorker: async (_database, _owner, _budgetId, use) => use("unused") },
      operatorChat: async (input) => {
        calls.push(input);
        return { kind: "ok", json: {}, content: "answer", requestId: null };
      },
      logUpstreamCall: () => {},
    });

    const answer = await chat({ messages: [{ role: "user", content: "recognize" }] });

    expect(answer).toBe("answer");
    expect(calls).toEqual([
      expect.objectContaining({
        userId: claimedJob().userId,
        payload: expect.objectContaining({ model: "gpt-test" }),
      }),
    ]);
  });

  test("logs only safe upstream metadata when Enveo AI rejects an import", async () => {
    const diagnostics: unknown[] = [];
    const chat = createImportJobChat(claimedJob(), {
      database: {} as never,
      credentials: { withServerCredentialForWorker: async (_database, _owner, _budgetId, use) => use("unused") },
      operatorChat: async () => ({ kind: "upstream_error", status: 400, detail: "private upstream response", requestId: "req-safe" }),
      logUpstreamFailure: (metadata) => diagnostics.push(metadata),
      logUpstreamCall: () => {},
    });

    await expect(chat({ messages: [{ role: "user", content: "private prompt" }] })).rejects.toThrow("openai 400");
    expect(diagnostics).toEqual([{ status: 400, requestId: "req-safe" }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });

  test("opens Own OpenAI only through the worker vault callback and invokes BYOK outside its transaction", async () => {
    const calls: string[] = [];
    const job = claimedJob({ provider: { provider: "openai", model: "gpt-owned" } });
    const chat = createImportJobChat(job, {
      database: {} as never,
      credentials: {
        withServerCredentialForWorker: async (_database, owner, budgetId, use) => {
          calls.push(`vault:${owner.userId}:${budgetId}`);
          return use("sk-private");
        },
      },
      byokChat: async ({ apiKey, model }) => {
        calls.push(`byok:${apiKey}:${model}`);
        return { kind: "ok", json: {}, content: "owned-answer" };
      },
      logUpstreamCall: () => {},
    });

    const answer = await chat({ messages: [] });

    expect(answer).toBe("owned-answer");
    expect(calls).toEqual([`vault:${job.userId}:${job.budgetId}`, "byok:sk-private:gpt-owned"]);
  });
});

describe("plain import retry classification", () => {
  test.each([
    [new UpstreamNetworkError(new Error("offline")), "network", 30_000],
    [new UpstreamTimeoutError(1_000), "ai_timeout", 30_000],
    [new ByokUpstreamError(429), "network", 30_000],
  ] as const)("classifies retryable transport failures", (error, errorCode, delayMs) => {
    expect(classifyImportJobFailure(error, 1, NOW)).toEqual({ kind: "retry", errorCode, retryAt: new Date(NOW.getTime() + delayMs) });
  });

  test("keeps the exact SpendDenied retry instant", () => {
    expect(classifyImportJobFailure(new SpendDenied(77), 1, NOW)).toEqual({
      kind: "retry",
      errorCode: "ai_budget_exhausted",
      retryAt: new Date(NOW.getTime() + 77_000),
    });
    expect(classifyImportJobFailure(new SpendDenied(77), 3, NOW)).toEqual({ kind: "permanent", errorCode: "ai_budget_exhausted" });
  });

  test.each([
    [new ImportJobBudgetMismatch(), "budget_mismatch"],
    [new ImportJobTierMismatch(), "tier_mismatch"],
    [new ImportJobAccountUnavailable(), "account_unavailable"],
    [new ImportJobInvalidKey(), "ai_key_invalid"],
    [new ImportJobModelUnavailable(), "ai_model_unavailable"],
  ] as const)("classifies permanent job failures", (error, errorCode) => {
    expect(classifyImportJobFailure(error, 1, NOW)).toEqual({ kind: "permanent", errorCode });
  });

  test("maps Own OpenAI authentication and model responses to actionable permanent errors", () => {
    expect(classifyImportJobFailure(new ByokUpstreamError(401), 1, NOW)).toEqual({ kind: "permanent", errorCode: "ai_key_invalid" });
    expect(classifyImportJobFailure(new ByokUpstreamError(404), 1, NOW)).toEqual({ kind: "permanent", errorCode: "ai_model_unavailable" });
  });

  test("stops retrying malformed model output after the third processing attempt", () => {
    expect(classifyImportJobFailure(new ImportJobMalformedResponse(), 2, NOW)).toEqual({
      kind: "retry",
      errorCode: "malformed_model_response",
      retryAt: new Date(NOW.getTime() + 120_000),
    });
    expect(classifyImportJobFailure(new ImportJobMalformedResponse(), 3, NOW)).toEqual({
      kind: "permanent",
      errorCode: "malformed_model_response",
    });
  });
});

describe("chunked cycle one in the worker", () => {
  const twoWindowJob = () =>
    claimedJob({
      screenshotTotal: 7,
      images: Array.from({ length: 7 }, (_, position) => ({
        position,
        mimeType: "image/png",
        sha256: "a".repeat(64),
        byteLength: 2,
        content: new Uint8Array([1, 2]),
      })),
      chunks: [
        { index: 0, start: 0, end: 6, attempt: 0, status: "pending", errorCode: null, retryAt: null, extraction: null },
        { index: 1, start: 5, end: 7, attempt: 1, status: "pending", errorCode: "ai_timeout", retryAt: null, extraction: null },
      ],
    });

  test("hands per-chunk state to recognition and judges each failed window on its own attempt counter", async () => {
    // given: window 1 already failed once; this claim it fails again while window 0 succeeds
    const fixture = processorFixture();
    let seenChunks: unknown;
    const recognize = async (input: ImportRecognitionRunInput) => {
      seenChunks = input.chunks;
      await input.beforeUpstream();
      await input.afterUpstream();
      await input.saveChunkExtraction(0, { rows: [] });
      const disposition = await input.failChunk(1, new UpstreamTimeoutError(1_000));
      expect(disposition).toBe("retry");
      throw new ImportChunksPendingError([1]);
    };

    // when: the worker processes the claim
    const outcome = await processClaimedImportJob(twoWindowJob(), { ...fixture, recognize, now: () => NOW });

    // then: the job waits for the earliest chunk retry with that chunk's error, nothing is marked ready
    expect(seenChunks).toEqual([
      { index: 0, start: 0, end: 6, extraction: null, permanentlyFailed: false },
      { index: 1, start: 5, end: 7, extraction: null, permanentlyFailed: false },
    ]);
    expect(outcome).toEqual({ kind: "retry", errorCode: "ai_timeout", retryAt: new Date(NOW.getTime() + 120_000) });
    expect(fixture.events).toContain("chunk-stored:0");
    expect(fixture.events).toContain("chunk-failed:1:ai_timeout:retry");
    expect(fixture.events).toContain("retry:ai_timeout:2026-08-24T12:02:00.000Z");
    expect(fixture.events).not.toContain("ready");
  });

  test("marks a window permanent after its third attempt and fails the job only when nothing was read", async () => {
    const fixture = processorFixture();
    const job = twoWindowJob();
    job.chunks[1]!.attempt = 2;
    const recognize = async (input: ImportRecognitionRunInput) => {
      expect(await input.failChunk(1, new UpstreamNetworkError(new Error("down")))).toBe("permanent");
      expect(await input.failChunk(0, new UpstreamNetworkError(new Error("down")))).toBe("retry");
      throw new ImportChunksPendingError([0]);
    };

    const outcome = await processClaimedImportJob(job, { ...fixture, recognize, now: () => NOW });

    expect(fixture.events).toContain("chunk-failed:1:network:permanent");
    expect(fixture.events).toContain("chunk-failed:0:network:retry");
    expect(outcome).toMatchObject({ kind: "retry", errorCode: "network" });

    const exhausted = processorFixture();
    const allFailed = async (input: ImportRecognitionRunInput) => {
      await input.failChunk(0, new UpstreamTimeoutError(1_000));
      await input.failChunk(1, new UpstreamTimeoutError(1_000));
      throw new ImportExtractionFailedError([new UpstreamTimeoutError(1_000)]);
    };
    const failedJob = twoWindowJob();
    failedJob.chunks[0]!.attempt = 2;
    failedJob.chunks[1]!.attempt = 2;
    expect(await processClaimedImportJob(failedJob, { ...exhausted, recognize: allFailed, now: () => NOW })).toEqual({
      kind: "failed",
      errorCode: "ai_timeout",
    });
    expect(exhausted.events).toContain("failed:ai_timeout");
  });

  test("judges a post-extraction failure as a first attempt when extraction completed in this claim", async () => {
    // given: the third claim of a job whose windows only now finished reading
    const fixture = processorFixture();
    const recognize = async (input: ImportRecognitionRunInput) => {
      await input.saveChunkExtraction(0, { rows: [] });
      await input.saveExtraction(EMPTY_RESULT);
      throw new ImportEnrichmentMalformedError(new Error("bad rows"));
    };

    const outcome = await processClaimedImportJob(claimedJob({ attempt: 3 }), { ...fixture, recognize, now: () => NOW });

    // then: enrichment gets its own retry budget instead of inheriting the exhausted extraction attempts
    expect(outcome).toEqual({ kind: "retry", errorCode: "malformed_model_response", retryAt: new Date(NOW.getTime() + 30_000) });
  });

  test("keeps a resumed post-extraction stage on the stored attempt counter", async () => {
    const fixture = processorFixture();
    const recognize = async () => {
      throw new ImportEnrichmentMalformedError(new Error("bad rows"));
    };

    const outcome = await processClaimedImportJob(claimedJob({ attempt: 3, extraction: EMPTY_RESULT, images: [], phase: "validating" }), {
      ...fixture,
      recognize,
      now: () => NOW,
    });

    expect(outcome).toEqual({ kind: "failed", errorCode: "malformed_model_response" });
  });

  test("propagates a lost lease discovered while recording a window failure", async () => {
    const fixture = processorFixture();
    fixture.repository.failChunk = async () => false;
    const recognize = async (input: ImportRecognitionRunInput) => {
      await input.failChunk(1, new UpstreamTimeoutError(1_000));
      throw new Error("unreachable");
    };

    const outcome = await processClaimedImportJob(twoWindowJob(), { ...fixture, recognize, now: () => NOW });

    expect(outcome).toEqual({ kind: "lease_expired", errorCode: "expired" });
  });

  test("resumes a job whose screenshots are gone but whose windows are checkpointed", async () => {
    const fixture = processorFixture();
    const recognize = async (input: ImportRecognitionRunInput) => {
      expect(input.chunks?.[0]?.extraction).toEqual({ rows: [] });
      await input.saveExtraction(EMPTY_RESULT);
      await input.advancePhase("reconciling");
      await input.saveResult(EMPTY_RESULT);
      return EMPTY_RESULT;
    };
    const job = claimedJob({
      images: [],
      chunks: [{ index: 0, start: 0, end: 1, attempt: 1, status: "extracted", errorCode: null, retryAt: null, extraction: { rows: [] } }],
    });

    expect(await processClaimedImportJob(job, { ...fixture, recognize, now: () => NOW })).toEqual({ kind: "ready" });
  });
});

describe("upstream call diagnostics", () => {
  test("logs duration and token usage per model call without any prompt or answer content", async () => {
    const entries: unknown[] = [];
    let tick = 1_000;
    const chat = createImportJobChat(claimedJob(), {
      database: {} as never,
      credentials: { withServerCredentialForWorker: async (_database, _owner, _budgetId, use) => use("unused") },
      operatorChat: async () => ({
        kind: "ok",
        json: { usage: { prompt_tokens: 1440, completion_tokens: 2100 } },
        content: '{"rows":[]}',
        requestId: null,
      }),
      logUpstreamCall: (entry) => entries.push(entry),
      now: () => (tick += 250),
    });

    await chat({ messages: [{ role: "user", content: "private prompt" }] }, undefined, { stage: "extract", chunk: 2 });

    expect(entries).toEqual([
      { jobId: claimedJob().id, stage: "extract", chunk: 2, batch: null, durationMs: 250, promptTokens: 1440, completionTokens: 2100, outcome: "ok" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("private prompt");
  });

  test("logs a failed call with its stage and no token counts", async () => {
    const entries: Array<{ outcome: string; stage: string; promptTokens: number | null }> = [];
    const chat = createImportJobChat(claimedJob(), {
      database: {} as never,
      credentials: { withServerCredentialForWorker: async (_database, _owner, _budgetId, use) => use("unused") },
      operatorChat: async () => ({ kind: "denied", retryAfterSeconds: 5 }),
      logUpstreamCall: (entry) => entries.push(entry),
    });

    await expect(chat({ messages: [] }, undefined, { stage: "seam" })).rejects.toBeInstanceOf(SpendDenied);
    expect(entries).toEqual([expect.objectContaining({ outcome: "error", stage: "seam", promptTokens: null })]);
  });
});
