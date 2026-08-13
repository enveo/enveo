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
import { fetchSessionUserId } from "./auth";
import { DEFAULT_KDF_PARAMS, dekWrapAadContext, deriveKek, freshKdfParams, generateDek, generateSalt, wrapDek } from "./crypto";
import * as e2ee from "./e2ee";
import { clearLocalData, idbGet, storageMode } from "./idb";
import { purgeLegacyPlannedIds } from "./legacyPlanned";



import * as outbox from "./outbox";
import * as persist from "./persist";
import { requestPersistentStorage } from "./storage";
import { store } from "./store";
import {
  BACKOFF_MAX_MS,
  type BootSource,
  BudgetMismatchError,
  E2eeUpgradeRequiredError,
  EMPTY_LEDGER,
  type IdentityVerdict,
  INTERVAL_MS,
  type LocalMode,
  type PendingE2eeUpgrade,
  POKE_DEBOUNCE_MS,
  PUSH_BATCH,
  TierMismatchError,
  UnauthorizedError,
} from "./sync/contracts";
import { applyLocalMode, configureLocalMode, disableLocal, enablePaused, enableWiped, getLocalMode, setLocalModeValue } from "./sync/localMode";
import { clearReplacePending, clearResyncPending, hydrateObligations, isReplacePending, isResyncPending, markResyncPending } from "./sync/obligations";
import { e2eeReplicaBudgetId, isEmptyUnboundReplica, replayOutbox } from "./sync/replica";
import { bumpStatus, getLastSyncAt, getSyncStatus, installOutboxStatusListener, setLastSyncAt, setOwnerUnproven, setState } from "./sync/status";
import {
  bootstrapReplica,
  configureTransport,
  doPull,
  doPullE2ee,
  fetchServerBudgetId,
  fetchServerE2eeIdentity,
  getClientId,
  pushE2eeBatch,
  pushLocalToServer,
  pushPlainBatch,
  resetServerE2ee,
  sessionBudgetIsEmpty,
  throwIfBudgetMismatch,
  throwIfTierMismatch,
  unauthorized,
  wipeServer,
} from "./sync/transport";

export type { BootSource, IdentityVerdict, LocalMode, PendingE2eeUpgrade, SyncState, SyncStatus } from "./sync/contracts";
 
export { E2eeUpgradeRequiredError, EMPTY_LEDGER, TierMismatchError } from "./sync/contracts";
export { disableLocal, enablePaused, enableWiped, getLocalMode, isLocalOnly } from "./sync/localMode";
export { __resetObligations, markReplacePending } from "./sync/obligations";
export { getSyncStatus, subscribeSyncStatus } from "./sync/status";
export { fetchSnapshot, getClientId, pushLocalToServer, resetServerE2ee } from "./sync/transport";

 

let lastBootSource: BootSource = null;
export function getLastBootSource(): BootSource {
  return lastBootSource;
}

// every outbox queue change (add/ack/dead-letter) refreshes the status —
// explicit, idempotent installation (sync/status.ts), done at composition time
installOutboxStatusListener();

 

let backoffMs = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRetry(): void {
  backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  const jitter = backoffMs * (0.7 + Math.random() * 0.6);  
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void syncNow("retry"), jitter);
}

function resetBackoff(): void {
  backoffMs = 0;
  clearTimeout(retryTimer);
  retryTimer = undefined;
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
  void persist.persistLedger(store.snapshotForPersist());  
  notePeersMayNeedUpdate();  
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
  identityVerifiedFor = null;  
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

/* ── Account identity of the replica (multi-tenant guard) ────────────────
 *
 * The replica knows its budgetId but NOT whose it is. With mandatory accounts one
 * device can hold user A's ledger AND A's queued ops while user B signs in (sign-out
 * keeps the replica, and the Login screen is reachable again — see enterUnauthed).
 * doCycle pushes the WHOLE outbox before the push RESPONSE reveals a foreign budgetId,
 * so A's entity-creating ops (account/envelope/category/place/budget.update, and any
 * txn.create whose FKs are created in the same batch) would already be written into B's
 * budget — the server's FK guards only reject references to ANOTHER budget's EXISTING
 * rows, never fresh creates. /sync/replace and /sync2/reset are worse still: they
 * OVERWRITE the session user's entire budget with this replica.
 *
 * THREE LAYERS, because this check is about a MOVING target (the cookie is shared by every tab
 * and can be swapped mid-cycle, while one cycle makes many server writes):
 *  1. at BOOT — bootOwnerOk(): the replica is not handed to the UI until its stamp has been
 *     compared with the session. This is the READ side (the two below only guard writes): boot
 *     renders from IDB and syncs afterwards, and in local mode no cycle ever runs at all,
 *  2. per CYCLE — ensureIdentity() below: no write of any kind until the session's user id has
 *     been compared with the one stamped next to the replica. A resync — which REPLACES the
 *     mirror with the session's budget — re-runs it (resyncVerified), because the very server
 *     answer that asks for a resync is what calls the cycle's verdict into question,
 *  3. per REQUEST — every push body NAMES the budget it is for, every full-budget overwrite (and
 *     the e2ee checkpoint upload) NAMES the verified user, and the server 409s (budget_mismatch)
 *     when that is not the budget/session it resolves. The window between the identity check and
 *     the Nth write is thus closed at the only place that can close it completely: the same
 *     request that carries the write.
 *
 * Therefore no server write may happen before the session's user id is compared with the
 * one stamped next to the replica (IDB meta "userId"):
 *  - no session   → UnauthorizedError → Login (this is ALSO the re-auth path: an expired
 *                   cookie now reaches the login screen instead of a muted badge),
 *  - other user   → FOREIGN replica: refuse every server write and hand the decision to the
 *                   HUMAN (BootStatus "foreign" → ForeignReplicaScreen: export a backup, or
 *                   remove the data and continue). NOTHING is destroyed unattended — see
 *                   enterForeignReplica,
 *  - same user    → stamp it (idempotent) and let the cycle run.
 *
 * The session is re-read from the server on EVERY cycle (one cheap same-origin GET; only a
 * verdict for the SAME session user id is reused). Verifying once per page load would not
 * hold: the cookie is shared by all tabs, so a sign-out+sign-in in ANOTHER tab (which
 * reloads only ITSELF) swaps the session under a long-lived tab — with a valid new cookie
 * that tab never even sees a 401 — and its next interval/focus cycle would push the
 * previous user's ops under the new user's session.
 *
 * A replica with NO stamp (persisted by a version older than this guard, or never synced)
 * is not adopted on trust: proveOwnership() has to show that the SESSION's budget really is
 * this replica's budget before the first write. The trigger is the replica itself, not the
 * outbox: the durable REPLACE obligation is a server-write channel too, and importBackup
 * CLEARS the outbox while setting it (as does the "wiped" local mode) — "outbox empty"
 * proves nothing.
 *
 * ONLY the stamp can prove FOREIGN. An unstamped replica whose proof fails is merely UNPROVEN:
 * budgetId is not a tenant id but the replica EPOCH marker (api/context.ts — a wipe+reseed, a DB
 * restore, and the lazy creation of an empty budget for a user who has none all mint a new one),
 * so "the session's budget id differs from mine" is exactly what the 2.0 upgrade path looks like:
 * a pre-2.0 device holds an unstamped replica of budget B_old, the owner registers, the pull
 * lazily creates the empty B_new — and treating that as another account would be a false
 * positive. Unproven therefore refuses every server write and waits (a later cycle re-proves; a
 * stamped replica in the same situation is handled non-destructively by the resync path).
 *
 * NEITHER verdict destroys anything unattended. "Foreign" blocks every write and stops there
 * (BootStatus "foreign" → ForeignReplicaScreen), because the replica may be the last copy of that
 * budget and because a user id does not survive a server rebuild — see enterForeignReplica. The
 * asymmetry the guard keeps is: an unproven owner ⇒ refuse every server write, destroy nothing.
 */

 
export function decideIdentity(sessionUserId: string | null, stamped: string | undefined): IdentityVerdict {
  if (!sessionUserId) return "unauthed";
  if (stamped && stamped !== sessionUserId) return "foreign";
  return "ok";  
}

 
let identityVerifiedFor: string | null = null;
let identityBlocked = false;  

 
export function __resetIdentity(): void {
  identityVerifiedFor = null;
  identityBlocked = false;
  setOwnerUnproven(false);
}

/** Test hook (unit tests only): cancel a pending retry so it cannot fire into the next test. */
export function __resetBackoff(): void {
  resetBackoff();
}

 
export function __setLocalMode(mode: LocalMode): void {
  applyLocalMode(mode);
}

/**
 * 401 — during boot OR mid-cycle: without a session the app cannot sync at all, so the
 * Login screen takes over (BootStatus "unauthed"). Previously a running cycle only set
 * SyncState "unauthed" (a muted badge opening Settings, which offers no way to sign in):
 * after the cookie expired the outbox grew forever and the only escape was "Clear local
 * data" — which throws the unsynced ops away. The replica and the outbox STAY in IDB, so
 * signing back in as the SAME user resumes the push exactly where it stopped.
 *
 * Forgetting the identity verdict is part of the guard: the next session that shows up on
 * this device may belong to somebody else, and it must be verified from scratch.
 */
function enterUnauthed(): void {
  identityVerifiedFor = null;
  setOwnerUnproven(false);  
  store.setBootStatus("unauthed");
  setState("unauthed"); // no retry loop — a 401 does not clear on its own
}

/**
 * The replica's owner stamp names a DIFFERENT account than the session: block every server
 * write (nothing of the previous owner's may reach this account's budget) and hand the decision
 * to the HUMAN — BootStatus "foreign" renders ForeignReplicaScreen (export a backup / remove the
 * data and continue).
 *
 * It does NOT wipe, and that asymmetry is deliberate — the exact opposite of what the first cut
 * of this guard did:
 *  - the replica can be the LAST copy of that budget. In local mode "wiped" the server data was
 *    deliberately deleted, so IDB holds the only copy; and even in normal mode the outbox may
 *    hold ops the server has never seen.
 *  - a user id is not stable across a server rebuild. A self-hoster who loses the Postgres
 *    volume reinstalls, registers with the same e-mail and gets a NEW user uuid — their phone,
 *    which still holds the complete replica, would compare the old stamp against the new id and
 *    destroy the very data the rebuild was supposed to recover. That is precisely the
 *    disaster-recovery case local-first exists for.
 * Refusing every write already contains the cross-tenant risk completely; destroying data does
 * not add safety, only loss.
 */
function enterForeignReplica(): void {
  identityBlocked = true;  
  setOwnerUnproven(false);  
  console.warn("sync: the local replica belongs to a different account — every server write is refused");
  store.setBootStatus("foreign");  
  setState("error"); // honest: sync is not happening (no retry loop of its own)
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

/**
 * Where EVERY sign-out lands (auth.signOutKeepingReplica calls this once the session is gone —
 * from Settings and from ForeignReplicaScreen alike): back to Login WITHOUT touching the replica.
 * The owner (or the same human after a server rebuild handed them a new user id) signs back in,
 * their stamp matches again, and the ledger plus every queued op resume where they stopped.
 *
 * A SELFHOST sign-out does NOT wipe (spec §3, owner's decision): the replica may be the last
 * copy of the budget (local mode "wiped" deleted the server's on purpose) and the outbox may
 * hold ops the server has never seen — a window.confirm is not consent to destroy them. CLOUD
 * sign-out is the deliberate exception (device-trust spec, 2026-07-17): there the server is the
 * durable copy, so LogoutRow flushes the outbox, ends the session and only then wipes — and a
 * non-empty remainder still requires the human's explicit consent. What protects the NEXT
 * account to sign in on this device is the guard, not a wipe: bootOwnerOk refuses to render a
 * replica stamped by somebody else, and ensureIdentity refuses to write it anywhere.
 */
export function enterLoginKeepingReplica(): void {
  identityVerifiedFor = null;
  identityBlocked = false; // a NEW session must be verified from scratch — see ensureIdentity
  enterUnauthed();  
}

/**
 * Pre-sign-out outbox flush for CLOUD deployments. Their sign-out wipes the replica (the server
 * is the durable copy there — operator backups, not this device), and queued ops would go with
 * it; selfhost sign-out keeps the replica instead (see enterLoginKeepingReplica — it may be the
 * LAST copy). One ordinary cycle through the usual mutex; returns how many ops are STILL queued
 * afterwards. 0 ⇒ a wipe loses nothing; anything else (offline, 5xx, an unproven replica) ⇒ the
 * caller must obtain explicit consent before discarding, or abort the sign-out.
 */
export async function flushOutboxForSignOut(): Promise<number> {
  await syncNow("sign-out");
  return outbox.size();
}

/**
 * The replica's owner could NOT be established (see proveOwnership). We refuse every server
 * write, but we do NOT wipe: the data may well be this user's, and destroying it (with its
 * unsynced ops) on an inconclusive probe would be the worse error. A later cycle
 * (focus/interval) retries the proof — e.g. after an Unlock the tier lines up again.
 *
 * This is NOT a corner case: it is exactly where a 1.x device lands during the 2.0 upgrade (the
 * owner registers, the server lazily creates an empty budget, and the old budget is reattached by
 * the operator only afterwards), and it can last for as long as that takes. So it gets a state of
 * its own — the badge says what is true (nothing is being sent) and links to Settings → Sync,
 * which names the two real causes and offers the safe ways out: export a backup, discard the local
 * copy, or check again. No retry loop and no backoff: the proof is re-run by the ordinary triggers
 * (focus / visibility / the 60 s interval) and by the human's "check again".
 */
function enterUnverified(): void {
  console.warn("sync: cannot establish the local replica's owner — no server write will be made");
  setOwnerUnproven(true);  
  setState("unverified");
}

/**
 * "Check again" (Settings → Sync, the unverified-replica notice): forget the cached verdict and
 * run a full cycle, which re-proves ownership from scratch. It is exactly what the next
 * focus/interval trigger would do — the button is there so the human is not left waiting on a
 * timer they cannot see, and so the moment the operator reattaches the budget the device can be
 * told to notice. Nothing here writes: a still-unproven replica lands back in "unverified".
 */
export function recheckReplicaOwner(): Promise<void> {
  identityVerifiedFor = null;
  return syncNow("recheck-owner");
}

/**
 * What the ownership proof for a replica with no owner stamp can conclude. Deliberately NOT
 * "foreign": nothing an unstamped replica can be compared against distinguishes another
 * ACCOUNT from the same account's rotated budget (see the section header), and only the
 * userId stamp — decideIdentity → "foreign" — may trigger the destructive path.
 */
type Ownership = "ours" | "unknown";

/**
 * Does a replica with NO owner stamp belong to the budget the SESSION owns? Runs before its
 * FIRST server write of any kind (push, /sync/replace, /sync2/reset). This can only ever
 * CONFIRM ownership ("ours" → adopt + write) or fail to ("unknown" → no write, no wipe):
 *
 *  - plain: the budgetId reported by the session's pull must equal the replica's. A replica that
 *    names NO budget (created offline, restored from a backup that carried none, or left behind
 *    by "Clear local data") proves nothing at all — it is adopted ONLY when adoption cannot
 *    destroy anything, i.e. when the session's budget is provably EMPTY. Adopting it on trust is
 *    how one account's ledger ends up REPLACING another's: "ours" authorizes /sync/replace,
 *    which wipes the session user's budget and re-inserts this replica,
 *  - e2ee : the same comparison (since 2.0 the v2 snapshot names its budget as well, and a
 *    legacy replica that has no cursor-level budgetId usually still carries one INSIDE the
 *    ledger — see e2eeReplicaBudgetId). Only when NEITHER is available does the proof fall back
 *    to the DEK: the server's checkpoint is encrypted with the budget's DEK and AES-GCM
 *    authenticates it, so a key that came out of IDB TOGETHER with the replica (origin "store")
 *    and opens the session's checkpoint says the two are the same budget. A DEK unwrapped from
 *    the SESSION's key envelope (Unlock / enable / password change — origin "session") proves
 *    nothing: it decrypts that session's budget by construction, whoever the replica belongs to.
 *    Hence e2ee.isDekFromStore(), whose answer is DURABLE (e2ee.ts) — setDek() persists the key,
 *    so without a persisted provenance one reload would turn a session key into a "store" key
 *    and hand any signed-in user a proof for somebody else's replica.
 *
 * A mismatch does NOT mean "another account". budgetId is the replica epoch marker, not a
 * tenant id: the session's budget is lazily created when the user has none (the 2.0 upgrade
 * path, before the budget is reattached), and a reseed/DB restore rotates it. A checkpoint the
 * replica's stored DEK cannot open likewise only proves the KEY is stale (the same user's
 * disable→enable re-encrypts with a fresh DEK — a case whose pre-guard behaviour was a 409
 * epoch mismatch → Unlock, with the outbox intact). Both therefore end as "unknown": refuse
 * every write, destroy nothing, re-prove on the next cycle.
 *
 * A 409 tier_mismatch means the session's budget lives in the OTHER tier: retry the proof
 * there ONCE. It must never escape this function — doCycle would hand it to handleTierFlip,
 * which re-bootstraps from the session's budget and REPLAYS the still-unattributed outbox
 * onto it (the outbox is plaintext and survives tier flips by design).
 */
async function proveOwnership(): Promise<Ownership> {
  // An e2ee replica is ALWAYS server-bound (it can only exist because some budget's snapshot
  // bootstrapped it), so a missing budgetId there means "cannot tell" — never "bound to nothing
  // yet". Captured BEFORE the loop: a tier flip discovered mid-proof (the session's budget is
  // plain) must not turn such a replica into an unbound one and hand it the shortcut below.
  const bornE2ee = e2ee.getTierMeta().tier === "e2ee";
  for (let attempt = 0; ; attempt++) {
    try {
      if (e2ee.getTierMeta().tier === "e2ee") {
        const server = await fetchServerE2eeIdentity();
        const mine = e2eeReplicaBudgetId();
        if (mine && server.budgetId) return mine === server.budgetId ? "ours" : "unknown";
        const dek = e2ee.getDek();
        if (!dek || !e2ee.isDekFromStore() || !server.blob || !server.budgetId) return "unknown";
        try {
          // The checkpoint's claimed context comes with it; what the proof establishes is that
          // THIS replica's stored key authenticates the session's checkpoint under exactly that
          // context — a foreign budget's blob (different DEK) cannot pass.
          await e2ee.decryptSnapshot(server.blob, dek, { budgetId: server.budgetId, epoch: server.epoch, uptoSeq: server.uptoSeq });
          // The successful decrypt also VALIDATED the stored key for exactly this generation
          // (the AAD carried server.epoch) — record it for the push/pull precondition.
          e2ee.markDekValidated(server.epoch);
          // The successful decrypt just AUTHENTICATED the claimed budget id with the replica's
          // own stored key (GCM verifies the AAD tuple). Bind the replica to it: v2 writes are
          // fail-closed without a named budget, so an adopted legacy replica must learn the id
          // its own key just vouched for.
          const ledger = store.getLedger();
          if (ledger && !store.getBudgetId()) {
            store.replace(ledger, store.getCursor(), server.budgetId);
            void persist.persistLedger(store.snapshotForPersist());
          }
          return "ours";  
        } catch {
          return "unknown"; // …it does not: a stale key OR another budget — indistinguishable
        }
      }
      const localBudgetId = store.getBudgetId();
      




      if (!localBudgetId) return !bornE2ee && (await sessionBudgetIsEmpty()) ? "ours" : "unknown";
      const server = await fetchServerBudgetId();
      if (!server) return "unknown";
      return localBudgetId === server ? "ours" : "unknown";
    } catch (err) {
      if (err instanceof TierMismatchError) {
        if (attempt === 0) continue;  
        return "unknown";  
      }
      throw err;  
    }
  }
}

/**
 * MULTI-TENANT GUARD — runs before ANY server write (cycle push, replace, e2ee reset/enable/
 * disable). Returns the VERIFIED session user id, which every full-budget overwrite then carries
 * in its request body (the per-REQUEST owner assertion — see replaceServer); null means the
 * caller must NOT write (foreign replica awaiting the human's decision, or an owner we could not
 * establish). Throws UnauthorizedError when there is no session. Network failures propagate to
 * the normal backoff — being offline is NOT being signed out.
 */
async function ensureIdentity(): Promise<string | null> {
  const sessionUserId = await fetchSessionUserId(); 


  if (!sessionUserId) throw unauthorized();
  if (identityVerifiedFor !== sessionUserId) {
    const stamped = await idbGet<string>("meta", "userId").catch(() => undefined);
    const verdict = decideIdentity(sessionUserId, stamped);
    if (verdict === "unauthed") throw unauthorized(); // defensive (sessionUserId is set)
    // The stamp names another account: refuse every write and let the HUMAN decide what happens
    // to the data (enterForeignReplica destroys nothing — a stamp mismatch is not proof that the
    // data is expendable, only that it must not be written into THIS account's budget).
    if (verdict === "foreign") {
      enterForeignReplica();
      return null;
    }
    if (!stamped && (await proveOwnership()) === "unknown") {
      enterUnverified();  
      return null;
    }
    await persist.putMeta("userId", sessionUserId);  
    identityVerifiedFor = sessionUserId;
  }
  // Proved (or adopted): the replica's owner is no longer in question — clear the sticky fact, so
  // the badge, the Settings dot and the Sync section stop saying "not sending".
  setOwnerUnproven(false);
  

  if (store.getBootStatus() === "unauthed" && store.getLedger()) store.setBootStatus("ready");
  return sessionUserId;
}

/**
 * The guard for server writes made OUTSIDE this module: Settings → "Enable E2EE" (POST
 * /e2ee/enable uploads an encrypted snapshot of the whole replica AND flips the session
 * budget's tier under this device's wrappedDek) and "Disable E2EE" (POST /e2ee/disable
 * uploads the whole plaintext ledger, from which the server rebuilds the budget's rows).
 * Both are the same "OVERWRITE the session user's entire budget with this replica" class as
 * /sync/replace, and both are reachable while a cookie swapped in another tab (or a replica
 * whose owner cannot be established) makes the local mirror foreign to the session.
 *
 * Returns the VERIFIED session user id — the caller MUST put it in the request body (`userId`):
 * this check and the write are two different requests, and the cookie can be swapped between
 * them (a sign-in in another tab; encrypting and uploading a whole ledger takes seconds on
 * mobile). The server refuses a body whose `userId` is not the session it resolves — 409
 * budget_mismatch, nothing written. Throws when no write may be made; the caller renders it.
 */
export async function assertOwnReplica(): Promise<string> {
  const userId = await ensureIdentity();
  if (!userId) throw new Error("foreign_replica");
  return userId;
}

 

 
async function doCycle(): Promise<boolean> {
  

  if (getLocalMode() !== "off") {
    setState("local");
    return true;
  }
  

  if (store.getBootStatus() === "locked") return true;
   
  if (identityBlocked) return true;
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
        await resetServerE2ee(dek); // server := ciphertext of the local mirror; clears replacePending
      } else {
        await pushLocalToServer();  
      }
      clearResyncPending();
      notePeersMayNeedUpdate();  
      finishSuccess();
      return true;
    }

    // ABSORB "orphans" from the SHARED IDB outbox — ops enqueued by ANOTHER
    // tab that closed before its own push (outbox memory is PER
    // TAB; without this such an entry would wait in IDB until a full reload — no live
    // tab re-reads the outbox). Apply them onto the mirror (pending-guard + UI)
    // and persist; the rest of the cycle pushes them (server idempotency dedupes a possible duplicate).
    const { absorbed, peerDeadLettered } = await outbox.reconcileFromIdb();
    


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
      notePeersMayNeedUpdate();  
    }

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
          // budgetId = the PER-REQUEST tenant assertion (see the v1 push below) — in v2 it is
          // also the authenticated op context, so it is REQUIRED, never optional
          await pushE2eeBatch(epoch, pushBudgetId, ops);
          outbox.removeAcked(batch.map((en) => en.op.opId));
          notePeersMayNeedUpdate();  
        } finally {
          outbox.clearInFlight();
        }
      }

      // PULL v2 — ciphertext delta (own pending ops skipped + outbox replay)
      await doPullE2ee(dek, userId);

      

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
        if (acked.length > 0) notePeersMayNeedUpdate(); 

        if (batch.length > 0 && settled === 0) throw new Error("push: response without batch results");
      } finally {
        outbox.clearInFlight();
      }
    }

     
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
    void persist.persistLedger(store.snapshotForPersist());
    notePeersMayNeedUpdate();
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
  if (broadcastPending) {
    broadcastPending = false;
    postMsg("updated");  
  }
}

 

let running: Promise<void> | null = null;
let dirty = false;

export function syncNow(reason: string): Promise<void> {
  void reason;  
  if (import.meta.env.DEV) lastReason = reason;
  


  if (getLocalMode() !== "off") {
    setState("local");
    return Promise.resolve();
  }
  

  if (identityBlocked) return Promise.resolve();
  if (running) {
    dirty = true;
    return running;
  }
  running = (async () => {
    do {
      dirty = false;
      const ok = await doCycle();
      if (!ok) break;  
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

 
function broadcastLocalMode(mode: LocalMode): void {
  try {
    channel?.postMessage({ type: "localmode", mode });
  } catch {
     
  }
}

 

let pokeTimer: ReturnType<typeof setTimeout> | undefined;

export function poke(): void {
  resetBackoff();  
  bumpStatus();  
  postMsg("poke");  
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => void syncNow("enqueue"), POKE_DEBOUNCE_MS);
}

 

/**
 * Best-effort load of meta flags (lastSyncAt, resyncPending) — each independently
 * and without throwing, so one failed read doesn't skip the other or
 * topple the whole boot. CRITICAL: the durable resync obligation (D1) must reach
 * memory on BOTH boot paths (success and recovery), otherwise a rejected op
 * would leave a "ghost" for the whole session.
 */
async function loadSyncMeta(): Promise<void> {
  try {
    // E2EE state (DEK + tier/epoch + checkpoint counter) — BEFORE bootstrap,
    // so bootstrapReplica picks the right path on the very first shot
    await e2ee.hydrate();
  } catch (e) {
    console.warn("reading e2ee state failed", e);
  }
  try {
    setLastSyncAt((await idbGet<string>("meta", "lastSyncAt")) ?? getLastSyncAt());
  } catch (e) {
    console.warn("reading lastSyncAt failed", e);
  }
  // durable resync + replace obligations (sync/obligations.ts): both must reach memory
  await hydrateObligations();
}

/**
 * One-time client-side sweep for legacy `planned` transactions (see legacyPlanned.ts): on a
 * PLAIN-tier budget migration 0018's server-side DELETE already removed them and the `changes`
 * journal replicates that everywhere, but on E2EE-tier budgets the server never saw plaintext —
 * that DELETE was a no-op there, so a replica that already had `planned` rows keeps them until
 * this sweep catches them. Runs right after the replica is resolved (hydrated/bootstrapped +
 * outbox replayed) and BEFORE `store.setBootStatus("ready")` hands it to the UI, so a leftover
 * row is never rendered even for a frame. `local.deleteTxn` is the normal applyOp+outbox path:
 * the delete pushes encrypted on e2ee, and is an idempotent no-op push on plain (the server
 * already dropped the row). Idempotent overall — nothing is left to find on the next boot.
 *
 * `local` is fetched via a lazy `import("./mutate")` rather than a static top-of-file import:
 * mutate.ts imports `poke` from this module, so a static `sync.ts → mutate.ts` edge would form an
 * import cycle. This is the ONLY place sync.ts needs `local`, so the lazy import keeps the
 * dependency graph acyclic at negligible cost (mutate.ts is already statically imported
 * elsewhere in the app, so this resolves from the already-loaded module).
 */
async function sweepLegacyPlanned(): Promise<void> {
  const ledger = store.getLedger();
  if (!ledger) return;
  const ids = purgeLegacyPlannedIds(ledger);
  if (ids.length === 0) return;
  const { local } = await import("./mutate");
  for (const id of ids) local.deleteTxn(id);
}

/**
 * Boot in LOCAL MODE (paused/wiped): we operate EXCLUSIVELY off the local replica —
 * NO fetchSnapshot/pull (respect the offline/privacy choice). No local
 * data (rare: "Clear local data" while in local mode) → empty ledger, so the
 * UI doesn't hang on "Loading…"; the real data comes back after disabling the mode.
 */
async function bootLocalReady(hydrated: "ready" | "empty"): Promise<void> {
  if (hydrated === "empty" || !store.getLedger()) {
    store.replace(EMPTY_LEDGER, store.getCursor(), store.getBudgetId() ?? "");
  }
  replayOutbox();
  await sweepLegacyPlanned();
  if (outbox.size() > 0) void persist.persistLedger(store.snapshotForPersist());
  store.setBootStatus("ready");
  setState("local");
}

/**
 * MULTI-TENANT GUARD AT BOOT — runs BEFORE the hydrated replica is handed to the UI, and this is
 * the only place that can protect the READ side.
 *
 * The cycle's guard (ensureIdentity) protects WRITES, but boot renders first and syncs second:
 * store.setBootStatus("ready") on a replica hydrated straight out of IDB, then `void
 * syncNow("boot")`. Between the two, the previous owner's ENTIRE budget is on screen and
 * editable — and the ways a device changes hands are routine, not exotic: a 90-day cookie
 * expires → Login; a sign-out (which KEEPS the replica — see DataSection/ForeignReplicaScreen) →
 * Login; then the next account signs in. Worse, the window is not always short: in local mode
 * doCycle bails before ensureIdentity ever runs (the mode gate comes first), so without this
 * check the verdict would NEVER be reached and the other account's ledger would simply be the
 * app — permanently.
 *
 * Returns false when the replica may NOT be rendered (BootStatus set to "foreign"/"unauthed").
 * Deliberately NOT a hard gate in two cases, because the replica can be the LAST copy of a budget
 * and a boot that refuses to show it is its own kind of data loss:
 *  - the server is unreachable (fetchSessionUserId THROWS): being offline is not being somebody
 *    else — local-first wins, and the first cycle that does reach the server enforces the verdict,
 *  - no session in LOCAL MODE: nobody else is claiming this device (a sign-in needs the server),
 *    the mode means "do not talk to the server", and the server may be gone for good (mode
 *    "wiped" deleted its copy on purpose). Forcing Login there would lock the owner out of the
 *    only copy of their budget. In normal mode a missing session DOES go to Login — the cycle
 *    would land there within the second anyway, only after rendering the data first.
 */
async function bootOwnerOk(): Promise<boolean> {
  const stamped = await idbGet<string>("meta", "userId").catch(() => undefined);
  if (!stamped) return true; 

  let sessionUser: string | null;
  try {
    sessionUser = await fetchSessionUserId();
  } catch {
    return true; // offline / server down — cannot verify; see the contract above
  }
  if (decideIdentity(sessionUser, stamped) === "foreign") {
    enterForeignReplica(); // ForeignReplicaScreen — the other account's budget is never rendered
    return false;
  }
  if (!sessionUser) {
    if (getLocalMode() !== "off") return true;  
    enterUnauthed();  
    return false;
  }
  identityVerifiedFor = sessionUser;  
  return true;
}

async function boot(): Promise<void> {
  store.setBootStatus("booting");
  void getClientId();  
  void requestPersistentStorage();  
  try {
    const [hydrated] = await Promise.all([store.hydrate(), outbox.hydrate()]);
    await loadSyncMeta();
     
    if (!(await bootOwnerOk())) return;
    if (getLocalMode() !== "off") {
      lastBootSource = "local";
      await bootLocalReady(hydrated);  
      return;
    }
    if (hydrated === "empty") {
      lastBootSource = "snapshot"; 

      if ((await bootstrapReplica()) === "locked") {
         
        store.setBootStatus("locked");
        return;
      }
    } else {
      lastBootSource = "replica";  
    }
    // REPLAY the outbox onto the mirror — heals a crash between addOutbox of an op and persist
    // (reducers are idempotent: create guards the id, update = full replacement);
    // the mirror was a PREFIX of the outbox, so the replay catches it up (never rolls back)
    replayOutbox();
    await sweepLegacyPlanned();
    if (outbox.size() > 0) void persist.persistLedger(store.snapshotForPersist());
    store.setBootStatus("ready");
    bumpStatus();
    void syncNow("boot");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      

      enterUnauthed();
      return;
    }
    if (store.getLedger()) {
       
      lastBootSource = "replica";
      // Read the meta flags HERE too: the resync obligation from IDB must not be lost.
      await loadSyncMeta();
      replayOutbox();
      await sweepLegacyPlanned();
      store.setBootStatus("ready");
      if (getLocalMode() !== "off") {
        setState("local");
        return;
      }
      bumpStatus();
      void syncNow("boot");
    } else {
      console.warn("First start without a server connection", e);
      store.setBootStatus("error");
    }
  }
}

let bootPromise: Promise<void> | null = null;

 
export function bootOnce(): Promise<void> {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

 
export function retryBoot(): Promise<void> {
  bootPromise = boot();
  return bootPromise;
}

 

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
let broadcastPending = false;  
let applyingPeerUpdate = false;

 
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
     
  }
}








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
  if (applyingPeerUpdate) return;  
  if (store.getBootStatus() !== "ready") return;  
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
        


        void syncNow("leader");
        return new Promise<void>(() => {});  
      })
      .catch(() => {
        isLeader = true;  
      });
  } else {
    isLeader = true;  
  }

  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("enveo-sync");
    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; mode?: LocalMode } | null;
      if (!msg) return;
      if (msg.type === "updated") void applyPeerUpdate();
      else if (msg.type === "keys") {
        

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
            void syncNow("peer-localmode-off");  
          else {
            setOwnerUnproven(false);  
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
    

    if (isLeader && document.visibilityState === "visible") void syncNow("interval");
  }, INTERVAL_MS);
}



configureTransport({
  enterUnauthed,
  assertOwnReplica,
  notePeersMayNeedUpdate,
});



configureLocalMode({
  setState,
  setOwnerUnproven,
  broadcastLocalMode,
  wipeServer,
  pushLocalToServer,
  awaitInFlightCycle: async () => {
    if (running) await running.catch(() => {});  
  },
  syncNow,
  isEmptyUnboundReplica,
});

installTriggers();

 

let lastReason = "";

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__sync = {
    status: getSyncStatus,
    outboxSize: () => outbox.size(),
    outbox: () => outbox.snapshot(),
    deadLetters: () => outbox.getDeadLetters(),
    flushed: () => outbox.flushed(),
    syncNow: () => syncNow("debug"),
    getLastReason: () => lastReason,
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
