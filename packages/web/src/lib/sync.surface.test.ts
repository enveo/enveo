/**
 * COMPILE-TIME PUBLIC-SURFACE FIXTURE for lib/sync.ts (workflow §3c-3).
 *
 * Captured BEFORE the module split and kept through it: every value/type exported by the
 * facade is imported here and its signature pinned with an explicit annotation, so removing,
 * renaming or retyping any public export fails `typecheck` (tsconfig.test.json) even if no
 * runtime test happens to touch it. The runtime block below is a trivial smoke — the point of
 * this file is the type layer.
 */
import { describe, expect, it } from "bun:test";
import type { ClientLedger } from "@enveo/shared";
import {
  __resetBackoff,
  __resetIdentity,
  __resetObligations,
  assertOwnReplica,
  type BootSource,
  beginSignOutCoordination,
  bootOnce,
  broadcastKeysChanged,
  type CoordinatedSignOutLease,
  cancelSignOutCoordination,
  clearLocalAccountData,
  clearLocalAccountDataForSignOut,
  decideIdentity,
  discardLocalReplica,
  discardPendingE2eeUpgrade,
  E2eeUpgradeRequiredError,
  EMPTY_LEDGER,
  enterLoginPreservingReplica,
  fetchSnapshot,
  finishSignOutCoordination,
  flushOutboxForSignOut,
  fullResync,
  getClientId,
  getLastBootSource,
  getSyncStatus,
  hasPendingE2eeUpgrade,
  type IdentityVerdict,
  markReplacePending,
  markSignOutServerSucceeded,
  type PendingE2eeUpgrade,
  poke,
  pullNow,
  pushLocalToServer,
  recheckReplicaOwner,
  resetServerE2ee,
  retryBoot,
  type SyncState,
  type SyncStatus,
  subscribeSyncStatus,
  syncNow,
  TierMismatchError,
  upgradeServerE2eeV2,
  wipeLocalData,
} from "./sync";

/* ── Value signatures (a changed parameter or return type is a compile error) ── */

const _getClientId: () => Promise<string> = getClientId;
const _emptyLedger: ClientLedger = EMPTY_LEDGER;
const _getLastBootSource: () => BootSource = getLastBootSource;
const _getSyncStatus: () => SyncStatus = getSyncStatus;
const _subscribeSyncStatus: (fn: () => void) => () => void = subscribeSyncStatus;
const _markReplacePending: () => void = markReplacePending;
const _fetchSnapshot: () => Promise<void> = fetchSnapshot;
const _fullResync: () => Promise<void> = fullResync;
const _decideIdentity: (sessionUserId: string | null, stamped: string | undefined) => IdentityVerdict = decideIdentity;
const _resetIdentity: () => void = __resetIdentity;
const _resetObligations: () => void = __resetObligations;
const _resetBackoff: () => void = __resetBackoff;
const _discardLocalReplica: () => Promise<void> = discardLocalReplica;
const _clearLocalAccountData: () => Promise<void> = clearLocalAccountData;
const _enterLoginPreservingReplica: () => void = enterLoginPreservingReplica;
const _flushOutboxForSignOut: (lease: CoordinatedSignOutLease) => Promise<number> = flushOutboxForSignOut;
const _beginSignOutCoordination: () => Promise<CoordinatedSignOutLease> = beginSignOutCoordination;
const _cancelSignOutCoordination: (lease: CoordinatedSignOutLease) => void = cancelSignOutCoordination;
const _markSignOutServerSucceeded: (lease: CoordinatedSignOutLease) => void = markSignOutServerSucceeded;
const _clearLocalAccountDataForSignOut: (lease: CoordinatedSignOutLease, clearAdditionalAccountState?: () => void) => Promise<void> =
  clearLocalAccountDataForSignOut;
const _finishSignOutCoordination: (lease: CoordinatedSignOutLease) => void = finishSignOutCoordination;

function _finalFlushRequiresLeaseAtCompileTime(): void {
  // @ts-expect-error The final flush is privileged and cannot be called without coordination.
  void flushOutboxForSignOut();
}
const _recheckReplicaOwner: () => Promise<void> = recheckReplicaOwner;
const _assertOwnReplica: () => Promise<string> = assertOwnReplica;
const _syncNow: (reason: string) => Promise<void> = syncNow;
const _pullNow: () => Promise<void> = pullNow;
const _pushLocalToServer: () => Promise<void> = pushLocalToServer;
const _resetServerE2ee: (dek?: Uint8Array) => Promise<void> = resetServerE2ee;
const _hasPendingE2eeUpgrade: () => Promise<boolean> = hasPendingE2eeUpgrade;
const _discardPendingE2eeUpgrade: () => Promise<void> = discardPendingE2eeUpgrade;
const _upgradeServerE2eeV2: (password: string | null) => Promise<void> = upgradeServerE2eeV2;
const _poke: () => void = poke;
const _bootOnce: () => Promise<void> = bootOnce;
const _retryBoot: () => Promise<void> = retryBoot;
const _broadcastKeysChanged: () => Promise<void> = broadcastKeysChanged;
const _wipeLocalData: () => Promise<void> = wipeLocalData;

/* ── Error classes: constructor shape, inheritance and payload fields ── */

const _tierMismatch: TierMismatchError = new TierMismatchError("e2ee", 1);
const _tierOfMismatch: "plain" | "e2ee" = _tierMismatch.tier;
const _epochOfMismatch: number = _tierMismatch.epoch;
const _upgradeRequired: E2eeUpgradeRequiredError = new E2eeUpgradeRequiredError(1, null);
const _epochOfUpgrade: number = _upgradeRequired.epoch;
const _budgetOfUpgrade: string | null = _upgradeRequired.budgetId;

/* ── Type shapes ── */

const _bootSources: BootSource[] = ["replica", "snapshot", null];
const _syncStates: SyncState[] = ["synced", "syncing", "offline", "error", "unauthed", "unverified"];
const _verdicts: IdentityVerdict[] = ["unauthed", "foreign", "ok"];
const _status: SyncStatus = {
  state: "synced",
  pending: 0,
  deadLetters: 0,
  lastSyncAt: null,
  ownerUnproven: false,
};
const _pendingUpgrade: PendingE2eeUpgrade = {
  budgetId: "b",
  expectedEpoch: 1,
  nextEpoch: 2,
  dek: new Uint8Array(32),
  wrappedDek: "w",
  kdfParams: "k",
  snapshotBlob: "s",
  credentialAction: { kind: "none" },
  opIds: [],
};

// Silence "declared but never read" without changing tsconfig: one reference each.
const surface = [
  _getClientId,
  _emptyLedger,
  _getLastBootSource,
  _getSyncStatus,
  _subscribeSyncStatus,
  _markReplacePending,
  _fetchSnapshot,
  _fullResync,
  _decideIdentity,
  _resetIdentity,
  _resetObligations,
  _resetBackoff,
  _discardLocalReplica,
  _clearLocalAccountData,
  _enterLoginPreservingReplica,
  _flushOutboxForSignOut,
  _beginSignOutCoordination,
  _cancelSignOutCoordination,
  _markSignOutServerSucceeded,
  _clearLocalAccountDataForSignOut,
  _finishSignOutCoordination,
  _recheckReplicaOwner,
  _assertOwnReplica,
  _syncNow,
  _pullNow,
  _pushLocalToServer,
  _resetServerE2ee,
  _hasPendingE2eeUpgrade,
  _discardPendingE2eeUpgrade,
  _upgradeServerE2eeV2,
  _poke,
  _bootOnce,
  _retryBoot,
  _broadcastKeysChanged,
  _wipeLocalData,
  _tierMismatch,
  _tierOfMismatch,
  _epochOfMismatch,
  _upgradeRequired,
  _epochOfUpgrade,
  _budgetOfUpgrade,
  _bootSources,
  _syncStates,
  _verdicts,
  _status,
  _pendingUpgrade,
] as const;

describe("sync public surface (compile-time fixture)", () => {
  it("every export is present and callable-shaped", () => {
    expect(surface.length).toBe(46);
    expect(_tierMismatch.name).toBe("TierMismatchError");
    expect(_upgradeRequired.name).toBe("E2eeUpgradeRequiredError");
  });
});
