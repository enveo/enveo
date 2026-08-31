/**
 * Rollout regression of a newly replicated entity (budgets, 1.1.8):
 * an old replica blob in IDB has no `budgets` field — the store must normalize it
 * (otherwise the UI sees undefined → e.g. a dead currency select), and applyPulled must
 * not fall over spreading undefined when a `budgets` change arrives via pull.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ClientLedger } from "@enveo/shared";
import { IDBFactory } from "fake-indexeddb";
import { __newIdbBackendForTests, __resetStorageForTests, clearLocalData, idbGet, idbGetAll, idbPut } from "./idb";
import { MemoryBackend, type StorageBackend } from "./storageBackend";
import { type PullChange, store } from "./store";

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  delete (globalThis as Record<string, unknown>).localStorage;
  __resetStorageForTests();
});

/** A pre-1.1.8 replica — without the budgets field (what an old blob looks like after hydrate). */
const oldLedger = (): ClientLedger =>
  ({
    accounts: [],
    groups: [],
    envelopes: [],
    categories: [],
    places: [],
    transactions: [],
    allocations: [],
  }) as unknown as ClientLedger;

describe("an old replica without budgets (pre-1.1.8)", () => {
  it("replace normalizes missing budgets to []", () => {
    store.replace(oldLedger(), 0, "b1");
    expect(store.getLedger()!.budgets).toEqual([]);
  });

  it("applyPulled upserts a budgets row without falling over", () => {
    store.replace(oldLedger(), 0, "b1");
    const ch: PullChange[] = [{ seq: 1, table: "budgets", op: "upsert", row: { id: "b1", name: "Budżet", currency: "EUR" } }];
    expect(() => store.applyPulled(ch, 1)).not.toThrow();
    expect(store.getLedger()!.budgets[0]!.currency).toBe("EUR");
  });
});

async function exerciseImportStores(backend: StorageBackend) {
  const job = { id: "11111111-1111-1111-1111-111111111111", ciphertext: "v2.job" };
  const draft = { id: "22222222-2222-2222-2222-222222222222", requestHash: "draft-hash" };

  await backend.put("importJobs", job);
  await backend.put("importDrafts", draft);
  const beforeDelete = [await backend.get("importJobs", job.id), await backend.getAll("importDrafts")];
  await backend.delete("importJobs", job.id);

  return [...beforeDelete, await backend.get("importJobs", job.id)];
}

async function exerciseRevisionGuard(backend: StorageBackend) {
  const original = { id: "66666666-6666-6666-6666-666666666666", checkpointRevision: 0, phase: "extracting" };
  const winner = { ...original, checkpointRevision: 1, phase: "validating" };
  const stale = { ...original, checkpointRevision: 1, phase: "waiting_for_device" };
  await backend.put("importJobs", original);
  const winnerStored = await backend.putImportJobIfRevision(winner, 0);
  const staleStored = await backend.putImportJobIfRevision(stale, 0);
  return [winnerStored, staleStored, await backend.get("importJobs", original.id)];
}

async function exerciseConcurrentDraftCreate(backend: StorageBackend) {
  const first = {
    id: "77777777-7777-7777-7777-777777777777",
    ownerId: "user-a",
    budgetId: "budget-a",
    accountId: "account-a",
    locale: "en-US",
    images: ["data:image/png;base64,Zmlyc3Q="],
    requestHash: "hash-first",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
    expiresAt: "2026-08-25T10:00:00.000Z",
  };
  const second = { ...first, images: ["data:image/png;base64,c2Vjb25k"], requestHash: "hash-second" };

  const results = await Promise.all([backend.putImportDraftIfAbsentOrSame(first), backend.putImportDraftIfAbsentOrSame(second)]);

  return [results, await backend.get("importDrafts", first.id)];
}

async function exerciseMemoryCloneAndFailedCas(backend: StorageBackend) {
  const original = {
    id: "88888888-8888-8888-8888-888888888888",
    ownerId: "user-a",
    budgetId: "budget-a",
    checkpointRevision: 0,
    nested: { phase: "extracting" },
  };
  await backend.put("importJobs", original);
  original.nested.phase = "mutated-after-put";
  const firstRead = (await backend.get("importJobs", original.id)) as typeof original;
  firstRead.checkpointRevision = 99;
  firstRead.nested.phase = "mutated-after-read";
  const staleWrite = await backend.putImportJobIfRevision({ ...firstRead, checkpointRevision: 100 }, 99);

  return [staleWrite, await backend.get("importJobs", original.id)];
}

async function exerciseDraftCompareDelete(backend: StorageBackend) {
  const replacement = {
    id: "99999999-9999-9999-9999-999999999999",
    ownerId: "user-a",
    budgetId: "budget-a",
    accountId: "account-a",
    locale: "en-US",
    images: ["data:image/png;base64,cmVwbGFjZW1lbnQ="],
    requestHash: "hash-replacement",
  };
  await backend.put("importDrafts", replacement);

  const staleDeleted = await backend.deleteImportDraftIfMatches({
    id: replacement.id,
    ownerId: replacement.ownerId,
    budgetId: replacement.budgetId,
    accountId: replacement.accountId,
    locale: replacement.locale,
    requestHash: "hash-original",
  });
  const afterStale = await backend.get("importDrafts", replacement.id);
  const currentDeleted = await backend.deleteImportDraftIfMatches({
    id: replacement.id,
    ownerId: replacement.ownerId,
    budgetId: replacement.budgetId,
    accountId: replacement.accountId,
    locale: replacement.locale,
    requestHash: replacement.requestHash,
  });

  return [staleDeleted, afterStale, currentDeleted, await backend.get("importDrafts", replacement.id)];
}

async function exerciseScopedDeletion(backend: StorageBackend) {
  const scope = { ownerId: "user-a", budgetId: "budget-a" };
  const foreignScope = { ownerId: "user-b", budgetId: "budget-a" };
  const ownJob = { id: "12121212-1212-1212-1212-121212121212", ...scope };
  const foreignJob = { id: "13131313-1313-1313-1313-131313131313", ...foreignScope };
  const ownDraft = {
    id: "14141414-1414-1414-1414-141414141414",
    ...scope,
    expiresAt: "2026-08-24T10:00:00.000Z",
  };
  const foreignDraft = {
    id: "15151515-1515-1515-1515-151515151515",
    ...foreignScope,
    expiresAt: "2026-08-24T10:00:00.000Z",
  };
  await backend.put("importJobs", ownJob);
  await backend.put("importJobs", foreignJob);
  await backend.put("importDrafts", ownDraft);
  await backend.put("importDrafts", foreignDraft);

  return [
    await backend.deleteImportJobIfScope(foreignJob.id, scope),
    await backend.deleteImportJobIfScope(ownJob.id, scope),
    await backend.deleteExpiredImportDrafts(scope, Date.parse("2026-08-24T10:00:00.000Z")),
    await backend.get("importJobs", foreignJob.id),
    await backend.get("importDrafts", foreignDraft.id),
  ];
}

describe("durable import stores", () => {
  it("provide identical put/get/list/delete behavior in memory and IndexedDB", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();

    const inIndexedDb = await exerciseImportStores(__newIdbBackendForTests());
    const inMemory = await exerciseImportStores(new MemoryBackend());

    expect(inIndexedDb).toEqual(inMemory);
    expect(inIndexedDb).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", ciphertext: "v2.job" },
      [{ id: "22222222-2222-2222-2222-222222222222", requestHash: "draft-hash" }],
      undefined,
    ]);
  });

  it("atomically fences stale checkpoint writers in memory and IndexedDB", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();

    const inIndexedDb = await exerciseRevisionGuard(__newIdbBackendForTests());
    const inMemory = await exerciseRevisionGuard(new MemoryBackend());

    expect(inIndexedDb).toEqual(inMemory);
    expect(inIndexedDb).toEqual([true, false, { id: "66666666-6666-6666-6666-666666666666", checkpointRevision: 1, phase: "validating" }]);
  });

  it("atomically accepts one concurrent draft identity and rejects the conflicting writer in both backends", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();

    const inIndexedDb = await exerciseConcurrentDraftCreate(__newIdbBackendForTests());
    const inMemory = await exerciseConcurrentDraftCreate(new MemoryBackend());

    expect(inIndexedDb).toEqual(inMemory);
    expect(inIndexedDb).toEqual([
      [{ kind: "created", value: expect.objectContaining({ requestHash: "hash-first" }) }, { kind: "conflict" }],
      expect.objectContaining({ requestHash: "hash-first", images: ["data:image/png;base64,Zmlyc3Q="] }),
    ]);
  });

  it("structured-clones writes and reads so caller mutation cannot manufacture a successful CAS", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();

    const inIndexedDb = await exerciseMemoryCloneAndFailedCas(__newIdbBackendForTests());
    const inMemory = await exerciseMemoryCloneAndFailedCas(new MemoryBackend());

    expect(inIndexedDb).toEqual(inMemory);
    expect(inMemory).toEqual([
      false,
      {
        id: "88888888-8888-8888-8888-888888888888",
        ownerId: "user-a",
        budgetId: "budget-a",
        checkpointRevision: 0,
        nested: { phase: "extracting" },
      },
    ]);
  });

  it("compare-deletes only the exact acknowledged draft in memory and IndexedDB", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();

    const inIndexedDb = await exerciseDraftCompareDelete(__newIdbBackendForTests());
    const inMemory = await exerciseDraftCompareDelete(new MemoryBackend());

    expect(inIndexedDb).toEqual(inMemory);
    expect(inMemory).toEqual([false, expect.objectContaining({ requestHash: "hash-replacement" }), true, undefined]);
  });

  it("scope-deletes and prunes identically without touching foreign records", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();

    const inIndexedDb = await exerciseScopedDeletion(__newIdbBackendForTests());
    const inMemory = await exerciseScopedDeletion(new MemoryBackend());

    expect(inIndexedDb).toEqual(inMemory);
    expect(inMemory).toEqual([false, true, 1, expect.objectContaining({ ownerId: "user-b" }), expect.objectContaining({ ownerId: "user-b" })]);
  });

  it("upgrades a v1 database without losing replica, outbox, or dead-letter data", async () => {
    const factory = new IDBFactory();
    (globalThis as Record<string, unknown>).indexedDB = factory;
    const request = factory.open("enveo", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("meta");
      request.result.createObjectStore("outbox", { keyPath: "localSeq", autoIncrement: true });
      request.result.createObjectStore("deadletter", { keyPath: "opId" });
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(["meta", "outbox", "deadletter"], "readwrite");
    transaction.objectStore("meta").put({ accounts: [{ id: "account-before-upgrade" }] }, "ledger");
    transaction.objectStore("meta").put(new Uint8Array([1, 2, 3]), "e2eeDek");
    transaction.objectStore("meta").put({ ciphertext: "v2.credential" }, "e2eePendingUpgrade");
    transaction.objectStore("outbox").put({ localSeq: 7, op: { opId: "queued-before-upgrade" } });
    transaction.objectStore("deadletter").put({ opId: "rejected-before-upgrade", error: "invalid" });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    __resetStorageForTests();

    await idbPut("importJobs", { id: "33333333-3333-3333-3333-333333333333", ciphertext: "v2.new" });

    expect(await idbGet<{ accounts: Array<{ id: string }> }>("meta", "ledger")).toEqual({ accounts: [{ id: "account-before-upgrade" }] });
    expect(await idbGet<Uint8Array>("meta", "e2eeDek")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await idbGet<{ ciphertext: string }>("meta", "e2eePendingUpgrade")).toEqual({ ciphertext: "v2.credential" });
    expect(await idbGetAll("outbox")).toEqual([{ localSeq: 7, op: { opId: "queued-before-upgrade" } }]);
    expect(await idbGetAll("deadletter")).toEqual([{ opId: "rejected-before-upgrade", error: "invalid" }]);
    expect(await idbGetAll("importJobs")).toEqual([{ id: "33333333-3333-3333-3333-333333333333", ciphertext: "v2.new" }]);
    expect(await idbGetAll("importDrafts")).toEqual([]);
  });

  it("clears import jobs and drafts in the same local-data wipe as the replica and queues", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
    await idbPut("meta", { accounts: [] }, "ledger");
    await idbPut("meta", new Uint8Array([1, 2, 3]), "e2eeDek");
    await idbPut("meta", { ciphertext: "v2.credential" }, "e2eePendingUpgrade");
    await idbPut("outbox", { localSeq: 1, op: { opId: "queued" } });
    await idbPut("deadletter", { opId: "rejected" });
    await idbPut("importJobs", { id: "44444444-4444-4444-4444-444444444444", ciphertext: "v2.job" });
    await idbPut("importDrafts", { id: "55555555-5555-5555-5555-555555555555", requestHash: "draft" });

    await clearLocalData();

    expect(await Promise.all(["meta", "outbox", "deadletter", "importJobs", "importDrafts"].map((name) => idbGetAll(name as never)))).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });
});
