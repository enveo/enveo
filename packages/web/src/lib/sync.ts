/**
 * Sync engine — the heart of local-first:
 *
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
 */
import { DEFAULT_KDF_PARAMS, dekWrapAadContext, deriveKek, freshKdfParams, generateDek, generateSalt, wrapDek } from "./crypto";
import * as e2ee from "./e2ee";
import { idbGet, storageMode } from "./idb";



import * as outbox from "./outbox";
import * as persist from "./persist";
import { store } from "./store";
import { INTERVAL_MS, type LocalMode, type PendingE2eeUpgrade, TierMismatchError } from "./sync/contracts";
import { awaitInFlightCycle, configureCycle, getLastSyncReason, resetBackoff, syncNow } from "./sync/cycle";
import { assertOwnReplica, enterUnauthed } from "./sync/identity";
import { applyLocalMode, configureLocalMode, disableLocal, enablePaused, enableWiped, getLocalMode } from "./sync/localMode";
import {
  broadcastKeysChanged,
  broadcastLocalMode,
  broadcastUpdatedIfPending,
  installMultiTab,
  isLeaderTab,
  notePeersMayNeedUpdate,
  postMsg,
  wipeLocalData,
} from "./sync/multitab";
import { clearReplacePending, isReplacePending, isResyncPending } from "./sync/obligations";
import { e2eeReplicaBudgetId, isEmptyUnboundReplica } from "./sync/replica";
import { getSyncStatus, installOutboxStatusListener, setOwnerUnproven, setState } from "./sync/status";
import { configureTransport, pushLocalToServer, throwIfBudgetMismatch, throwIfTierMismatch, unauthorized, wipeServer } from "./sync/transport";

 
export { bootOnce, getLastBootSource, retryBoot } from "./sync/boot";
export type { BootSource, IdentityVerdict, LocalMode, PendingE2eeUpgrade, SyncState, SyncStatus } from "./sync/contracts";
export { E2eeUpgradeRequiredError, EMPTY_LEDGER, TierMismatchError } from "./sync/contracts";
export { __resetBackoff, flushOutboxForSignOut, fullResync, poke, pullNow, recheckReplicaOwner, syncNow } from "./sync/cycle";
export { __resetIdentity, assertOwnReplica, decideIdentity, enterLoginKeepingReplica } from "./sync/identity";
export { disableLocal, enablePaused, enableWiped, getLocalMode, isLocalOnly } from "./sync/localMode";
export { broadcastKeysChanged, wipeLocalData } from "./sync/multitab";
export { __resetObligations, markReplacePending } from "./sync/obligations";
export { getSyncStatus, subscribeSyncStatus } from "./sync/status";
export { fetchSnapshot, getClientId, pushLocalToServer, resetServerE2ee } from "./sync/transport";

// every outbox queue change (add/ack/dead-letter) refreshes the status —
// explicit, idempotent installation (sync/status.ts), done at composition time
installOutboxStatusListener();

 
export function __setLocalMode(mode: LocalMode): void {
  applyLocalMode(mode);
}

/**
 * The human chose "remove this data and continue" — on ForeignReplicaScreen (the replica is
 * stamped by another account) or in the unverified-replica notice (its owner cannot be proved).
 * This is the ONLY path that destroys such a replica, and it destroys it whole (mirror + outbox +
 * DEK + owner stamp), then reloads so the boot bootstraps the signed-in account's data.
 *
 * The local-mode flag goes with it: it belonged to the PREVIOUS owner (and after the discard there
 * is nothing left to keep offline). Leaving it at "wiped" would boot the signed-in user into a
 * network-free app on an EMPTY, unbound replica — and their first "Disable local mode" would
 * upload exactly that empty replica over their server budget.
 */
export async function discardLocalReplica(): Promise<void> {
  outbox.clearAll();  
  if (getLocalMode() !== "off") applyLocalMode("off");  
  await persist.flushed();  
  await wipeLocalData();  
}



















 
async function loadPendingE2eeUpgrade(): Promise<PendingE2eeUpgrade | null> {
  const raw = await idbGet<(Omit<PendingE2eeUpgrade, "dek"> & { dek: Uint8Array | ArrayBuffer }) | null>("meta", "e2eePendingUpgrade").catch(() => null);
  if (!raw?.budgetId || !raw.wrappedDek || !raw.snapshotBlob) return null;
   
  const dek = raw.dek instanceof Uint8Array ? raw.dek : raw.dek instanceof ArrayBuffer ? new Uint8Array(raw.dek) : null;
  if (!dek) return null;
  return { ...raw, dek };
}

 
export async function hasPendingE2eeUpgrade(): Promise<boolean> {
  return (await loadPendingE2eeUpgrade()) !== null;
}

/**
 * DELIBERATE abandonment of an interrupted ceremony (its own button + copy in the panel —
 * never automatic on error). If the server had in fact committed the interrupted attempt, the
 * next fresh attempt gets a stale-epoch 409, this device re-bootstraps into Unlock, and the
 * password typed in the INTERRUPTED attempt opens the budget — the panel's copy says so.
 */
export async function discardPendingE2eeUpgrade(): Promise<void> {
  await persist.putMeta("e2eePendingUpgrade", null);
  await persist.flushed();
}



















export async function upgradeServerE2eeV2(password: string | null): Promise<void> {
  const userId = await assertOwnReplica();  
  const budgetId = e2eeReplicaBudgetId();
  if (!budgetId) throw new Error("foreign_replica");
  let pending = await loadPendingE2eeUpgrade();
  if (pending && pending.budgetId !== budgetId) {
    // a record for a different replica (account switch since) — never send it for this budget
    await discardPendingE2eeUpgrade();
    pending = null;
  }
  if (!pending) {
    if (password === null) throw new Error("no_encryption_key");  
    const ledger = store.getLedger();
    if (!ledger) throw new Error("no_local_replica");  
    const expectedEpoch = e2ee.getTierMeta().epoch;
    const nextEpoch = expectedEpoch + 1;
    const salt = generateSalt();
    const dek = generateDek();
    const kek = await deriveKek(password, salt, DEFAULT_KDF_PARAMS);
    pending = {
      budgetId,
      expectedEpoch,
      nextEpoch,
      dek,
      wrappedDek: await wrapDek(dek, kek, dekWrapAadContext(budgetId, nextEpoch)),
      kdfParams: freshKdfParams(salt),
      snapshotBlob: await e2ee.encryptSnapshot(ledger, dek, { budgetId, epoch: nextEpoch, uptoSeq: 0 }),
      opIds: outbox.snapshot().map((en) => en.op.opId),  
    };
    // DURABLE before the first POST — a lost response must find the same materials on retry.
    await persist.putMeta("e2eePendingUpgrade", pending);
    await persist.flushed();
  }
  const res = await fetch("/api/budget/e2ee/upgrade-v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // budgetId AND userId = the per-request tenant assertions (both REQUIRED on this route);
    // expectedEpoch makes concurrent/repeated attempts explicit: one winner or an idempotent
    // already-upgraded answer, never two epoch increments.
    body: JSON.stringify({
      budgetId: pending.budgetId,
      userId,
      expectedEpoch: pending.expectedEpoch,
      cipherVersion: 2,
      wrappedDek: pending.wrappedDek,
      kdfParams: pending.kdfParams,
      snapshotBlob: pending.snapshotBlob,
    }),
  });
  if (res.status === 401) throw unauthorized();
  try {
    await throwIfTierMismatch(res); // stale epoch: upgraded/flipped ELSEWHERE — tierMeta fresh
    await throwIfBudgetMismatch(res);  
  } catch (err) {
    // A stale-epoch refusal is authoritative: this exact body can never commit (our own
    // committed attempt would have answered 200 via the envelope comparison). Keeping the
    // record would 409 on every retry forever — drop it; budget_mismatch keeps it (the right
    // session may retry the very same intent).
    if (err instanceof TierMismatchError) await discardPendingE2eeUpgrade();
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`);  
  }
  const body = (await res.json()) as { epoch: number };
   
  e2ee.setDek(pending.dek, body.epoch); // validated for the new epoch by construction
  e2ee.setTierMeta({ tier: "e2ee", epoch: body.epoch });
  e2ee.setCipherVersion(2);
  e2ee.resetOpsCounter(); // the checkpoint at uptoSeq 0 IS the captured replica — counter restarts
  // Ack EXACTLY the ops the snapshot contains — an edit made in another tab DURING the
  // ceremony stays queued and pushes under the new epoch right after this. The live mirror is
  // NOT replaced (it already equals captured + later edits; resetServerE2ee deliberately never
  // replaces either), and the cursor needs no reset: e2ee_ops.seq is a global bigserial, so
  // post-upgrade rows sort after any old cursor and the first pull converges it.
  outbox.removeAcked(pending.opIds);
  void persist.persistLedger(store.snapshotForPersist());
  clearReplacePending();  
  await persist.putMeta("e2eePendingUpgrade", null);  
  await broadcastKeysChanged();  
  void syncNow("e2ee-upgrade-v2");
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
    else if (outbox.size() > 0) postMsg("poke");  
  });
  // Closing / bfcaching a tab with unsent ops: poke (BroadcastChannel
  // "poke") a possibly-live leader so it absorbs+pushes right away. Correctness
  // does NOT depend on this — the real safeguard is reconcileFromIdb at the start of
  // a cycle (plus leadership takeover when the Web Lock is released) — this cuts latency.
  window.addEventListener("pagehide", () => {
    if (outbox.size() > 0) postMsg("poke");
  });
  



  window.addEventListener("beforeunload", (e) => {
    if (storageMode() === "memory-forced" && outbox.size() > 0) {
      e.preventDefault();
      e.returnValue = ""; // legacy engines only show the dialog when returnValue is set
    }
  });
  setInterval(() => {
    

    if (isLeaderTab() && document.visibilityState === "visible") void syncNow("interval");
  }, INTERVAL_MS);
}



configureTransport({
  enterUnauthed,
  assertOwnReplica,
  notePeersMayNeedUpdate,
});



configureCycle({
  notePeersMayNeedUpdate,
  broadcastUpdatedIfPending,
  postPokeToPeers: () => postMsg("poke"),
});



configureLocalMode({
  setState,
  setOwnerUnproven,
  broadcastLocalMode,
  wipeServer,
  pushLocalToServer,
  awaitInFlightCycle,
  syncNow,
  isEmptyUnboundReplica,
});

installTriggers();

 

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
    localMode: () => getLocalMode(),
    tierMeta: () => e2ee.getTierMeta(),
    dekLoaded: () => e2ee.getDek() !== null,
    enablePaused: () => enablePaused(),
    enableWiped: () => enableWiped(),
    disableLocal: () => disableLocal(),
  };
}
