/**
 * Sync STATUS — the single owner of SyncState, lastSyncAt, the sticky ownerUnproven fact,
 * the listener set and the stable status snapshot (workflow §3c-3). Consumed by the UI via
 * getSyncStatus/subscribeSyncStatus (useSyncExternalStore); mutated by the engine through
 * setState / setOwnerUnproven / setLastSyncAt / bumpStatus only.
 */
import * as outbox from "../outbox";
import type { SyncState, SyncStatus } from "./contracts";

let syncState: SyncState = "synced";
let lastSyncAt: string | null = null;

/**
 * "This replica's owner has not been proved" — a FACT that holds until the proof succeeds, unlike
 * SyncState, which is a momentary thing. Every cycle passes through "syncing" on its way BACK to
 * "unverified" (doCycle sets "syncing" before ensureIdentity), so a UI keyed on the state alone
 * flickers on every trigger — the 60 s interval, focus, a local edit's poke and, worst, the
 * human's own "Check again": the very panel that explains the state (and hosts an open discard
 * confirmation) would unmount mid-interaction and be replaced, for the duration of the network
 * proof, by "Sync now" / "N changes waiting to be sent" — the reassuring lie this state exists to
 * remove. So the badge, the Settings dot and the Sync section read THIS instead.
 *
 * Set by enterUnverified, cleared the moment ensureIdentity proves (or adopts) the replica — and
 * on the verdicts that supersede it: no session (Login) or a foreign stamp
 * (ForeignReplicaScreen).
 */
let ownerUnproven = false;

const statusListeners = new Set<() => void>();
let statusSnapshot: SyncStatus = {
  state: syncState,
  pending: 0,
  deadLetters: 0,
  lastSyncAt: null,
  ownerUnproven: false,
};

export function bumpStatus(): void {
  statusSnapshot = {
    state: syncState,
    pending: outbox.size(),
    deadLetters: outbox.getDeadLetters().length,
    lastSyncAt,
    ownerUnproven,
  };
  for (const fn of statusListeners) fn();
}

export function setState(s: SyncState): void {
  if (syncState === s) {
    bumpStatus(); // counters may have changed
    return;
  }
  syncState = s;
  bumpStatus();
}

/** The sticky "owner unproven" fact (see above) — notifies the UI when it actually changes. */
export function setOwnerUnproven(v: boolean): void {
  if (ownerUnproven === v) return;
  ownerUnproven = v;
  bumpStatus();
}

/** "Last successful sync" stamp (written by finishSuccess, hydrated by boot). */
export function setLastSyncAt(v: string | null): void {
  lastSyncAt = v;
}

export function getLastSyncAt(): string | null {
  return lastSyncAt;
}

/** Status snapshot (stable reference between changes — useSyncExternalStore). */
export function getSyncStatus(): SyncStatus {
  return statusSnapshot;
}

export function subscribeSyncStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

let outboxListenerInstalled = false;

/**
 * Every outbox queue change (add/ack/dead-letter) refreshes the status. EXPLICIT and
 * idempotent installation — the facade calls this at composition time; it is deliberately
 * not an import side effect of this module.
 */
export function installOutboxStatusListener(): void {
  if (outboxListenerInstalled) return;
  outboxListenerInstalled = true;
  outbox.setOnChange(bumpStatus);
}
