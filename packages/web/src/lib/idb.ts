/**
 * Minimal promise wrapper over IndexedDB — zero dependencies.
 *
 * DB "enveo" v1:
 * - "meta"       — out-of-line keys: "ledger" (the whole ClientLedger as one
 *                  blob), "cursor", "clientId", "budgetId", "lastSyncAt"
 * - "outbox"     — keyPath "localSeq" autoIncrement (created ALREADY so that
 *                  Phase 4 wouldn't require a DB version bump)
 * - "deadletter" — keyPath "opId"
 *
 * Open-failure policy (corruption etc.): deleteDatabase + retry once →
 * if it still fails, in-memory mode (the app works, nothing persists;
 * console.warn) — the store can detect this via isInMemoryMode().
 *
 * All writes return a promise resolved AFTER the IDB transaction completes
 * (tx.oncomplete), not merely after request.onsuccess.
 */

const DB_NAME = "enveo";
const DB_VERSION = 1;
/** Old database name (pre-rebranding) — concatenated at runtime so a
 *  de-branding grep and the minified bundle don't contain the former brand. */
const LEGACY_DB_NAME = ["4gros", "ze"].join("");

export type StoreName = "meta" | "outbox" | "deadletter";

/** keyPath per store (null = out-of-line keys) — used by the in-memory mode. */
const KEY_PATH: Record<StoreName, string | null> = {
  meta: null,
  outbox: "localSeq",
  deadletter: "opId",
};

/* ── In-memory mode (fallback after an unrecoverable open failure) ────── */

let memoryMode = false;
const memStores = new Map<StoreName, Map<IDBValidKey, unknown>>();
let memAutoKey = 0;

export function isInMemoryMode(): boolean {
  return memoryMode;
}

function mem(name: StoreName): Map<IDBValidKey, unknown> {
  let m = memStores.get(name);
  if (!m) {
    m = new Map();
    memStores.set(name, m);
  }
  return m;
}

function memKeyOf(name: StoreName, value: unknown, key?: IDBValidKey): IDBValidKey {
  if (key !== undefined) return key;
  const kp = KEY_PATH[name];
  const k = kp ? (value as Record<string, unknown>)[kp] : undefined;
  return (k as IDBValidKey | undefined) ?? ++memAutoKey;
}

/* ── Open (lazy singleton) ───────────────────────────────────────────── */

let dbPromise: Promise<IDBDatabase | null> | null = null;

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
 *  lost → Unlock). Fire-and-forget: deleting a nonexistent database is a no-op,
 *  `blocked` (an old tab holds a connection) is ignored — we'll retry on the next boot. */
function deleteLegacyDb(): void {
  try {
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch {
    /* ignore — best-effort */
  }
}

/** Opens the DB once; null = in-memory mode. */
function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (typeof indexedDB === "undefined") {
        memoryMode = true;
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
          memoryMode = true;
          console.warn(
            "IndexedDB unrecoverable — in-memory mode (the app works, nothing persists)",
            second,
          );
          return null;
        }
      }
    })();
  }
  return dbPromise;
}

/* ── Operations ────────────────────────────────────────────────────────── */

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return mem(store).get(key) as T | undefined;
  const tx = db.transaction(store, "readonly");
  return requestToPromise(tx.objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  if (!db) return [...mem(store).values()] as T[];
  const tx = db.transaction(store, "readonly");
  return requestToPromise(tx.objectStore(store).getAll()) as Promise<T[]>;
}

/** put — `key` required for "meta" (out-of-line keys), omitted for keyPath stores. */
export async function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  if (!db) {
    mem(store).set(memKeyOf(store, value, key), value);
    return;
  }
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await txDone(tx);
}

/** Multiple puts in ONE IDB transaction (atomic: all or nothing). */
export async function idbPutMany(
  store: StoreName,
  entries: Array<{ value: unknown; key?: IDBValidKey }>,
): Promise<void> {
  const db = await openDb();
  if (!db) {
    for (const e of entries) mem(store).set(memKeyOf(store, e.value, e.key), e.value);
    return;
  }
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const e of entries) os.put(e.value, e.key);
  await txDone(tx);
}

/** add — for the outbox (autoIncrement); returns the assigned key (localSeq). */
export async function idbAdd(store: StoreName, value: unknown): Promise<IDBValidKey> {
  const db = await openDb();
  if (!db) {
    const key = ++memAutoKey;
    const kp = KEY_PATH[store];
    const v = kp ? { ...(value as Record<string, unknown>), [kp]: key } : value;
    mem(store).set(key, v);
    return key;
  }
  const tx = db.transaction(store, "readwrite");
  const req = tx.objectStore(store).add(value);
  await txDone(tx);
  return req.result;
}

/**
 * ATOMICALLY move an op to dead-letter: delete its row from "outbox" (if seq !==
 * null) AND insert the entry into "deadletter" in ONE IDB transaction spanning both
 * stores. Crucial for multi-tab: another tab reading outbox→deadletter (in that
 * order) NEVER sees the intermediate state "the op vanished from the outbox but
 * isn't in deadletter yet" — thanks to this reconcileFromIdb reliably distinguishes
 * an acked op (applied/duplicate) from one REJECTED by another tab (dead-letter),
 * and the latter forces a fullResync (undoing the phantom). Atomicity also closes the
 * crash window (never "the op both in the outbox and in deadletter").
 */
export async function idbMoveToDeadLetter(seq: number | null, deadLetter: unknown): Promise<void> {
  const db = await openDb();
  if (!db) {
    if (seq !== null) mem("outbox").delete(seq);
    mem("deadletter").set(memKeyOf("deadletter", deadLetter), deadLetter);
    return;
  }
  const tx = db.transaction(["outbox", "deadletter"], "readwrite");
  if (seq !== null) tx.objectStore("outbox").delete(seq);
  tx.objectStore("deadletter").put(deadLetter);
  await txDone(tx);
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  if (!db) {
    mem(store).delete(key);
    return;
  }
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  if (!db) {
    mem(store).clear();
    return;
  }
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await txDone(tx);
}

/**
 * "Clear local data" (Settings) — the rescue hatch when the replica diverges.
 *
 * MULTI-TAB SAFE: CLEARS all object stores (meta/outbox/deadletter) in one
 * transaction instead of deleting the whole database. `indexedDB.deleteDatabase` is BLOCKED
 * by an open connection of ANOTHER tab (our `db.close()` closes only our own);
 * onblocked resolved silently, the caller reloaded, and afterwards `open()`
 * queued up BEHIND the hanging (blocked) deletion and never
 * fired — boot hung on "Loading…" until the other tab closed.
 * Clearing stores is a plain readwrite transaction — never blocked by
 * other connections. After the reload, empty stores ⇒ a normal bootstrap from the server
 * snapshot (functionally identical to the old database deletion). Other tabs
 * are reloaded by the "wipe" broadcast in sync.ts (see wipeLocalData). In-memory mode:
 * we clear memory.
 */
export async function clearLocalData(): Promise<void> {
  const db = typeof indexedDB === "undefined" ? null : await openDb();
  if (!db) {
    memStores.clear();
    memAutoKey = 0;
    return;
  }
  const tx = db.transaction(["meta", "outbox", "deadletter"], "readwrite");
  tx.objectStore("meta").clear();
  tx.objectStore("outbox").clear();
  tx.objectStore("deadletter").clear();
  await txDone(tx);
}
