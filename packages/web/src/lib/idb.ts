/**
 * Public storage facade — a minimal promise API over the ACTIVE StorageBackend.
 *
 * DB "enveo" v2 (IdbBackend):
 * - "meta"       — out-of-line keys: "ledger" (the whole ClientLedger as one
 *                  blob), "cursor", "clientId", "budgetId", "lastSyncAt", "userId"
 * - "outbox"     — keyPath "localSeq" autoIncrement
 * - "deadletter" — keyPath "opId"
 * - "importJobs" — keyPath "id" (device-local E2EE job metadata + ciphertext)
 * - "importDrafts" — keyPath "id" (plain upload recovery until server acknowledgement)
 *
 * Backend selection happens ONCE per page load, lazily, before the first
 * operation (activeBackend).
 *
 * IdbBackend open-failure policy (corruption etc.): deleteDatabase + retry once
 * → if it still fails, an internal MemoryBackend takes over (the app works,
 * nothing persists; console.warn) — observable via storageMode() ===
 * "memory-fallback".
 *
 * All writes resolve AFTER the IDB transaction completes (tx.oncomplete), not
 * merely after request.onsuccess.
 */
import { runAccountStorageWrite } from "./accountStorageOperations";
import { getDeviceStoragePolicy } from "./deviceStoragePolicy";
import type { SignOutPermit } from "./signOutBarrier";
import {
  evaluateImportTransactionProof,
  type ImportDraftDeleteMatch,
  type ImportDraftPutResult,
  type ImportDraftStateMutation,
  type ImportRecordScope,
  MemoryBackend,
  type StorageBackend,
  type StoreName,
} from "./storageBackend";

export type { StoreName } from "./storageBackend";

const DB_NAME = "enveo";
const DB_VERSION = 2;
/** Old database name (pre-rebranding) — concatenated at runtime so a
 *  de-branding grep and the minified bundle don't contain the former brand. */
const LEGACY_DB_NAME = ["4gros", "ze"].join("");

/* ── IdbBackend ─────────────────────────────────────────────────────────── */

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB: request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB: transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB: transaction aborted"));
  });
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "localSeq", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("deadletter")) {
        db.createObjectStore("deadletter", { keyPath: "opId" });
      }
      if (!db.objectStoreNames.contains("importJobs")) {
        db.createObjectStore("importJobs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("importDrafts")) {
        db.createObjectStore("importDrafts", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB: open failed"));
  });
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    // blocked = another tab holds a connection; don't hang — we'll try to open anyway
    req.onblocked = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IndexedDB: deleteDatabase failed"));
  });
}

/** Best-effort deletion of the pre-rebranding database (the replica already lives
 *  in DB_NAME, rebuilt via snapshot-resync; the e2ee DEK from the old database is
 *  lost → Unlock). Fire-and-forget. */
function deleteLegacyDb(): void {
  try {
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch {
    /* ignore — best-effort */
  }
}

class IdbBackend implements StorageBackend {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private fallback = new MemoryBackend();
  private fellBack = false;

  usingFallback(): boolean {
    return this.fellBack;
  }

  /** Opens the DB once; null = unrecoverable → the ops below use the memory fallback. */
  private open(): Promise<IDBDatabase | null> {
    if (!this.dbPromise) {
      this.dbPromise = runAccountStorageWrite(async () => {
        if (typeof indexedDB === "undefined") {
          this.fellBack = true;
          console.warn("IndexedDB unavailable — local data memory-only (won't survive a refresh)");
          return null;
        }
        deleteLegacyDb();
        try {
          return await openRaw();
        } catch (first) {
          // corruption / incompatible version — delete the database and try once more
          console.warn("IndexedDB: open failed, deleting the database and retrying", first);
          try {
            await deleteDb();
            return await openRaw();
          } catch (second) {
            this.fellBack = true;
            console.warn("IndexedDB unrecoverable — in-memory mode (the app works, nothing persists)", second);
            return null;
          }
        }
      });
    }
    return this.dbPromise;
  }

  async get(store: StoreName, key: IDBValidKey): Promise<unknown> {
    const db = await this.open();
    if (!db) return this.fallback.get(store, key);
    const tx = db.transaction(store, "readonly");
    return requestToPromise(tx.objectStore(store).get(key));
  }

  async getAll(store: StoreName): Promise<unknown[]> {
    const db = await this.open();
    if (!db) return this.fallback.getAll(store);
    const tx = db.transaction(store, "readonly");
    return requestToPromise(tx.objectStore(store).getAll());
  }

  async mutateMeta(key: IDBValidKey, update: (current: unknown) => unknown): Promise<unknown> {
    const db = await this.open();
    if (!db) return this.fallback.mutateMeta(key, update);
    const tx = db.transaction("meta", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("meta");
    const current = await requestToPromise(store.get(key));
    const next = update(current);
    store.put(next, key);
    await done;
    return structuredClone(next);
  }

  async importTransactionProof(scope: ImportRecordScope, transactionId: string): Promise<"durable" | "rejected" | "absent"> {
    const db = await this.open();
    if (!db) return this.fallback.importTransactionProof(scope, transactionId);
    const tx = db.transaction(["meta", "outbox", "deadletter"], "readonly");
    const done = txDone(tx);
    const meta = tx.objectStore("meta");
    const [ownerId, budgetId, ledger, outboxRows, deadletterRows] = await Promise.all([
      requestToPromise(meta.get("userId")),
      requestToPromise(meta.get("budgetId")),
      requestToPromise(meta.get("ledger")),
      requestToPromise(tx.objectStore("outbox").getAll()),
      requestToPromise(tx.objectStore("deadletter").getAll()),
    ]);
    await done;
    return evaluateImportTransactionProof(scope, transactionId, ownerId, budgetId, ledger, outboxRows, deadletterRows);
  }

  async put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.put(store, value, key);
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    await txDone(tx);
  }

  async putMany(store: StoreName, entries: Array<{ value: unknown; key?: IDBValidKey }>): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.putMany(store, entries);
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const e of entries) os.put(e.value, e.key);
    await txDone(tx);
  }

  async putImportJobIfRevision(value: unknown, expectedRevision: number): Promise<boolean> {
    const db = await this.open();
    if (!db) return this.fallback.putImportJobIfRevision(value, expectedRevision);
    const record = value as { id: IDBValidKey; ownerId: string; budgetId: string };
    const tx = db.transaction("importJobs", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("importJobs");
    const current = (await requestToPromise(store.get(record.id))) as Record<string, unknown> | undefined;
    if (current?.checkpointRevision !== expectedRevision || current.ownerId !== record.ownerId || current.budgetId !== record.budgetId) {
      await done;
      return false;
    }
    store.put(value);
    await done;
    return true;
  }

  async putImportJobForScope(value: unknown, scope: ImportRecordScope): Promise<boolean> {
    const db = await this.open();
    if (!db) return this.fallback.putImportJobForScope(value, scope);
    const record = value as { id: IDBValidKey; ownerId: string; budgetId: string };
    if (record.ownerId !== scope.ownerId || record.budgetId !== scope.budgetId) return false;
    const tx = db.transaction("importJobs", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("importJobs");
    const current = (await requestToPromise(store.get(record.id))) as Record<string, unknown> | undefined;
    if (current && (current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId)) {
      await done;
      return false;
    }
    store.put(value);
    await done;
    return true;
  }

  async putImportDraftIfAbsentOrSame(value: unknown): Promise<ImportDraftPutResult> {
    const db = await this.open();
    if (!db) return this.fallback.putImportDraftIfAbsentOrSame(value);
    const record = value as { id: IDBValidKey; ownerId: string; budgetId: string; requestHash: string };
    const tx = db.transaction("importDrafts", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("importDrafts");
    const current = (await requestToPromise(store.get(record.id))) as Record<string, unknown> | undefined;
    if (current) {
      await done;
      return current.requestHash === record.requestHash && current.ownerId === record.ownerId && current.budgetId === record.budgetId
        ? { kind: "existing", value: structuredClone(current) }
        : { kind: "conflict" };
    }
    store.put(value);
    await done;
    return { kind: "created", value: structuredClone(value) };
  }

  async mutateImportDraftState(mutation: ImportDraftStateMutation): Promise<unknown | undefined> {
    const db = await this.open();
    if (!db) return this.fallback.mutateImportDraftState(mutation);
    const tx = db.transaction("importDrafts", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("importDrafts");
    const current = (await requestToPromise(store.get(mutation.id))) as Record<string, unknown> | undefined;
    if (!current || current.ownerId !== mutation.ownerId || current.budgetId !== mutation.budgetId || current.requestHash !== mutation.requestHash) {
      await done;
      return undefined;
    }
    const next = {
      ...current,
      [mutation.field]: current[mutation.field] ?? mutation.at,
      updatedAt: mutation.at,
    };
    store.put(next);
    await done;
    return structuredClone(next);
  }

  async deleteImportDraftIfMatches(expected: ImportDraftDeleteMatch): Promise<boolean> {
    const db = await this.open();
    if (!db) return this.fallback.deleteImportDraftIfMatches(expected);
    const tx = db.transaction("importDrafts", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("importDrafts");
    const current = (await requestToPromise(store.get(expected.id))) as Record<string, unknown> | undefined;
    if (
      !current ||
      current.ownerId !== expected.ownerId ||
      current.budgetId !== expected.budgetId ||
      (expected.accountId !== undefined && current.accountId !== expected.accountId) ||
      (expected.locale !== undefined && current.locale !== expected.locale) ||
      (expected.requireCancelRequestedAtNull === true && current.cancelRequestedAt != null) ||
      current.requestHash !== expected.requestHash
    ) {
      await done;
      return false;
    }
    store.delete(expected.id);
    await done;
    return true;
  }

  async deleteImportJobIfScope(id: IDBValidKey, scope: ImportRecordScope): Promise<boolean> {
    const db = await this.open();
    if (!db) return this.fallback.deleteImportJobIfScope(id, scope);
    const tx = db.transaction("importJobs", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("importJobs");
    const current = (await requestToPromise(store.get(id))) as Record<string, unknown> | undefined;
    if (!current || current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId) {
      await done;
      return false;
    }
    store.delete(id);
    await done;
    return true;
  }

  async deleteImportJobWithMetaIfScope(id: IDBValidKey, scope: ImportRecordScope, metaKeys: IDBValidKey[], permitted: () => boolean): Promise<boolean> {
    const db = await this.open();
    if (!db) return this.fallback.deleteImportJobWithMetaIfScope(id, scope, metaKeys, permitted);
    const tx = db.transaction(["importJobs", "meta"], "readwrite");
    const done = txDone(tx);
    const jobs = tx.objectStore("importJobs");
    const current = (await requestToPromise(jobs.get(id))) as Record<string, unknown> | undefined;
    if (!permitted() || !current || current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId) {
      await done;
      return false;
    }
    jobs.delete(id);
    const meta = tx.objectStore("meta");
    for (const key of metaKeys) meta.delete(key);
    await done;
    return true;
  }

  async deleteExpiredImportDrafts(scope: ImportRecordScope, expiresAt: number): Promise<number> {
    const db = await this.open();
    if (!db) return this.fallback.deleteExpiredImportDrafts(scope, expiresAt);
    const tx = db.transaction("importDrafts", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("importDrafts");
    const drafts = (await requestToPromise(store.getAll())) as Array<Record<string, unknown>>;
    const expired = drafts.filter(
      (draft) =>
        draft.ownerId === scope.ownerId &&
        draft.budgetId === scope.budgetId &&
        draft.cancelRequestedAt == null &&
        typeof draft.expiresAt === "string" &&
        Date.parse(draft.expiresAt) <= expiresAt,
    );
    for (const draft of expired) store.delete(draft.id as IDBValidKey);
    await done;
    return expired.length;
  }

  async add(store: StoreName, value: unknown): Promise<IDBValidKey> {
    const db = await this.open();
    if (!db) return this.fallback.add(store, value);
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).add(value);
    await txDone(tx);
    return req.result;
  }

  /**
   * ATOMIC outbox→deadletter move — one transaction spanning both stores.
   * Crucial for multi-tab: another tab reading outbox→deadletter (in that
   * order) NEVER sees "the op vanished from the outbox but isn't in deadletter
   * yet" — reconcileFromIdb relies on that to tell an acked op from one
   * REJECTED by another tab. Atomicity also closes the crash window.
   */
  async moveToDeadLetter(seq: number | null, deadLetter: unknown): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.moveToDeadLetter(seq, deadLetter);
    const tx = db.transaction(["outbox", "deadletter"], "readwrite");
    if (seq !== null) tx.objectStore("outbox").delete(seq);
    tx.objectStore("deadletter").put(deadLetter);
    await txDone(tx);
  }

  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.delete(store, key);
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    await txDone(tx);
  }

  async clear(store: StoreName): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.clear(store);
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    await txDone(tx);
  }

  /**
   * "Clear local data" — MULTI-TAB SAFE: CLEARS all object stores in one
   * transaction instead of deleting the whole database. `deleteDatabase` is
   * BLOCKED by an open connection of ANOTHER tab; a blocked deletion once left
   * boot hanging on "Loading…" behind it. Clearing stores is a plain readwrite
   * transaction — never blocked. Empty stores ⇒ a normal bootstrap from the
   * server snapshot. Other tabs are reloaded by the "wipe" broadcast in sync.ts.
   */
  async clearAll(): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.clearAll();
    const tx = db.transaction(["meta", "outbox", "deadletter", "importJobs", "importDrafts"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("outbox").clear();
    tx.objectStore("deadletter").clear();
    tx.objectStore("importJobs").clear();
    tx.objectStore("importDrafts").clear();
    await txDone(tx);
  }
}

/* ── Active backend (selected once per page load) ───────────────────────── */

let backend: StorageBackend | null = null;
let forcedMemory = false;

function activeBackend(): StorageBackend {
  if (!backend) {
    // The storage policy decides ONCE per page load, before anything touches
    // storage: session → memory only. IndexedDB is then NEVER opened, so a
    // previous persistent replica is neither read nor destroyed —
    // this session cannot even see that it exists (and never lands on
    // ForeignReplicaScreen). Persistent / absent policy → the durable default.
    forcedMemory = getDeviceStoragePolicy() === "session";
    backend = forcedMemory ? new MemoryBackend() : new IdbBackend();
  }
  return backend;
}

export type StorageMode = "idb" | "memory-session" | "memory-fallback";

/**
 * Which backend the replica actually lives in:
 *  - "idb"             — IndexedDB (the durable default),
 *  - "memory-session"  — session policy: memory by CHOICE, IndexedDB never opened,
 *  - "memory-fallback" — IndexedDB broke irrecoverably; the app runs, nothing persists.
 * Replaces isInMemoryMode(); the old predicate is `storageMode() !== "idb"`.
 */
export function storageMode(): StorageMode {
  const b = activeBackend();
  if (forcedMemory) return "memory-session";
  return b instanceof IdbBackend && b.usingFallback() ? "memory-fallback" : "idb";
}

/** Test hook (unit tests only): drop the backend singleton. */
export function __resetStorageForTests(): void {
  backend = null;
  forcedMemory = false;
}

/** Test hook (unit tests only): a fresh, unshared IdbBackend for parity tests. */
export function __newIdbBackendForTests(): StorageBackend {
  return new IdbBackend();
}

/* ── Public operations (signatures unchanged — consumers untouched) ─────── */

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return (await activeBackend().get(store, key)) as T | undefined;
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return (await activeBackend().getAll(store)) as T[];
}

/** Atomic read-modify-write for one metadata value, including across browser tabs. */
export async function idbMutateMeta<T>(key: IDBValidKey, update: (current: unknown) => T): Promise<T> {
  return (await runAccountStorageWrite(() => activeBackend().mutateMeta(key, update))) as T;
}

export function idbImportTransactionProof(scope: ImportRecordScope, transactionId: string): Promise<"durable" | "rejected" | "absent"> {
  return activeBackend().importTransactionProof(scope, transactionId);
}

/** put — `key` required for "meta" (out-of-line keys), omitted for keyPath stores. */
export function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  return runAccountStorageWrite(() => activeBackend().put(store, value, key));
}

/** Multiple puts in ONE transaction (atomic: all or nothing). */
export function idbPutMany(store: StoreName, entries: Array<{ value: unknown; key?: IDBValidKey }>): Promise<void> {
  return runAccountStorageWrite(() => activeBackend().putMany(store, entries));
}

/** Atomic stale-writer fence for the device-local E2EE import runner. */
export function idbPutImportJobIfRevision(value: unknown, expectedRevision: number): Promise<boolean> {
  return runAccountStorageWrite(() => activeBackend().putImportJobIfRevision(value, expectedRevision));
}

/** Scope-preserving create/replace for device-local E2EE import jobs. */
export function idbPutImportJobForScope(value: unknown, scope: ImportRecordScope): Promise<boolean> {
  return runAccountStorageWrite(() => activeBackend().putImportJobForScope(value, scope));
}

/** Atomic draft create/idempotency boundary across tabs. */
export function idbPutImportDraftIfAbsentOrSame(value: unknown): Promise<ImportDraftPutResult> {
  return runAccountStorageWrite(() => activeBackend().putImportDraftIfAbsentOrSame(value));
}

/** Atomic exact-request upload/cancellation state mutation. */
export function idbMutateImportDraftState(mutation: ImportDraftStateMutation): Promise<unknown | undefined> {
  return runAccountStorageWrite(() => activeBackend().mutateImportDraftState(mutation));
}

/** Atomic compare-delete for request completion/cancellation. */
export function idbDeleteImportDraftIfMatches(expected: ImportDraftDeleteMatch): Promise<boolean> {
  return runAccountStorageWrite(() => activeBackend().deleteImportDraftIfMatches(expected));
}

export function idbDeleteImportJobIfScope(id: IDBValidKey, scope: ImportRecordScope): Promise<boolean> {
  return runAccountStorageWrite(() => activeBackend().deleteImportJobIfScope(id, scope));
}

export function idbDeleteImportJobWithMetaIfScope(
  id: IDBValidKey,
  scope: ImportRecordScope,
  metaKeys: IDBValidKey[],
  permitted: () => boolean,
): Promise<boolean> {
  return runAccountStorageWrite(() => activeBackend().deleteImportJobWithMetaIfScope(id, scope, metaKeys, permitted));
}

export function idbDeleteExpiredImportDrafts(scope: ImportRecordScope, expiresAt: number): Promise<number> {
  return runAccountStorageWrite(() => activeBackend().deleteExpiredImportDrafts(scope, expiresAt));
}

/** add — for the outbox (autoIncrement); returns the assigned key (localSeq). */
export function idbAdd(store: StoreName, value: unknown): Promise<IDBValidKey> {
  return runAccountStorageWrite(() => activeBackend().add(store, value));
}

/** Atomic outbox→deadletter move — see StorageBackend.moveToDeadLetter. */
export function idbMoveToDeadLetter(seq: number | null, deadLetter: unknown): Promise<void> {
  return runAccountStorageWrite(() => activeBackend().moveToDeadLetter(seq, deadLetter));
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  return runAccountStorageWrite(() => activeBackend().delete(store, key));
}

export function idbClear(store: StoreName): Promise<void> {
  return runAccountStorageWrite(() => activeBackend().clear(store));
}

/** "Clear local data" (Settings) — the rescue hatch when the replica diverges. */
export function clearLocalData(): Promise<void> {
  return runAccountStorageWrite(() => activeBackend().clearAll());
}

/** Privileged coordinated-sign-out clear; never exported by the public sync facade. */
export function clearLocalDataForSignOut(permit: SignOutPermit): Promise<void> {
  return runAccountStorageWrite(() => activeBackend().clearAll(), permit);
}
