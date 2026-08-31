import type { ImportDraftDeleteMatch, ImportDraftPutResult, ImportDraftStateMutation, ImportRecordScope, StoreName } from "./storageBackend";

type Stores = (name: StoreName) => Map<IDBValidKey, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

export function transactionProof(mem: Stores, scope: ImportRecordScope, transactionId: string): "durable" | "rejected" | "absent" {
  return evaluateImportTransactionProof(
    scope,
    transactionId,
    mem("meta").get("userId"),
    mem("meta").get("budgetId"),
    mem("meta").get("ledger"),
    [...mem("outbox").values()],
    [...mem("deadletter").values()],
  );
}

export function putJobIfRevision(mem: Stores, value: unknown, expectedRevision: number): boolean {
  const record = value as { id: IDBValidKey; ownerId: string; budgetId: string; checkpointRevision: number };
  const current = mem("importJobs").get(record.id) as Record<string, unknown> | undefined;
  if (current?.checkpointRevision !== expectedRevision || current.ownerId !== record.ownerId || current.budgetId !== record.budgetId) return false;
  mem("importJobs").set(record.id, clone(value));
  return true;
}

export function putJobForScope(mem: Stores, value: unknown, scope: ImportRecordScope): boolean {
  const record = value as { id: IDBValidKey; ownerId: string; budgetId: string };
  if (record.ownerId !== scope.ownerId || record.budgetId !== scope.budgetId) return false;
  const current = mem("importJobs").get(record.id) as Record<string, unknown> | undefined;
  if (current && (current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId)) return false;
  mem("importJobs").set(record.id, clone(value));
  return true;
}

export function putDraft(mem: Stores, value: unknown): ImportDraftPutResult {
  const record = value as { id: IDBValidKey; ownerId: string; budgetId: string; requestHash: string };
  const current = mem("importDrafts").get(record.id) as Record<string, unknown> | undefined;
  if (current) {
    return current.requestHash === record.requestHash && current.ownerId === record.ownerId && current.budgetId === record.budgetId
      ? { kind: "existing", value: clone(current) }
      : { kind: "conflict" };
  }
  const stored = clone(value);
  mem("importDrafts").set(record.id, stored);
  return { kind: "created", value: clone(stored) };
}

export function mutateDraft(mem: Stores, mutation: ImportDraftStateMutation): unknown | undefined {
  const current = mem("importDrafts").get(mutation.id) as Record<string, unknown> | undefined;
  if (!current || current.ownerId !== mutation.ownerId || current.budgetId !== mutation.budgetId || current.requestHash !== mutation.requestHash)
    return undefined;
  const next = { ...current, [mutation.field]: current[mutation.field] ?? mutation.at, updatedAt: mutation.at };
  mem("importDrafts").set(mutation.id, clone(next));
  return clone(next);
}

export function deleteDraft(mem: Stores, expected: ImportDraftDeleteMatch): boolean {
  const current = mem("importDrafts").get(expected.id) as Record<string, unknown> | undefined;
  if (
    !current ||
    current.ownerId !== expected.ownerId ||
    current.budgetId !== expected.budgetId ||
    (expected.accountId !== undefined && current.accountId !== expected.accountId) ||
    (expected.locale !== undefined && current.locale !== expected.locale) ||
    (expected.requireCancelRequestedAtNull === true && current.cancelRequestedAt != null) ||
    current.requestHash !== expected.requestHash
  )
    return false;
  mem("importDrafts").delete(expected.id);
  return true;
}

export function deleteJob(mem: Stores, id: IDBValidKey, scope: ImportRecordScope): boolean {
  const current = mem("importJobs").get(id) as Record<string, unknown> | undefined;
  if (!current || current.ownerId !== scope.ownerId || current.budgetId !== scope.budgetId) return false;
  mem("importJobs").delete(id);
  return true;
}

export function deleteJobWithMeta(mem: Stores, id: IDBValidKey, scope: ImportRecordScope, metaKeys: IDBValidKey[], permitted: () => boolean): boolean {
  if (!permitted() || !deleteJob(mem, id, scope)) return false;
  for (const key of metaKeys) mem("meta").delete(key);
  return true;
}

export function deleteExpiredDrafts(mem: Stores, scope: ImportRecordScope, expiresAt: number): number {
  let deleted = 0;
  for (const [id, value] of mem("importDrafts")) {
    const draft = value as Record<string, unknown>;
    if (
      draft.ownerId === scope.ownerId &&
      draft.budgetId === scope.budgetId &&
      draft.cancelRequestedAt == null &&
      typeof draft.expiresAt === "string" &&
      Date.parse(draft.expiresAt) <= expiresAt
    ) {
      mem("importDrafts").delete(id);
      deleted++;
    }
  }
  return deleted;
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
