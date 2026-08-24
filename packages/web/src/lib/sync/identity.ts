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
 *     renders from IDB and syncs afterwards,
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
 *  - other user   → FOREIGN replica: refuse every server write. On SELFHOST the decision is
 *                   the HUMAN's (BootStatus "foreign" → ForeignReplicaScreen: export a backup,
 *                   or remove the data and continue) and nothing is destroyed unattended; on
 *                   CLOUD the previous account's local data is silently discarded and the page
 *                   reloads into the session account's boot — see enterForeignReplica,
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
 * CLEARS the outbox while setting it — "outbox empty"
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
 * On SELFHOST neither verdict destroys anything unattended: "foreign" blocks every write and
 * stops there (BootStatus "foreign" → ForeignReplicaScreen), because the replica may be the last
 * copy of that budget and because a user id does not survive a server rebuild — see
 * enterForeignReplica, which also documents the ONE exception: a PROVEN foreign stamp on CLOUD
 * is discarded silently. The asymmetry the guard keeps everywhere is: an unproven owner ⇒
 * refuse every server write, destroy nothing.
 */

import { accountPreferences } from "../accountPreferences";
import { fetchSessionUserId } from "../auth";
import { getCachedDeployment } from "../deviceStoragePolicy";
import * as e2ee from "../e2ee";
import { idbGet } from "../idb";
import * as persist from "../persist";
import { store } from "../store";
import { type IdentityDeps, type IdentityVerdict, TierMismatchError } from "./contracts";
import { e2eeReplicaBudgetId } from "./replica";
import { setOwnerUnproven, setState } from "./status";
import { fetchServerBudgetId, fetchServerE2eeIdentity, sessionBudgetIsEmpty, unauthorized } from "./transport";

/** Pure decision: what to do with a replica stamped `stamped` under session `sessionUserId`. */
export function decideIdentity(sessionUserId: string | null, stamped: string | undefined): IdentityVerdict {
  if (!sessionUserId) return "unauthed";
  if (stamped && stamped !== sessionUserId) return "foreign";
  return "ok"; // same account, or a replica with no stamp yet (proved + adopted below)
}

/** Session user id ALREADY verified against this replica (null ⇒ verify from scratch). */
let identityVerifiedFor: string | null = null;
let identityBlocked = false; // foreign replica → no network write (human decision on selfhost, wipe+reload on cloud)

/** Injected by the facade at composition time (identity cannot import sync.ts back). */
let identityDeps: IdentityDeps | null = null;

/** Compose the identity layer's facade-owned dependency; returns the previous value so tests can restore it. */
export function configureIdentity(deps: IdentityDeps | null): IdentityDeps | null {
  const prev = identityDeps;
  identityDeps = deps;
  return prev;
}

/** Forget the cached verdict — the next check verifies the session from scratch. */
export function invalidateIdentityVerdict(): void {
  identityVerifiedFor = null;
}

/** Foreign replica detected — no cycle may touch the network until it is resolved (human on selfhost, wipe+reload on cloud). */
export function isIdentityBlocked(): boolean {
  return identityBlocked;
}

/** Test hook (unit tests only): forget the identity verdict. */
export function __resetIdentity(): void {
  identityVerifiedFor = null;
  identityBlocked = false;
  setOwnerUnproven(false);
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
export function enterUnauthed(): void {
  identityVerifiedFor = null;
  accountPreferences.dehydrate(); // no account-scoped UI state may remain visible on Login
  setOwnerUnproven(false); // no session ⇒ nothing to prove YET; the next one proves from scratch
  store.setBootStatus("unauthed");
  setState("unauthed"); // no retry loop — a 401 does not clear on its own
}

/**
 * The replica's owner stamp names a DIFFERENT account than the session: block every server
 * write (nothing of the previous owner's may reach this account's budget). What happens to the
 * data depends on the deployment — CLOUD discards it silently (see the branch below), SELFHOST
 * hands the decision to the HUMAN: BootStatus "foreign" renders ForeignReplicaScreen (export a
 * backup / remove the data and continue).
 *
 * SELFHOST does NOT wipe, and that asymmetry is deliberate — the exact opposite of what the
 * first cut of this guard did:
 *  - the replica can be the LAST copy of that budget; the outbox may hold ops the server has
 *    never seen, and a rebuilt server may know nothing about the device copy.
 *  - a user id is not stable across a server rebuild. A self-hoster who loses the Postgres
 *    volume reinstalls, registers with the same e-mail and gets a NEW user uuid — their phone,
 *    which still holds the complete replica, would compare the old stamp against the new id and
 *    destroy the very data the rebuild was supposed to recover. That is precisely the
 *    disaster-recovery case local-first exists for.
 * Refusing every write already contains the cross-tenant risk completely; destroying data does
 * not add safety, only loss.
 */
export function enterForeignReplica(): void {
  identityBlocked = true; // no cycle may touch the network until the human decides (or the wipe reloads)
  accountPreferences.dehydrate(); // the signed-in account is not the cache owner
  setOwnerUnproven(false); // a PROVEN foreign stamp supersedes "unproven" (ForeignReplicaScreen)
  // CLOUD: silently discard instead. Every argument for the human decision above is a SELFHOST
  // argument — there the operator IS the user, a rebuilt server rotates user ids and the replica
  // can be the last copy. On cloud the server is the durable copy of every account's budget
  // (operator backups), a user-id rotation is the operator's incident to repair, and the export
  // path is hidden anyway — so the previous account's data (queued ops included — a session that
  // ended without sign-out forfeits them; deliberate product decision) is removed and the page
  // reloads into the session account's clean boot. Fail-safe both ways: an unknown deployment
  // reads as "selfhost" (getCachedDeployment), and an uncomposed module keeps the screen. The
  // cache is written at Login from /api/auth/meta — the same sign-in that makes a replica
  // foreign refreshes it, so a stale value needs an operator-side DEPLOYMENT flip to linger.
  if (getCachedDeployment() === "cloud" && identityDeps) {
    console.warn("sync: the local replica belongs to a different account — removing it (cloud)");
    // A failed wipe (IDB evicted, private mode) must not strand the app on an eternal splash:
    // fall back to the screen, which is recoverable (and hides the export on cloud). Retrying
    // the wipe by reloading would loop on a persistent IDB failure.
    identityDeps.discardForeignReplica().catch(() => {
      store.setBootStatus("foreign");
      setState("error");
    });
    return;
  }
  console.warn("sync: the local replica belongs to a different account — every server write is refused");
  store.setBootStatus("foreign"); // ForeignReplicaScreen: [Export backup] / [Remove and continue]
  setState("error"); // honest: sync is not happening (no retry loop of its own)
}

/**
 * Where session expiry and the protected foreign-replica exit land: back to Login WITHOUT
 * touching the replica.
 * The owner (or the same human after a server rebuild handed them a new user id) signs back in,
 * their stamp matches again, and the ledger plus every queued op resume where they stopped.
 *
 * Ordinary explicit sign-out uses the separate signOut flow and clears local account data after
 * handling pending writes. A foreign replica is the exception because it is not owned by the
 * signed-in session and may be the previous owner's last copy.
 */
export function enterLoginPreservingReplica(): void {
  identityVerifiedFor = null;
  identityBlocked = false; // a NEW session must be verified from scratch — see ensureIdentity
  enterUnauthed(); // Login screen, replica intact
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
  setOwnerUnproven(true); // STICKY: it survives the "syncing" of every re-proof (see ownerUnproven)
  setState("unverified");
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
          return "ours"; // the session's checkpoint opens with the replica's own key
        } catch {
          return "unknown"; // …it does not: a stale key OR another budget — indistinguishable
        }
      }
      const localBudgetId = store.getBudgetId();
      // An UNBOUND replica (no budgetId): it points at no account — neither this one nor
      // another. Adopt it only where being wrong costs nothing: an EMPTY session budget has
      // nothing to lose. Against a session budget that holds data, an unbound replica is exactly
      // the "adopt + overwrite" hole this guard exists to close (it can arrive on the device via
      // a previous reset or an offline start, and it may be another user's).
      if (!localBudgetId) return !bornE2ee && (await sessionBudgetIsEmpty()) ? "ours" : "unknown";
      const server = await fetchServerBudgetId();
      if (!server) return "unknown";
      return localBudgetId === server ? "ours" : "unknown";
    } catch (err) {
      if (err instanceof TierMismatchError) {
        if (attempt === 0) continue; // tierMeta is fresh → prove on the other path
        return "unknown"; // tier keeps flapping — inconclusive, so: no writes
      }
      throw err; // 401 → Login; network/5xx → the normal backoff
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
export async function ensureIdentity(): Promise<string | null> {
  const sessionUserId = await fetchSessionUserId(); // 5xx/network THROWS (≠ "signed out")
  // unauthorized() routes the app to Login — crucial for the writers OUTSIDE doCycle
  // (assertOwnReplica / replaceServer / resetServerE2ee), which have no 401 handler of their own
  if (!sessionUserId) throw unauthorized();
  if (identityVerifiedFor !== sessionUserId) {
    const stamped = await idbGet<string>("meta", "userId").catch(() => undefined);
    const verdict = decideIdentity(sessionUserId, stamped);
    if (verdict === "unauthed") throw unauthorized(); // defensive (sessionUserId is set)
    // The stamp names another account: refuse every write; enterForeignReplica then either hands
    // the decision to the HUMAN (selfhost — a stamp mismatch is not proof that the data is
    // expendable, only that it must not be written into THIS account's budget) or, on cloud,
    // discards the previous account's local data and reloads.
    if (verdict === "foreign") {
      enterForeignReplica();
      return null;
    }
    if (!stamped && (await proveOwnership()) === "unknown") {
      enterUnverified(); // inconclusive → no write, no wipe, no adoption; retried next cycle
      return null;
    }
    await persist.putMeta("userId", sessionUserId); // stamp the owner next to the replica
    identityVerifiedFor = sessionUserId;
  }
  // Proved (or adopted): the replica's owner is no longer in question — clear the sticky fact, so
  // the badge, the Settings dot and the Sync section stop saying "not sending".
  setOwnerUnproven(false);
  // The session is back (e.g. the user signed in in ANOTHER tab) while this tab sits on
  // Login: the replica is intact and belongs to this account → back into the app.
  if (store.getBootStatus() === "unauthed" && store.getLedger()) store.setBootStatus("ready");
  return sessionUserId;
}

/** Account whose session and replica stamp have been matched in this tab. */
export function verifiedIdentityUserId(): string | null {
  return identityVerifiedFor;
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

/**
 * MULTI-TENANT GUARD AT BOOT — runs BEFORE the hydrated replica is handed to the UI, and this is
 * the only place that can protect the READ side.
 *
 * The cycle's guard (ensureIdentity) protects WRITES, but boot renders first and syncs second:
 * store.setBootStatus("ready") on a replica hydrated straight out of IDB, then `void
 * syncNow("boot")`. Between the two, the previous owner's ENTIRE budget is on screen and
 * editable — and the ways a device changes hands are routine, not exotic: a 90-day cookie
 * expires → Login; a sign-out (which KEEPS the replica — see DataSection/ForeignReplicaScreen) →
 * Login; then the next account signs in.
 *
 * Returns false when the replica may NOT be rendered (BootStatus set to "foreign"/"unauthed").
 * Deliberately NOT a hard gate when the server is unreachable, because the replica can be the
 * LAST copy of a budget and a boot that refuses to show it is its own kind of data loss:
 *  - the server is unreachable (fetchSessionUserId THROWS): being offline is not being somebody
 *    else — local-first wins, and the first cycle that does reach the server enforces the verdict.
 * A reachable server with no session always routes to Login before rendering; the replica and
 * outbox remain untouched so the owner can sign back in without losing queued work.
 */
export interface BootOwnerVerdict {
  ok: boolean;
  /** Session account whose preferences may be shown; this does not prove replica ownership. */
  preferenceUserId: string | null;
}

export async function bootOwnerOk(): Promise<BootOwnerVerdict> {
  const stamped = await idbGet<string>("meta", "userId").catch(() => undefined);
  if (!stamped) {
    // There is no replica owner to compare yet, but the current SESSION still owns the
    // account-scoped UI preferences. Resolve it before boot releases the splash; ownership of
    // the ledger remains unproven and the cycle's proveOwnership still guards every write.
    let sessionUser: string | null;
    try {
      sessionUser = await fetchSessionUserId();
    } catch {
      return { ok: true, preferenceUserId: null }; // offline: local-first, no identity to hydrate
    }
    if (!sessionUser) {
      enterUnauthed();
      return { ok: false, preferenceUserId: null };
    }
    return { ok: true, preferenceUserId: sessionUser };
  }
  let sessionUser: string | null;
  try {
    sessionUser = await fetchSessionUserId();
  } catch {
    // The durable stamp is sufficient to load that account's cached preferences while offline;
    // it still does not permit a write until ensureIdentity reaches the server.
    return { ok: true, preferenceUserId: stamped };
  }
  if (decideIdentity(sessionUser, stamped) === "foreign") {
    enterForeignReplica(); // ForeignReplicaScreen — the other account's budget is never rendered
    return { ok: false, preferenceUserId: null };
  }
  if (!sessionUser) {
    enterUnauthed(); // Login BEFORE the data is on screen; the replica and the outbox stay
    return { ok: false, preferenceUserId: null };
  }
  identityVerifiedFor = sessionUser; // same account — the first cycle needn't re-read the stamp
  return { ok: true, preferenceUserId: sessionUser };
}
