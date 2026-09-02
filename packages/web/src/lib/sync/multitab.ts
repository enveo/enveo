/* ── Multi-tab (Web Locks leader + BroadcastChannel) — workflow §3c-3 ─────
 *
 * CHOSEN MODEL (simple and RESILIENT — correctness before optimization):
 *
 * EACH tab pushes on its own triggers (enqueue / focus / online / visible
 * / boot / leader interval), and EVERY cycle FIRST absorbs "orphans" from IDB —
 * ops enqueued by ANOTHER tab (outbox.reconcileFromIdb in doCycle).
 * Outbox memory is PER TAB and is read from IDB only at boot, so without
 * this an op enqueued in tab B, which closed before its own push,
 * would be stuck in IDB until a full reload (no live tab would re-read the outbox).
 * Reconcile closes that: the SHARED durable outbox is the source of truth, and any live
 * tab drains it. Server idempotency (the sync_ops guard) dedupes possible
 * double sends (two tabs absorbing the same orphan).
 *
 * The leader (Web Locks, exclusive lock held "forever") gates ONLY the
 * 60 s interval — one tab polls the server in the background instead of N. Closing
 * the leader tab releases the lock → another tab takes it over, immediately runs a cycle
 * (absorbs orphans left by the previous leader) and resumes the interval. No Web Locks
 * ⇒ isLeader=true in every tab (behavior as before — harmless thanks to
 * idempotency + reconcile).
 *
 * BroadcastChannel("enveo-sync"):
 *  - "updated" (after a cycle that changed data): other tabs rehydrate the mirror
 *    from IDB + replay their own outbox (applyPeerUpdate) — they reflect this tab's
 *    sync WITHOUT their own network request,
 *  - "poke" (after a local enqueue): the leader syncs right away (doesn't wait for
 *    the interval). Both sides feature-detect; no channel ⇒ tabs converge
 *    via their own pulls (focus/interval).
 *  - attempt-scoped sign-out start/ack/cancel messages: peers verify a bounded shared
 *    coordination marker, quiesce cycles, drain pre-barrier persistence and acknowledge.
 *    The marker contains only opaque protocol ids/timestamps; account data stays out of it.
 *    Only terminal "wipe" reloads tabs after the initiator has durably cleared account data.
 * Loop protection: applyPeerUpdate itself does not broadcast. Re-establishing the E2EE
 * provider invariant may enqueue and persist one terminal preference op; that mutation is
 * idempotent and follows the normal sync path.
 *
 * This module owns the channel, the leader flag and the pending-"updated" flag; the cycle
 * reaches it only through the deps the facade injects (configureCycle), so the static module
 * graph stays acyclic (multitab → cycle/boot, never the reverse).
 */

import { accountPreferences, configureAccountPreferencesBroadcast } from "../accountPreferences";
import { devicePreferences } from "../devicePreferences";
import * as e2ee from "../e2ee";
import { ensureE2eeProviderPreference } from "../e2eeProviderInvariant";
import { clearLocalData } from "../idb";
import * as persist from "../persist";
import {
  __resetSignOutBarrierForTests,
  activateSignOutAttempt,
  configureSignOutSharedBlocker,
  createSignOutPermit,
  isSignOutBlocking,
  markLocalCleared,
  markServerFailed,
  releaseSignOutAttempt,
  type SignOutPermit,
} from "../signOutBarrier";
import {
  browserSignOutStorage,
  createRegistryWriteGate,
  createSignOutCoordinator,
  createSignOutRegistry,
  SIGN_OUT_COORDINATION_ERROR,
  type SignOutCoordinationLease,
  type SignOutCoordinationMessage,
  type SignOutCoordinator,
  type SignOutRegistry,
} from "../signOutCoordination";
import { store } from "../store";
import { retryBoot } from "./boot";
import { flushOutboxForSignOut as flushCoordinatedOutbox, quiesceSyncForSignOut, syncNow } from "./cycle";
import { replayOutbox } from "./replica";
import { bumpStatus } from "./status";

let isLeader = false;
let channel: BroadcastChannel | null = null;
let broadcastPending = false; // this cycle changed data → broadcast "updated" at the end
let applyingPeerUpdate = false;
let signOutRegistry: SignOutRegistry | null = null;
let signOutCoordinator: SignOutCoordinator<SignOutPermit> | null = null;
let signOutMaintenanceTimer: ReturnType<typeof setInterval> | undefined;

export type CoordinatedSignOutLease = SignOutCoordinationLease<SignOutPermit>;

/** Is THIS tab the background-polling leader? (No Web Locks ⇒ every tab answers true.) */
export function isLeaderTab(): boolean {
  return isLeader;
}

/** Mark that the current cycle changed data — finishSuccess broadcasts "updated". */
export function notePeersMayNeedUpdate(): void {
  broadcastPending = true;
}

/** finishSuccess: if this cycle changed data, post "updated" so peer tabs rehydrate (consume). */
export function broadcastUpdatedIfPending(): void {
  if (isSignOutBlocking()) return;
  if (broadcastPending) {
    broadcastPending = false;
    postMsg("updated"); // this cycle changed data → other tabs rehydrate from IDB
  }
}

/**
 * The KEY GENERATION on this device changed (upgrade / enable / disable / unlock / password
 * change): flush the persist chain first — the peers re-READ from IDB — then tell every other
 * live tab to drop its in-memory key state and rehydrate ("keys"). The plain "updated"
 * broadcast is NOT enough: it re-reads only the ledger, while the e2ee module's hydrate is
 * memoized and its dekTouched latch blocks a re-read — a second tab would keep the dead DEK
 * and the old epoch in memory and push poison under the new generation.
 */
export async function broadcastKeysChanged(): Promise<void> {
  if (isSignOutBlocking()) return;
  await persist.flushed();
  if (isSignOutBlocking()) return;
  postMsg("keys");
}

export type MultiTabMessageType = "updated" | "poke" | "wipe" | "keys" | "preferences";

export function postMsg(type: MultiTabMessageType): void {
  try {
    channel?.postMessage({ type });
  } catch {
    /* best-effort — channel closed during unload */
  }
}

/**
 * "Clear local data" (Settings) — multi-tab safe. First CLEARS the IDB stores
 * (doesn't delete the database → doesn't block on another tab's connection), THEN broadcasts
 * "wipe" so the remaining tabs reload too (they boot from empty stores =
 * fresh snapshot), and finally reloads ITSELF. The order (clear → broadcast →
 * reload) guarantees tabs receiving "wipe" boot from ALREADY EMPTY stores.
 */
export async function wipeLocalData(): Promise<void> {
  await Promise.all([accountPreferences.clear(), devicePreferences.clear()]);
  await clearLocalData();
  postMsg("wipe");
  if (typeof location !== "undefined") location.reload();
}

/**
 * Receiving "updated" from another tab: apply its sync without our own network. Rehydrate
 * the ledger blob from IDB, THEN replay our own outbox (idempotent — doesn't lose
 * THIS tab's optimistic ops). Does not broadcast. The E2EE provider invariant may use the
 * normal local mutation path to enqueue and persist one idempotent terminal preference op.
 */
async function applyPeerUpdate(): Promise<void> {
  if (isSignOutBlocking()) return;
  if (applyingPeerUpdate) return; // coalescing — rehydrate reads the freshest blob anyway
  if (store.getBootStatus() !== "ready") return; // before boot our own hydrate handles it
  applyingPeerUpdate = true;
  try {
    await store.rehydrateFromIdb();
    if (isSignOutBlocking()) return;
    replayOutbox();
    ensureE2eeProviderPreference();
    bumpStatus();
  } finally {
    applyingPeerUpdate = false;
  }
}

/** Test hook (unit tests only): close the channel and reset state so the bun process can exit. */
export function __resetMultiTabForTests(): void {
  channel?.close();
  channel = null;
  isLeader = false;
  broadcastPending = false;
  applyingPeerUpdate = false;
  clearInterval(signOutMaintenanceTimer);
  signOutMaintenanceTimer = undefined;
  try {
    signOutRegistry?.removePresence();
  } catch {
    // test teardown must remain best-effort
  }
  signOutRegistry = null;
  signOutCoordinator = null;
  configureSignOutSharedBlocker(null);
  persist.configurePersistWriteGate(null);
  __resetSignOutBarrierForTests();
}

function postCoordinationMessage(message: SignOutCoordinationMessage): void {
  try {
    channel?.postMessage(message);
  } catch {
    // A closed channel makes the initiator time out and fail closed.
  }
}

function installSignOutCoordinator(): void {
  const storage = browserSignOutStorage();
  if (!storage) return;
  try {
    signOutRegistry = createSignOutRegistry({ storage });
    configureSignOutSharedBlocker(
      () => signOutRegistry !== null && (!signOutRegistry.isPageGenerationCurrent() || signOutRegistry.activeAttempts().length > 0),
    );
    const gate = createRegistryWriteGate(signOutRegistry);
    persist.configurePersistWriteGate(gate);
    signOutCoordinator = createSignOutCoordinator({
      registry: signOutRegistry,
      gate,
      barrier: {
        activate: activateSignOutAttempt,
        release: releaseSignOutAttempt,
        createPermit: createSignOutPermit,
        markLocalCleared,
        markServerFailed,
      },
      send: postCoordinationMessage,
      quiesceCycle: quiesceSyncForSignOut,
      drainPersistence: async () => {
        await Promise.all([persist.flushed(), accountPreferences.flushed(), devicePreferences.flushed()]);
      },
    });
    signOutCoordinator.install();
    signOutMaintenanceTimer = setInterval(() => {
      try {
        signOutCoordinator?.maintain();
      } catch {
        // Loss of shared coordination never releases an existing local barrier.
      }
    }, 10_000);
  } catch {
    signOutRegistry = null;
    signOutCoordinator = null;
    configureSignOutSharedBlocker(null);
    persist.configurePersistWriteGate(null);
  }
}

function requireSignOutCoordinator(): SignOutCoordinator<SignOutPermit> {
  if (!signOutCoordinator) throw new Error(SIGN_OUT_COORDINATION_ERROR);
  return signOutCoordinator;
}

/** Task 5 may continue only after this promise returns a live, opaque lease. */
export function beginSignOutCoordination(): Promise<CoordinatedSignOutLease> {
  return requireSignOutCoordinator().begin();
}

export function cancelSignOutCoordination(lease: CoordinatedSignOutLease): void {
  requireSignOutCoordinator().cancel(lease);
}

export function markSignOutStorageCleared(lease: CoordinatedSignOutLease): void {
  requireSignOutCoordinator().markStorageCleared(lease);
}

export function markCoordinatedServerFailed(lease: CoordinatedSignOutLease): void {
  requireSignOutCoordinator().markServerFailed(lease);
}

export function finishSignOutCoordination(lease: CoordinatedSignOutLease): void {
  requireSignOutCoordinator().finish(lease);
}

export function flushOutboxForSignOut(lease: CoordinatedSignOutLease): Promise<number> {
  return flushCoordinatedOutbox(lease);
}

interface LockManagerLike {
  request(name: string, options: { mode: "exclusive" | "shared" }, cb: () => Promise<void>): Promise<void>;
}

export function installMultiTab(): void {
  configureAccountPreferencesBroadcast(() => postMsg("preferences"));
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("enveo-sync");
    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string } | null;
      if (!msg) return;
      if (msg.type === "sign-out-start" || msg.type === "sign-out-ack" || msg.type === "sign-out-cancel") {
        signOutCoordinator?.handleMessage(e.data);
        return;
      }
      if (msg.type === "wipe" && typeof location !== "undefined") {
        location.reload();
        return;
      }
      if (isSignOutBlocking()) return;
      if (msg.type === "updated") {
        void applyPeerUpdate().catch((error) => console.warn("peer update failed", error));
      } else if (msg.type === "preferences") {
        void accountPreferences.rehydrateCurrent().catch((error) => console.warn("peer preference rehydrate failed", error));
      } else if (msg.type === "keys") {
        void e2ee
          .rehydrateKeysFromPeer()
          .then(() => {
            if (!isSignOutBlocking() && (store.getBootStatus() === "locked" || store.getBootStatus() === "ready")) void retryBoot();
          })
          .catch((error) => console.warn("peer key rehydrate failed", error));
      } else if (msg.type === "poke" && isLeader) void syncNow("peer-poke");
    };
  }

  // Shared markers are scanned synchronously before leader election can launch a cycle.
  installSignOutCoordinator();
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (locks && typeof locks.request === "function") {
    locks
      .request("enveo-sync-leader", { mode: "exclusive" }, () => {
        isLeader = true;
        // a freshly elected leader (the previous one closed its tab) inherits the background:
        // run a cycle right away — it absorbs from IDB any "orphans" left by the previous leader
        // (an op enqueued just before it closed), without waiting for the interval
        void syncNow("leader");
        return new Promise<void>(() => {}); // hold the lock until the tab closes
      })
      .catch(() => {
        isLeader = true; // lock failure → act as leader (safer to poll)
      });
  } else {
    isLeader = true; // no Web Locks → every tab is a leader
  }
}
