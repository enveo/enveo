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

export type StoreName = "meta" | "outbox" | "deadletter" | "importJobs" | "importDrafts";

/** keyPath per store (null = out-of-line keys). */
export const KEY_PATH: Record<StoreName, string | null> = {
  meta: null,
  outbox: "localSeq",
  deadletter: "opId",
  importJobs: "id",
  importDrafts: "id",
};

export type ImportDraftPutResult = { kind: "created" | "existing"; value: unknown } | { kind: "conflict" };
export interface ImportDraftDeleteMatch {
  id: IDBValidKey;
  ownerId: string;
  budgetId: string;
  accountId?: string;
  locale?: string;
  requestHash: string;
  requireCancelRequestedAtNull?: boolean;
}
export interface ImportRecordScope {
  ownerId: string;
  budgetId: string;
}
export interface ImportDraftStateMutation extends ImportRecordScope {
  id: IDBValidKey;
  requestHash: string;
  field: "uploadAttemptedAt" | "cancelRequestedAt";
  at: string;
}

export interface StorageBackend {
  get(store: StoreName, key: IDBValidKey): Promise<unknown>;
  getAll(store: StoreName): Promise<unknown[]>;
  /** Atomically replace one out-of-line metadata value from its current value. */
  mutateMeta(key: IDBValidKey, update: (current: unknown) => unknown): Promise<unknown>;
  /** Persistent proof for one imported transaction, read consistently across replica/outbox/deadletter. */
  importTransactionProof(scope: ImportRecordScope, transactionId: string): Promise<"durable" | "rejected" | "absent">;
  /** put — `key` required for "meta" (out-of-line keys), omitted for keyPath stores. */
  put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void>;
  /** Multiple puts in ONE transaction (atomic: all or nothing). */
  putMany(store: StoreName, entries: Array<{ value: unknown; key?: IDBValidKey }>): Promise<void>;
  /** Replace one import job only while its durable checkpoint revision still matches. */
  putImportJobIfRevision(value: unknown, expectedRevision: number): Promise<boolean>;
  /** Create/replace a job only when an existing same-id record belongs to this scope. */
  putImportJobForScope(value: unknown, scope: ImportRecordScope): Promise<boolean>;
  /** Atomically insert a draft, return the identical existing request, or reject an id collision. */
  putImportDraftIfAbsentOrSame(value: unknown): Promise<ImportDraftPutResult>;
  /** Atomically mark the exact draft request as attempted or cancelled. */
  mutateImportDraftState(mutation: ImportDraftStateMutation): Promise<unknown | undefined>;
  /** Delete only the exact draft identity that a request or acknowledgement refers to. */
  deleteImportDraftIfMatches(expected: ImportDraftDeleteMatch): Promise<boolean>;
  deleteImportJobIfScope(id: IDBValidKey, scope: ImportRecordScope): Promise<boolean>;
  /** Atomically delete an owned local E2EE job and its scoped apply metadata when capability still permits it. */
  deleteImportJobWithMetaIfScope(id: IDBValidKey, scope: ImportRecordScope, metaKeys: IDBValidKey[], permitted: () => boolean): Promise<boolean>;
  deleteExpiredImportDrafts(scope: ImportRecordScope, expiresAt: number): Promise<number>;
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

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  get(store: StoreName, key: IDBValidKey): Promise<unknown> {
    const value = this.mem(store).get(key);
    return Promise.resolve(value === undefined ? undefined : this.clone(value));
  }
  getAll(store: StoreName): Promise<unknown[]> {
    return Promise.resolve([...this.mem(store).values()].map((value) => this.clone(value)));
  }
  mutateMeta(key: IDBValidKey, update: (current: unknown) => unknown): Promise<unknown> {
    const current = this.mem("meta").get(key);
    const next = this.clone(update(current === undefined ? undefined : this.clone(current)));
    this.mem("meta").set(key, next);
    return Promise.resolve(this.clone(next));
  }
  importTransactionProof(scope: ImportRecordScope, transactionId: string): Promise<"durable" | "rejected" | "absent"> {
    return Promise.resolve(
      evaluateImportTransactionProof(
        scope,
        transactionId,
        this.mem("meta").get("userId"),
        this.mem("meta").get("budgetId"),
        this.mem("meta").get("ledger"),
        [...this.mem("outbox").values()],
        [...this.mem("deadletter").values()],
      ),
    );
  }
  put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    const copy = this.clone(value);
    this.mem(store).set(this.keyOf(store, copy, key), copy);
    return Promise.resolve();
  }
  putMany(store: StoreName, entries: Array<{ value: unknown; key?: IDBValidKey }>): Promise<void> {
    const copies = entries.map((entry) => ({ value: this.clone(entry.value), key: entry.key }));
    for (const entry of copies) this.mem(store).set(this.keyOf(store, entry.value, entry.key), entry.value);
    return Promise.resolve();
  }
  putImportJobIfRevision(value: unknown, expectedRevision: number): Promise<boolean> {
    const record = value as { id: IDBValidKey; ownerId: string; budgetId: string; checkpointRevision: number };
    const current = this.mem("importJobs").get(record.id) as Record<string, unknown> | undefined;
    if (current?.checkpointRevision !== expectedRevision || current.ownerId !== record.ownerId || current.budgetId !== record.budgetId) {
      return Promise.resolve(false);
    }
    this.mem("importJobs").set(record.id, this.clone(value));
    return Promise.resolve(true);
  }
  putImportJobForScope(value: unknown, scope: ImportRecordScope): Promise<boolean> {
    const record = value as { id: IDBValidKey; ownerId: string; budgetId: string };
    if (record.ownerId !== scope.ownerId || record.budgetId !== scope.budgetId) return Promise.resolve(false);
    const current = this.mem("importJobs").get(record.id) as Record<string, unknown> | undefined;
    if (current && (current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId)) return Promise.resolve(false);
    this.mem("importJobs").set(record.id, this.clone(value));
    return Promise.resolve(true);
  }
  putImportDraftIfAbsentOrSame(value: unknown): Promise<ImportDraftPutResult> {
    const record = value as { id: IDBValidKey; ownerId: string; budgetId: string; requestHash: string };
    const current = this.mem("importDrafts").get(record.id) as Record<string, unknown> | undefined;
    if (current) {
      return Promise.resolve(
        current.requestHash === record.requestHash && current.ownerId === record.ownerId && current.budgetId === record.budgetId
          ? { kind: "existing", value: this.clone(current) }
          : { kind: "conflict" },
      );
    }
    const stored = this.clone(value);
    this.mem("importDrafts").set(record.id, stored);
    return Promise.resolve({ kind: "created", value: this.clone(stored) });
  }
  mutateImportDraftState(mutation: ImportDraftStateMutation): Promise<unknown | undefined> {
    const current = this.mem("importDrafts").get(mutation.id) as Record<string, unknown> | undefined;
    if (!current || current.ownerId !== mutation.ownerId || current.budgetId !== mutation.budgetId || current.requestHash !== mutation.requestHash) {
      return Promise.resolve(undefined);
    }
    const next = {
      ...current,
      [mutation.field]: current[mutation.field] ?? mutation.at,
      updatedAt: mutation.at,
    };
    this.mem("importDrafts").set(mutation.id, this.clone(next));
    return Promise.resolve(this.clone(next));
  }
  deleteImportDraftIfMatches(expected: ImportDraftDeleteMatch): Promise<boolean> {
    const current = this.mem("importDrafts").get(expected.id) as Record<string, unknown> | undefined;
    if (
      !current ||
      current.ownerId !== expected.ownerId ||
      current.budgetId !== expected.budgetId ||
      (expected.accountId !== undefined && current.accountId !== expected.accountId) ||
      (expected.locale !== undefined && current.locale !== expected.locale) ||
      (expected.requireCancelRequestedAtNull === true && current.cancelRequestedAt != null) ||
      current.requestHash !== expected.requestHash
    ) {
      return Promise.resolve(false);
    }
    this.mem("importDrafts").delete(expected.id);
    return Promise.resolve(true);
  }
  deleteImportJobIfScope(id: IDBValidKey, scope: ImportRecordScope): Promise<boolean> {
    const current = this.mem("importJobs").get(id) as Record<string, unknown> | undefined;
    if (!current || current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId) return Promise.resolve(false);
    this.mem("importJobs").delete(id);
    return Promise.resolve(true);
  }
  deleteImportJobWithMetaIfScope(id: IDBValidKey, scope: ImportRecordScope, metaKeys: IDBValidKey[], permitted: () => boolean): Promise<boolean> {
    const current = this.mem("importJobs").get(id) as Record<string, unknown> | undefined;
    if (!permitted() || !current || current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId) return Promise.resolve(false);
    this.mem("importJobs").delete(id);
    for (const key of metaKeys) this.mem("meta").delete(key);
    return Promise.resolve(true);
  }
  deleteExpiredImportDrafts(scope: ImportRecordScope, expiresAt: number): Promise<number> {
    let deleted = 0;
    for (const [id, value] of this.mem("importDrafts")) {
      const draft = value as Record<string, unknown>;
      if (
        draft.ownerId === scope.ownerId &&
        draft.budgetId === scope.budgetId &&
        draft.cancelRequestedAt == null &&
        typeof draft.expiresAt === "string" &&
        Date.parse(draft.expiresAt) <= expiresAt
      ) {
        this.mem("importDrafts").delete(id);
        deleted++;
      }
    }
    return Promise.resolve(deleted);
  }
  add(store: StoreName, value: unknown): Promise<IDBValidKey> {
    const copy = this.clone(value);
    const key = ++this.autoKey;
    const kp = KEY_PATH[store];
    const v = kp ? { ...(copy as Record<string, unknown>), [kp]: key } : copy;
    this.mem(store).set(key, v);
    return Promise.resolve(key);
  }
  moveToDeadLetter(seq: number | null, deadLetter: unknown): Promise<void> {
    const copy = this.clone(deadLetter);
    if (seq !== null) this.mem("outbox").delete(seq);
    this.mem("deadletter").set(this.keyOf("deadletter", copy), copy);
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

export function evaluateImportTransactionProof(
  scope: ImportRecordScope,
  transactionId: string,
  ownerId: unknown,
  budgetId: unknown,
  ledger: unknown,
  outboxRows: unknown[],
  deadletterRows: unknown[],
): "durable" | "rejected" | "absent" {
  if (ownerId !== scope.ownerId || budgetId !== scope.budgetId) return "absent";
  const isCreate = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const operation = (value as { op?: unknown }).op;
    if (!operation || typeof operation !== "object") return false;
    const record = operation as { kind?: unknown; payload?: unknown };
    return record.kind === "txn.create" && !!record.payload && typeof record.payload === "object" && (record.payload as { id?: unknown }).id === transactionId;
  };
  if (deadletterRows.some(isCreate)) return "rejected";
  if (outboxRows.some(isCreate)) return "durable";
  const transactions = ledger && typeof ledger === "object" ? (ledger as { transactions?: unknown }).transactions : undefined;
  return Array.isArray(transactions) && transactions.some((transaction) => transaction && typeof transaction === "object" && transaction.id === transactionId)
    ? "durable"
    : "absent";
}
