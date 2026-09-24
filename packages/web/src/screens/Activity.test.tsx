/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportProposal } from "@enveo/shared";
import { importProgressPresentation, runImportProgressAction, sharedDeviceImportWarning } from "../components/ImportProgress";
import type { ImportActivityItem } from "../lib/importJobs/store";
import * as activityModule from "./Activity";
import {
  activityAttentionCount,
  activityDismissMessage,
  activitySections,
  canRetryActivityImport,
  importActivityFigures,
  retryActivityImport,
} from "./Activity";

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
    const phases: ImportActivityItem["phase"][] = ["uploading", "queued", "extracting", "validating", "enriching", "reconciling"];

    const presentations = phases.map((phase) => importProgressPresentation(item(phase === "queued" ? "queued" : "running", { phase })));
    const ready = importProgressPresentation(item("ready"));

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
    const events: string[] = [];
    const deps = {
      jobId: "job-running",
      close: () => events.push("closed"),
      cancel: async (id: string) => void events.push(`cancelled:${id}`),
    };

    await runImportProgressAction("background", deps);
    expect(events).toEqual(["closed"]);

    events.length = 0;
    await runImportProgressAction("cancel", deps);
    expect(events).toEqual(["cancelled:job-running", "closed"]);
  });

  it("deduplicates the merged activity list into current imports and recent completions", () => {
    const duplicateDraft = item("queued", { id: "same", source: "plain-draft", updatedAt: "2026-08-24T10:00:00.000Z" });
    const accepted = item("running", { id: "same", source: "plain", updatedAt: "2026-08-24T10:02:00.000Z" });
    const ready = item("ready", { id: "ready" });
    const failed = item("failed", { id: "failed" });
    const completed = item("completed", { id: "completed" });
    const cancelled = item("cancelled", { id: "cancelled" });
    const expired = item("completed", { id: "expired", expiresAt: "2026-08-23T00:00:00.000Z" });

    const sections = activitySections([duplicateDraft, accepted, ready, failed, completed, cancelled, expired], new Date("2026-08-24T12:00:00.000Z"));

    expect(sections.current.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: "same", source: "plain" },
      { id: "ready", source: "plain" },
      { id: "failed", source: "plain" },
    ]);
    expect(sections.completed.map((job) => job.id)).toEqual(["completed"]);
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

    expect(sections.current.map((job) => job.id)).toEqual(["retrying"]);
    expect(activityAttentionCount(sections)).toBe(0);
    expect(importProgressPresentation(retrying)).toMatchObject({ kind: "progress", message: "A retry is scheduled…", canCancel: true });
  });

  it("counts a ready import's candidates and the balance change of the preselected ones", () => {
    const proposal = (overrides: Partial<ImportProposal>): ImportProposal => ({
      rowId: "r",
      sourceRows: ["r"],
      disposition: "candidate",
      date: "2026-08-20",
      amount: 1000,
      currency: "USD",
      type: "expense",
      isRefund: false,
      toAccountId: null,
      semanticKind: "card_purchase",
      relation: null,
      name: "Example Market",
      tag: "",
      rawPlace: "",
      envelopeId: null,
      categoryId: null,
      placeName: null,
      reviewReasons: [],
      selected: true,
      ...overrides,
    });
    const ready = item("ready", {
      result: {
        rows: [],
        proposals: [
          proposal({ amount: 4250 }),
          proposal({ amount: 185000, type: "income" }),
          proposal({ amount: 675, isRefund: true }),
          proposal({ amount: 2000, type: "transfer", toAccountId: "account-1" }),
          proposal({ amount: 900, selected: false }),
          proposal({ amount: 300, disposition: "supporting" }),
        ],
      },
    });

    expect(importActivityFigures(ready)).toEqual({ kind: "review", toReview: 5, delta: -4250 + 185000 + 675 + 2000 });
  });

  it("reports what a completed import added and how it moved the source account", () => {
    const completed = item("completed", {
      appliedCount: 18,
      skippedCount: 2,
      result: {
        rows: [],
        proposals: [],
        receipt: {
          completedAt: "2026-08-24T10:01:00.000Z",
          currency: "USD",
          balances: [
            { accountId: "account-2", name: "Prairie Savings", before: 0, after: 500 },
            { accountId: "account-1", name: "Maple Harbor Checking", before: 436495, after: 395265 },
          ],
          rows: [],
        },
      },
    });

    expect(importActivityFigures(completed)).toEqual({ kind: "completed", added: 18, skipped: 2, delta: -41230 });
    expect(importActivityFigures(item("completed"))).toEqual({ kind: "completed", added: 1, skipped: 1, delta: null });
    expect(importActivityFigures(item("running"))).toBeNull();
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
  });

  it("hides row checkboxes behind an explicit Select mode with bulk actions", () => {
    const source = readFileSync(join(import.meta.dir, "Activity.tsx"), "utf8");

    expect(source).toContain("const [selecting, setSelecting] = useState(false)");
    expect(source).toContain("data-import-select-mode");
    expect(source).toContain('{selecting ? t("Done") : t("Select")}');
    expect(source).toContain("const checkable = selecting && canRemoveActivityImport(job)");
    expect(source).toContain("data-import-select");
    expect(source).toContain("data-section-heading-actions");
    expect(source).toContain('{t(allSelected ? msg("Deselect all") : msg("Select all"))}');
    expect(source).toContain('aria-label={t("Delete selected ({count})", { count: selected.size })}');
    expect(source).toContain('aria-label={t("Select import from {date}", { date: date(job.updatedAt) })}');
  });

  it("uses the Duet band header on phones and grouped import rows on every layout", () => {
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
    expect(source).toContain('{list(msg("To review"), sections.current');
    expect(source).toContain('{list(msg("Completed"), visibleCompleted');
    expect(source).toContain("<CardBox");
    expect(source).toContain("sections.completed.slice(0, PHONE_COMPLETED_LIMIT)");
  });

  it("opens screenshot review and its editor in the side panel outside phone mode", () => {
    const source = readFileSync(join(import.meta.dir, "..", "components", "ImportSheet.tsx"), "utf8");

    expect(source).toContain("<Surface show={show} onClose={close}>");
    expect(source).toContain("const editorPanel = wideHost?.surfaces?.node ?? null");
    expect(source).toContain("editorPanel ?? document.body");
    expect(source).toContain('data-import-editor-mode={wideHost?.mode ?? "phone"}');
    expect(source).toContain("importJobManager.list().catch");
  });
});
