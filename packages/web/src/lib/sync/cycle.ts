import { accountPreferences } from "../accountPreferences";
import { devicePreferences } from "../devicePreferences";
import * as e2ee from "../e2ee";
import { migrateLegacySettings } from "../legacySettingsMigrationRuntime";
import * as outbox from "../outbox";
import * as persist from "../persist";
import { isSignOutBlocking, isSignOutPermitActive, type SignOutPermit } from "../signOutBarrier";
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
import {
  bootstrapReplica,
  doPull,
  doPullE2ee,
  pushE2eeBatch,
  pushLocalToServer,
  pushLocalToServerForSignOut,
  pushPlainBatch,
  resetServerE2ee,
  resetServerE2eeForSignOut,
} from "./transport";

let deps: CycleDeps | null = null;

export function configureCycle(d: CycleDeps): void {
  deps = d;
}

function requireDeps(): CycleDeps {
  if (!deps) throw new Error("sync_cycle_unconfigured"); // composition bug — never user-reachable
  return deps;
}

let backoffMs = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRetry(): void {
  if (isSignOutBlocking()) return;
  backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  const jitter = backoffMs * (0.7 + Math.random() * 0.6);
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

function enterLocked(): void {
  store.setBootStatus("locked");
  setState("error");
}

async function doFullResync(): Promise<void> {
  if ((await bootstrapReplica()) === "locked") {
    enterLocked();
    throw new Error("e2ee: no DEK — waiting for unlock");
  }
  replayOutbox();
  requireDeps().ensureE2eeProviderPreference();
  void persist.persistLedger(store.snapshotForPersist());
  requireDeps().notePeersMayNeedUpdate();
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
  invalidateIdentityVerdict();
  if (!(await ensureIdentity())) return false;
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
export async function flushOutboxWithPermit(permit: SignOutPermit): Promise<number> {
  if (!isSignOutPermitActive(permit)) throw new Error("sign_out_coordination_failed");
  await syncNowForSignOut("sign-out", permit);
  if (!isSignOutPermitActive(permit)) throw new Error("sign_out_coordination_failed");
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

function cycleMayContinue(permit?: SignOutPermit): boolean {
  return !isSignOutBlocking() || isSignOutPermitActive(permit);
}

async function doCycle(permit?: SignOutPermit): Promise<boolean> {
  if (store.getBootStatus() === "locked") return true;

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
    if (!cycleMayContinue(permit)) return true;
    if (!userId) return true;
    await accountPreferences.hydrateForUser(userId);
    if (!cycleMayContinue(permit)) return true;
    // Preferences are an auxiliary channel: a temporary failure must not stall ledger sync.
    if (!permit) {
      try {
        await accountPreferences.sync(userId);
        await devicePreferences.hydrate();
        await migrateLegacySettings();
      } catch (error) {
        console.warn("account preference sync or legacy migration failed", error);
      }
    }
    if (!cycleMayContinue(permit)) return true;

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
          enterLocked();
          return true;
        }
        await (permit ? resetServerE2eeForSignOut(dek, permit) : resetServerE2ee(dek)); // server := ciphertext of the local mirror; clears replacePending
      } else {
        await (permit ? pushLocalToServerForSignOut(permit) : pushLocalToServer());
      }
      if (!cycleMayContinue(permit)) return true;
      clearResyncPending();
      requireDeps().notePeersMayNeedUpdate();
      finishSuccess();
      return true;
    }

    // ABSORB "orphans" from the SHARED IDB outbox — ops enqueued by ANOTHER
    // tab that closed before its own push (outbox memory is PER
    // TAB; without this such an entry would wait in IDB until a full reload — no live
    // tab re-reads the outbox). Apply them onto the mirror (pending-guard + UI)
    // and persist; the rest of the cycle pushes them (server idempotency dedupes a possible duplicate).
    const { absorbed, peerDeadLettered } = await outbox.reconcileFromIdb();
    if (!cycleMayContinue(permit)) return true;

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
      requireDeps().notePeersMayNeedUpdate();
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
        enterLocked();
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
          if (!cycleMayContinue(permit)) return true;
          // budgetId = the PER-REQUEST tenant assertion (see the v1 push below) — in v2 it is
          // also the authenticated op context, so it is REQUIRED, never optional
          await pushE2eeBatch(epoch, pushBudgetId, ops, permit);
          if (!cycleMayContinue(permit)) return true;
          outbox.removeAcked(batch.map((en) => en.op.opId));
          requireDeps().notePeersMayNeedUpdate();
        } finally {
          outbox.clearInFlight();
        }
      }

      // PULL v2 — ciphertext delta (own pending ops skipped + outbox replay)
      await doPullE2ee(dek, userId, permit);
      if (!cycleMayContinue(permit)) return true;

      requireDeps().ensureE2eeProviderPreference();

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
        const body = await pushPlainBatch(
          batch.map((e) => e.op),
          permit,
        );
        if (!cycleMayContinue(permit)) return true;
        if (body.budgetId !== store.getBudgetId()) {
          // The server applied the batch to a budget this replica does not name. It can only
          // happen when the replica named NONE (an unbound replica sends no budgetId, so the
          // server's per-request assertion has nothing to compare) — either a new data epoch, or
          // a cookie swapped mid-cycle. resyncVerified re-proves the session before it replaces
          // the mirror; foreign/unproven ⇒ no snapshot, and we STOP the cycle (ops stay in the
          // outbox — server idempotency makes re-sending them safe).
          if (!(await resyncVerified())) return true;
          dirty = true;
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
        if (acked.length > 0) requireDeps().notePeersMayNeedUpdate();

        if (batch.length > 0 && settled === 0) throw new Error("push: response without batch results");
      } finally {
        outbox.clearInFlight();
      }
    }

    await doPull();
    if (!cycleMayContinue(permit)) return true;

    // CONSUMER of the durable resync obligation (rejected / new epoch from pull / full-import).
    // Always AFTER push+pull; on success clears the flag, on failure leaves it (retry). It goes
    // through resyncVerified: a resync REPLACES this replica with the SESSION's budget, and the
    // pull that asked for it may have been answered under a cookie swapped in another tab.
    if (isResyncPending() && !(await resyncVerified())) return true;

    finishSuccess();
    return true;
  } catch (e) {
    if (!cycleMayContinue(permit)) return true;
    if (e instanceof UnauthorizedError) {
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
    if (!(await resyncVerified())) return true;
    dirty = true;
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
      enterLocked();
      return true;
    }
    replayOutbox();
    requireDeps().ensureE2eeProviderPreference();
    void persist.persistLedger(store.snapshotForPersist());
    requireDeps().notePeersMayNeedUpdate();
    clearResyncPending();
    dirty = true;
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

  void persist.putMeta("lastSyncAt", at);
  setState("synced");
  requireDeps().broadcastUpdatedIfPending();
}

let running: Promise<void> | null = null;
let dirty = false;

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
      if (isSignOutBlocking()) break;
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

function runSyncNow(reason: string, permit?: SignOutPermit): Promise<void> {
  if (!cycleMayContinue(permit)) return Promise.resolve();
  void reason;
  if (import.meta.env.DEV) lastReason = reason;

  if (isIdentityBlocked()) return Promise.resolve();
  if (running) {
    dirty = true;
    return running;
  }
  running = (async () => {
    do {
      dirty = false;
      const ok = await doCycle(permit);
      if (!ok) break;
    } while (dirty);
  })().finally(() => {
    running = null;
  });
  return running;
}

export function syncNow(reason: string): Promise<void> {
  return runSyncNow(reason);
}

export function syncNowForSignOut(reason: string, permit: SignOutPermit): Promise<void> {
  return runSyncNow(reason, permit);
}

/**
 * Bridge for read-only callers (imports, Settings) — goes through
 * the same mutex as push, so cycles never interleave.
 */
export function pullNow(): Promise<void> {
  return syncNow("pull");
}

export async function awaitInFlightCycle(): Promise<void> {
  if (running) await running.catch(() => {});
}

export async function quiesceSyncForSignOut(): Promise<void> {
  dirty = false;
  resetBackoff();
  clearTimeout(pokeTimer);
  pokeTimer = undefined;
  await awaitInFlightCycle();
  dirty = false;
}

let pokeTimer: ReturnType<typeof setTimeout> | undefined;

export function poke(): void {
  if (isSignOutBlocking()) return;
  resetBackoff();
  bumpStatus();
  requireDeps().postPokeToPeers();
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => void syncNow("enqueue"), POKE_DEBOUNCE_MS);
}

let lastReason = "";

export function getLastSyncReason(): string {
  return lastReason;
}
