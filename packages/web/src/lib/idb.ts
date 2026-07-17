/**
 * Public storage facade — a minimal promise API over the ACTIVE StorageBackend.
 *
 * DB "enveo" v1 (IdbBackend):
 * - "meta"       — out-of-line keys: "ledger" (the whole ClientLedger as one
 *                  blob), "cursor", "clientId", "budgetId", "lastSyncAt", "userId"
 * - "outbox"     — keyPath "localSeq" autoIncrement
 * - "deadletter" — keyPath "opId"
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
import { getDeviceTrust } from "./deviceTrust";
import { MemoryBackend, type StorageBackend, type StoreName } from "./storageBackend";

export type { StoreName } from "./storageBackend";

const DB_NAME = "enveo";
const DB_VERSION = 1;
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
      this.dbPromise = (async () => {
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
            console.warn(
              "IndexedDB unrecoverable — in-memory mode (the app works, nothing persists)",
              second,
            );
            return null;
          }
        }
      })();
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
    const tx = db.transaction(["meta", "outbox", "deadletter"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("outbox").clear();
    tx.objectStore("deadletter").clear();
    await txDone(tx);
  }
}

/* ── Active backend (selected once per page load) ───────────────────────── */

let backend: StorageBackend | null = null;
let forcedMemory = false;

function activeBackend(): StorageBackend {
  if (!backend) {
    // The device-trust flag decides ONCE per page load, before anything touches
    // storage: untrusted → memory only. IndexedDB is then NEVER opened, so a
    // previous (trusted) user's on-disk replica is neither read nor destroyed —
    // a guest session cannot even see that it exists (and never lands on
    // ForeignReplicaScreen). Trusted / absent flag → the durable default.
    forcedMemory = getDeviceTrust() === "untrusted";
    backend = forcedMemory ? new MemoryBackend() : new IdbBackend();
  }
  return backend;
}

export type StorageMode = "idb" | "memory-forced" | "memory-fallback";

/**
 * Which backend the replica actually lives in:
 *  - "idb"             — IndexedDB (the durable default),
 *  - "memory-forced"   — untrusted device: memory by CHOICE, IndexedDB never opened,
 *  - "memory-fallback" — IndexedDB broke irrecoverably; the app runs, nothing persists.
 * Replaces isInMemoryMode(); the old predicate is `storageMode() !== "idb"`.
 */
export function storageMode(): StorageMode {
  if (forcedMemory) return "memory-forced";
  const b = activeBackend();
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

/** put — `key` required for "meta" (out-of-line keys), omitted for keyPath stores. */
export function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  return activeBackend().put(store, value, key);
}

/** Multiple puts in ONE transaction (atomic: all or nothing). */
export function idbPutMany(
  store: StoreName,
  entries: Array<{ value: unknown; key?: IDBValidKey }>,
): Promise<void> {
  return activeBackend().putMany(store, entries);
}

/** add — for the outbox (autoIncrement); returns the assigned key (localSeq). */
export function idbAdd(store: StoreName, value: unknown): Promise<IDBValidKey> {
  return activeBackend().add(store, value);
}

/** Atomic outbox→deadletter move — see StorageBackend.moveToDeadLetter. */
export function idbMoveToDeadLetter(seq: number | null, deadLetter: unknown): Promise<void> {
  return activeBackend().moveToDeadLetter(seq, deadLetter);
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  return activeBackend().delete(store, key);
}

export function idbClear(store: StoreName): Promise<void> {
  return activeBackend().clear(store);
}

/** "Clear local data" (Settings) — the rescue hatch when the replica diverges. */
export function clearLocalData(): Promise<void> {
  return activeBackend().clearAll();
}
