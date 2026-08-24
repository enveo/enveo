import { describe, expect, it } from "bun:test";
import type { ImportJobDetail } from "@enveo/shared";
import { createImportActivityStore, importActivityFromDraft, importActivityFromServer } from "./store";

const ID = "11111111-1111-1111-1111-111111111111";
const BUDGET = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "33333333-3333-3333-3333-333333333333";

const serverJob = (status: ImportJobDetail["status"] = "queued"): ImportJobDetail => ({
  id: ID,
  budgetId: BUDGET,
  accountId: ACCOUNT,
  provider: { provider: "enveo", model: "gpt-5.6-luna" },
  locale: "en-US",
  tier: "plain",
  epoch: 0,
  status,
  phase: status === "ready" ? "ready" : "queued",
  resumePhase: null,
  cancelRequested: false,
  attempt: status === "ready" ? 1 : 0,
  errorCode: null,
  retryAt: null,
  result: status === "ready" ? { rows: [], proposals: [] } : null,
  proposalCount: 0,
  appliedCount: 0,
  skippedCount: 0,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:00:00.000Z",
  expiresAt: "2026-08-31T10:00:00.000Z",
});

describe("merged import activity store", () => {
  it("replaces an upload draft with the acknowledged server job under one activity id", () => {
    const activity = createImportActivityStore();
    activity.upsert(
      importActivityFromDraft({
        id: ID,
        ownerId: "user-a",
        budgetId: BUDGET,
        accountId: ACCOUNT,
        locale: "en-US",
        images: ["data:image/png;base64,AA=="],
        requestHash: "hash",
        createdAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:00:00.000Z",
        expiresAt: "2026-08-25T10:00:00.000Z",
      }),
    );
    activity.upsert(importActivityFromServer(serverJob()));

    expect(activity.list()).toEqual([expect.objectContaining({ id: ID, source: "plain", phase: "queued" })]);
  });

  it("delivers the current item immediately and then only persisted updates for that id", () => {
    const activity = createImportActivityStore();
    const queued = importActivityFromServer(serverJob());
    activity.upsert(queued);
    const phases: string[] = [];
    const unsubscribe = activity.observe(ID, (item) => phases.push(item?.phase ?? "missing"));

    activity.upsert(importActivityFromServer(serverJob("ready")));
    unsubscribe();
    activity.remove(ID);

    expect(phases).toEqual(["queued", "ready"]);
  });
});
