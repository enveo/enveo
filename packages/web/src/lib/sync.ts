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
import { clearLocalData, idbGet, storageMode } from "./idb";
// NOTE: no static `import { local } from "./mutate"` here — mutate.ts imports `poke` from this
// facade, so a static edge in the other direction would be a cycle. The one place the engine
// needs `local` (sweepLegacyPlanned in sync/boot.ts) does a lazy `await import("../mutate")`.
import * as outbox from "./outbox";
import * as persist from "./persist";
import { store } from "./store";
import { retryBoot } from "./sync/boot";
import { INTERVAL_MS, type LocalMode, type PendingE2eeUpgrade, TierMismatchError } from "./sync/contracts";
import { awaitInFlightCycle, configureCycle, getLastSyncReason, resetBackoff, syncNow } from "./sync/cycle";
import { assertOwnReplica, enterUnauthed } from "./sync/identity";
import { applyLocalMode, configureLocalMode, disableLocal, enablePaused, enableWiped, getLocalMode, setLocalModeValue } from "./sync/localMode";
import { clearReplacePending, isReplacePending, isResyncPending } from "./sync/obligations";
import { e2eeReplicaBudgetId, isEmptyUnboundReplica, replayOutbox } from "./sync/replica";
import { bumpStatus, getSyncStatus, installOutboxStatusListener, setOwnerUnproven, setState } from "./sync/status";
import { configureTransport, pushLocalToServer, throwIfBudgetMismatch, throwIfTierMismatch, unauthorized, wipeServer } from "./sync/transport";

/* ── Re-exported public surface (types, errors, constants — see sync/contracts.ts) ── */
export { bootOnce, getLastBootSource, retryBoot } from "./sync/boot";
export type { BootSource, IdentityVerdict, LocalMode, PendingE2eeUpgrade, SyncState, SyncStatus } from "./sync/contracts";
export { E2eeUpgradeRequiredError, EMPTY_LEDGER, TierMismatchError } from "./sync/contracts";
export { __resetBackoff, flushOutboxForSignOut, fullResync, poke, pullNow, recheckReplicaOwner, syncNow } from "./sync/cycle";
export { __resetIdentity, assertOwnReplica, decideIdentity, enterLoginKeepingReplica } from "./sync/identity";
export { disableLocal, enablePaused, enableWiped, getLocalMode, isLocalOnly } from "./sync/localMode";
export { __resetObligations, markReplacePending } from "./sync/obligations";
export { getSyncStatus, subscribeSyncStatus } from "./sync/status";
export { fetchSnapshot, getClientId, pushLocalToServer, resetServerE2ee } from "./sync/transport";

// every outbox queue change (add/ack/dead-letter) refreshes the status —
// explicit, idempotent installation (sync/status.ts), done at composition time
installOutboxStatusListener();

/** Test hook (unit tests only): set the local-mode flag without touching the server. */
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
  outbox.clearAll(); // in-memory queue too: nothing of the previous owner's may go out
  if (getLocalMode() !== "off") applyLocalMode("off"); // the mode was the previous owner's choice
  await persist.flushed(); // let queued writes land BEFORE the stores are cleared
  await wipeLocalData(); // clears IDB (mirror, outbox, DEK), tells other tabs, reloads
}

/**
 * The MANDATORY v1→v2 upgrade ceremony (client side) — the only boundary a legacy pre-AAD
 * E2EE budget may cross. This is a REAL data-key rotation, not the same-DEK password rewrap
 * of /sync2/rekey: a fresh DEK + salt + KEK are generated, the epoch increments, the complete
 * LOCAL ledger (outbox effects included — they are already applied to the mirror) becomes the
 * new v2 checkpoint at uptoSeq 0, and the server atomically swaps envelope + journal +
 * checkpoint. Old pairing codes and the old DEK die with the rotation; other devices hit an
 * epoch mismatch and unlock with the new password or a freshly minted pairing code.
 *
 * Preconditions enforced here: proven replica ownership (assertOwnReplica — an unstamped or
 * foreign replica must not perform this full-budget overwrite) and a replica that names its
 * budget. The UI enforces the fresh-backup acknowledgement before calling. The old server key
 * envelope is deliberately NOT used or required.
 *
 * NOTHING local changes until the server confirms: a failed or interrupted request leaves
 * both sides on the old generation and retrying is safe (the server is idempotent for a
 * repeated identical attempt and refuses a stale epoch).
 */
/** The durable CEREMONY-INTENT record — type + rationale in sync/contracts.ts (PendingE2eeUpgrade). */
async function loadPendingE2eeUpgrade(): Promise<PendingE2eeUpgrade | null> {
  const raw = await idbGet<(Omit<PendingE2eeUpgrade, "dek"> & { dek: Uint8Array | ArrayBuffer }) | null>("meta", "e2eePendingUpgrade").catch(() => null);
  if (!raw?.budgetId || !raw.wrappedDek || !raw.snapshotBlob) return null;
  // structured clone preserves Uint8Array; defensively accept ArrayBuffer too (see e2ee.hydrate)
  const dek = raw.dek instanceof Uint8Array ? raw.dek : raw.dek instanceof ArrayBuffer ? new Uint8Array(raw.dek) : null;
  if (!dek) return null;
  return { ...raw, dek };
}

/** Does an interrupted upgrade ceremony await completion? (The panel offers Resume/Discard.) */
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

/**
 * The MANDATORY v1→v2 upgrade ceremony (client side) — the only boundary a legacy pre-AAD
 * E2EE budget may cross. This is a REAL data-key rotation, not the same-DEK password rewrap
 * of /sync2/rekey: a fresh DEK + salt + KEK are generated, the epoch increments, the complete
 * LOCAL ledger (with every already-applied outbox effect) becomes the new v2 checkpoint at
 * uptoSeq 0, and the server atomically swaps envelope + journal + checkpoint. Old pairing
 * codes and the old DEK die with the rotation; other devices hit an epoch mismatch, their
 * held DEK fails validation against the new generation, and they land on Unlock.
 *
 * `password` starts a NEW ceremony intent; `null` RESUMES a pending one (materials come from
 * the persisted record — the interrupted attempt's password stays the operative one, and the
 * record's expectedEpoch is immune to 409-driven tierMeta adoption in between).
 *
 * NOTHING local changes until the server confirms; a stale-epoch 409 means another device
 * changed the generation — that intent can never commit (our own committed-but-unconfirmed
 * attempt answers 200 via the server's envelope comparison instead), so the record is dropped
 * and the caller re-syncs.
 */
export async function upgradeServerE2eeV2(password: string | null): Promise<void> {
  const userId = await assertOwnReplica(); // foreign/unverified — no write
  const budgetId = e2eeReplicaBudgetId();
  if (!budgetId) throw new Error("foreign_replica");
  let pending = await loadPendingE2eeUpgrade();
  if (pending && pending.budgetId !== budgetId) {
    // a record for a different replica (account switch since) — never send it for this budget
    await discardPendingE2eeUpgrade();
    pending = null;
  }
  if (!pending) {
    if (password === null) throw new Error("no_encryption_key"); // resume with nothing to resume
    const ledger = store.getLedger();
    if (!ledger) throw new Error("no_local_replica"); // error CODES — lib/api.ts owns the wording
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
      opIds: outbox.snapshot().map((en) => en.op.opId), // their effects are inside the snapshot
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
    await throwIfBudgetMismatch(res); // the session was swapped mid-upload → nothing was written
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
    throw new Error(`${res.status} ${txt}`); // UI: apiErrorMessage extracts { error }
  }
  const body = (await res.json()) as { epoch: number };
  // COMMIT — only after server success: install the new generation on this device.
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
  clearReplacePending(); // the upgrade IS a full server replace from local
  await persist.putMeta("e2eePendingUpgrade", null); // the intent is fulfilled
  await broadcastKeysChanged(); // peer tabs drop dead key state; stale devices hit the 409 → Unlock
  void syncNow("e2ee-upgrade-v2");
}

/** Broadcast the local-mode change to other tabs (best-effort). */
function broadcastLocalMode(mode: LocalMode): void {
  try {
    channel?.postMessage({ type: "localmode", mode });
  } catch {
    /* best-effort — channel closed during unload */
  }
}

/* ── Multi-tab (Web Locks leader + BroadcastChannel) ──────────────────── */

/**
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
 * Loop protection: receive handlers do NOT broadcast (applyPeerUpdate
 * posts nothing and persists nothing).
 */
let isLeader = false;
let channel: BroadcastChannel | null = null;
let broadcastPending = false; // this cycle changed data → broadcast "updated" at the end
let applyingPeerUpdate = false;

/** Mark that the current cycle changed data — finishSuccess broadcasts "updated". */
function notePeersMayNeedUpdate(): void {
  broadcastPending = true;
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
  await persist.flushed();
  postMsg("keys");
}

function postMsg(type: "updated" | "poke" | "wipe" | "keys"): void {
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
  await clearLocalData();
  postMsg("wipe");
  if (typeof location !== "undefined") location.reload();
}

/**
 * Receiving "updated" from another tab: apply its sync without our own network. Rehydrate
 * the ledger blob from IDB, THEN replay our own outbox (idempotent — doesn't lose
 * THIS tab's optimistic ops). Does NOT broadcast and does NOT persist (no loop).
 */
async function applyPeerUpdate(): Promise<void> {
  if (applyingPeerUpdate) return; // coalescing — rehydrate reads the freshest blob anyway
  if (store.getBootStatus() !== "ready") return; // before boot our own hydrate handles it
  applyingPeerUpdate = true;
  try {
    await store.rehydrateFromIdb();
    replayOutbox();
    bumpStatus();
  } finally {
    applyingPeerUpdate = false;
  }
}

interface LockManagerLike {
  request(name: string, options: { mode: "exclusive" | "shared" }, cb: () => Promise<void>): Promise<void>;
}

function installMultiTab(): void {
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

  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("enveo-sync");
    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; mode?: LocalMode } | null;
      if (!msg) return;
      if (msg.type === "updated") void applyPeerUpdate();
      else if (msg.type === "keys") {
        // a peer tab rotated/validated/dropped the key state — re-read it, then let the
        // normal machinery converge (a locked tab may now be unlockable and vice versa)
        void e2ee.rehydrateKeysFromPeer().then(() => {
          if (store.getBootStatus() === "locked" || store.getBootStatus() === "ready") void retryBoot();
        });
      } else if (msg.type === "poke" && isLeader) void syncNow("peer-poke");
      // another tab cleared the local data → reload and boot from empty
      // stores (fresh snapshot); we persist NOTHING along the way (no race)
      else if (msg.type === "wipe" && typeof location !== "undefined") location.reload();
      // another tab changed the local mode → update the module flag (localStorage is
      // shared, but the in-memory flag was read once at load time). Crucial:
      // after enabling local mode in one tab, the OTHERS must stop syncing
      // (the gate in syncNow). After disabling — resume the cycle.
      else if (msg.type === "localmode") {
        const m = msg.mode;
        if (m === "off" || m === "paused" || m === "wiped") {
          setLocalModeValue(m);
          if (m === "off")
            void syncNow("peer-localmode-off"); // still unproven? the cycle re-proves
          else {
            setOwnerUnproven(false); // sync is off by choice now — same as applyLocalMode
            setState("local");
          }
        }
      }
    };
  }
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
  // Untrusted device (memory-forced): the replica AND the outbox live only in this tab's
  // memory — closing the tab with unsent ops loses them for good. Best-effort warning
  // (the browser shows its own generic prompt). Trusted devices need none: the outbox is
  // durable and any live tab (or the next boot) drains it.
  window.addEventListener("beforeunload", (e) => {
    if (storageMode() === "memory-forced" && outbox.size() > 0) {
      e.preventDefault();
      e.returnValue = ""; // legacy engines only show the dialog when returnValue is set
    }
  });
  setInterval(() => {
    // only the leader polls in the background (Web Locks) — the other tabs sync on
    // interaction/enqueue; no Web Locks ⇒ isLeader=true (every tab, as before)
    if (isLeader && document.visibilityState === "visible") void syncNow("interval");
  }, INTERVAL_MS);
}

// The transport's higher-layer effects (identity transitions, ownership guard, peer notice)
// are wired in HERE — the facade is the composition root (workflow §3c-3).
configureTransport({
  enterUnauthed,
  assertOwnReplica,
  notePeersMayNeedUpdate,
});

// The cycle's multi-tab broadcasts (the channel and its pending-"updated" flag live here
// until the multitab extraction) — the facade is the composition root (workflow §3c-3).
configureCycle({
  notePeersMayNeedUpdate,
  broadcastUpdatedIfPending: () => {
    if (broadcastPending) {
      broadcastPending = false;
      postMsg("updated"); // this cycle changed data → other tabs rehydrate from IDB
    }
  },
  postPokeToPeers: () => postMsg("poke"),
});

// Local-mode transitions live in sync/localMode.ts; their status/broadcast/server-write
// effects are wired in HERE — the facade is the composition root (workflow §3c-3).
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
    isLeader: () => isLeader,
    localMode: () => getLocalMode(),
    tierMeta: () => e2ee.getTierMeta(),
    dekLoaded: () => e2ee.getDek() !== null,
    enablePaused: () => enablePaused(),
    enableWiped: () => enableWiped(),
    disableLocal: () => disableLocal(),
  };
}
