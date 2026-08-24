import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { decryptPayload, encryptPayload, generateDek, importJobAadContext } from "./crypto";
import { __resetStorageForTests, idbAdd, idbGet, idbPut, storageMode } from "./idb";
import {
  IMPORT_DRAFT_TTL_MS,
  type ImportJobStorageScope,
  importJobStorage,
  type PlainImportUploadDraftInput,
  type StoredE2eeImportJob,
} from "./importJobStorage";

const JOB_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_JOB_ID = "22222222-2222-2222-2222-222222222222";
const BUDGET_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_BUDGET_ID = "44444444-4444-4444-4444-444444444444";
const ACCOUNT_ID = "55555555-5555-5555-5555-555555555555";
const IMAGE = "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==";
const OWNER_ID = "user-a";
const OTHER_OWNER_ID = "user-b";
const SCOPE = { ownerId: OWNER_ID, budgetId: BUDGET_ID } satisfies ImportJobStorageScope;
const OTHER_OWNER_SCOPE = { ownerId: OTHER_OWNER_ID, budgetId: BUDGET_ID } satisfies ImportJobStorageScope;
const OTHER_BUDGET_SCOPE = { ownerId: OWNER_ID, budgetId: OTHER_BUDGET_ID } satisfies ImportJobStorageScope;

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
  ownerId: OWNER_ID,
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
  it("persists exact apply identities and counts without storing recognized result data", async () => {
    await importJobStorage.putApplyProgress(SCOPE, JOB_ID, {
      appliedRowIds: ["row-one", "row-two", "row-one"],
      skippedRowIds: ["row-three"],
    });

    expect(await importJobStorage.getApplyProgress(SCOPE, JOB_ID)).toEqual({
      appliedRowIds: ["row-one", "row-two"],
      appliedCount: 2,
      skippedRowIds: ["row-three"],
      skippedCount: 1,
    });
    expect(JSON.stringify(await idbGet("meta", JSON.stringify(["import-apply-progress", 3, OWNER_ID, BUDGET_ID, JOB_ID])))).not.toContain("Private result");
  });

  it("atomically keeps one prepared transaction identity and merges progress across tabs", async () => {
    // given: two tabs prepare and then account for different rows at the same time
    const claims = await Promise.all([
      importJobStorage.claimApplyRow(SCOPE, JOB_ID, {
        rowToken: "opaque-row-one",
        transactionId: "transaction-from-tab-one",
        ownerToken: "tab-one",
        now: 100,
        leaseUntil: 200,
      }),
      importJobStorage.claimApplyRow(SCOPE, JOB_ID, {
        rowToken: "opaque-row-one",
        transactionId: "transaction-from-tab-two",
        ownerToken: "tab-two",
        now: 100,
        leaseUntil: 200,
      }),
    ]);

    await Promise.all([
      importJobStorage.mergeApplyProgress(SCOPE, JOB_ID, { appliedRowIds: ["opaque-row-one"] }),
      importJobStorage.mergeApplyProgress(SCOPE, JOB_ID, { skippedRowIds: ["opaque-row-two"] }),
    ]);

    // then: both tabs use the same mutation id and neither durable identity is lost
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "busy")).toHaveLength(1);
    expect(await importJobStorage.getApplyProgress(SCOPE, JOB_ID)).toEqual({
      appliedRowIds: ["opaque-row-one"],
      appliedCount: 1,
      skippedRowIds: ["opaque-row-two"],
      skippedCount: 1,
    });
  });

  it("fences one row owner, renews it, and reclaims the lease only after expiry", async () => {
    // given: two tabs race for one opaque apply identity
    const first = await importJobStorage.claimApplyRow(SCOPE, JOB_ID, {
      rowToken: "h1.opaque-row",
      transactionId: "transaction-from-tab-one",
      ownerToken: "tab-one",
      now: 100,
      leaseUntil: 200,
    });
    const blocked = await importJobStorage.claimApplyRow(SCOPE, JOB_ID, {
      rowToken: "h1.opaque-row",
      transactionId: "transaction-from-tab-two",
      ownerToken: "tab-two",
      now: 150,
      leaseUntil: 250,
    });
    const sameOwnerBlocked = await importJobStorage.claimApplyRow(SCOPE, JOB_ID, {
      rowToken: "h1.opaque-row",
      transactionId: "must-not-replace-stable-transaction",
      ownerToken: "tab-one",
      now: 151,
      leaseUntil: 251,
    });

    // when: only the current owner renews, then another tab returns after expiry
    const wrongOwnerRenewed = await importJobStorage.renewApplyRow(SCOPE, JOB_ID, {
      rowToken: "h1.opaque-row",
      ownerToken: "tab-two",
      fence: first.kind === "claimed" ? first.fence : -1,
      now: 175,
      leaseUntil: 275,
    });
    const reclaimed = await importJobStorage.claimApplyRow(SCOPE, JOB_ID, {
      rowToken: "h1.opaque-row",
      transactionId: "must-not-replace-stable-transaction",
      ownerToken: "tab-two",
      now: 201,
      leaseUntil: 301,
    });

    // then: the transaction id is stable and the monotonically increasing fence rejects tab one
    expect(first).toEqual({ kind: "claimed", transactionId: "transaction-from-tab-one", fence: 1 });
    expect(blocked).toEqual({ kind: "busy" });
    expect(sameOwnerBlocked).toEqual({ kind: "busy" });
    expect(wrongOwnerRenewed).toBe(false);
    expect(reclaimed).toEqual({ kind: "claimed", transactionId: "transaction-from-tab-one", fence: 2 });
    expect(
      await importJobStorage.completeApplyRow(SCOPE, JOB_ID, {
        rowToken: "h1.opaque-row",
        ownerToken: "tab-one",
        fence: 1,
      }),
    ).toBe(false);
    expect(
      await importJobStorage.completeApplyRow(SCOPE, JOB_ID, {
        rowToken: "h1.opaque-row",
        ownerToken: "tab-two",
        fence: 2,
      }),
    ).toBe(true);
  });

  it("proves a transaction only from persistent replica state and lets deadletter rejection win", async () => {
    // given: the durable replica belongs to this scope but contains no transaction or outbox receipt
    await idbPut("meta", OWNER_ID, "userId");
    await idbPut("meta", BUDGET_ID, "budgetId");
    await idbPut("meta", { transactions: [] }, "ledger");
    const operation = {
      opId: "77777777-7777-4777-8777-777777777777",
      kind: "txn.create",
      payload: { id: "88888888-8888-4888-8888-888888888888" },
    };

    // then: optimistic memory alone cannot prove the prepared row
    expect(await importJobStorage.durableTransactionProof(SCOPE, operation.payload.id)).toBe("absent");

    // when: the exact create reaches the durable outbox, it becomes crash-recoverable
    await idbAdd("outbox", { op: operation });
    expect(await importJobStorage.durableTransactionProof(SCOPE, operation.payload.id)).toBe("durable");

    // and: a durable server rejection always overrides a stale mirror/outbox trace
    await idbPut("deadletter", { opId: operation.opId, op: operation, error: "rejected", at: new Date(0).toISOString() });
    expect(await importJobStorage.durableTransactionProof(SCOPE, operation.payload.id)).toBe("rejected");
  });

  it("promotes crash recovery only for the exact prepared transaction identity", async () => {
    await importJobStorage.claimApplyRow(SCOPE, JOB_ID, {
      rowToken: "h1.opaque-row",
      transactionId: "stable-transaction",
      ownerToken: "crashed-tab",
      now: 100,
      leaseUntil: 200,
    });

    expect(await importJobStorage.promoteDurableApplyRow(SCOPE, JOB_ID, "h1.opaque-row", "other-transaction")).toBe(false);
    expect(await importJobStorage.promoteDurableApplyRow(SCOPE, JOB_ID, "h1.opaque-row", "stable-transaction")).toBe(true);
    expect(await importJobStorage.getApplyProgress(SCOPE, JOB_ID)).toMatchObject({ appliedRowIds: ["h1.opaque-row"], appliedCount: 1 });
  });

  it("persists the canonical request and keeps the same idempotent draft on retry", async () => {
    const createdAt = new Date("2026-08-24T10:00:00.000Z");
    const first = await importJobStorage.createDraft(SCOPE, draftInput(), createdAt);
    const retry = await importJobStorage.createDraft(SCOPE, draftInput(), new Date("2026-08-24T11:00:00.000Z"));

    expect(retry).toEqual(first);
    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toEqual(first);
    expect(first).toMatchObject({
      id: JOB_ID,
      ownerId: OWNER_ID,
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

  it("atomically records upload attempts and durable cancellation without changing request identity", async () => {
    const draft = await importJobStorage.createDraft(SCOPE, draftInput(), new Date("2026-08-24T10:00:00.000Z"));

    const attempted = await importJobStorage.markDraftUploadAttempt(SCOPE, JOB_ID, draft.requestHash, new Date("2026-08-24T10:01:00.000Z"));
    const cancelled = await importJobStorage.requestDraftCancellation(SCOPE, JOB_ID, draft.requestHash, new Date("2026-08-24T10:02:00.000Z"));

    expect(attempted).toMatchObject({ requestHash: draft.requestHash, uploadAttemptedAt: "2026-08-24T10:01:00.000Z", cancelRequestedAt: null });
    expect(cancelled).toMatchObject({
      requestHash: draft.requestHash,
      images: [IMAGE],
      uploadAttemptedAt: "2026-08-24T10:01:00.000Z",
      cancelRequestedAt: "2026-08-24T10:02:00.000Z",
    });
    expect(await importJobStorage.markDraftUploadAttempt(OTHER_OWNER_SCOPE, JOB_ID, draft.requestHash)).toBeUndefined();
  });

  it("uses the same upload-attempt and cancel tombstone protocol in shared-device memory", async () => {
    const factory = new IDBFactory();
    (globalThis as Record<string, unknown>).indexedDB = factory;
    stubLocalStorage("session");
    __resetStorageForTests();
    const draft = await importJobStorage.createDraft(SCOPE, draftInput());

    await importJobStorage.markDraftUploadAttempt(SCOPE, JOB_ID, draft.requestHash);
    await importJobStorage.requestDraftCancellation(SCOPE, JOB_ID, draft.requestHash);

    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toMatchObject({
      uploadAttemptedAt: expect.any(String),
      cancelRequestedAt: expect.any(String),
      images: [IMAGE],
    });
    expect(storageMode()).toBe("memory-session");
    expect(await factory.databases()).toEqual([]);
  });

  it("refuses to replace a client job id with a conflicting canonical request", async () => {
    await importJobStorage.createDraft(SCOPE, draftInput(), new Date("2026-08-24T10:00:00.000Z"));

    await expect(importJobStorage.createDraft(SCOPE, draftInput({ images: ["data:image/png;base64,ZGlmZmVyZW50"] }))).rejects.toThrow("import_draft_conflict");
    await expect(importJobStorage.createDraft(OTHER_OWNER_SCOPE, draftInput({ ownerId: OTHER_OWNER_ID }))).rejects.toThrow("import_draft_conflict");

    expect((await importJobStorage.getDraft(SCOPE, JOB_ID))?.images).toEqual([IMAGE]);
  });

  it("deletes a draft only for the matching durable server acknowledgement", async () => {
    const draft = await importJobStorage.createDraft(SCOPE, draftInput());

    expect(
      await importJobStorage.acknowledgeDraft(SCOPE, draft.requestHash, {
        id: JOB_ID,
        budgetId: OTHER_BUDGET_ID,
        accountId: ACCOUNT_ID,
        locale: "en-US",
        tier: "plain",
      }),
    ).toBe(false);
    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toBeDefined();
    expect(
      await importJobStorage.acknowledgeDraft(SCOPE, draft.requestHash, {
        id: JOB_ID,
        budgetId: BUDGET_ID,
        accountId: OTHER_JOB_ID,
        locale: "en-US",
        tier: "plain",
      }),
    ).toBe(false);
    expect(
      await importJobStorage.acknowledgeDraft(SCOPE, draft.requestHash, {
        id: JOB_ID,
        budgetId: BUDGET_ID,
        accountId: ACCOUNT_ID,
        locale: "pl-PL",
        tier: "plain",
      }),
    ).toBe(false);
    expect(
      await importJobStorage.acknowledgeDraft(SCOPE, draft.requestHash, {
        id: OTHER_JOB_ID,
        budgetId: BUDGET_ID,
        accountId: ACCOUNT_ID,
        locale: "en-US",
        tier: "plain",
      }),
    ).toBe(false);
    expect(
      await importJobStorage.acknowledgeDraft(SCOPE, draft.requestHash, {
        id: JOB_ID,
        budgetId: BUDGET_ID,
        accountId: ACCOUNT_ID,
        locale: "en-US",
        tier: "plain",
      }),
    ).toBe(true);
    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toBeUndefined();
  });

  it("does not let a stale acknowledgement delete a same-id replacement", async () => {
    const original = await importJobStorage.createDraft(SCOPE, draftInput());
    expect(await importJobStorage.deleteDraft(SCOPE, original.id, original.requestHash)).toBe(true);
    const replacement = await importJobStorage.createDraft(SCOPE, draftInput({ images: ["data:image/png;base64,cmVwbGFjZW1lbnQ="] }));

    expect(
      await importJobStorage.acknowledgeDraft(SCOPE, original.requestHash, {
        id: JOB_ID,
        budgetId: BUDGET_ID,
        accountId: ACCOUNT_ID,
        locale: "en-US",
        tier: "plain",
      }),
    ).toBe(false);
    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toEqual(replacement);
  });

  it("serializes conflicting facade creates without last-writer overwrite", async () => {
    const results = await Promise.allSettled([
      importJobStorage.createDraft(SCOPE, draftInput({ images: ["data:image/png;base64,Zmlyc3Q="] })),
      importJobStorage.createDraft(SCOPE, draftInput({ images: ["data:image/png;base64,c2Vjb25k"] })),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = await importJobStorage.getDraft(SCOPE, JOB_ID);
    const fulfilled = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<PlainImportUploadDraftInput>;
    expect(winner?.images).toEqual(fulfilled.value.images);
  });

  it("serializes conflicting facade creates in shared-device memory", async () => {
    stubLocalStorage("session");
    __resetStorageForTests();

    const results = await Promise.allSettled([
      importJobStorage.createDraft(SCOPE, draftInput({ images: ["data:image/png;base64,Zmlyc3Q="] })),
      importJobStorage.createDraft(SCOPE, draftInput({ images: ["data:image/png;base64,c2Vjb25k"] })),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(storageMode()).toBe("memory-session");
  });

  it("clones draft image arrays so caller mutation cannot change payload or hash", async () => {
    stubLocalStorage("session");
    __resetStorageForTests();
    const input = draftInput();
    const creation = importJobStorage.createDraft(SCOPE, input);
    input.images[0] = "data:image/png;base64,bXV0YXRlZC1kdXJpbmctaGFzaA==";
    const created = await creation;
    const originalHash = created.requestHash;
    created.images[0] = "data:image/png;base64,bXV0YXRlZC1yZXR1cm4=";

    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toMatchObject({ images: [IMAGE], requestHash: originalHash });
    expect(await importJobStorage.createDraft(SCOPE, draftInput())).toMatchObject({ images: [IMAGE], requestHash: originalHash });
  });

  it("expires only drafts that have reached the 24-hour boundary", async () => {
    const start = new Date("2026-08-24T10:00:00.000Z");
    await importJobStorage.createDraft(SCOPE, draftInput(), start);
    await importJobStorage.createDraft(SCOPE, draftInput({ id: OTHER_JOB_ID }), new Date(start.getTime() + 1));

    expect(await importJobStorage.pruneExpiredDrafts(SCOPE, new Date(start.getTime() + IMPORT_DRAFT_TTL_MS))).toBe(1);
    expect((await importJobStorage.listDrafts(SCOPE)).map((draft) => draft.id)).toEqual([OTHER_JOB_ID]);
  });

  it("deletes a cancelled draft and notifies its observers", async () => {
    const draft = await importJobStorage.createDraft(SCOPE, draftInput());
    const notifications: string[] = [];
    const unsubscribe = importJobStorage.subscribe(SCOPE, () => notifications.push("changed"));

    await importJobStorage.deleteDraft(SCOPE, JOB_ID, draft.requestHash);

    unsubscribe();
    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toBeUndefined();
    expect(notifications).toEqual(["changed"]);
  });

  it("isolates plaintext drafts, pruning, deletion, and notifications by replica owner and budget", async () => {
    const expiredAt = "2026-08-23T10:00:00.000Z";
    const currentAt = "2026-08-25T10:00:00.000Z";
    const staleDraft = (id: string, ownerId: string, budgetId: string, image: string, expiresAt: string) => ({
      ...draftInput({ id, ownerId, budgetId, images: [image] }),
      requestHash: `hash-${id}`,
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-22T10:00:00.000Z",
      expiresAt,
    });
    const ownId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const foreignId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const otherBudgetId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const foreignImage = "data:image/png;base64,Zm9yZWlnbi1wbGFpbnRleHQ=";
    await idbPut("importDrafts", staleDraft(ownId, OWNER_ID, BUDGET_ID, IMAGE, expiredAt));
    await idbPut("importDrafts", staleDraft(foreignId, OTHER_OWNER_ID, BUDGET_ID, foreignImage, expiredAt));
    await idbPut("importDrafts", staleDraft(otherBudgetId, OWNER_ID, OTHER_BUDGET_ID, "data:image/png;base64,b3RoZXItYnVkZ2V0", expiredAt));

    expect(await importJobStorage.getDraft(SCOPE, foreignId)).toBeUndefined();
    expect(JSON.stringify(await importJobStorage.listDrafts(SCOPE))).not.toContain(foreignImage);
    expect(await importJobStorage.deleteDraft(SCOPE, foreignId, `hash-${foreignId}`)).toBe(false);
    expect(await importJobStorage.pruneExpiredDrafts(SCOPE, new Date(currentAt))).toBe(1);
    expect(await idbGet("importDrafts", foreignId)).toBeDefined();
    expect(await idbGet("importDrafts", otherBudgetId)).toBeDefined();

    const notifications = { own: 0, foreign: 0, otherBudget: 0 };
    const unsubscribeOwn = importJobStorage.subscribe(SCOPE, () => notifications.own++);
    const unsubscribeForeign = importJobStorage.subscribe(OTHER_OWNER_SCOPE, () => notifications.foreign++);
    const unsubscribeOtherBudget = importJobStorage.subscribe(OTHER_BUDGET_SCOPE, () => notifications.otherBudget++);
    await importJobStorage.createDraft(OTHER_OWNER_SCOPE, draftInput({ id: OTHER_JOB_ID, ownerId: OTHER_OWNER_ID, images: [foreignImage] }));
    unsubscribeOwn();
    unsubscribeForeign();
    unsubscribeOtherBudget();
    expect(notifications).toEqual({ own: 0, foreign: 1, otherBudget: 0 });
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
      ownerId: OWNER_ID,
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

    await importJobStorage.putJob(SCOPE, job);

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
    const unsubscribe = importJobStorage.subscribe(SCOPE, () => notifications.push(notifications.length + 1));
    const job = {
      id: JOB_ID,
      ownerId: OWNER_ID,
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

    await importJobStorage.putJob(SCOPE, job);
    expect(await importJobStorage.getJob(SCOPE, JOB_ID)).toEqual(job);
    expect(await importJobStorage.listJobs(SCOPE)).toEqual([job]);
    expect(await importJobStorage.deleteJob(SCOPE, JOB_ID)).toBe(true);
    expect(await importJobStorage.getJob(SCOPE, JOB_ID)).toBeUndefined();
    unsubscribe();
    expect(notifications).toEqual([1, 2]);
  });

  it("rejects a stale runner before it can replace a newer checkpoint revision", async () => {
    const original = {
      id: JOB_ID,
      ownerId: OWNER_ID,
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
    await importJobStorage.putJob(SCOPE, original);
    const winner = { ...original, phase: "validating" as const, checkpointCiphertext: "v2.checkpoint", checkpointRevision: 1 };
    const stale = { ...original, phase: "waiting_for_device" as const, resumePhase: "extracting" as const, checkpointRevision: 1 };

    expect(await importJobStorage.putJobIfRevision(SCOPE, winner, 0)).toBe(true);
    expect(await importJobStorage.putJobIfRevision(SCOPE, stale, 0)).toBe(false);

    expect(await importJobStorage.getJob(SCOPE, JOB_ID)).toEqual(winner);
  });

  it("never returns or deletes jobs belonging to another replica owner or budget", async () => {
    const own = { id: JOB_ID, ownerId: OWNER_ID, budgetId: BUDGET_ID, updatedAt: "2026-08-24T10:00:00.000Z" };
    const foreign = { id: OTHER_JOB_ID, ownerId: OTHER_OWNER_ID, budgetId: BUDGET_ID, updatedAt: "2026-08-24T11:00:00.000Z" };
    const otherBudget = {
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      ownerId: OWNER_ID,
      budgetId: OTHER_BUDGET_ID,
      updatedAt: "2026-08-24T12:00:00.000Z",
    };
    await idbPut("importJobs", own);
    await idbPut("importJobs", foreign);
    await idbPut("importJobs", otherBudget);

    expect(await importJobStorage.getJob(SCOPE, OTHER_JOB_ID)).toBeUndefined();
    expect(await importJobStorage.listJobs(SCOPE)).toEqual([expect.objectContaining(own)]);
    expect(await importJobStorage.deleteJob(SCOPE, OTHER_JOB_ID)).toBe(false);
    expect(await idbGet<Record<string, unknown>>("importJobs", OTHER_JOB_ID)).toEqual(foreign);
    expect(await importJobStorage.deleteJob(SCOPE, JOB_ID)).toBe(true);
  });

  it("uses MemoryBackend under the shared-device policy without opening IndexedDB", async () => {
    const factory = new IDBFactory();
    (globalThis as Record<string, unknown>).indexedDB = factory;
    stubLocalStorage("session");
    __resetStorageForTests();

    await importJobStorage.createDraft(SCOPE, draftInput());

    expect(storageMode()).toBe("memory-session");
    expect(await importJobStorage.getDraft(SCOPE, JOB_ID)).toBeDefined();
    expect(await factory.databases()).toEqual([]);
  });
});
