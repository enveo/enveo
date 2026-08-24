import { describe, expect, it } from "bun:test";
import { advanceImportJob, IMPORT_JOB_PHASES, type ImportJobProgress, importJobDetailSchema, importJobPhaseSchema, isTerminalImportJob } from "./importJobs";

const progress = (status: ImportJobProgress["status"], phase: ImportJobProgress["phase"]): ImportJobProgress => ({
  status,
  phase,
  cancelRequested: false,
  attempt: status === "queued" ? 0 : 1,
  errorCode: null,
  retryAt: null,
  updatedAt: "2026-08-24T12:00:00.000Z",
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
    expect(offline).toMatchObject({ status: "running", phase: "waiting_for_network", errorCode: null });
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
      cancelRequested: false,
      attempt: 1,
      errorCode: null,
      retryAt: null,
      result: { rows: [], proposals: [] },
      proposalCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:01.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
    };

    expect(importJobDetailSchema.parse(detail)).toEqual(detail);
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
