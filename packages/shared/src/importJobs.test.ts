import { describe, expect, it } from "bun:test";
import {
  advanceImportJob,
  IMPORT_JOB_PHASES,
  type ImportJobEvent,
  type ImportJobProgress,
  importJobDetailSchema,
  importJobPhaseSchema,
  isTerminalImportJob,
} from "./importJobs";

const progress = (status: ImportJobProgress["status"], phase: ImportJobProgress["phase"]): ImportJobProgress => ({
  status,
  phase,
  resumePhase: null,
  cancelRequested: false,
  attempt: status === "queued" ? 0 : 1,
  errorCode: null,
  retryAt: null,
  updatedAt: "2026-08-24T12:00:00.000Z",
});

const detailFor = (
  state: ImportJobProgress,
  result = state.status === "ready" || state.status === "completed" || state.phase === "ready" || state.phase === "applying"
    ? { rows: [], proposals: [] }
    : null,
) => ({
  id: "018f7c89-4d76-7b8a-9a3e-4d6bf4a99811",
  budgetId: "budget-1",
  accountId: "account-1",
  locale: "pl-PL",
  provider: { provider: "enveo" as const, model: "gpt-test" },
  tier: "plain" as const,
  epoch: 1,
  ...state,
  result,
  proposalCount: 0,
  screenshots: { total: 1, read: state.status === "queued" ? 0 : 1, failed: 0 },
  partialFailure: null,
  appliedCount: 0,
  skippedCount: 0,
  createdAt: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-08-31T12:00:00.000Z",
});

describe("durable screenshot import lifecycle", () => {
  it("moves a queued import through processing to a reviewable result", () => {
    // given: a durably queued screenshot import
    const queued = progress("queued", "queued");

    // when: a worker claims it and persists a result
    const running = advanceImportJob(queued, { type: "claimed", at: "2026-08-24T12:00:01.000Z" });
    const ready = advanceImportJob(running, { type: "result_ready", at: "2026-08-24T12:00:02.000Z" });

    // then: the same job becomes ready for explicit review
    expect(running).toMatchObject({ status: "running", phase: "extracting", attempt: 1 });
    expect(ready).toMatchObject({ status: "ready", phase: "ready" });
    expect(isTerminalImportJob(ready.status)).toBe(false);
  });

  it("keeps network and device waits as resumable running work", () => {
    // given: an import currently being processed
    const running = progress("running", "extracting");

    // when: its execution context becomes temporarily unavailable
    const offline = advanceImportJob(running, {
      type: "wait",
      phase: "waiting_for_network",
      at: "2026-08-24T12:00:01.000Z",
    });

    // then: it remains resumable instead of becoming failed
    expect(offline).toMatchObject({ status: "running", phase: "waiting_for_network", resumePhase: "extracting", errorCode: null });
  });

  it("remembers processing progress while waiting and rejects a backwards resume", () => {
    // given: reconciliation paused because the device is offline
    const reconciling = progress("running", "reconciling");
    const waiting = advanceImportJob(reconciling, {
      type: "wait",
      phase: "waiting_for_network",
      at: "2026-08-24T12:00:01.000Z",
    });

    // when: the worker resumes after connectivity returns
    const resumed = advanceImportJob(waiting, { type: "resume", at: "2026-08-24T12:00:02.000Z" });

    // then: it resumes reconciliation and cannot go back to extraction
    expect(resumed).toMatchObject({ status: "running", phase: "reconciling" });
    expect(() =>
      advanceImportJob(waiting, {
        type: "phase",
        phase: "extracting",
        at: "2026-08-24T12:00:02.000Z",
      } as ImportJobEvent),
    ).toThrow("invalid_import_job_transition");
  });

  it("rejects invalid event timestamps before persisting them as updatedAt", () => {
    // given: a queue entry awaiting a claim
    const queued = progress("queued", "queued");

    // when/then: an invalid wire timestamp cannot become its persisted update timestamp
    expect(() => advanceImportJob(queued, { type: "claimed", at: "not-a-timestamp" })).toThrow("invalid_import_job_transition");
  });

  it("records cancellation intent until a running upstream call can be discarded", () => {
    // given: a running model request
    const running = progress("running", "extracting");

    // when: the user explicitly cancels it
    const requested = advanceImportJob(running, { type: "cancel", at: "2026-08-24T12:00:01.000Z" });
    const cancelled = advanceImportJob(requested, { type: "cancelled", at: "2026-08-24T12:00:02.000Z" });

    // then: cancellation is visible only after cleanup is persisted
    expect(requested).toMatchObject({ status: "running", cancelRequested: true });
    expect(cancelled).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(isTerminalImportJob(cancelled.status)).toBe(true);
  });

  it("rejects backwards phases and changes to terminal jobs", () => {
    const validating = progress("running", "validating");
    const completed = progress("completed", "completed");

    expect(() => advanceImportJob(validating, { type: "phase", phase: "extracting", at: "2026-08-24T12:00:01.000Z" })).toThrow("invalid_import_job_transition");
    expect(() => advanceImportJob(completed, { type: "cancel", at: "2026-08-24T12:00:01.000Z" })).toThrow("invalid_import_job_transition");
  });
});

describe("durable screenshot import wire contract", () => {
  it("exposes only the accepted persisted phases", () => {
    expect(IMPORT_JOB_PHASES).toEqual([
      "preparing",
      "uploading",
      "queued",
      "extracting",
      "validating",
      "enriching",
      "reconciling",
      "ready",
      "applying",
      "completed",
      "waiting_for_network",
      "waiting_for_device",
      "waiting_for_unlock",
      "retry_scheduled",
    ]);
    for (const phase of IMPORT_JOB_PHASES) expect(importJobPhaseSchema.parse(phase)).toBe(phase);
    expect(() => importJobPhaseSchema.parse("42_percent")).toThrow();
  });

  it("accepts a complete ready job without internal worker fields", () => {
    const detail = {
      id: "018f7c89-4d76-7b8a-9a3e-4d6bf4a99811",
      budgetId: "budget-1",
      accountId: "account-1",
      locale: "pl-PL",
      provider: { provider: "enveo" as const, model: "gpt-test" },
      tier: "plain" as const,
      epoch: 1,
      status: "ready" as const,
      phase: "ready" as const,
      resumePhase: null,
      cancelRequested: false,
      attempt: 1,
      errorCode: null,
      retryAt: null,
      result: { rows: [], proposals: [] },
      proposalCount: 0,
      screenshots: { total: 1, read: 1, failed: 0 },
      partialFailure: null,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:01.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
    };

    expect(importJobDetailSchema.parse(detail)).toEqual(detail);
  });

  it("accepts the Stage A recognition result before reconciliation adds ledger state", () => {
    const detail = {
      id: "018f7c89-4d76-7b8a-9a3e-4d6bf4a99811",
      budgetId: "budget-1",
      accountId: "account-1",
      locale: "pl-PL",
      provider: { provider: "enveo" as const, model: "gpt-test" },
      tier: "plain" as const,
      epoch: 1,
      status: "ready" as const,
      phase: "ready" as const,
      resumePhase: null,
      cancelRequested: false,
      attempt: 1,
      errorCode: null,
      retryAt: null,
      result: {
        rows: [],
        proposals: [
          {
            rowId: "row-1",
            sourceRows: ["row-1"],
            disposition: "candidate" as const,
            date: "2026-08-24",
            amount: 123,
            currency: "PLN",
            type: "expense" as const,
            isRefund: false,
            toAccountId: null,
            semanticKind: "card_purchase" as const,
            relation: null,
            name: "Shop",
            tag: "",
            rawPlace: "Shop",
            envelopeId: null,
            categoryId: null,
            placeName: null,
            reviewReasons: [],
            selected: true,
          },
        ],
      },
      proposalCount: 1,
      screenshots: { total: 1, read: 1, failed: 0 },
      partialFailure: null,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:01.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
    };

    expect(importJobDetailSchema.parse(detail)).toEqual(detail);
  });

  it("validates epoch according to the budget tier", () => {
    const freshPlain = { ...detailFor(progress("queued", "queued")), tier: "plain" as const, epoch: 0 };
    const encrypted = { ...detailFor(progress("queued", "queued")), tier: "e2ee" as const, epoch: 1 };

    expect(importJobDetailSchema.parse(freshPlain)).toEqual(freshPlain);
    expect(importJobDetailSchema.parse(encrypted)).toEqual(encrypted);
    expect(() => importJobDetailSchema.parse({ ...freshPlain, epoch: -1 })).toThrow();
    expect(() => importJobDetailSchema.parse({ ...encrypted, epoch: 0 })).toThrow();
  });

  it("rejects impossible status and phase combinations", () => {
    const base = {
      id: "018f7c89-4d76-7b8a-9a3e-4d6bf4a99811",
      budgetId: "budget-1",
      accountId: "account-1",
      locale: "pl-PL",
      provider: { provider: "enveo", model: "gpt-test" },
      tier: "plain",
      epoch: 1,
      resumePhase: null,
      cancelRequested: false,
      attempt: 1,
      errorCode: null,
      retryAt: null,
      result: null,
      proposalCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:01.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
    };

    expect(() => importJobDetailSchema.parse({ ...base, status: "completed", phase: "queued" })).toThrow();
    expect(() => importJobDetailSchema.parse({ ...base, status: "ready", phase: "extracting" })).toThrow();
    expect(() => importJobDetailSchema.parse({ ...base, status: "failed", phase: "retry_scheduled" })).toThrow();
  });

  it("accepts every meaningful state produced by the lifecycle guard", () => {
    const queued = progress("queued", "queued");
    const running = advanceImportJob(queued, { type: "claimed", at: "2026-08-24T12:00:01.000Z" });
    const validating = advanceImportJob(running, { type: "phase", phase: "validating", at: "2026-08-24T12:00:02.000Z" });
    const enriching = advanceImportJob(validating, { type: "phase", phase: "enriching", at: "2026-08-24T12:00:03.000Z" });
    const reconciling = advanceImportJob(enriching, { type: "phase", phase: "reconciling", at: "2026-08-24T12:00:04.000Z" });
    const waiting = advanceImportJob(reconciling, { type: "wait", phase: "waiting_for_network", at: "2026-08-24T12:00:05.000Z" });
    const resumed = advanceImportJob(waiting, { type: "resume", at: "2026-08-24T12:00:06.000Z" });
    const ready = advanceImportJob(resumed, { type: "result_ready", at: "2026-08-24T12:00:07.000Z" });
    const applying = advanceImportJob(ready, { type: "begin_apply", at: "2026-08-24T12:00:08.000Z" });
    const completed = advanceImportJob(applying, { type: "completed", at: "2026-08-24T12:00:09.000Z" });
    const failed = advanceImportJob(running, { type: "failed", errorCode: "network", retryAt: null, at: "2026-08-24T12:00:08.000Z" });
    const retryScheduled = advanceImportJob(running, {
      type: "failed",
      errorCode: "network",
      retryAt: "2026-08-24T12:05:00.000Z",
      at: "2026-08-24T12:00:08.000Z",
    });
    const retried = advanceImportJob(retryScheduled, { type: "retry", at: "2026-08-24T12:00:09.000Z" });
    const cancelRequested = advanceImportJob(running, { type: "cancel", at: "2026-08-24T12:00:10.000Z" });
    const cancelledRunning = advanceImportJob(cancelRequested, { type: "cancelled", at: "2026-08-24T12:00:11.000Z" });
    const cancelledQueued = advanceImportJob(queued, { type: "cancel", at: "2026-08-24T12:00:12.000Z" });
    const cancelledApplying = advanceImportJob(applying, { type: "cancel", at: "2026-08-24T12:00:13.000Z" });
    const cancelledFailed = advanceImportJob(failed, { type: "cancel", at: "2026-08-24T12:00:14.000Z" });
    const cancelledRetryScheduled = advanceImportJob(retryScheduled, { type: "cancel", at: "2026-08-24T12:00:15.000Z" });

    for (const [name, state] of [
      ["queued", queued],
      ["running", running],
      ["validating", validating],
      ["enriching", enriching],
      ["reconciling", reconciling],
      ["waiting", waiting],
      ["resumed", resumed],
      ["ready", ready],
      ["applying", applying],
      ["completed", completed],
      ["failed", failed],
      ["retry scheduled", retryScheduled],
      ["retried", retried],
      ["cancel requested", cancelRequested],
      ["cancelled running", cancelledRunning],
      ["cancelled queued", cancelledQueued],
      ["cancelled applying", cancelledApplying],
      ["cancelled failed", cancelledFailed],
      ["cancelled retry scheduled", cancelledRetryScheduled],
    ] as const) {
      expect(importJobDetailSchema.safeParse(detailFor(state)).success, name).toBe(true);
    }
  });

  it("rejects impossible lifecycle state combinations", () => {
    const failed = advanceImportJob(progress("running", "extracting"), {
      type: "failed",
      errorCode: "network",
      retryAt: null,
      at: "2026-08-24T12:00:01.000Z",
    });
    const cases = [
      { name: "completed cancellation", state: { ...progress("completed", "completed"), cancelRequested: true } },
      { name: "failed cancellation", state: { ...failed, cancelRequested: true } },
      { name: "failed ready phase", state: { ...failed, phase: "ready" as const } },
      { name: "failed applying phase", state: { ...failed, phase: "applying" as const } },
      { name: "failed completed phase", state: { ...failed, phase: "completed" as const } },
      { name: "failed without error", state: { ...failed, errorCode: null } },
      { name: "retry phase without retry timestamp", state: { ...failed, phase: "retry_scheduled" as const } },
    ];

    for (const { name, state } of cases) {
      expect(importJobDetailSchema.safeParse(detailFor(state)).success, name).toBe(false);
    }
  });

  it("rejects malformed public job details", () => {
    expect(() =>
      importJobDetailSchema.parse({
        id: "018f7c89-4d76-7b8a-9a3e-4d6bf4a99811",
        budgetId: "budget-1",
        accountId: "account-1",
        locale: "pl-PL",
        provider: { provider: "enveo", model: "gpt-test" },
        tier: "plain",
        epoch: 1,
        status: "ready",
        phase: "ready",
        cancelRequested: false,
        attempt: 1,
        errorCode: null,
        retryAt: null,
        result: { rows: [], proposals: [{ selected: "yes" }] },
        appliedCount: 0,
        skippedCount: 0,
        createdAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:00:01.000Z",
        expiresAt: "2026-08-31T12:00:00.000Z",
      }),
    ).toThrow();
  });
});
