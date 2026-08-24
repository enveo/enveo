/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { importProgressPresentation, runImportProgressAction, sharedDeviceImportWarning } from "../components/ImportProgress";
import type { ImportActivityItem } from "../lib/importJobs/store";
import { activityAttentionCount, activityDismissMessage, activitySections } from "./Activity";

const item = (status: ImportActivityItem["status"], overrides: Partial<ImportActivityItem> = {}): ImportActivityItem => ({
  id: `job-${status}`,
  budgetId: "budget-1",
  accountId: "account-1",
  provider: { provider: "openai", model: "gpt-5.6-luna" },
  locale: "en-US",
  tier: "plain",
  epoch: 0,
  source: "plain",
  status,
  phase:
    status === "ready" ? "ready" : status === "completed" ? "completed" : status === "failed" ? "extracting" : status === "running" ? "extracting" : "queued",
  resumePhase: null,
  cancelRequested: false,
  attempt: status === "queued" ? 0 : 1,
  errorCode: status === "failed" ? "network" : null,
  retryAt: null,
  result: status === "ready" ? { rows: [], proposals: [] } : null,
  proposalCount: status === "ready" ? 2 : 0,
  appliedCount: status === "completed" ? 1 : 0,
  skippedCount: status === "completed" ? 1 : 0,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:01:00.000Z",
  expiresAt: "2026-08-31T10:00:00.000Z",
  ...overrides,
});

describe("durable import foreground and Activity view models", () => {
  it("presents persisted phases in order and sends a waiting observer directly to review", () => {
    // given: one foreground observer receives the durable lifecycle in sequence
    const phases: ImportActivityItem["phase"][] = ["uploading", "queued", "extracting", "validating", "enriching", "reconciling"];

    // when: each update is converted to the foreground presentation
    const presentations = phases.map((phase) => importProgressPresentation(item(phase === "queued" ? "queued" : "running", { phase })));
    const ready = importProgressPresentation(item("ready"));

    // then: the visible labels preserve phase order and ready opens the same review immediately
    expect(presentations.map((state) => state.message)).toEqual([
      "Uploading screenshots…",
      "Waiting to start…",
      "Reading transactions…",
      "Checking recognized data…",
      "Matching your budget…",
      "Checking the current ledger…",
    ]);
    expect(presentations.every((state) => state.kind === "progress" && state.canContinueInBackground && state.canCancel)).toBe(true);
    expect(ready).toMatchObject({ kind: "review", message: "Ready to review", canContinueInBackground: false, canCancel: false });
  });

  it("keeps background close distinct from explicit cancellation", async () => {
    // given: the foreground sheet owns only view-close and explicit cancel callbacks
    const events: string[] = [];
    const deps = {
      jobId: "job-running",
      close: () => events.push("closed"),
      cancel: async (id: string) => void events.push(`cancelled:${id}`),
    };

    // when/then: continuing in background detaches the view without touching the job
    await runImportProgressAction("background", deps);
    expect(events).toEqual(["closed"]);

    // when/then: explicit cancellation reaches the manager before closing
    events.length = 0;
    await runImportProgressAction("cancel", deps);
    expect(events).toEqual(["cancelled:job-running", "closed"]);
  });

  it("deduplicates the merged activity list and groups attention and recent completion truthfully", () => {
    // given: draft/server publication for one id overlaps active, ready, failed, expired, and recent jobs
    const duplicateDraft = item("queued", { id: "same", source: "plain-draft", updatedAt: "2026-08-24T10:00:00.000Z" });
    const accepted = item("running", { id: "same", source: "plain", updatedAt: "2026-08-24T10:02:00.000Z" });
    const ready = item("ready", { id: "ready" });
    const failed = item("failed", { id: "failed" });
    const completed = item("completed", { id: "completed" });
    const expired = item("completed", { id: "expired", expiresAt: "2026-08-23T00:00:00.000Z" });

    // when: Activity builds its one shared view model
    const sections = activitySections([duplicateDraft, accepted, ready, failed, completed, expired], new Date("2026-08-24T12:00:00.000Z"));

    // then: accepted wins by id, expired history disappears, and ready+failed drive the badge
    expect(sections.active.map(({ id, source }) => ({ id, source }))).toEqual([{ id: "same", source: "plain" }]);
    expect(sections.ready.map((job) => job.id)).toEqual(["ready"]);
    expect(sections.failed.map((job) => job.id)).toEqual(["failed"]);
    expect(sections.completed.map((job) => job.id)).toEqual(["completed"]);
    expect(activityAttentionCount(sections)).toBe(2);
  });

  it("labels plain dismissal as session-only and explains local E2EE shared-device privacy", () => {
    expect(activityDismissMessage(item("completed"))).toBe("Hide for this session");
    expect(activityDismissMessage(item("completed", { source: "e2ee", tier: "e2ee", epoch: 3 }))).toBe("Remove from this device");
    expect(sharedDeviceImportWarning("e2ee", "memory-session")).toBe(
      "This import runs directly between this device and OpenAI. On a shared device it cannot survive closing or reloading the app.",
    );
    expect(sharedDeviceImportWarning("plain", "memory-session")).toBeNull();
  });
});
