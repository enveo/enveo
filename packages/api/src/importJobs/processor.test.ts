import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ImportEnrichmentMalformedError, type ImportJobErrorCode, type ImportRecognitionResult } from "@enveo/shared";
import { ByokInvalidBodyError, ByokUpstreamError } from "../aiCredentials/transport";
import { SpendDenied } from "../aiSpend/transport";
import { UpstreamNetworkError, UpstreamTimeoutError } from "../openaiHttp";
import {
  classifyImportJobFailure,
  createImportJobChat,
  ImportJobAccountUnavailable,
  ImportJobBudgetMismatch,
  ImportJobInvalidKey,
  ImportJobMalformedResponse,
  ImportJobModelUnavailable,
  ImportJobTierMismatch,
  processClaimedImportJob,
} from "./processor";
import type { ClaimedImportJob, ImportJobClaimContext } from "./repository";

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
  const recognize = async (input: {
    checkpoint: ImportRecognitionResult | null;
    beforeUpstream: () => Promise<void>;
    afterUpstream: () => Promise<void>;
    saveExtraction: (result: ImportRecognitionResult) => Promise<void>;
    advancePhase: (phase: "enriching" | "reconciling") => Promise<void>;
    saveResult: (result: ImportRecognitionResult) => Promise<void>;
  }) => {
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
        return "owned-answer";
      },
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
