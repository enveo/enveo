import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { decryptPayload, encryptPayload, generateDek, importJobAadContext } from "./crypto";
import { __resetStorageForTests, idbGet, storageMode } from "./idb";
import { IMPORT_DRAFT_TTL_MS, importJobStorage, type PlainImportUploadDraftInput, type StoredE2eeImportJob } from "./importJobStorage";

const JOB_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_JOB_ID = "22222222-2222-2222-2222-222222222222";
const BUDGET_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_BUDGET_ID = "44444444-4444-4444-4444-444444444444";
const ACCOUNT_ID = "55555555-5555-5555-5555-555555555555";
const IMAGE = "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==";

function stubLocalStorage(policy: "persistent" | "session") {
  const values = new Map<string, string>([["enveo.deviceStoragePolicy", policy]]);
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const draftInput = (overrides: Partial<PlainImportUploadDraftInput> = {}): PlainImportUploadDraftInput => ({
  id: JOB_ID,
  budgetId: BUDGET_ID,
  accountId: ACCOUNT_ID,
  locale: "en-US",
  images: [IMAGE],
  ...overrides,
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
  stubLocalStorage("persistent");
  __resetStorageForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  delete (globalThis as Record<string, unknown>).localStorage;
  __resetStorageForTests();
});

describe("plain import upload drafts", () => {
  it("persists the canonical request and keeps the same idempotent draft on retry", async () => {
    const createdAt = new Date("2026-08-24T10:00:00.000Z");
    const first = await importJobStorage.createDraft(draftInput(), createdAt);
    const retry = await importJobStorage.createDraft(draftInput(), new Date("2026-08-24T11:00:00.000Z"));

    expect(retry).toEqual(first);
    expect(await importJobStorage.getDraft(JOB_ID)).toEqual(first);
    expect(first).toMatchObject({
      id: JOB_ID,
      budgetId: BUDGET_ID,
      accountId: ACCOUNT_ID,
      locale: "en-US",
      images: [IMAGE],
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
      expiresAt: "2026-08-25T10:00:00.000Z",
    });
    expect(first.requestHash).toBe("508d645bd4499667ec003bce1605f129a0781baf64889e7011edefdd4a715607");
  });

  it("refuses to replace a client job id with a conflicting canonical request", async () => {
    await importJobStorage.createDraft(draftInput(), new Date("2026-08-24T10:00:00.000Z"));

    await expect(importJobStorage.createDraft(draftInput({ images: ["data:image/png;base64,ZGlmZmVyZW50"] }))).rejects.toThrow("import_draft_conflict");

    expect((await importJobStorage.getDraft(JOB_ID))?.images).toEqual([IMAGE]);
  });

  it("deletes a draft only for the matching durable server acknowledgement", async () => {
    await importJobStorage.createDraft(draftInput());

    expect(await importJobStorage.acknowledgeDraft({ id: JOB_ID, budgetId: OTHER_BUDGET_ID, accountId: ACCOUNT_ID, locale: "en-US", tier: "plain" })).toBe(
      false,
    );
    expect(await importJobStorage.getDraft(JOB_ID)).toBeDefined();
    expect(await importJobStorage.acknowledgeDraft({ id: OTHER_JOB_ID, budgetId: BUDGET_ID, accountId: ACCOUNT_ID, locale: "en-US", tier: "plain" })).toBe(
      false,
    );
    expect(await importJobStorage.acknowledgeDraft({ id: JOB_ID, budgetId: BUDGET_ID, accountId: ACCOUNT_ID, locale: "en-US", tier: "plain" })).toBe(true);
    expect(await importJobStorage.getDraft(JOB_ID)).toBeUndefined();
  });

  it("expires only drafts that have reached the 24-hour boundary", async () => {
    const start = new Date("2026-08-24T10:00:00.000Z");
    await importJobStorage.createDraft(draftInput(), start);
    await importJobStorage.createDraft(draftInput({ id: OTHER_JOB_ID }), new Date(start.getTime() + 1));

    expect(await importJobStorage.pruneExpiredDrafts(new Date(start.getTime() + IMPORT_DRAFT_TTL_MS))).toBe(1);
    expect((await importJobStorage.listDrafts()).map((draft) => draft.id)).toEqual([OTHER_JOB_ID]);
  });

  it("deletes a cancelled draft and notifies its observers", async () => {
    await importJobStorage.createDraft(draftInput());
    const notifications: string[] = [];
    const unsubscribe = importJobStorage.subscribe(() => notifications.push("changed"));

    await importJobStorage.deleteDraft(JOB_ID);

    unsubscribe();
    expect(await importJobStorage.getDraft(JOB_ID)).toBeUndefined();
    expect(notifications).toEqual(["changed"]);
  });
});

describe("device-local E2EE import jobs", () => {
  it("stores only allowlisted metadata and v2 ciphertext, never plaintext image or result fields", async () => {
    const dek = generateDek();
    const inputCiphertext = await encryptPayload(IMAGE, dek, importJobAadContext(BUDGET_ID, 3, JOB_ID, "input"));
    const resultPlaintext = '{"merchant":"Private result"}';
    const resultCiphertext = await encryptPayload(resultPlaintext, dek, importJobAadContext(BUDGET_ID, 3, JOB_ID, "result"));
    const job: StoredE2eeImportJob & { images: string[]; prompt: string; result: { merchant: string }; dek: Uint8Array; openAiKey: string } = {
      id: JOB_ID,
      budgetId: BUDGET_ID,
      accountId: ACCOUNT_ID,
      provider: { provider: "openai", model: "gpt-5.6-luna" },
      locale: "en-US",
      tier: "e2ee",
      epoch: 3,
      status: "ready",
      phase: "ready",
      resumePhase: null,
      cancelRequested: false,
      attempt: 1,
      errorCode: null,
      retryAt: null,
      inputCiphertext,
      checkpointCiphertext: null,
      resultCiphertext,
      checkpointRevision: 2,
      proposalCount: 1,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:05:00.000Z",
      expiresAt: "2026-08-31T10:00:00.000Z",
      images: [IMAGE],
      prompt: "Private prompt",
      result: { merchant: "Private result" },
      dek,
      openAiKey: "sk-private",
    };

    await importJobStorage.putJob(job);

    const raw = await idbGet<Record<string, unknown>>("importJobs", JOB_ID);
    expect(raw).toBeDefined();
    expect((raw!.inputCiphertext as string).startsWith("v2.")).toBe(true);
    expect((raw!.resultCiphertext as string).startsWith("v2.")).toBe(true);
    expect(JSON.stringify(raw)).not.toContain(IMAGE);
    expect(JSON.stringify(raw)).not.toContain("Private prompt");
    expect(JSON.stringify(raw)).not.toContain("Private result");
    expect(JSON.stringify(raw)).not.toContain("sk-private");
    expect(raw?.dek).toBeUndefined();
    expect(await decryptPayload(raw?.resultCiphertext as string, dek, importJobAadContext(BUDGET_ID, 3, JOB_ID, "result"))).toBe(resultPlaintext);
  });

  it("supports job CRUD and notifies subscribers after durable mutations", async () => {
    const notifications: number[] = [];
    const unsubscribe = importJobStorage.subscribe(() => notifications.push(notifications.length + 1));
    const job = {
      id: JOB_ID,
      budgetId: BUDGET_ID,
      accountId: ACCOUNT_ID,
      provider: { provider: "openai" as const, model: "gpt-5.6-luna" },
      locale: "en-US",
      tier: "e2ee" as const,
      epoch: 3,
      status: "queued" as const,
      phase: "preparing" as const,
      resumePhase: null,
      cancelRequested: false,
      attempt: 0,
      errorCode: null,
      retryAt: null,
      inputCiphertext: "v2.input",
      checkpointCiphertext: null,
      resultCiphertext: null,
      checkpointRevision: 0,
      proposalCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
      expiresAt: "2026-08-31T10:00:00.000Z",
    } satisfies StoredE2eeImportJob;

    await importJobStorage.putJob(job);
    expect(await importJobStorage.getJob(JOB_ID)).toEqual(job);
    expect(await importJobStorage.listJobs()).toEqual([job]);
    await importJobStorage.deleteJob(JOB_ID);
    expect(await importJobStorage.getJob(JOB_ID)).toBeUndefined();
    unsubscribe();
    expect(notifications).toEqual([1, 2]);
  });

  it("rejects a stale runner before it can replace a newer checkpoint revision", async () => {
    const original = {
      id: JOB_ID,
      budgetId: BUDGET_ID,
      accountId: ACCOUNT_ID,
      provider: { provider: "openai" as const, model: "gpt-5.6-luna" },
      locale: "en-US",
      tier: "e2ee" as const,
      epoch: 3,
      status: "running" as const,
      phase: "extracting" as const,
      resumePhase: null,
      cancelRequested: false,
      attempt: 1,
      errorCode: null,
      retryAt: null,
      inputCiphertext: "v2.input",
      checkpointCiphertext: null,
      resultCiphertext: null,
      checkpointRevision: 0,
      proposalCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
      expiresAt: "2026-08-31T10:00:00.000Z",
    } satisfies StoredE2eeImportJob;
    await importJobStorage.putJob(original);
    const winner = { ...original, phase: "validating" as const, checkpointCiphertext: "v2.checkpoint", checkpointRevision: 1 };
    const stale = { ...original, phase: "waiting_for_device" as const, resumePhase: "extracting" as const, checkpointRevision: 1 };

    expect(await importJobStorage.putJobIfRevision(winner, 0)).toBe(true);
    expect(await importJobStorage.putJobIfRevision(stale, 0)).toBe(false);

    expect(await importJobStorage.getJob(JOB_ID)).toEqual(winner);
  });

  it("uses MemoryBackend under the shared-device policy without opening IndexedDB", async () => {
    const factory = new IDBFactory();
    (globalThis as Record<string, unknown>).indexedDB = factory;
    stubLocalStorage("session");
    __resetStorageForTests();

    await importJobStorage.createDraft(draftInput());

    expect(storageMode()).toBe("memory-session");
    expect(await importJobStorage.getDraft(JOB_ID)).toBeDefined();
    expect(await factory.databases()).toEqual([]);
  });
});
