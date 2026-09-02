/**
 * TRANSPORT — request construction, response classification (401 / 409 tier_mismatch /
 * 409 e2ee_upgrade_required / 409 budget_mismatch) and every snapshot/pull/push/replace/reset
 * wire call of the sync engine (workflow §3c-3). Request order, per-request assertions and the
 * v2 AAD inputs are preserved byte-for-byte from the pre-split facade — the request-shape
 * suite (transport.test.ts) pins the exact body key order of every endpoint.
 *
 * Higher-layer effects (identity's enterUnauthed/assertOwnReplica, multitab's peer notice)
 * are injected by the facade via configureTransport — identity and multitab sit ABOVE this
 * module, so importing them here would be a cycle.
 */
import type { ClientLedger, SyncOp } from "@enveo/shared";
import * as e2ee from "../e2ee";
import { idbGet, idbPut } from "../idb";
import * as outbox from "../outbox";
import * as persist from "../persist";
import { runServerWriteOperation } from "../serverWriteOperations";
import type { SignOutPermit } from "../signOutBarrier";
import { requestPersistentStorage } from "../storage";
import { store } from "../store";
import {
  BudgetMismatchError,
  type E2eeSnapshotResponse,
  E2eeUpgradeRequiredError,
  EMPTY_LEDGER,
  type PullResponse,
  type PushResponse,
  type SnapshotResponse,
  TierMismatchError,
  type TransportDeps,
  UnauthorizedError,
} from "./contracts";
import { clearReplacePending, markResyncPending } from "./obligations";
import { e2eeReplicaBudgetId, isEmptyUnboundReplica, replayOutbox } from "./replica";

let deps: TransportDeps | null = null;

/** Wire the higher-layer effects in (called ONCE by the facade at composition time). */
export function configureTransport(d: TransportDeps): void {
  deps = d;
}

function requireDeps(): TransportDeps {
  if (!deps) throw new Error("sync_transport_unconfigured"); // composition bug — never user-reachable
  return deps;
}

/**
 * A 401 from ANY channel (cycle, boot, or an out-of-cycle write such as /sync/replace,
 * /sync2/reset, Settings → E2EE): route the app to the Login screen (enterUnauthed) and hand
 * the caller the error to throw. Callers that do NOT go through doCycle used to let the raw
 * "unauthorized: 401" bubble into an error label instead of making Login reachable.
 */
export function unauthorized(): UnauthorizedError {
  requireDeps().enterUnauthed();
  return new UnauthorizedError();
}

/** 409 e2ee_upgrade_required → record epoch + cipherVersion 1 and throw; other statuses = no-op. */
export async function throwIfUpgradeRequired(res: Response): Promise<void> {
  if (res.status !== 409) return;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: string; epoch?: number; budgetId?: string } | null;
  if (body?.error === "e2ee_upgrade_required") {
    e2ee.setTierMeta({ tier: "e2ee", epoch: body.epoch ?? 0 });
    e2ee.setCipherVersion(1);
    throw new E2eeUpgradeRequiredError(body.epoch ?? 0, body.budgetId ?? null);
  }
}

/** 409 tier_mismatch → update tierMeta and throw; other statuses = no-op. */
export async function throwIfTierMismatch(res: Response): Promise<void> {
  if (res.status !== 409) return;
  // clone(): don't consume the caller's body (error paths read res.text())
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: string; tier?: string; epoch?: number; cipherVersion?: number } | null;
  if (body?.error === "tier_mismatch" && (body.tier === "plain" || body.tier === "e2ee")) {
    e2ee.setTierMeta({ tier: body.tier, epoch: body.epoch ?? 0 });
    // The authoritative answer also names the budget's CURRENT ciphertext format (since round
    // 3). Adopting it here is what lets a device pinned to the upgrade state re-learn that the
    // server is v2 (another device completed the ceremony) and fall back to a normal unlock —
    // without it the durable cipherVersion=1 meta was a one-way trap.
    if (body.cipherVersion === 1 || body.cipherVersion === 2) e2ee.setCipherVersion(body.cipherVersion);
    throw new TierMismatchError(body.tier, body.epoch ?? 0);
  }
}

/** 409 budget_mismatch (push v1/v2) → throw; other statuses = no-op. */
export async function throwIfBudgetMismatch(res: Response): Promise<void> {
  if (res.status !== 409) return;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: string; budgetId?: string } | null;
  if (body?.error === "budget_mismatch") throw new BudgetMismatchError(body.budgetId ?? null);
}

/* ── clientId (stable installation identifier — sent with push) ────────── */

let clientIdPromise: Promise<string> | null = null;

export function getClientId(): Promise<string> {
  if (!clientIdPromise) {
    clientIdPromise = (async () => {
      try {
        const existing = await idbGet<string>("meta", "clientId");
        if (existing) return existing;
        const id = crypto.randomUUID();
        try {
          await idbPut("meta", id, "clientId");
        } catch {
          /* persist best-effort — the id lives in this session's memory */
        }
        return id;
      } catch {
        // IDB read failed — id memory-only (persist best-effort); push must
        // NEVER brick on a missing clientId (D4); the promise resolves, never throws
        const id = crypto.randomUUID();
        void idbPut("meta", id, "clientId").catch(() => {});
        return id;
      }
    })();
  }
  return clientIdPromise;
}

/* ── Snapshot bootstrap ─────────────────────────────────────────────────── */

export async function fetchSnapshot(): Promise<void> {
  const res = await fetch("/api/sync/snapshot");
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res); // budget in e2ee tier → v2 path (bootstrapReplica)
  if (!res.ok) throw new Error(`snapshot: ${res.status}`);
  const snap = (await res.json()) as SnapshotResponse;
  const ledger: ClientLedger = {
    accounts: snap.accounts,
    groups: snap.groups,
    envelopes: snap.envelopes,
    transactions: snap.transactions,
    allocations: snap.allocations,
    categories: snap.categories,
    places: snap.places,
    budgets: snap.budgets ?? [], // defensive: older server without `budgets` in the snapshot
  };
  store.replace(ledger, snap.cursor, snap.budgetId); // memory
  void persist.persistLedger(store.snapshotForPersist()); // durability on the chain
  void requestPersistentStorage(); // persistent storage (anti-eviction iOS) — idempotent
}

/**
 * E2EE path bootstrap: GET /sync2/snapshot → decryptSnapshot → replace the mirror
 * (cursor := the checkpoint's uptoSeq; the journal tail is fetched by the v2 pull in the cycle).
 * Without the DEK nothing can be decrypted → "locked" (the caller sets BootStatus,
 * the Unlock screen from T2 provides the key and does retryBoot). No checkpoint (fresh
 * budget without a POSTed snapshot) → empty ledger + pull from zero.
 */
async function fetchSnapshotE2ee(): Promise<"ready" | "locked"> {
  const dek = e2ee.getDek();
  if (!dek) return "locked";
  const res = await fetch("/api/sync2/snapshot");
  if (res.status === 401) throw unauthorized();
  await throwIfUpgradeRequired(res); // legacy v1-format budget → the explicit upgrade ceremony
  await throwIfTierMismatch(res); // budget flipped back to plain → v1 path (bootstrapReplica)
  if (!res.ok) throw new Error(`sync2 snapshot: ${res.status}`);
  const body = (await res.json()) as E2eeSnapshotResponse;
  e2ee.setTierMeta({ tier: "e2ee", epoch: body.epoch });
  e2ee.setCipherVersion(2); // the server only answers 200 here for a v2-format budget
  // Decryption context: the locally BOUND budget id when this replica has one (caller-expected
  // value — a bootstrap of an already-bound replica must not let the response redefine it); a
  // genuinely fresh device has no local expectation yet and uses the named budget, whose
  // (budgetId, epoch) the DEK's own authenticated unwrap already vouched for (Unlock/pairing).
  // The AAD then binds blob ↔ uptoSeq: a checkpoint served at a false position fails, so the
  // cursor below can only ever start where the blob was really made.
  const expectedBudgetId = e2eeReplicaBudgetId() || body.budgetId || "";
  if (body.blob && !expectedBudgetId) throw new Error("bad_ciphertext"); // no context — cannot authenticate
  let ledger: ClientLedger;
  if (body.blob) {
    try {
      ledger = await e2ee.decryptSnapshot(body.blob, dek, { budgetId: expectedBudgetId, epoch: body.epoch, uptoSeq: body.uptoSeq });
    } catch (err) {
      // Our own codes mean the DATA is unreadable (legacy/malformed) — the key proved nothing
      // either way; keep it and surface the error. Anything else is an AUTHENTICATION failure:
      // the held DEK does not open this generation's checkpoint (the key was rotated on another
      // device). Trust in it is over — drop it (memory AND IDB) and route to Unlock, where the
      // new password or a fresh pairing code re-keys this device. The replica, cursor and
      // outbox stay untouched; the queued ops go out under the NEW key after unlocking.
      const code = err instanceof Error ? err.message : "";
      if (code === "legacy_ciphertext" || code === "bad_ciphertext") throw err;
      e2ee.clearDek();
      return "locked";
    }
    // The authenticated decrypt just PROVED the key opens this generation — record it, so the
    // push/pull precondition (doCycle) accepts the key for exactly this epoch and nothing else.
    e2ee.markDekValidated(body.epoch);
  } else {
    // No checkpoint to validate against: only a key already validated for THIS epoch (it was
    // handed out for it — Unlock/enable/upgrade) may proceed. Never guess — a wrong key here
    // would poison the new journal on the first push. Fail closed to Unlock; the key stays
    // (nothing proved it wrong), and the envelope unwrap there is the validation.
    if (e2ee.getDekEpoch() !== body.epoch) return "locked";
    ledger = EMPTY_LEDGER;
  }
  // The v2 channel is guarded by `epoch`, but the snapshot NAMES its budget: remember it, so
  // this replica can later prove whose it is (multi-tenant guard). An older server omits it
  // → keep whatever we knew (a legacy e2ee replica may end up with no budgetId at all).
  store.replace(ledger, body.uptoSeq, body.budgetId ?? store.getBudgetId() ?? "");
  void persist.persistLedger(store.snapshotForPersist());
  void requestPersistentStorage();
  return "ready";
}

/**
 * Fresh replica on the RIGHT path per tierMeta; a 409 tier_mismatch along the way
 * updates tierMeta (throwIfTierMismatch) and we retry on the OTHER path —
 * exactly once (loop max 1; further flapping = a real error → backoff).
 */
export async function bootstrapReplica(): Promise<"ready" | "locked"> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (e2ee.getTierMeta().tier === "e2ee") return await fetchSnapshotE2ee();
      await fetchSnapshot();
      return "ready";
    } catch (err) {
      if (err instanceof TierMismatchError && attempt === 0) continue; // tierMeta already fresh
      // Legacy v1-format budget: nothing on the v2 path can read it, and re-bootstrapping in a
      // loop would just repeat the 409. "locked" routes the UI to the Unlock screen, which
      // renders the dedicated upgrade state (cipherVersion meta is already 1).
      if (err instanceof E2eeUpgradeRequiredError) return "locked";
      throw err;
    }
  }
}

/* ── Pull (delta with pending-guard) ──────────────────────────────────── */

export async function doPull(): Promise<void> {
  const budgetId = store.getBudgetId();
  if (!store.getLedger() || !budgetId) return; // before bootstrap
  const res = await fetch(`/api/sync/pull?since=${store.getCursor()}`);
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res); // budget switched to e2ee → re-bootstrap on the v2 path
  if (!res.ok) throw new Error(`pull: ${res.status}`);
  const body = (await res.json()) as PullResponse;
  if (body.budgetId !== budgetId || body.resetRequired) {
    // The server answered for a DIFFERENT budget than this replica mirrors (or asked for a
    // reset): a new data epoch (wipe+reseed / DB restore / trimmed log) — OR the shared cookie
    // was swapped mid-cycle and this is another ACCOUNT's budget. The two are indistinguishable
    // HERE (budgetId is the epoch marker, not a tenant id), and the difference decides between a
    // recovery and a cross-tenant disaster — so we only record the DURABLE resync obligation and
    // let its consumer (resyncVerified, after push+pull) settle it by RE-VERIFYING the session.
    // A transient blip won't lose the obligation.
    markResyncPending();
    return;
  }
  if (body.changes.length > 0) {
    store.applyPulled(body.changes, body.cursor, outbox.pendingKeys()); // memory
    void persist.persistLedger(store.snapshotForPersist()); // durability on the chain
    requireDeps().notePeersMayNeedUpdate(); // other tabs rehydrate from IDB (BroadcastChannel)
  } else if (body.cursor !== store.getCursor()) {
    // The cursor is the GLOBAL `changes` sequence, so it also advances on OTHER tenants' writes
    // (their rows are filtered out of our delta — see the pull route). Take the new cursor in
    // memory, but do NOT re-render and do NOT rewrite the whole ledger blob in IDB for it: on a
    // busy multi-user instance that would be constant, pointless churn. A cursor that lags in
    // IDB costs at most one redundant (idempotent) delta after a reload.
    store.setCursor(body.cursor);
  }
}

/**
 * E2EE path pull: ciphertext delta from the e2ee_ops journal → decryptOps →
 * store.applyRemoteOps (applyOp one by one). We advance the cursor to the seq of the LAST
 * applied row (not to the server's global cursor — with LIMIT 1000
 * we would skip the middle of the journal); the loop fetches further pages right away.
 * Own ops WAITING in the outbox are skipped (the pending-guard equivalent),
 * and after applying we REPLAY the outbox — this tab's optimistic state doesn't roll
 * back even when the journal carried an older version of the same entity.
 */
export async function doPullE2ee(dek: Uint8Array, userId: string, permit?: SignOutPermit): Promise<void> {
  if (!store.getLedger()) return; // before bootstrap
  // Decryption context = CALLER-EXPECTED values: the budget this replica is locally bound to
  // and the epoch WE requested — never the response's own metadata, which would let a malicious
  // store redefine the expected AAD and bless its own substitution. A replica that cannot name
  // its budget cannot authenticate anything → fail closed (no legacy tolerance on this path).
  const budgetId = e2eeReplicaBudgetId();
  if (!budgetId) throw new Error("e2ee: replica names no budget"); // internal abort — doCycle catch-all, never rendered
  for (;;) {
    const epoch = e2ee.getTierMeta().epoch;
    const res = await fetch(`/api/sync2/pull?since=${store.getCursor()}&epoch=${epoch}`);
    if (res.status === 401) throw unauthorized();
    await throwIfUpgradeRequired(res); // legacy v1-format budget → the explicit upgrade ceremony
    await throwIfTierMismatch(res); // flip/epoch → re-bootstrap (catch in doCycle)
    if (!res.ok) throw new Error(`sync2 pull: ${res.status}`);
    const body = (await res.json()) as {
      cursor: number;
      epoch: number;
      ops: Array<{ seq: number; opId: string; ciphertext: string }>;
    };
    if (body.ops.length === 0 && body.cursor === store.getCursor()) return;
    // A failed decrypt (substituted/foreign/tampered row) throws HERE — before any op reaches
    // the mirror and before the cursor advances: nothing is applied, nothing is skipped.
    const ops = await e2ee.decryptOps(body.ops, dek, { budgetId, epoch });
    const ownPending = new Set(outbox.snapshot().map((en) => en.op.opId));
    const nextCursor = body.ops.length > 0 ? body.ops[body.ops.length - 1]!.seq : body.cursor;
    store.applyRemoteOps(ops, nextCursor, ownPending);
    replayOutbox(); // this tab's optimistic ops back on top (idempotent)
    void persist.persistLedger(store.snapshotForPersist());
    requireDeps().notePeersMayNeedUpdate();
    e2ee.noteOpsSeen(body.ops.length);
    // Checkpoint every SNAPSHOT_EVERY_OPS ops — best-effort, doesn't block the cycle. It is a
    // WRITE (it overwrites the session budget's whole checkpoint), so it carries the tenant this
    // cycle verified: fired in the background, it is the LAST thing to reach the server in a
    // cycle and the widest open window for a cookie swapped in another tab.
    void e2ee.maybeUploadSnapshot(store.getLedger(), store.getCursor(), userId, budgetId, permit).catch(() => {});
    if (body.ops.length === 0 || nextCursor >= body.cursor) return; // journal caught up
  }
}

/* ── Push wire calls (the batching/ack loop itself lives in the cycle) ── */

/**
 * POST /api/sync/push — one v1 batch. Every request NAMES the budget it is for (PER-REQUEST
 * tenant assertion): the identity guard runs ONCE per cycle, but a cycle makes N writes, and
 * the session cookie is shared by all tabs — a sign-out+sign-in elsewhere can swap it BETWEEN
 * two batches, and the server resolves the target budget from the cookie alone. Without the
 * assertion the remaining batches would be applied to the NEW user's budget (fresh creates
 * pass every FK guard). The server refuses a mismatch with 409 budget_mismatch and writes
 * nothing.
 */
export function pushPlainBatch(ops: SyncOp[], permit?: SignOutPermit): Promise<PushResponse> {
  return runServerWriteOperation("sync-push", () => pushPlainBatchImpl(ops), permit);
}

async function pushPlainBatchImpl(ops: SyncOp[]): Promise<PushResponse> {
  const res = await fetch("/api/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: await getClientId(),
      budgetId: store.getBudgetId() || undefined,
      ops,
    }),
  });
  if (!res.ok) {
    if (res.status === 401) throw unauthorized();
    await throwIfTierMismatch(res); // budget switched to e2ee → re-bootstrap on the v2 path
    await throwIfBudgetMismatch(res); // not the session's budget → nothing was written
    if (res.status < 500 && res.status !== 429) {
      // 4xx on the WHOLE request (broken batch) = a bug — we don't dead-letter
      console.error("sync push: unexpected 4xx", res.status, await res.text().catch(() => ""));
    }
    throw new Error(`push: ${res.status}`);
  }
  return (await res.json()) as PushResponse;
}

/**
 * POST /api/sync2/push — one v2 batch of already-encrypted rows. budgetId = the PER-REQUEST
 * tenant assertion (see pushPlainBatch) — in v2 it is also the authenticated op context, so it
 * is REQUIRED, never optional. HTTP success = whole batch accepted (applied/duplicate).
 */
export function pushE2eeBatch(epoch: number, budgetId: string, ops: e2ee.CipherOp[], permit?: SignOutPermit): Promise<void> {
  return runServerWriteOperation("sync-push", () => pushE2eeBatchImpl(epoch, budgetId, ops), permit);
}

async function pushE2eeBatchImpl(epoch: number, budgetId: string, ops: e2ee.CipherOp[]): Promise<void> {
  const res = await fetch("/api/sync2/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epoch, budgetId, ops }),
  });
  if (res.status === 401) throw unauthorized();
  await throwIfUpgradeRequired(res); // legacy v1-format budget → ceremony; ops STAY queued
  await throwIfTierMismatch(res); // flip/epoch → re-bootstrap; ops STAY in the outbox
  await throwIfBudgetMismatch(res); // not the session's budget → nothing was written
  if (!res.ok) throw new Error(`sync2 push: ${res.status}`);
}

/* ── Ownership-proof probes (READS — consumed by identity.proveOwnership) ── */

/**
 * The budget the SESSION owns on the v1 path. A delta pull at the current cursor: normally
 * an empty response, and a READ, so it may run before the push loop.
 */
export async function fetchServerBudgetId(): Promise<string | null> {
  const res = await fetch(`/api/sync/pull?since=${store.getCursor()}`);
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res);
  if (!res.ok) throw new Error(`pull: ${res.status}`);
  const body = (await res.json()) as PullResponse;
  return body.budgetId ?? null;
}

/**
 * Is the budget the SESSION owns provably EMPTY — i.e. is there anything a write from this
 * replica could destroy? A READ (GET /sync/snapshot; it does NOT touch the mirror — fetchSnapshot
 * does). The budget ROW itself is ignored: it always exists (it is what `budgets` carries).
 */
export async function sessionBudgetIsEmpty(): Promise<boolean> {
  const res = await fetch("/api/sync/snapshot");
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res);
  if (!res.ok) throw new Error(`snapshot: ${res.status}`);
  const snap = (await res.json()) as SnapshotResponse;
  return (
    snap.accounts.length === 0 &&
    snap.groups.length === 0 &&
    snap.envelopes.length === 0 &&
    snap.transactions.length === 0 &&
    snap.allocations.length === 0 &&
    snap.categories.length === 0 &&
    snap.places.length === 0
  );
}

/** The budget the SESSION owns on the v2 path + its checkpoint (a READ; no DEK needed).
 *  A 409 e2ee_upgrade_required still NAMES the session's budget — the ownership proof needs
 *  exactly that id before the upgrade ceremony may write, so it is an identity answer here
 *  (with no readable checkpoint), not an error. epoch/uptoSeq ride along for the DEK-fallback
 *  proof, whose decrypt needs the checkpoint's claimed context. */
export async function fetchServerE2eeIdentity(): Promise<{ budgetId: string | null; blob: string | null; epoch: number; uptoSeq: number }> {
  const res = await fetch("/api/sync2/snapshot");
  if (res.status === 401) throw unauthorized();
  if (res.status === 409) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: string; epoch?: number; budgetId?: string } | null;
    if (body?.error === "e2ee_upgrade_required") {
      e2ee.setTierMeta({ tier: "e2ee", epoch: body.epoch ?? 0 });
      e2ee.setCipherVersion(1);
      return { budgetId: body.budgetId ?? null, blob: null, epoch: body.epoch ?? 0, uptoSeq: 0 };
    }
  }
  await throwIfTierMismatch(res);
  if (!res.ok) throw new Error(`sync2 snapshot: ${res.status}`);
  const body = (await res.json()) as E2eeSnapshotResponse;
  return { budgetId: body.budgetId ?? null, blob: body.blob, epoch: body.epoch, uptoSeq: body.uptoSeq };
}

/* ── Full-budget overwrites (server := local) ───────────────────────────── */

/**
 * POST /sync/replace — full replacement of the server replica with the given ledger. Returns
 * the cursor (maxSeq after the write). Throws with the server message (apiErrorMessage-compatible)
 * on !ok — the whole server operation is atomic (either the entire replace or nothing).
 */
async function replaceServer(ledger: ClientLedger): Promise<{ budgetId: string; cursor: number }> {
  // MULTI-TENANT GUARD — /sync/replace is reachable OUTSIDE a cycle (a JSON import replaces
  // the mirror), so the
  // check cannot live in doCycle alone: replacing ANOTHER account's budget with this replica
  // is the worst write of all. The verdict for an already-verified session is reused, so
  // inside a cycle this costs one cheap /api/auth/get-session.
  const userId = await requireDeps().assertOwnReplica(); // foreign/unverified — no write
  const res = await fetch("/api/sync/replace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // PER-REQUEST owner assertion: the guard above ran in a DIFFERENT request, and the cookie is
    // shared by every tab — a sign-in elsewhere can complete while this ledger is being
    // serialized and uploaded (seconds on mobile for a big budget), after which the server would
    // resolve the NEW user's budget and this restore would wipe and overwrite it. Naming the
    // verified tenant in the body closes that window at the only place that can: the write
    // itself (409 budget_mismatch ⇒ the server wrote nothing).
    body: JSON.stringify({ ledger, userId }),
  });
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res); // e2ee tier: replace v1 unavailable (import → /sync2/reset, T4)
  await throwIfBudgetMismatch(res); // the session was swapped mid-upload → nothing was written
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`); // UI: apiErrorMessage extracts { error }
  }
  return (await res.json()) as { budgetId: string; cursor: number };
}

/**
 * Upload the ENTIRE local mirror to the server (server := local). On success: the queue is
 * moot (outbox.clearAll — server == local), cursor := the returned maxSeq
 * (a pull from that point fetches nothing) and budgetId := the canonical one from the server
 * (consistent epoch — the next pull won't force a needless fullResync). Also fulfills the durable
 * replace obligation (backup import). Throws on failure (server untouched, the flag stays up).
 */
export function pushLocalToServer(permit?: SignOutPermit): Promise<void> {
  return runServerWriteOperation("backup-replace", () => pushLocalToServerImpl(), permit);
}

async function pushLocalToServerImpl(): Promise<void> {
  const ledger = store.getLedger();
  // Error CODES, never prose: this is reachable from the UI (backup import)
  // and lib/api.ts owns the wording in every locale (ERROR_KEYS → apiErrorMessage).
  if (!ledger) throw new Error("no_local_replica");
  // Nothing to upload, everything to lose: an empty replica bound to no budget can only wipe the
  // session user's budget (see isEmptyUnboundReplica). Refuse rather than turning an empty,
  // unbound client state into a destructive full-budget replacement.
  if (isEmptyUnboundReplica()) throw new Error("empty_unbound_replica");
  const { budgetId, cursor } = await replaceServer(ledger);
  outbox.clearAll(); // server == local → queued ops are already reflected
  store.replace(ledger, cursor, budgetId); // same replica + canonical cursor/budgetId
  void persist.persistLedger(store.snapshotForPersist());
  clearReplacePending(); // server == local → the replace obligation (if any) is fulfilled
}

/**
 * The pushLocalToServer counterpart for the E2EE path (JSON backup import in the e2ee tier):
 * server := ENCRYPTED checkpoint of the local mirror. POST /sync2/reset deletes
 * the budget's entire e2ee_ops journal and swaps the snapshot (epoch UNCHANGED — this is
 * compaction/restore, not a tier flip). uptoCursor = this tab's current cursor:
 * seq (bigserial) doesn't go backwards after a delete, so subsequent pushes get
 * seq > cursor and pull loses nothing. On success the queue is moot
 * (outbox.clearAll) and the replace obligation fulfilled. Throws on failure (server
 * untouched — the replacePending flag stays up, doCycle retries).
 */
export function resetServerE2ee(dek?: Uint8Array, permit?: SignOutPermit): Promise<void> {
  return runServerWriteOperation("e2ee-reset", () => resetServerE2eeImpl(dek), permit);
}

async function resetServerE2eeImpl(dek?: Uint8Array): Promise<void> {
  // MULTI-TENANT GUARD — as in replaceServer: /sync2/reset DELETES the session user's whole
  // journal and swaps their checkpoint, and it is reachable outside a cycle (disable local
  // mode, JSON import). Two independently-e2ee budgets both sit at epoch 1, so the server's
  // epoch check would happily accept another account's ciphertext here.
  const userId = await requireDeps().assertOwnReplica(); // foreign/unverified — no write
  const ledger = store.getLedger();
  // Error CODES, never prose — see pushLocalToServer (both are reachable from Settings).
  if (!ledger) throw new Error("no_local_replica");
  const key = dek ?? e2ee.getDek();
  if (!key) throw new Error("no_encryption_key");
  // The key must be VALIDATED for the epoch this ciphertext claims — UNCONDITIONALLY, explicit
  // parameter or not (round 3, R1: the explicit-key call path bypassed the module-key guard,
  // making it dead code). An unvalidated key may be a dead generation's, and this route swaps
  // the budget's ONLY checkpoint after deleting the whole journal — no caller may bypass.
  if (!e2ee.isDekValidForEpoch(e2ee.getTierMeta().epoch)) throw new Error("no_encryption_key");
  // The snapshot AAD binds the blob to (budgetId, epoch, uptoSeq) — a replica that cannot name
  // its budget cannot produce an authenticated checkpoint and must not write (fail-closed).
  const budgetId = e2eeReplicaBudgetId();
  if (!budgetId) throw new Error("foreign_replica");
  const cursor = store.getCursor();
  const epoch = e2ee.getTierMeta().epoch;
  const snapshotBlob = await e2ee.encryptSnapshot(ledger, key, { budgetId, epoch, uptoSeq: cursor });
  const res = await fetch("/api/sync2/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // userId = the PER-REQUEST owner assertion (see replaceServer): encrypting and uploading a
    // whole replica takes seconds, and the epoch does NOT distinguish tenants (two independently
    // encrypted budgets both sit at epoch 1) — the server refuses a session it did not verify.
    body: JSON.stringify({
      epoch,
      uptoCursor: cursor,
      snapshotBlob,
      userId,
    }),
  });
  if (res.status === 401) throw unauthorized();
  await throwIfUpgradeRequired(res); // legacy v1-format budget → the explicit upgrade ceremony
  await throwIfTierMismatch(res); // flip meanwhile → tierMeta fresh; the cycle retries on the right path
  await throwIfBudgetMismatch(res); // the session was swapped mid-upload → nothing was written
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`); // UI: apiErrorMessage extracts { error }
  }
  outbox.clearAll(); // server == ciphertext of local → pre-import ops are moot
  e2ee.resetOpsCounter(); // fresh checkpoint — the counter to the next one starts from zero
  clearReplacePending(); // replace obligation fulfilled
}
