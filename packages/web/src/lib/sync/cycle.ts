/**
 * The push→pull CYCLE (workflow §3c-3) — single owner of the flight/backoff/dirty state:
 * syncNow's single-flight mutex with dirty coalescing, the exponential backoff, the poke
 * debounce, doCycle's push batching + ack/dead-letter handling, and the tier/budget-mismatch
 * recovery paths. Wire calls live in transport.ts; the identity guard in identity.ts; the
 * durable obligations in obligations.ts. Peer-tab broadcasts are injected (configureCycle) —
 * the channel is owned by the multi-tab layer above.
 */

import { accountPreferences } from "../accountPreferences";
import { devicePreferences } from "../devicePreferences";
import * as e2ee from "../e2ee";
import { migrateLegacySettings } from "../legacySettingsMigrationRuntime";
import * as outbox from "../outbox";
import * as persist from "../persist";
import { isSignOutBlocking } from "../signOutBarrier";
import { store } from "../store";
import {
  BACKOFF_MAX_MS,
  BudgetMismatchError,
  type CycleDeps,
  E2eeUpgradeRequiredError,
  POKE_DEBOUNCE_MS,
  PUSH_BATCH,
  TierMismatchError,
  UnauthorizedError,
} from "./contracts";
import { ensureIdentity, enterUnauthed, invalidateIdentityVerdict, isIdentityBlocked } from "./identity";
import { clearResyncPending, isReplacePending, isResyncPending, markResyncPending } from "./obligations";
import { e2eeReplicaBudgetId, replayOutbox } from "./replica";
import { bumpStatus, setLastSyncAt, setState } from "./status";
import { bootstrapReplica, doPull, doPullE2ee, pushE2eeBatch, pushLocalToServer, pushPlainBatch, resetServerE2ee } from "./transport";

let deps: CycleDeps | null = null;

/** Wire the multi-tab broadcasts in (called ONCE by the facade at composition time). */
export function configureCycle(d: CycleDeps): void {
  deps = d;
}

function requireDeps(): CycleDeps {
  if (!deps) throw new Error("sync_cycle_unconfigured"); // composition bug — never user-reachable
  return deps;
}

/* ── Backoff (network / 5xx / 429) ──────────────────────────────────── */

let backoffMs = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRetry(): void {
  backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  const jitter = backoffMs * (0.7 + Math.random() * 0.6); // ±30%
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void syncNow("retry"), jitter);
}

export function resetBackoff(): void {
  backoffMs = 0;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

/** Test hook (unit tests only): cancel a pending retry so it cannot fire into the next test. */
export function __resetBackoff(): void {
  resetBackoff();
}

/**
 * E2ee tier without a DEK while running (practically only after a flip on another
 * device): freeze the UI on the Unlock screen; cycles bail (guard in doCycle),
 * unlocking (setDek + retryBoot) resumes a normal boot.
 */
function enterLocked(): void {
  store.setBootStatus("locked");
  setState("error"); // sync genuinely doesn't work until unlocked (no retry loop)
}

/**
 * PRIVATE recovery — called EXCLUSIVELY inside a cycle (under the syncNow mutex):
 * fresh snapshot (path per tier) + REPLAY of the remaining outbox ops onto the new
 * mirror (memory — they still await push) + persist. The rejected op is no longer
 * in the outbox, so its phantom disappears (delete wins).
 */
async function doFullResync(): Promise<void> {
  if ((await bootstrapReplica()) === "locked") {
    enterLocked();
    throw new Error("e2ee: no DEK — waiting for unlock"); // cycle aborted; locked-guard blocks the next ones
  }
  replayOutbox();
  requireDeps().ensureE2eeProviderPreference();
  void persist.persistLedger(store.snapshotForPersist()); // mirror after replay
  requireDeps().notePeersMayNeedUpdate(); // fresh snapshot → other tabs rehydrate from IDB
}

/**
 * THE ONLY WAY doFullResync may be reached from a cycle — the guard that makes a resync
 * non-destructive.
 *
 * doFullResync REPLACES the whole local mirror (and its durable copy) with a snapshot of the
 * budget the SESSION owns, then replays this replica's outbox onto it. That is destructive in
 * exactly the way the multi-tenant guard exists to prevent, and every trigger for it is a
 * SERVER answer that says "this is not the budget you think you are talking to":
 *  - a pull whose budgetId differs (doPull),
 *  - a push response naming another budget (an unbound replica names none, so the server cannot
 *    refuse it per-request),
 *  - a 409 budget_mismatch (handleBudgetMismatch),
 *  - a rejected op / a peer's dead-letter / a JSON import (the obligation set elsewhere, executed
 *    on a mirror that the pull above may have just found foreign).
 * Each of those is EITHER the same user's rotated budget (reseed, DB restore, reattach — a new
 * data epoch, which is what a resync is for) OR the shared cookie having been swapped to another
 * ACCOUNT mid-cycle (the push loop is skipped entirely when the outbox is empty, so its
 * per-request assertion never fires and the pull is the first thing that notices). The two look
 * identical from here; only RE-VERIFYING the session tells them apart, and the cycle's cached
 * verdict is precisely what the server just called into question.
 *
 * Foreign / unproven ⇒ false: no snapshot is fetched, the mirror and the outbox are left exactly
 * as they are, and the human decides (ForeignReplicaScreen). Nothing is destroyed unattended.
 */
async function resyncVerified(): Promise<boolean> {
  invalidateIdentityVerdict(); // the cached verdict predates the server's answer — prove it again
  if (!(await ensureIdentity())) return false; // foreign (the human decides) / unproven → no write
  markResyncPending(); // durable BEFORE the snapshot: a blip must not lose the obligation
  await doFullResync();
  clearResyncPending();
  return true;
}

/**
 * PUBLIC trigger after a full import (Settings) — through the same mutex as
 * push: set the durable resync obligation and run a cycle (the consumer in doCycle
 * does doFullResync after push+pull). Does NOT touch the snapshot/mirror directly, so
 * it doesn't interleave with an in-flight cycle. Callers use fire-and-forget (void).
 */
export function fullResync(): Promise<void> {
  markResyncPending();
  return syncNow("full-import");
}

/**
 * Pre-sign-out outbox flush for every deployment. Explicit sign-out clears local account data,
 * so queued ops must first get an ordinary cycle through the usual mutex. The remaining count
 * determines whether the human must retry, export a backup, or explicitly discard.
 */
export async function flushOutboxForSignOut(): Promise<number> {
  await syncNow("sign-out");
  return outbox.size();
}

/**
 * "Check again" (Settings → Sync, the unverified-replica notice): forget the cached verdict and
 * run a full cycle, which re-proves ownership from scratch. It is exactly what the next
 * focus/interval trigger would do — the button is there so the human is not left waiting on a
 * timer they cannot see, and so the moment the operator reattaches the budget the device can be
 * told to notice. Nothing here writes: a still-unproven replica lands back in "unverified".
 */
export function recheckReplicaOwner(): Promise<void> {
  invalidateIdentityVerdict();
  return syncNow("recheck-owner");
}

/* ── Push→pull cycle ──────────────────────────────────────────────────── */

/** One full cycle; returns false on error (backoff already scheduled). */
async function doCycle(): Promise<boolean> {
  // E2ee tier without a key → the UI sits on the Unlock screen; no network until unlocked
  // (setDek + retryBoot will lift "locked" and resume a normal boot + cycle).
  if (store.getBootStatus() === "locked") return true;
  // Foreign replica detected in an earlier cycle — no write until it is resolved (selfhost: the human; cloud: the wipe reloads)
  if (isIdentityBlocked()) return true;
  let isE2ee = e2ee.getTierMeta().tier === "e2ee";
  // before bootstrap — nothing to do (a fresh e2ee replica may not know its budgetId yet)
  if (!store.getLedger() || (!isE2ee && !store.getBudgetId())) return true;
  setState("syncing");
  try {
    // MULTI-TENANT GUARD — BEFORE any server write (replace/push): whose replica is this?
    // No session → UnauthorizedError (→ Login); another account (or an owner we cannot
    // establish) → no write at all (null). The verified id travels with every full-budget
    // overwrite this cycle makes (per-REQUEST assertion — the cookie can still be swapped later).
    const userId = await ensureIdentity();
    if (!userId) return true;
    await accountPreferences.hydrateForUser(userId);
    // Preferences are an auxiliary channel: a temporary failure must not stall ledger sync.
    try {
      await accountPreferences.sync(userId);
      await devicePreferences.hydrate();
      await migrateLegacySettings();
    } catch (error) {
      console.warn("account preference sync or legacy migration failed", error);
    }
    // The ownership proof may have learned that the session's budget sits in the OTHER tier
    // (409 → tierMeta refreshed): take the path the server actually serves.
    isE2ee = e2ee.getTierMeta().tier === "e2ee";

    // CONSUMER of the durable REPLACE obligation (JSON backup import) — BEFORE everything:
    // the local mirror is CANONICAL and must REPLACE the server, never a delta pull
    // (which would revert the import to the server state). Path per tier: plain →
    // pushLocalToServer (/sync/replace), e2ee → resetServerE2ee (/sync2/reset —
    // encrypted checkpoint + zeroed journal; /sync/replace would bounce with a
    // 409 flip↔bootstrap loop). Both paths clear the replace flag on
    // success; after a full replacement server==local, so any resync
    // obligation is moot (we clear it). Failure (network/5xx) → the catch below
    // schedules a retry, and the flag stays up → the next cycle retries the replace.
    // HARD PRECONDITION (round 3, R1) — gates the ENTIRE e2ee branch of the cycle, the replace
    // obligation INCLUDED (it runs first and posts /sync2/reset, the single most destructive
    // write there is: it deletes the whole journal and swaps the only checkpoint). A key that
    // is not VALIDATED for the current epoch may be a dead generation's — encrypting the
    // obligation's checkpoint with it would wipe the server copy beyond recovery. Locked, not
    // an error: Unlock re-validates, and the durable obligation is consumed right after.
    if (isE2ee && !e2ee.isDekValidForEpoch(e2ee.getTierMeta().epoch)) {
      enterLocked();
      return true;
    }
    if (isReplacePending()) {
      if (isE2ee) {
        const dek = e2ee.getDek();
        if (!dek) {
          enterLocked(); // without a DEK we can't encrypt the checkpoint — waiting for Unlock (flag stays up)
          return true;
        }
        await resetServerE2ee(dek); // server := ciphertext of the local mirror; clears replacePending
      } else {
        await pushLocalToServer(); // server := local; clears replacePending
      }
      clearResyncPending();
      requireDeps().notePeersMayNeedUpdate(); // imported mirror → other tabs rehydrate from IDB
      finishSuccess();
      return true;
    }

    // ABSORB "orphans" from the SHARED IDB outbox — ops enqueued by ANOTHER
    // tab that closed before its own push (outbox memory is PER
    // TAB; without this such an entry would wait in IDB until a full reload — no live
    // tab re-reads the outbox). Apply them onto the mirror (pending-guard + UI)
    // and persist; the rest of the cycle pushes them (server idempotency dedupes a possible duplicate).
    const { absorbed, peerDeadLettered } = await outbox.reconcileFromIdb();
    // ANOTHER tab rejected (dead-lettered) an op we had in the outbox mirror — its
    // optimistic effect is a phantom (the server has no id, no tombstone will remove it).
    // Durable resync obligation; the consumer after push+pull does doFullResync (delete wins).
    if (peerDeadLettered) markResyncPending();
    if (absorbed.length > 0) {
      for (const op of absorbed) {
        try {
          store.applyLocal(op);
        } catch (e) {
          console.warn("absorbed op does not apply onto the mirror", op, e);
        }
      }
      void persist.persistLedger(store.snapshotForPersist());
      requireDeps().notePeersMayNeedUpdate(); // mirror changed → other tabs rehydrate from IDB
    }
    // Reconciliation may have absorbed a later plain-tier Enveo preference from a peer tab.
    // The terminal rules op must be in this very push batch, after the absorbed ordering.
    requireDeps().ensureE2eeProviderPreference();

    // ── E2EE path: encrypted push/pull on /sync2 (the outbox stays plaintext) ──
    if (isE2ee) {
      const dek = e2ee.getDek();
      // HARD PRECONDITION: no op is ever encrypted or decrypted with a DEK that has not been
      // VALIDATED for the current epoch (an authenticated unwrap or checkpoint decrypt under
      // exactly this epoch's AAD). Adopting a new epoch from a 409 body invalidates the held
      // key until bootstrap/Unlock re-proves it — pushing on adoption alone would write
      // dead-key ciphertext the blind server accepts and every correct device chokes on.
      if (!dek || !e2ee.isDekValidForEpoch(e2ee.getTierMeta().epoch)) {
        enterLocked(); // no key, or a key from another generation — waiting for Unlock
        return true;
      }
      // PUSH v2 — the same batches in localSeq order; encryption happens ONLY here,
      // so ops enqueued while still in the plain tier go out on the correct path.
      // The server dedupes by (budgetId, opId) — no per-op "rejected" in v2:
      // HTTP success = whole batch accepted (applied/duplicate) → remove from the outbox.
      // The op AAD needs the budget id, so a replica that cannot name its budget cannot
      // push AT ALL — fail-closed (v2 has no "legacy replica without a budget" tolerance;
      // such a replica belongs to a v1-format budget and must cross the upgrade ceremony).
      const pushBudgetId = e2eeReplicaBudgetId();
      if (outbox.size() > 0 && !pushBudgetId) {
        throw new Error("e2ee: replica names no budget"); // internal abort — doCycle catch-all, never rendered
      }
      while (outbox.size() > 0) {
        const batch = outbox.takeBatch(PUSH_BATCH);
        try {
          const epoch = e2ee.getTierMeta().epoch;
          const ops = await Promise.all(batch.map((en) => e2ee.encryptOp(en.op, dek, { budgetId: pushBudgetId, epoch })));
          // budgetId = the PER-REQUEST tenant assertion (see the v1 push below) — in v2 it is
          // also the authenticated op context, so it is REQUIRED, never optional
          await pushE2eeBatch(epoch, pushBudgetId, ops);
          outbox.removeAcked(batch.map((en) => en.op.opId));
          requireDeps().notePeersMayNeedUpdate(); // canon after push → rehydrate other tabs
        } finally {
          outbox.clearInFlight();
        }
      }

      // PULL v2 — ciphertext delta (own pending ops skipped + outbox replay)
      await doPullE2ee(dek, userId);
      // A stale peer can also have reached the encrypted journal after our earlier rules op.
      // Normalize after pull; poke coalescing schedules the new terminal op immediately.
      requireDeps().ensureE2eeProviderPreference();

      // CONSUMER of the durable resync obligation — as in v1 (resyncVerified goes by tier, and
      // re-proves the session first: a resync REPLACES the mirror with the session's budget)
      if (isResyncPending() && !(await resyncVerified())) return true;
      finishSuccess();
      return true;
    }

    // PUSH — batches in localSeq order, while the outbox is non-empty.
    // Every request NAMES the budget it is for (PER-REQUEST tenant assertion): the identity
    // guard above runs ONCE per cycle, but a cycle makes N writes, and the session cookie is
    // shared by all tabs — a sign-out+sign-in elsewhere can swap it BETWEEN two batches, and the
    // server resolves the target budget from the cookie alone. Without the assertion the
    // remaining batches would be applied to the NEW user's budget (fresh creates pass every FK
    // guard). The server refuses a mismatch with 409 budget_mismatch and writes nothing.
    while (outbox.size() > 0) {
      const batch = outbox.takeBatch(PUSH_BATCH);
      try {
        const body = await pushPlainBatch(batch.map((e) => e.op));
        if (body.budgetId !== store.getBudgetId()) {
          // The server applied the batch to a budget this replica does not name. It can only
          // happen when the replica named NONE (an unbound replica sends no budgetId, so the
          // server's per-request assertion has nothing to compare) — either a new data epoch, or
          // a cookie swapped mid-cycle. resyncVerified re-proves the session before it replaces
          // the mirror; foreign/unproven ⇒ no snapshot, and we STOP the cycle (ops stay in the
          // outbox — server idempotency makes re-sending them safe).
          if (!(await resyncVerified())) return true;
          dirty = true; // D5: push the held-up ops immediately, don't wait up to 60 s
          finishSuccess();
          return true;
        }
        const acked: string[] = [];
        let settled = 0;
        for (const result of body.results) {
          if (result.status === "rejected") {
            const entry = batch.find((e) => e.op.opId === result.opId);
            console.warn("sync: op rejected by the server → dead-letter", result.error, entry?.op);
            // DURABLE resync obligation BEFORE the dead-letter: the IDB write order
            // (flag → removing the op from the outbox) guarantees a crash in the window
            // won't leave a phantom without the obligation to remove it. The consumer
            // (after pull) runs doFullResync; a transient blip before it will NOT lose it.
            markResyncPending();
            if (entry) {
              outbox.toDeadLetter(entry, result.error ?? "rejected");
              settled++;
            }
          } else {
            acked.push(result.opId);
            settled++;
          }
        }
        outbox.removeAcked(acked);
        if (acked.length > 0) requireDeps().notePeersMayNeedUpdate(); // canon after push → rehydrate other tabs
        // loop defense: a batch that settled nothing = a server bug
        if (batch.length > 0 && settled === 0) throw new Error("push: response without batch results");
      } finally {
        outbox.clearInFlight();
      }
    }

    // PULL — delta with pending-guard (don't overwrite entities with ops in the outbox)
    await doPull();

    // CONSUMER of the durable resync obligation (rejected / new epoch from pull / full-import).
    // Always AFTER push+pull; on success clears the flag, on failure leaves it (retry). It goes
    // through resyncVerified: a resync REPLACES this replica with the SESSION's budget, and the
    // pull that asked for it may have been answered under a cookie swapped in another tab.
    if (isResyncPending() && !(await resyncVerified())) return true;

    finishSuccess();
    return true;
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      // session expired / revoked / signed out — the Login screen takes over (see
      // enterUnauthed); no retry loop (a 401 won't clear on its own). The replica and the
      // outbox stay durable: signing back in resumes the push.
      enterUnauthed();
      return false;
    }
    if (e instanceof TierMismatchError) return handleTierFlip();
    if (e instanceof BudgetMismatchError) return handleBudgetMismatch();
    if (e instanceof E2eeUpgradeRequiredError) {
      // Legacy v1-format budget: the server refuses every normal sync2 channel until the
      // explicit upgrade ceremony has run. NOT a tier flip (a re-bootstrap would hit the same
      // 409) and NOT a resync trigger: replica, cursor and outbox stay untouched, the
      // cipherVersion meta is already 1 (Settings shows the upgrade action), and the cycle
      // retries on the normal backoff so a completed upgrade elsewhere is picked up.
      setState("error");
      scheduleRetry();
      return false;
    }
    setState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error");
    scheduleRetry();
    return false;
  }
}

/**
 * 409 budget_mismatch mid-push: the server refused the batch because the budget the replica
 * named is not the one the session owns — nothing was written. Which of the two causes it was
 * can only be settled by RE-VERIFYING the identity from scratch (the per-cycle verdict is what
 * the mismatch just called into question) — which is exactly what resyncVerified does:
 *  - the cookie was swapped mid-cycle → the stamp now names another account → foreign replica
 *    (every write refused, the human decides), or an unstamped replica fails its ownership proof
 *    → no write at all. Critically, NO fullResync happens then: it would bootstrap the OTHER
 *    user's budget and replay this replica's outbox onto it — the cross-tenant write we refused.
 *  - the same user's budget was rotated (wipe+reseed, DB restore, budget reattached after the
 *    2.0 upgrade) → the identity still checks out → a new data epoch → fresh snapshot + replay.
 */
async function handleBudgetMismatch(): Promise<boolean> {
  try {
    // resyncVerified re-proves the session BEFORE any snapshot: foreign (the human decides) /
    // unproven → no write, no bootstrap of the other user's budget, nothing replayed onto it.
    if (!(await resyncVerified())) return true;
    dirty = true; // the held-up ops go out on the fresh replica immediately
    finishSuccess();
    return true;
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      enterUnauthed();
      return false;
    }
    setState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error");
    scheduleRetry();
    return false;
  }
}

/**
 * 409 tier_mismatch mid-cycle (v1 or v2): tierMeta is already fresh
 * (throwIfTierMismatch) — hard re-bootstrap on the right path: fresh snapshot
 * (cursor := from the snapshot), outbox replay (backlogged ops STAY — plaintext —
 * and go out on the new path), dirty=true to push them right away in the syncNow loop.
 * Any resync obligation is moot after a fresh snapshot.
 */
async function handleTierFlip(): Promise<boolean> {
  try {
    if ((await bootstrapReplica()) === "locked") {
      enterLocked(); // new e2ee tier without a DEK — the Unlock screen takes over (T2)
      return true;
    }
    replayOutbox();
    requireDeps().ensureE2eeProviderPreference();
    void persist.persistLedger(store.snapshotForPersist());
    requireDeps().notePeersMayNeedUpdate();
    clearResyncPending();
    dirty = true; // backlogged ops immediately on the new path (don't wait for the interval)
    finishSuccess();
    return true;
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      enterUnauthed();
      return false;
    }
    setState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error");
    scheduleRetry();
    return false;
  }
}

function finishSuccess(): void {
  resetBackoff();
  const at = new Date().toISOString();
  setLastSyncAt(at);
  // D6: "last sync" is written ONLY here (persistLedger doesn't stamp it),
  // so offline local edits don't masquerade as a fresh synchronization.
  void persist.putMeta("lastSyncAt", at);
  setState("synced");
  requireDeps().broadcastUpdatedIfPending(); // this cycle changed data → other tabs rehydrate from IDB
}

/* ── syncNow — single-flight with coalescing (dirty flag) ────────────── */

let running: Promise<void> | null = null;
let dirty = false;

/**
 * Run a maintenance operation under the same single-flight mutex as push/pull. Sync triggers
 * arriving while the task runs mark the flight dirty and are drained immediately afterwards.
 */
export async function runWithSyncMutex<T>(task: () => Promise<T>): Promise<T> {
  while (running) await running.catch(() => {});
  let result!: T;
  let failure: unknown;
  let failed = false;
  const current = (async () => {
    try {
      result = await task();
    } catch (error) {
      failure = error;
      failed = true;
    }
    while (dirty) {
      dirty = false;
      const ok = await doCycle();
      if (!ok) break;
    }
  })().finally(() => {
    if (running === current) running = null;
  });
  running = current;
  await current;
  if (failed) throw failure;
  return result;
}

export function syncNow(reason: string): Promise<void> {
  if (isSignOutBlocking()) return Promise.resolve();
  void reason; // diagnostics (dev: window.__sync.lastReason)
  if (import.meta.env.DEV) lastReason = reason;
  // Foreign replica (another account signed in on this device): the app is on
  // ForeignReplicaScreen and nothing of the previous owner's may reach this account's budget.
  if (isIdentityBlocked()) return Promise.resolve();
  if (running) {
    dirty = true;
    return running;
  }
  running = (async () => {
    do {
      dirty = false;
      const ok = await doCycle();
      if (!ok) break; // backoff takes over the retry — don't spin the loop on failure
    } while (dirty);
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Bridge for read-only callers (imports, Settings) — goes through
 * the same mutex as push, so cycles never interleave.
 */
export function pullNow(): Promise<void> {
  return syncNow("pull");
}

/** Resolve once the in-flight cycle (if any) has finished. */
export async function awaitInFlightCycle(): Promise<void> {
  if (running) await running.catch(() => {}); // finish the in-flight cycle on the PRE-wipe state
}

/* ── poke — new op in the outbox (debounce catches a reorder burst) ───── */

let pokeTimer: ReturnType<typeof setTimeout> | undefined;

export function poke(): void {
  if (isSignOutBlocking()) return;
  resetBackoff(); // new op = new chance, try right after the debounce
  bumpStatus(); // pending count changed
  requireDeps().postPokeToPeers(); // notify the leader to sync right away (multi-tab)
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => void syncNow("enqueue"), POKE_DEBOUNCE_MS);
}

/* ── Debug (dev only — also used by e2e verification) ───────────── */

let lastReason = "";

export function getLastSyncReason(): string {
  return lastReason;
}
