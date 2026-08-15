/**
 * StorageBackend — the persistence seam behind idb.ts's public API.
 *
 * Two implementations:
 *  - IdbBackend (idb.ts) — IndexedDB with the corruption-fallback policy,
 *  - MemoryBackend (here) — plain Maps; nothing survives the tab. It serves two
 *    roles: the FORCED backend under the session policy (the replica must leave
 *    no trace on disk, so IndexedDB is never even opened) and the emergency
 *    fallback inside IdbBackend after an unrecoverable IndexedDB failure.
 *
 * The interface mirrors idb.ts's operation set 1:1 — including the atomic
 * outbox→deadletter move (multi-tab correctness) and the multi-store clearAll
 * of "Clear local data" — so the facade delegates without translation.
 */

export type StoreName = "meta" | "outbox" | "deadletter";

/** keyPath per store (null = out-of-line keys). */
export const KEY_PATH: Record<StoreName, string | null> = {
  meta: null,
  outbox: "localSeq",
  deadletter: "opId",
};

export interface StorageBackend {
  get(store: StoreName, key: IDBValidKey): Promise<unknown>;
  getAll(store: StoreName): Promise<unknown[]>;
  /** put — `key` required for "meta" (out-of-line keys), omitted for keyPath stores. */
  put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void>;
  /** Multiple puts in ONE transaction (atomic: all or nothing). */
  putMany(store: StoreName, entries: Array<{ value: unknown; key?: IDBValidKey }>): Promise<void>;
  /** add — for the outbox (autoIncrement); returns the assigned key (localSeq). */
  add(store: StoreName, value: unknown): Promise<IDBValidKey>;
  /**
   * ATOMICALLY move an op to dead-letter: delete from "outbox" (if seq !== null)
   * AND insert into "deadletter" in ONE transaction spanning both stores — a
   * reader never sees "vanished from the outbox but not in deadletter yet".
   */
  moveToDeadLetter(seq: number | null, deadLetter: unknown): Promise<void>;
  delete(store: StoreName, key: IDBValidKey): Promise<void>;
  clear(store: StoreName): Promise<void>;
  /** "Clear local data": every store, one transaction. */
  clearAll(): Promise<void>;
}

export class MemoryBackend implements StorageBackend {
  private stores = new Map<StoreName, Map<IDBValidKey, unknown>>();
  private autoKey = 0;

  private mem(name: StoreName): Map<IDBValidKey, unknown> {
    let m = this.stores.get(name);
    if (!m) {
      m = new Map();
      this.stores.set(name, m);
    }
    return m;
  }

  private keyOf(name: StoreName, value: unknown, key?: IDBValidKey): IDBValidKey {
    if (key !== undefined) return key;
    const kp = KEY_PATH[name];
    const k = kp ? (value as Record<string, unknown>)[kp] : undefined;
    return (k as IDBValidKey | undefined) ?? ++this.autoKey;
  }

  get(store: StoreName, key: IDBValidKey): Promise<unknown> {
    return Promise.resolve(this.mem(store).get(key));
  }
  getAll(store: StoreName): Promise<unknown[]> {
    return Promise.resolve([...this.mem(store).values()]);
  }
  put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    this.mem(store).set(this.keyOf(store, value, key), value);
    return Promise.resolve();
  }
  putMany(store: StoreName, entries: Array<{ value: unknown; key?: IDBValidKey }>): Promise<void> {
    for (const e of entries) this.mem(store).set(this.keyOf(store, e.value, e.key), e.value);
    return Promise.resolve();
  }
  add(store: StoreName, value: unknown): Promise<IDBValidKey> {
    const key = ++this.autoKey;
    const kp = KEY_PATH[store];
    const v = kp ? { ...(value as Record<string, unknown>), [kp]: key } : value;
    this.mem(store).set(key, v);
    return Promise.resolve(key);
  }
  moveToDeadLetter(seq: number | null, deadLetter: unknown): Promise<void> {
    if (seq !== null) this.mem("outbox").delete(seq);
    this.mem("deadletter").set(this.keyOf("deadletter", deadLetter), deadLetter);
    return Promise.resolve();
  }
  delete(store: StoreName, key: IDBValidKey): Promise<void> {
    this.mem(store).delete(key);
    return Promise.resolve();
  }
  clear(store: StoreName): Promise<void> {
    this.mem(store).clear();
    return Promise.resolve();
  }
  clearAll(): Promise<void> {
    this.stores.clear();
    this.autoKey = 0;
    return Promise.resolve();
  }
}
