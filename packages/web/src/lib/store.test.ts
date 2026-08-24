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
