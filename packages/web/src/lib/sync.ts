/**
 * Sync engine — the heart of local-first. PUBLIC FACADE + COMPOSITION ROOT (workflow §3c-3):
 * the implementation lives in lib/sync/* and this file is the only module allowed to import
 * all of its subsystems; internal modules import contracts.ts and lower-level libs, never this
 * facade. Every public import path and symbol is preserved (sync.surface.test.ts pins them).
 *
 * The engine, in one breath:
 * - syncNow(reason): single-flight with a dirty flag (coalesces callers);
 *   cycle = PUSH (batches ≤100 from the outbox, in order) → PULL (delta
 *   with pending-guard) → possible fullResync after a rejection.
 * - push: applied|duplicate → remove from outbox; rejected → dead-letter
 *   + needResync (snapshot + replay of the remaining ops UNDOES the optimistic
 *   effect of the rejected op — delete wins); budgetId mismatch (new data
 *   epoch) → fullResync and STOP the cycle.
 * - network errors / 5xx / 429: retry with backoff 1s→2s→…→60s ±30% jitter;
 *   backoff reset on success / "online" / new op (poke).
 * - fullResync(): snapshot → replay ALL remaining outbox ops
 *   onto the fresh mirror (memory; they still await push) → persist.
 * - boot: hydrate mirror + outbox → WHOSE replica is this? (bootOwnerOk — a stamped replica is
 *   never rendered to another account) → (empty ⇒ snapshot) → REPLAY outbox
 *   (heals a crash between idbAdd of an op and persisting the mirror) → ready → syncNow.
 * - triggers: boot / poke after enqueue (300 ms debounce — catches a reorder
 *   burst) / focus / online / visibilitychange→visible / 60 s interval
 *   while the tab is visible. Installation is idempotent (StrictMode-safe).
 * - status for the UI (Phase 5): getSyncStatus() + subscribeSyncStatus().
 * - E2EE (tier "e2ee" in e2ee.getTierMeta()): SAME cycle, different network path —
 *   push encrypts outbox ops (the outbox stays plaintext!) to /sync2/push,
 *   pull fetches ciphertexts from /sync2/pull and applies them via applyOp
 *   (store.applyRemoteOps), bootstrap = /sync2/snapshot (no DEK ⇒ BootStatus
 *   "locked" → Unlock screen). 409 tier_mismatch from ANY call (v1 and v2)
 *   updates tierMeta from the body and forces a hard re-bootstrap on the right path.
 *
 * MODULE MAP (each mutable value has ONE owner):
 * - sync/contracts.ts   — shared types, wire shapes, constants, error classes, dep interfaces
 * - sync/status.ts      — SyncState/lastSyncAt/ownerUnproven + listeners/snapshot
 * - sync/obligations.ts — durable resync/replace flags + IDB mirrors
 * - sync/replica.ts     — stateless helpers over store/outbox (replay, budget id, emptiness)
 * - sync/transport.ts   — request construction/classification + every wire call (deps below)
 * - sync/identity.ts    — the multi-tenant guard: verdict state, ownership proof, boot check
 * - sync/cycle.ts       — flight/backoff/dirty state, doCycle, mismatch recovery, poke
 * - sync/boot.ts        — hydration, bootstrap, legacy sweep, bootOnce/retryBoot
 * - sync/multitab.ts    — Web Locks leadership, BroadcastChannel, peer-update application
 * - sync/upgrade.ts     — the v1→v2 E2EE upgrade ceremony + its durable intent record
 */

import { accountPreferences } from "./accountPreferences";
import { budgetPreferences } from "./budgetPreferences";
import { devicePreferences } from "./devicePreferences";
import * as e2ee from "./e2ee";
import { idbGet, idbPut, storageMode } from "./idb";
import { configureLegacySettingsMigration, parseLegacyMigrationAck } from "./legacySettingsMigration";
// NOTE: no static `import { local } from "./mutate"` here — mutate.ts imports `poke` from this
// facade, so a static edge in the other direction would be a cycle. The one place the engine
// needs `local` (sweepLegacyPlanned in sync/boot.ts) does a lazy `await import("../mutate")`.
import * as outbox from "./outbox";
import * as persist from "./persist";
import { readLegacySettings } from "./settingsPersist";
import { INTERVAL_MS } from "./sync/contracts";
import { configureCycle, getLastSyncReason, resetBackoff, syncNow } from "./sync/cycle";
import { assertOwnReplica, enterUnauthed } from "./sync/identity";
import { broadcastUpdatedIfPending, installMultiTab, isLeaderTab, notePeersMayNeedUpdate, postMsg, wipeLocalData } from "./sync/multitab";
import { isReplacePending, isResyncPending } from "./sync/obligations";
import { getSyncStatus, installOutboxStatusListener } from "./sync/status";
import { configureTransport } from "./sync/transport";

/* ── Re-exported public surface (unchanged import paths for every caller) ── */
export { bootOnce, getLastBootSource, retryBoot } from "./sync/boot";
export type { BootSource, IdentityVerdict, PendingE2eeUpgrade, SyncState, SyncStatus } from "./sync/contracts";
export { E2eeUpgradeRequiredError, EMPTY_LEDGER, TierMismatchError } from "./sync/contracts";
export { __resetBackoff, flushOutboxForSignOut, fullResync, poke, pullNow, recheckReplicaOwner, syncNow } from "./sync/cycle";
export { __resetIdentity, assertOwnReplica, decideIdentity, enterLoginKeepingReplica } from "./sync/identity";
export { broadcastKeysChanged, wipeLocalData } from "./sync/multitab";
export { __resetObligations, markReplacePending } from "./sync/obligations";
export { getSyncStatus, subscribeSyncStatus } from "./sync/status";
export { fetchSnapshot, getClientId, pushLocalToServer, resetServerE2ee } from "./sync/transport";
export { discardPendingE2eeUpgrade, hasPendingE2eeUpgrade, upgradeServerE2eeV2 } from "./sync/upgrade";

// every outbox queue change (add/ack/dead-letter) refreshes the status —
// explicit, idempotent installation (sync/status.ts), done at composition time
installOutboxStatusListener();

configureLegacySettingsMigration({
  readLegacy: () => readLegacySettings()?.value ?? null,
  loadAck: async () => parseLegacyMigrationAck(await idbGet("meta", "legacySettingsMigrationV1")),
  saveAck: (value) => idbPut("meta", value, "legacySettingsMigrationV1"),
  accountState: accountPreferences.migrationState,
  updateAccount: accountPreferences.update,
  budgetState: budgetPreferences.getSnapshot,
  updateBudget: async (patch) => {
    budgetPreferences.update(patch);
    await outbox.flushed(); // acknowledgement may not outrun the durable op
  },
  deviceState: devicePreferences.migrationState,
  updateDevice: devicePreferences.update,
});

/**
 * The human chose "remove this data and continue" — on ForeignReplicaScreen (the replica is
 * stamped by another account) or in the unverified-replica notice (its owner cannot be proved).
 * This is the ONLY path that destroys such a replica, and it destroys it whole (mirror + outbox +
 * DEK + owner stamp), then reloads so the boot bootstraps the signed-in account's data.
 *
 */
export async function discardLocalReplica(): Promise<void> {
  outbox.clearAll(); // in-memory queue too: nothing of the previous owner's may go out
  await persist.flushed(); // let queued writes land BEFORE the stores are cleared
  await wipeLocalData(); // clears IDB (mirror, outbox, DEK), tells other tabs, reloads
}

/* ── Triggers (idempotent installation — StrictMode-safe) ──────────── */

let triggersInstalled = false;

function installTriggers(): void {
  if (triggersInstalled || typeof window === "undefined") return;
  triggersInstalled = true;
  installMultiTab();
  window.addEventListener("focus", () => void syncNow("focus"));
  window.addEventListener("online", () => {
    resetBackoff();
    void syncNow("online");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow("visible");
    else if (outbox.size() > 0) postMsg("poke"); // hidden with unsent ops → poke a live leader
  });
  // Closing / bfcaching a tab with unsent ops: poke (BroadcastChannel
  // "poke") a possibly-live leader so it absorbs+pushes right away. Correctness
  // does NOT depend on this — the real safeguard is reconcileFromIdb at the start of
  // a cycle (plus leadership takeover when the Web Lock is released) — this cuts latency.
  window.addEventListener("pagehide", () => {
    if (outbox.size() > 0) postMsg("poke");
  });
  // Session policy (memory-session): the replica AND the outbox live only in this tab's
  // memory — closing the tab with unsent ops loses them for good. Best-effort warning
  // (the browser shows its own generic prompt). Persistent replicas need none: the outbox is
  // durable and any live tab (or the next boot) drains it.
  window.addEventListener("beforeunload", (e) => {
    if (storageMode() === "memory-session" && outbox.size() > 0) {
      e.preventDefault();
      e.returnValue = ""; // legacy engines only show the dialog when returnValue is set
    }
  });
  setInterval(() => {
    // only the leader polls in the background (Web Locks) — the other tabs sync on
    // interaction/enqueue; no Web Locks ⇒ isLeader=true (every tab, as before)
    if (isLeaderTab() && document.visibilityState === "visible") void syncNow("interval");
  }, INTERVAL_MS);
}

/* ── Composition (the facade is the ONLY module that wires the subsystems) ── */

// The transport's higher-layer effects (identity transitions, ownership guard, peer notice)
// are wired in HERE — identity and multitab sit above transport in the module graph.
configureTransport({
  enterUnauthed,
  assertOwnReplica,
  notePeersMayNeedUpdate,
});

// The cycle's multi-tab broadcasts (the channel and its pending-"updated" flag live in
// sync/multitab.ts).
configureCycle({
  notePeersMayNeedUpdate,
  broadcastUpdatedIfPending,
  postPokeToPeers: () => postMsg("poke"),
});

installTriggers();

/* ── Debug (dev only — also used by e2e verification) ───────────── */

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__sync = {
    status: getSyncStatus,
    outboxSize: () => outbox.size(),
    outbox: () => outbox.snapshot(),
    deadLetters: () => outbox.getDeadLetters(),
    flushed: () => outbox.flushed(),
    syncNow: () => syncNow("debug"),
    getLastReason: () => getLastSyncReason(),
    durableBroken: () => persist.isDurableBroken(),
    resyncPending: () => isResyncPending(),
    replacePending: () => isReplacePending(),
    isLeader: () => isLeaderTab(),
    tierMeta: () => e2ee.getTierMeta(),
    dekLoaded: () => e2ee.getDek() !== null,
  };
}
