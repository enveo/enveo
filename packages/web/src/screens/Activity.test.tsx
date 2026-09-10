/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importProgressPresentation, runImportProgressAction, sharedDeviceImportWarning } from "../components/ImportProgress";
import type { ImportActivityItem } from "../lib/importJobs/store";
import * as activityModule from "./Activity";
import { activityAttentionCount, activityDismissMessage, activitySections, canRetryActivityImport, retryActivityImport } from "./Activity";

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
  screenshots: { total: 1, read: status === "queued" ? 0 : 1, failed: 0 },
  partialFailure: null,
  appliedCount: status === "completed" ? 1 : 0,
  skippedCount: status === "completed" ? 1 : 0,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:01:00.000Z",
  expiresAt: "2026-08-31T10:00:00.000Z",
  ...overrides,
});

describe("durable import foreground and Activity view models", () => {
  it("allows selection only for imports that are safe to remove", () => {
    const canRemove = (activityModule as unknown as { canRemoveActivityImport: (value: ImportActivityItem) => boolean }).canRemoveActivityImport;

    expect([item("completed"), item("failed"), item("ready")].map(canRemove)).toEqual([true, true, true]);
    expect([item("queued"), item("running")].map(canRemove)).toEqual([false, false]);
  });
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
    const cancelled = item("cancelled", { id: "cancelled" });
    const expired = item("completed", { id: "expired", expiresAt: "2026-08-23T00:00:00.000Z" });

    // when: Activity builds its one shared view model
    const sections = activitySections([duplicateDraft, accepted, ready, failed, completed, cancelled, expired], new Date("2026-08-24T12:00:00.000Z"));

    // then: accepted wins by id, expired history disappears, and ready+failed drive the badge
    expect(sections.active.map(({ id, source }) => ({ id, source }))).toEqual([{ id: "same", source: "plain" }]);
    expect(sections.ready.map((job) => job.id)).toEqual(["ready"]);
    expect(sections.failed.map((job) => job.id)).toEqual(["failed"]);
    expect(sections.completed.map((job) => job.id)).toEqual(["completed"]);
    expect(sections.cancelled.map((job) => job.id)).toEqual(["cancelled"]);
    expect(activityAttentionCount(sections)).toBe(2);
  });

  it("presents a scheduled retry as automatic progress instead of user attention", () => {
    const retrying = item("failed", {
      id: "retrying",
      phase: "retry_scheduled",
      retryAt: "2026-08-24T10:05:00.000Z",
      errorCode: "network",
    });

    const sections = activitySections([retrying]);

    expect(sections.active.map((job) => job.id)).toEqual(["retrying"]);
    expect(sections.failed).toEqual([]);
    expect(activityAttentionCount(sections)).toBe(0);
    expect(importProgressPresentation(retrying)).toMatchObject({ kind: "progress", message: "A retry is scheduled…", canCancel: true });
  });

  it("offers manual retry only while the failed import still has retained input", () => {
    expect(canRetryActivityImport(item("failed", { errorCode: "network" }))).toBe(true);
    expect(canRetryActivityImport(item("failed", { errorCode: "expired" }))).toBe(false);
  });

  it("surfaces a rejected manual retry instead of swallowing the promise", async () => {
    let refreshed = false;
    const message = await retryActivityImport(
      "job-failed",
      async () => {
        throw new Error('409 {"error":"invalid_import_job_state"}');
      },
      async () => {
        refreshed = true;
      },
    );

    expect(message).toBe("This import expired. Start a new import from the screenshots.");
    expect(refreshed).toBe(true);
  });

  it("keeps the global badge in its own lazy entry without importing the Activity screen", () => {
    const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
    const badge = readFileSync(join(import.meta.dir, "..", "components", "ImportActivityBadge.tsx"), "utf8");
    const optionalChrome = readFileSync(join(import.meta.dir, "..", "components", "OptionalStatusChrome.tsx"), "utf8");

    expect(app).toContain('lazy(() => import("./components/OptionalStatusChrome")');
    expect(app).not.toContain("<Activity onOpen=");
    expect(readFileSync(join(import.meta.dir, "..", "components", "HeaderImportBadge.tsx"), "utf8")).toContain('import("./ImportActivityBadge")');
    expect(optionalChrome).not.toContain('from "../screens/Activity"');
    expect(optionalChrome).not.toContain('from "./ImportSheet"');
    expect(badge).not.toContain("importJobManager.list()");
    expect(badge).not.toContain("setInterval(");
  });

  it("aligns import and sync indicators in one header status group", () => {
    const optionalChrome = readFileSync(join(import.meta.dir, "..", "components", "OptionalStatusChrome.tsx"), "utf8");
    const importBadge = readFileSync(join(import.meta.dir, "..", "components", "ImportActivityBadge.tsx"), "utf8");
    const syncBadge = readFileSync(join(import.meta.dir, "..", "components", "SyncActivityBadge.tsx"), "utf8");

    expect(optionalChrome).toContain('data-header-status-group="true"');
    expect(optionalChrome).toContain('alignItems: "center"');
    expect(importBadge).not.toContain('position: "absolute"');
    expect(syncBadge).not.toContain('position: "absolute"');
  });

  it("keeps rejected sync writes eager and makes import-manager bootstrap failure retryable", () => {
    const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
    const main = readFileSync(join(import.meta.dir, "..", "main.tsx"), "utf8");
    const syncBadge = readFileSync(join(import.meta.dir, "..", "components", "SyncBadge.tsx"), "utf8");
    const optionalChrome = readFileSync(join(import.meta.dir, "..", "components", "OptionalStatusChrome.tsx"), "utf8");

    expect(app).toContain('import { SyncBadge } from "./components/SyncBadge"');
    expect(app).not.toContain('lazy(() => import("./components/SyncBadge")');
    expect(app).not.toContain('<LazyChunk variant="silent">\n              <SyncBadge');
    expect(app).toContain('lazy(() => import("./components/OptionalStatusChrome")');
    expect(syncBadge).toContain("if (deadLetters > 0)");
    expect(syncBadge).toContain('state === "unauthed"');
    expect(syncBadge).toContain("ownerUnproven");
    expect(syncBadge).not.toContain("lazy(");
    expect(optionalChrome).toContain('from "./UpdatePrompt"');
    expect(app).toContain("importManagerBootstrap.getSnapshot");
    expect(app).toContain('aria-label={t("Imports could not be refreshed. Try again.")}');
    expect(main).toContain("startImportJobManager()");
    expect(main).not.toContain('import("./lib/importJobs/manager").then');
  });

  it("labels plain dismissal as session-only and explains local E2EE shared-device privacy", () => {
    expect(activityDismissMessage(item("completed"))).toBe("Hide for this session");
    expect(activityDismissMessage(item("completed", { source: "e2ee", tier: "e2ee", epoch: 3 }))).toBe("Remove from this device");
    expect(sharedDeviceImportWarning("e2ee", "memory-session")).toBe(
      "This import runs directly between this device and OpenAI. On a shared device it cannot survive closing or reloading the app.",
    );
    expect(sharedDeviceImportWarning("plain", "memory-session")).toBeNull();
  });

  it("uses readable theme tokens for Activity status copy and actions", () => {
    const source = readFileSync(join(import.meta.dir, "Activity.tsx"), "utf8");

    expect(source).not.toContain("color: C.mute");
    expect((source.match(/color: C\.soft/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(source).not.toContain("color: TEAL");
    expect(source).not.toContain("background: TEAL");
    expect(source).toContain("background: C.text, color: C.card");
  });

  it("keeps card selection available without a layout-shifting selection mode", () => {
    const source = readFileSync(join(import.meta.dir, "Activity.tsx"), "utf8");

    expect(source).not.toContain("const [selecting");
    expect(source).not.toContain('\n                    {t("Select import")}');
    expect(source).not.toContain('{t("Cancel selection")}');
    expect(source).toContain("data-import-select");
    expect(source).toContain("data-section-heading-actions");
    expect(source).toContain('{t(allSelected ? msg("Deselect all") : msg("Select all"))}');
    expect(source).toContain('aria-label={t("Delete selected ({count})", { count: selected.size })}');
    expect(source).toContain("const selectionAnchorId = selected.values().next().value");
    expect(source).toContain("new Set([...selected, ...removable.map((job) => job.id)])");
    expect(source).toContain('aria-label={t("Select import from {date}", { date: date(job.updatedAt) })}');
    expect(source).toContain("marginRight: canRemoveActivityImport(job) ? 34 : 0");
  });

  it("uses the Duet band header on phones and a responsive import grid on fold and desktop", () => {
    const source = readFileSync(join(import.meta.dir, "Activity.tsx"), "utf8");

    expect(source).toContain('import { useWideHost } from "../lib/shellContext"');
    expect(source).toContain("const wideHost = useWideHost()");
    expect(source).toContain("const { band, hc } = useBand()");
    expect(source).toContain("{!wideHost && (");
    expect(source).toContain("data-imports-header");
    expect(source).toContain("data-band={band || undefined}");
    expect(source).toContain("background: band ? C.headerBg : undefined");
    expect(source).toContain('{t("Imports")}');
    expect(source).not.toContain("Imports continue independently of this screen.");
    expect(source).toContain('{t("No imports")}');
    expect(source).toContain('{t("Add screenshots or a PDF statement with the + button.")}');
    expect(source).toContain("data-activity-content");
    expect(source).toContain('boxSizing: "border-box"');
    expect(source).toContain('gridTemplateColumns: wideHost ? "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" : "1fr"');
  });

  it("opens screenshot review as a wide dialog and expands its editor outside phone mode", () => {
    const source = readFileSync(join(import.meta.dir, "..", "components", "ImportSheet.tsx"), "utf8");
    const chrome = readFileSync(join(import.meta.dir, "..", "components", "chrome.tsx"), "utf8");

    expect(source).toContain("const wideHost = useWideHost()");
    expect(source).toContain("<Sheet show={show} onClose={close} wideDialog>");
    expect(source).toContain("maxWidth: wideHost ? 720 : PHONE_COL");
    expect(source).toContain('data-import-editor-mode={wideHost?.mode ?? "phone"}');
    expect(source).toContain("importJobManager.list().catch");
    expect(chrome).toContain("wideDialog?: boolean");
    expect(chrome).toContain("const dialog = wideDialog && wideHost !== null");
    expect(chrome).toContain('data-sheet-layout={dialog ? "dialog" : "bottom"}');
    expect(chrome).toContain('boxSizing: "border-box"');
  });
});
