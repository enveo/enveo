import { endSessionForSignOut } from "./auth";
import { exportBackup, hasExportableBackup } from "./data";
import { storageMode } from "./idb";
import { clearLastAccountId } from "./lastAccount";
import { clearPersistedSettings } from "./settingsPersist";
import {
  assertOwnReplica,
  beginSignOutCoordination,
  type CoordinatedSignOutLease,
  cancelSignOutCoordination,
  clearLocalAccountDataForSignOut,
  finishSignOutCoordination,
  flushOutboxForSignOut,
  markSignOutServerSucceeded,
} from "./sync";

export type SignOutPreparation = { kind: "ready" } | { kind: "pending"; count: number } | { kind: "unexportable"; count: number };

export type SignOutDecision = "retry" | "export" | "discard";

export interface SignOutDeps {
  beginCoordination(): Promise<CoordinatedSignOutLease>;
  cancelCoordination(lease: CoordinatedSignOutLease): void;
  flushPending(lease: CoordinatedSignOutLease): Promise<number>;
  canExport(): boolean;
  exportBackup(): void;
  canRequestClearSiteData(): Promise<boolean>;
  endSession(lease: CoordinatedSignOutLease, clearSiteData: boolean): Promise<void>;
  markServerSucceeded(lease: CoordinatedSignOutLease): void;
  clearLocalAccountData(lease: CoordinatedSignOutLease): Promise<void>;
  finishCoordination(lease: CoordinatedSignOutLease): void;
  reloadOrLogin(): void;
}

const realDeps: SignOutDeps = {
  beginCoordination: beginSignOutCoordination,
  cancelCoordination: cancelSignOutCoordination,
  flushPending: flushOutboxForSignOut,
  canExport: hasExportableBackup,
  exportBackup,
  canRequestClearSiteData,
  endSession: endSessionForSignOut,
  markServerSucceeded: markSignOutServerSucceeded,
  clearLocalAccountData: (lease) =>
    clearLocalAccountDataForSignOut(lease, () => {
      clearPersistedSettings();
      clearLastAccountId();
    }),
  finishCoordination: finishSignOutCoordination,
  reloadOrLogin: () => {
    if (typeof location !== "undefined") location.reload();
  },
};

/**
 * Clear-Site-Data is deliberately opt-in: only a persistent replica freshly proved to belong to
 * the current session may authorize origin-wide browser cleanup. A shared-device session never
 * opens that replica, and an unavailable/mismatched identity simply falls back to local cleanup.
 */
export async function canRequestClearSiteData(): Promise<boolean> {
  if (storageMode() !== "idb") return false;
  try {
    await assertOwnReplica();
    return true;
  } catch {
    return false;
  }
}

export class ExplicitSignOutPendingError extends Error {
  constructor(readonly preparation: Exclude<SignOutPreparation, { kind: "ready" }>) {
    super("explicit_sign_out_pending");
  }
}

export async function prepareExplicitSignOut(deps: SignOutDeps = realDeps): Promise<SignOutPreparation> {
  const lease = await deps.beginCoordination();
  try {
    const count = await deps.flushPending(lease);
    if (count === 0) return { kind: "ready" };
    return deps.canExport() ? { kind: "pending", count } : { kind: "unexportable", count };
  } finally {
    deps.cancelCoordination(lease);
  }
}

/** Complete only after pending writes are drained or the human chooses a recovery action. */
export async function completeExplicitSignOut(decision: SignOutDecision, deps: SignOutDeps = realDeps): Promise<void> {
  if (decision === "export") {
    if (!deps.canExport()) throw new Error("sign_out_export_unavailable");
    deps.exportBackup();
  }
  const lease = await deps.beginCoordination();
  let serverSucceeded = false;
  try {
    // Every decision crosses the same required-lease final-flush boundary. Retry requires an
    // empty queue; export/discard preserve the human's recovery choice when writes remain.
    const count = await deps.flushPending(lease);
    if (decision === "retry") {
      if (count !== 0) {
        const preparation: Exclude<SignOutPreparation, { kind: "ready" }> = deps.canExport() ? { kind: "pending", count } : { kind: "unexportable", count };
        throw new ExplicitSignOutPendingError(preparation);
      }
    }
    const clearSiteData = await deps.canRequestClearSiteData();
    await deps.endSession(lease, clearSiteData);
    deps.markServerSucceeded(lease);
    serverSucceeded = true;
    try {
      await deps.clearLocalAccountData(lease);
    } catch {
      throw new Error("local_sign_out_cleanup_failed");
    }
    deps.finishCoordination(lease);
    deps.reloadOrLogin();
  } catch (error) {
    if (!serverSucceeded) deps.cancelCoordination(lease);
    throw error;
  }
}
