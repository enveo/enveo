import { endSession } from "./auth";
import { exportBackup, hasExportableBackup } from "./data";
import { clearLastAccountId } from "./lastAccount";
import { clearPersistedSettings } from "./settingsPersist";
import { clearLocalAccountData, flushOutboxForSignOut } from "./sync";

export type SignOutPreparation = { kind: "ready" } | { kind: "pending"; count: number } | { kind: "unexportable"; count: number };

export type SignOutDecision = "retry" | "export" | "discard";

export interface SignOutDeps {
  flushPending(): Promise<number>;
  canExport(): boolean;
  exportBackup(): void;
  endSession(): Promise<void>;
  clearCredentialMaterial(): void;
  clearLastAccount(): void;
  clearLocalAccountData(): Promise<void>;
  reloadOrLogin(): void;
}

const realDeps: SignOutDeps = {
  flushPending: flushOutboxForSignOut,
  canExport: hasExportableBackup,
  exportBackup,
  endSession,
  clearCredentialMaterial: clearPersistedSettings,
  clearLastAccount: clearLastAccountId,
  clearLocalAccountData,
  reloadOrLogin: () => {
    if (typeof location !== "undefined") location.reload();
  },
};

export class ExplicitSignOutPendingError extends Error {
  constructor(readonly preparation: Exclude<SignOutPreparation, { kind: "ready" }>) {
    super("explicit_sign_out_pending");
  }
}

export async function prepareExplicitSignOut(deps: SignOutDeps = realDeps): Promise<SignOutPreparation> {
  const count = await deps.flushPending();
  if (count === 0) return { kind: "ready" };
  return deps.canExport() ? { kind: "pending", count } : { kind: "unexportable", count };
}

/** Complete only after pending writes are drained or the human chooses a recovery action. */
export async function completeExplicitSignOut(decision: SignOutDecision, deps: SignOutDeps = realDeps): Promise<void> {
  if (decision === "retry") {
    const preparation = await prepareExplicitSignOut(deps);
    if (preparation.kind !== "ready") throw new ExplicitSignOutPendingError(preparation);
  } else if (decision === "export") {
    if (!deps.canExport()) throw new Error("sign_out_export_unavailable");
    deps.exportBackup();
  }

  await deps.endSession();
  deps.clearCredentialMaterial();
  deps.clearLastAccount();
  await deps.clearLocalAccountData();
  deps.reloadOrLogin();
}
