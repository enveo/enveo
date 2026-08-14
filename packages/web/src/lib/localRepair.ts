import { applyOp, type SyncOp, syncOpSchema } from "@enveo/shared";
import * as e2ee from "./e2ee";
import * as outbox from "./outbox";
import * as persist from "./persist";
import { store } from "./store";
import { runWithSyncMutex } from "./sync/cycle";
import { assertOwnReplica, isIdentityBlocked } from "./sync/identity";
import { postMsg } from "./sync/multitab";
import { bootstrapReplica } from "./sync/transport";

export type RepairResult = { kind: "rebuilt" } | { kind: "blocked"; reason: "unproven" | "outbox_unreadable" | "locked" };

export interface LocalRepairDeps {
  runExclusive<T>(task: () => Promise<T>): Promise<T>;
  identityBlocked(): boolean;
  assertOwnReplica(): Promise<unknown>;
  reconcileOutbox(): Promise<unknown>;
  pendingEntries(): unknown[];
  e2eeState(): { enabled: boolean; keyReady: boolean };
  markLocked(): void;
  fetchFreshBase(): Promise<"ready" | "locked">;
  replay(ops: readonly SyncOp[]): void;
  persist(): Promise<void>;
  durabilityReady(): boolean;
  broadcast(): void;
}

function pendingOps(entries: unknown[]): SyncOp[] | null {
  const result: SyncOp[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object") return null;
    const entry = value as { localSeq?: unknown; op?: unknown };
    if (entry.localSeq !== null && (!Number.isInteger(entry.localSeq) || (entry.localSeq as number) < 1)) return null;
    const parsed = syncOpSchema.safeParse(entry.op);
    if (!parsed.success) return null;
    result.push(parsed.data as SyncOp);
  }
  return result;
}

const realDeps: LocalRepairDeps = {
  runExclusive: runWithSyncMutex,
  identityBlocked: isIdentityBlocked,
  assertOwnReplica,
  reconcileOutbox: outbox.reconcileFromIdb,
  pendingEntries: outbox.snapshot,
  e2eeState: () => {
    const tier = e2ee.getTierMeta();
    return {
      enabled: tier.tier === "e2ee",
      keyReady: e2ee.getDek() !== null && e2ee.isDekValidForEpoch(tier.epoch),
    };
  },
  markLocked: () => store.setBootStatus("locked"),
  fetchFreshBase: bootstrapReplica,
  replay: (ops) => {
    const ledger = store.getLedger();
    const budgetId = store.getBudgetId();
    if (!ledger || !budgetId) throw new Error("no_local_replica");
    let next = ledger;
    for (const op of ops) next = applyOp(next, op);
    store.replace(next, store.getCursor(), budgetId);
  },
  persist: async () => {
    await persist.persistLedger(store.snapshotForPersist());
    await persist.flushed();
  },
  durabilityReady: () => !persist.isDurableBroken(),
  broadcast: () => postMsg("updated"),
};

/** Safely refresh the server-backed base and replay every still-pending local operation. */
export function rebuildLocalReplica(deps: LocalRepairDeps = realDeps): Promise<RepairResult> {
  return deps.runExclusive(async () => {
    if (deps.identityBlocked()) return { kind: "blocked", reason: "unproven" };
    if (!deps.durabilityReady()) return { kind: "blocked", reason: "outbox_unreadable" };
    try {
      await deps.assertOwnReplica();
    } catch (error) {
      if (error instanceof Error && error.message === "foreign_replica") return { kind: "blocked", reason: "unproven" };
      throw error;
    }

    try {
      await deps.reconcileOutbox();
    } catch {
      return { kind: "blocked", reason: "outbox_unreadable" };
    }
    const ops = pendingOps(deps.pendingEntries());
    if (!ops) return { kind: "blocked", reason: "outbox_unreadable" };

    const encryption = deps.e2eeState();
    if (encryption.enabled && !encryption.keyReady) {
      deps.markLocked();
      return { kind: "blocked", reason: "locked" };
    }
    if ((await deps.fetchFreshBase()) === "locked") {
      deps.markLocked();
      return { kind: "blocked", reason: "locked" };
    }

    deps.replay(ops);
    await deps.persist();
    if (!deps.durabilityReady()) return { kind: "blocked", reason: "outbox_unreadable" };
    deps.broadcast();
    return { kind: "rebuilt" };
  });
}
