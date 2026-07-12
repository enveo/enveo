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
 * - boot: hydrate mirror + outbox → (empty ⇒ snapshot) → REPLAY outbox
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
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { fetchSessionUserId } from "./auth";
import * as e2ee from "./e2ee";
import { clearLocalData, idbGet, idbPut } from "./idb";
import * as outbox from "./outbox";
import * as persist from "./persist";
import { requestPersistentStorage } from "./storage";
import { store, type PullChange } from "./store";

interface SnapshotResponse extends ClientLedger {
  budgetId: string;
  cursor: number;
}

interface PullResponse {
  budgetId: string;
  cursor: number;
  resetRequired: boolean;
  changes: PullChange[];
}

interface PushResponse {
  budgetId: string;
  results: Array<{ opId: string; status: "applied" | "duplicate" | "rejected"; error?: string }>;
}

/** GET /sync2/snapshot — `budgetId` is absent on servers older than 2.0. */
interface E2eeSnapshotResponse {
  budgetId?: string | null;
  epoch: number;
  wrappedDek: string | null;
  kdfParams: string | null;
  uptoSeq: number;
  blob: string | null;
}

const PUSH_BATCH = 100;
const BACKOFF_MAX_MS = 60_000;
const POKE_DEBOUNCE_MS = 300;
const INTERVAL_MS = 60_000;

/**
 * HTTP 401 (missing/expired session) — a "please log in" signal,
 * NOT a network failure: no retry/backoff loop. During boot → BootStatus "unauthed"
 * (login screen), while running → SyncState "unauthed" (badge).
 */
class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized: 401");
    this.name = "UnauthorizedError";
  }
}

/**
 * A 401 from ANY channel (cycle, boot, or an out-of-cycle write such as /sync/replace,
 * /sync2/reset, Settings → E2EE): route the app to the Login screen (enterUnauthed) and hand
 * the caller the error to throw. Callers that do NOT go through doCycle used to let the raw
 * "unauthorized: 401" bubble into an error label, which is a dead end on a device in local
 * mode "wiped": boot never touches the network there, so BootStatus stays "ready" and the
 * Login screen was unreachable — while the local replica is the ONLY copy of the budget.
 */
function unauthorized(): UnauthorizedError {
  enterUnauthed();
  return new UnauthorizedError();
}

/**
 * HTTP 409 { error: "tier_mismatch", tier, epoch } — the budget is in a DIFFERENT tier
 * (or a different e2ee epoch) than the called channel assumes. It's a "switch path" signal,
 * NOT a failure: throwIfTierMismatch updates tierMeta from the body BEFORE throwing,
 * and the catcher does a hard re-bootstrap (fresh snapshot on the right path).
 */
export class TierMismatchError extends Error {
  constructor(
    public readonly tier: e2ee.Tier,
    public readonly epoch: number,
  ) {
    super(`tier_mismatch: ${tier}/${epoch}`);
    this.name = "TierMismatchError";
  }
}

/**
 * HTTP 409 { error: "budget_mismatch", budgetId } — the PER-REQUEST tenant assertion failed:
 * the budget this replica names in the push body is not the budget the session owns. The
 * server wrote NOTHING. Two ways to get here, and the handler (handleBudgetMismatch) tells
 * them apart by re-verifying the session:
 *  - the session was swapped between two batches of the SAME push loop (the cookie is shared
 *    by all tabs, and one cycle can push many batches) — a cross-tenant write, refused,
 *  - the same user's budget was rotated (wipe+reseed, DB restore, reattach) — a new data
 *    epoch, which is exactly what fullResync is for.
 */
class BudgetMismatchError extends Error {
  constructor(public readonly serverBudgetId: string | null) {
    super(`budget_mismatch: ${serverBudgetId ?? "?"}`);
    this.name = "BudgetMismatchError";
  }
}

/** 409 tier_mismatch → update tierMeta and throw; other statuses = no-op. */
async function throwIfTierMismatch(res: Response): Promise<void> {
  if (res.status !== 409) return;
  // clone(): don't consume the caller's body (error paths read res.text())
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: string; tier?: string; epoch?: number } | null;
  if (body?.error === "tier_mismatch" && (body.tier === "plain" || body.tier === "e2ee")) {
    e2ee.setTierMeta({ tier: body.tier, epoch: body.epoch ?? 0 });
    throw new TierMismatchError(body.tier, body.epoch ?? 0);
  }
}

/** 409 budget_mismatch (push v1/v2) → throw; other statuses = no-op. */
async function throwIfBudgetMismatch(res: Response): Promise<void> {
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

/* ── Local mode (offline / privacy) ─────────────────────────────────────
 *
 * Tri-state (NOT a boolean) — key to the "we never lose data" promise:
 *  - "off"    — normal synchronization with the server,
 *  - "paused" — offline by choice: sync SUSPENDED, server data STAYS,
 *               the outbox grows and flushes on resume (safe, no network),
 *  - "wiped"  — privacy: data DELETED from the server (a deliberate, separate choice);
 *               local mirror untouched, on disable we upload it back.
 *
 * Module flag read at load time (BEFORE React), kept in localStorage
 * (keys under the old brand are migrated by storage.ts, imported by this module).
 * Migration of the old boolean "enveo.localOnly"==="true" → "paused" (the SAFE state,
 * no server destruction). */
export type LocalMode = "off" | "paused" | "wiped";

const LOCAL_MODE_KEY = "enveo.localMode";
const LEGACY_LOCAL_KEY = "enveo.localOnly";

function readLocalMode(): LocalMode {
  try {
    const v = localStorage.getItem(LOCAL_MODE_KEY);
    if (v === "off" || v === "paused" || v === "wiped") return v;
    if (localStorage.getItem(LEGACY_LOCAL_KEY) === "true") {
      // migrate to the SAFE state (paused doesn't wipe the server)
      try {
        localStorage.setItem(LOCAL_MODE_KEY, "paused");
        localStorage.removeItem(LEGACY_LOCAL_KEY);
      } catch {
        /* ignore */
      }
      return "paused";
    }
  } catch {
    /* localStorage unavailable — treat as off */
  }
  return "off";
}

let localMode: LocalMode = readLocalMode();

/** Current local mode (off/paused/wiped). */
export function getLocalMode(): LocalMode {
  return localMode;
}

/** Whether local mode is on (paused OR wiped) — sync is suspended. */
export function isLocalOnly(): boolean {
  return localMode !== "off";
}

/** Empty ledger — server wipe (/sync/replace) and UI init when there is no local replica. */
export const EMPTY_LEDGER: ClientLedger = {
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  recurrences: [],
  budgets: [],
};

/* ── Boot diagnostics (where the replica started from — shown in Settings) ──
 *  "replica"  — hydrate from IDB yielded data: fast, local-first works,
 *  "snapshot" — empty replica ⇒ full fetchSnapshot: slow (this is also what
 *               a cold start AFTER iOS IDB eviction looks like),
 *  "local"    — local mode (no network),
 *  null       — before boot / first-start error. */
export type BootSource = "replica" | "snapshot" | "local" | null;
let lastBootSource: BootSource = null;
export function getLastBootSource(): BootSource {
  return lastBootSource;
}

/* ── Sync status (consumed by the UI in Phase 5) ────────────────────── */

export type SyncState = "synced" | "syncing" | "offline" | "error" | "local" | "unauthed";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  deadLetters: number;
  lastSyncAt: string | null;
  localMode: LocalMode;
}

let syncState: SyncState = localMode !== "off" ? "local" : "synced";
let lastSyncAt: string | null = null;
const statusListeners = new Set<() => void>();
let statusSnapshot: SyncStatus = {
  state: syncState,
  pending: 0,
  deadLetters: 0,
  lastSyncAt: null,
  localMode,
};

function bumpStatus(): void {
  statusSnapshot = {
    state: syncState,
    pending: outbox.size(),
    deadLetters: outbox.getDeadLetters().length,
    lastSyncAt,
    localMode,
  };
  for (const fn of statusListeners) fn();
}

function setState(s: SyncState): void {
  if (syncState === s) {
    bumpStatus(); // counters may have changed
    return;
  }
  syncState = s;
  bumpStatus();
}

/** Status snapshot (stable reference between changes — useSyncExternalStore). */
export function getSyncStatus(): SyncStatus {
  return statusSnapshot;
}

export function subscribeSyncStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

// every outbox queue change (add/ack/dead-letter) refreshes the status
outbox.setOnChange(bumpStatus);

/* ── Backoff (network / 5xx / 429) ──────────────────────────────────── */

let backoffMs = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRetry(): void {
  backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  const jitter = backoffMs * (0.7 + Math.random() * 0.6); // ±30%
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void syncNow("retry"), jitter);
}

function resetBackoff(): void {
  backoffMs = 0;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

/* ── Durable resync obligation (D1) ────────────────────────────────────── */

/**
 * Kept ACROSS cycles and (mirrored in IDB) across reloads. An op rejected
 * by the server leaves a phantom in the mirror that ONLY snapshot+replay removes
 * (the server never accepted the client's id, so no tombstone will ever arrive
 * via pull). If the obligation were cycle-local, a transient blip in doPull/snapshot
 * after the rejection would lose it FOREVER. Consumed EXCLUSIVELY in doCycle after push+pull.
 */
let resyncPending = false;

function markResyncPending(): void {
  resyncPending = true;
  void persist.putMeta("resyncPending", true);
}

function clearResyncPending(): void {
  resyncPending = false;
  void persist.putMeta("resyncPending", false);
}

/* ── Durable REPLACE obligation (JSON backup import) ─────────────────────
 *
 * A backup import makes the LOCAL mirror canonical — it must REPLACE the server
 * (pushLocalToServer → /sync/replace), NEVER the other way around. When the push is DEFERRED
 * (local mode — no network) or FAILS (network/5xx), the next cycle
 * (consumer in doCycle) / resume will FINISH the replace. Without this durable
 * obligation, a delta pull(since=0) after the import would revert the imported data to
 * the (old) server state — silent loss of the restore. Persisted BEFORE swapping
 * the mirror on the SAME serial persist chain, so: durable-mirror ⟹
 * durable-flag (a crash won't leave an imported mirror without the obligation
 * to push it). Consumed EXCLUSIVELY in doCycle (under the syncNow mutex). */
let replacePending = false;

/** Set the durable replace obligation (called from backup import BEFORE swapping the mirror). */
export function markReplacePending(): void {
  replacePending = true;
  void persist.putMeta("replacePending", true);
}

function clearReplacePending(): void {
  replacePending = false;
  void persist.putMeta("replacePending", false);
}

/* ── Snapshot / fullResync ───────────────────────────────────────────── */

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
    recurrences: snap.recurrences,
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
  await throwIfTierMismatch(res); // budget flipped back to plain → v1 path (bootstrapReplica)
  if (!res.ok) throw new Error(`sync2 snapshot: ${res.status}`);
  const body = (await res.json()) as E2eeSnapshotResponse;
  e2ee.setTierMeta({ tier: "e2ee", epoch: body.epoch });
  const ledger = body.blob ? await e2ee.decryptSnapshot(body.blob, dek) : EMPTY_LEDGER;
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
async function bootstrapReplica(): Promise<"ready" | "locked"> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (e2ee.getTierMeta().tier === "e2ee") return await fetchSnapshotE2ee();
      await fetchSnapshot();
      return "ready";
    } catch (err) {
      if (err instanceof TierMismatchError && attempt === 0) continue; // tierMeta already fresh
      throw err;
    }
  }
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
  void persist.persistLedger(store.snapshotForPersist()); // mirror after replay
  notePeersMayNeedUpdate(); // fresh snapshot → other tabs rehydrate from IDB
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

/** Re-apply all outbox ops onto the mirror (reducers are idempotent). */
function replayOutbox(): void {
  if (!store.getLedger()) return;
  for (const entry of outbox.snapshot()) {
    try {
      store.applyLocal(entry.op);
    } catch (e) {
      console.warn("replay of an outbox op failed", entry.op, e);
    }
  }
}

/* ── Pull (delta with pending-guard) ──────────────────────────────────── */

async function doPull(): Promise<void> {
  const budgetId = store.getBudgetId();
  if (!store.getLedger() || !budgetId) return; // before bootstrap
  const res = await fetch(`/api/sync/pull?since=${store.getCursor()}`);
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res); // budget switched to e2ee → re-bootstrap on the v2 path
  if (!res.ok) throw new Error(`pull: ${res.status}`);
  const body = (await res.json()) as PullResponse;
  if (body.budgetId !== budgetId || body.resetRequired) {
    // new data epoch (wipe+reseed / trimmed log) — DURABLE resync obligation;
    // the consumer in doCycle (after pull) will run doFullResync. A transient blip won't lose it.
    markResyncPending();
    return;
  }
  if (body.changes.length > 0) {
    store.applyPulled(body.changes, body.cursor, outbox.pendingKeys()); // memory
    void persist.persistLedger(store.snapshotForPersist()); // durability on the chain
    notePeersMayNeedUpdate(); // other tabs rehydrate from IDB (BroadcastChannel)
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
async function doPullE2ee(dek: Uint8Array): Promise<void> {
  if (!store.getLedger()) return; // before bootstrap
  for (;;) {
    const epoch = e2ee.getTierMeta().epoch;
    const res = await fetch(`/api/sync2/pull?since=${store.getCursor()}&epoch=${epoch}`);
    if (res.status === 401) throw unauthorized();
    await throwIfTierMismatch(res); // flip/epoch → re-bootstrap (catch in doCycle)
    if (!res.ok) throw new Error(`sync2 pull: ${res.status}`);
    const body = (await res.json()) as {
      cursor: number;
      epoch: number;
      ops: Array<{ seq: number; opId: string; ciphertext: string }>;
    };
    if (body.ops.length === 0 && body.cursor === store.getCursor()) return;
    const ops = await e2ee.decryptOps(body.ops, dek);
    const ownPending = new Set(outbox.snapshot().map((en) => en.op.opId));
    const nextCursor = body.ops.length > 0 ? body.ops[body.ops.length - 1]!.seq : body.cursor;
    store.applyRemoteOps(ops, nextCursor, ownPending);
    replayOutbox(); // this tab's optimistic ops back on top (idempotent)
    void persist.persistLedger(store.snapshotForPersist());
    notePeersMayNeedUpdate();
    e2ee.noteOpsSeen(body.ops.length);
    // checkpoint every SNAPSHOT_EVERY_OPS ops — best-effort, doesn't block the cycle
    void e2ee.maybeUploadSnapshot(store.getLedger(), store.getCursor()).catch(() => {});
    if (body.ops.length === 0 || nextCursor >= body.cursor) return; // journal caught up
  }
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
 * TWO LAYERS, because this check is about a MOVING target (the cookie is shared by every tab
 * and can be swapped mid-cycle, while one cycle makes many server writes):
 *  1. per CYCLE — ensureIdentity() below: no write of any kind until the session's user id has
 *     been compared with the one stamped next to the replica,
 *  2. per REQUEST — every push body NAMES the budget it is for, and the server 409s
 *     (budget_mismatch) when that is not the budget the session owns. The window between the
 *     identity check and the Nth batch is thus closed at the only place that can close it
 *     completely: the same request that carries the write.
 *
 * Therefore no server write may happen before the session's user id is compared with the
 * one stamped next to the replica (IDB meta "userId"):
 *  - no session   → UnauthorizedError → Login (this is ALSO the re-auth path: an expired
 *                   cookie now reaches the login screen instead of a muted badge),
 *  - other user   → FOREIGN replica: wipe local data + reload, so the boot after the
 *                   reload bootstraps a clean replica for the signed-in account,
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
 * ONLY the stamp can prove FOREIGN (and only that verdict wipes). An unstamped replica whose
 * proof fails is merely UNPROVEN: budgetId is not a tenant id but the replica EPOCH marker
 * (api/context.ts — a wipe+reseed, a DB restore, and the lazy creation of an empty budget for
 * a user who has none all mint a new one), so "the session's budget id differs from mine" is
 * exactly what the 2.0 upgrade path looks like: a pre-2.0 device holds an unstamped replica of
 * budget B_old, the owner registers, the pull lazily creates the empty B_new — and the ledger
 * plus every queued op would be destroyed on a false positive. Unproven therefore refuses every
 * server write and waits (a later cycle re-proves; a stamped replica in the same situation is
 * already handled non-destructively by the resync path).
 */

export type IdentityVerdict = "unauthed" | "foreign" | "ok";

/** Pure decision: what to do with a replica stamped `stamped` under session `sessionUserId`. */
export function decideIdentity(
  sessionUserId: string | null,
  stamped: string | undefined,
): IdentityVerdict {
  if (!sessionUserId) return "unauthed";
  if (stamped && stamped !== sessionUserId) return "foreign";
  return "ok"; // same account, or a replica with no stamp yet (proved + adopted below)
}

/** Session user id ALREADY verified against this replica (null ⇒ verify from scratch). */
let identityVerifiedFor: string | null = null;
let identityBlocked = false; // foreign replica wiped → no network at all until the reload lands

/** Test hook (unit tests only): forget the identity verdict. */
export function __resetIdentity(): void {
  identityVerifiedFor = null;
  identityBlocked = false;
}

/** Test hook (unit tests only): drop the durable obligations held in module memory. */
export function __resetObligations(): void {
  resyncPending = false;
  replacePending = false;
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
  store.setBootStatus("unauthed");
  setState("unauthed"); // no retry loop — a 401 does not clear on its own
}

/**
 * The replica belongs to a DIFFERENT account: drop it (mirror + outbox + DEK) BEFORE
 * anything can be pushed, then reload — the fresh boot bootstraps this account's data.
 * The previous owner's unsynced ops are lost, and that is the safe direction: the only
 * alternative is writing them into the new account's budget (a cross-tenant write).
 */
async function enterForeignReplica(): Promise<void> {
  identityBlocked = true; // no cycle may touch the network until the reload lands
  console.warn("sync: the local replica belongs to a different account — clearing it before any push");
  outbox.clearAll(); // in-memory queue too: nothing of the previous owner's may go out
  await persist.flushed(); // let queued writes land BEFORE the stores are cleared
  await wipeLocalData(); // clears IDB (mirror, outbox, DEK), tells other tabs, reloads
}

/**
 * The replica's owner could NOT be established (see proveOwnership). We refuse every server
 * write, but we do NOT wipe: the data may well be this user's, and destroying it (with its
 * unsynced ops) on an inconclusive probe would be the worse error. A later cycle
 * (focus/interval) retries the proof — e.g. after an Unlock the tier lines up again.
 */
function enterUnverified(): void {
  console.warn("sync: cannot establish the local replica's owner — no server write will be made");
  setState("error"); // honest: sync really is not happening (no retry loop of its own)
}

/**
 * What the ownership proof for a replica with no owner stamp can conclude. Deliberately NOT
 * "foreign": nothing an unstamped replica can be compared against distinguishes another
 * ACCOUNT from the same account's rotated budget (see the section header), and only the
 * userId stamp — decideIdentity → "foreign" — may trigger the destructive path.
 */
type Ownership = "ours" | "unknown";

/**
 * The budget the SESSION owns on the v1 path. A delta pull at the current cursor: normally
 * an empty response, and a READ, so it may run before the push loop.
 */
async function fetchServerBudgetId(): Promise<string | null> {
  const res = await fetch(`/api/sync/pull?since=${store.getCursor()}`);
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res);
  if (!res.ok) throw new Error(`pull: ${res.status}`);
  const body = (await res.json()) as PullResponse;
  return body.budgetId ?? null;
}

/**
 * The budget an E2EE replica belongs to. store.getBudgetId() is set by every bootstrap, but a
 * replica bootstrapped over sync2 against a PRE-2.0 server carries none (that snapshot did not
 * name its budget) — the `budgets` entity inside the ledger still does, and it is exactly the id
 * the pairing code is built from (Settings → Pairing code). "" = genuinely unknown, which is
 * when the ownership proof has to fall back to the DEK. Deliberately NOT used on the plain path:
 * there store.getBudgetId() is always set, and a backup import deliberately adopts the id from
 * the file (data.ts), which the ledger fallback would then second-guess.
 */
function e2eeReplicaBudgetId(): string {
  return store.getBudgetId() || store.getLedger()?.budgets?.[0]?.id || "";
}

/** The budget the SESSION owns on the v2 path + its checkpoint (a READ; no DEK needed). */
async function fetchServerE2eeIdentity(): Promise<{ budgetId: string | null; blob: string | null }> {
  const res = await fetch("/api/sync2/snapshot");
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res);
  if (!res.ok) throw new Error(`sync2 snapshot: ${res.status}`);
  const body = (await res.json()) as E2eeSnapshotResponse;
  return { budgetId: body.budgetId ?? null, blob: body.blob };
}

/**
 * Does a replica with NO owner stamp belong to the budget the SESSION owns? Runs before its
 * FIRST server write of any kind (push, /sync/replace, /sync2/reset). This can only ever
 * CONFIRM ownership ("ours" → adopt + write) or fail to ("unknown" → no write, no wipe):
 *
 *  - plain: the budgetId reported by the session's pull must equal the replica's,
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
  const local = store.getBudgetId();
  const bornE2ee = e2ee.getTierMeta().tier === "e2ee";
  // Never bound to a server budget (created offline, or restored from a backup that carried
  // no budgetId): nothing about it points at ANOTHER account, so it is adopted. An e2ee
  // replica is always server-bound, so there a missing budgetId means "cannot tell".
  if (!local && !bornE2ee) return "ours";
  for (let attempt = 0; ; attempt++) {
    try {
      if (e2ee.getTierMeta().tier === "e2ee") {
        const server = await fetchServerE2eeIdentity();
        const mine = e2eeReplicaBudgetId();
        if (mine && server.budgetId) return mine === server.budgetId ? "ours" : "unknown";
        const dek = e2ee.getDek();
        if (!dek || !e2ee.isDekFromStore() || !server.blob) return "unknown";
        try {
          await e2ee.decryptSnapshot(server.blob, dek);
          return "ours"; // the session's checkpoint opens with the replica's own key
        } catch {
          return "unknown"; // …it does not: a stale key OR another budget — indistinguishable
        }
      }
      const server = await fetchServerBudgetId();
      if (!server || !local) return "unknown";
      return local === server ? "ours" : "unknown";
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
 * disable). Returns false when the caller must NOT write (foreign replica → wipe + reload in
 * flight, or an owner we could not establish); throws UnauthorizedError when there is no
 * session. Network failures propagate to the normal backoff — being offline is NOT being
 * signed out.
 */
async function ensureIdentity(): Promise<boolean> {
  const sessionUserId = await fetchSessionUserId(); // 5xx/network THROWS (≠ "signed out")
  // unauthorized() routes the app to Login — crucial for the writers OUTSIDE doCycle
  // (assertOwnReplica / replaceServer / resetServerE2ee), which have no 401 handler of their own
  if (!sessionUserId) throw unauthorized();
  if (identityVerifiedFor !== sessionUserId) {
    const stamped = await idbGet<string>("meta", "userId").catch(() => undefined);
    const verdict = decideIdentity(sessionUserId, stamped);
    if (verdict === "unauthed") throw unauthorized(); // defensive (sessionUserId is set)
    // The ONLY destructive verdict: the stamp names another account, so the replica provably
    // is not this user's (proveOwnership never concludes that — see Ownership).
    if (verdict === "foreign") {
      await enterForeignReplica();
      return false;
    }
    if (!stamped && (await proveOwnership()) === "unknown") {
      enterUnverified(); // inconclusive → no write, no wipe, no adoption; retried next cycle
      return false;
    }
    await persist.putMeta("userId", sessionUserId); // stamp the owner next to the replica
    identityVerifiedFor = sessionUserId;
  }
  // The session is back (e.g. the user signed in in ANOTHER tab) while this tab sits on
  // Login: the replica is intact and belongs to this account → back into the app.
  if (store.getBootStatus() === "unauthed" && store.getLedger()) store.setBootStatus("ready");
  return true;
}

/**
 * The guard for server writes made OUTSIDE this module: Settings → "Enable E2EE" (POST
 * /e2ee/enable uploads an encrypted snapshot of the whole replica AND flips the session
 * budget's tier under this device's wrappedDek) and "Disable E2EE" (POST /e2ee/disable
 * uploads the whole plaintext ledger, from which the server rebuilds the budget's rows).
 * Both are the same "OVERWRITE the session user's entire budget with this replica" class as
 * /sync/replace, and both are reachable while a cookie swapped in another tab (or a replica
 * whose owner cannot be established) makes the local mirror foreign to the session.
 * Throws when no write may be made; the caller renders the error.
 */
export async function assertOwnReplica(): Promise<void> {
  if (!(await ensureIdentity())) throw new Error("foreign_replica");
}

/* ── Push→pull cycle ──────────────────────────────────────────────────── */

/** One full cycle; returns false on error (backoff already scheduled). */
async function doCycle(): Promise<boolean> {
  // Defense: local mode may have been enabled BETWEEN iterations of the single-flight
  // loop (dirty re-loop) — bail without network (the gate is also in syncNow before the first cycle).
  if (localMode !== "off") {
    setState("local");
    return true;
  }
  // E2ee tier without a key → the UI sits on the Unlock screen; no network until unlocked
  // (setDek + retryBoot will lift "locked" and resume a normal boot + cycle).
  if (store.getBootStatus() === "locked") return true;
  // Foreign replica detected in an earlier cycle — the wipe + reload is in flight
  if (identityBlocked) return true;
  let isE2ee = e2ee.getTierMeta().tier === "e2ee";
  // before bootstrap — nothing to do (a fresh e2ee replica may not know its budgetId yet)
  if (!store.getLedger() || (!isE2ee && !store.getBudgetId())) return true;
  setState("syncing");
  try {
    // MULTI-TENANT GUARD — BEFORE any server write (replace/push): whose replica is this?
    // No session → UnauthorizedError (→ Login); another account (or an owner we cannot
    // establish) → no write at all (false).
    if (!(await ensureIdentity())) return true;
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
    if (replacePending) {
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
      notePeersMayNeedUpdate(); // imported mirror → other tabs rehydrate from IDB
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
      notePeersMayNeedUpdate(); // mirror changed → other tabs rehydrate from IDB
    }

    // ── E2EE path: encrypted push/pull on /sync2 (the outbox stays plaintext) ──
    if (isE2ee) {
      const dek = e2ee.getDek();
      if (!dek) {
        enterLocked(); // the key vanished (practically: wipe/eviction) — waiting for Unlock
        return true;
      }
      // PUSH v2 — the same batches in localSeq order; encryption happens ONLY here,
      // so ops enqueued while still in the plain tier go out on the correct path.
      // The server dedupes by (budgetId, opId) — no per-op "rejected" in v2:
      // HTTP success = whole batch accepted (applied/duplicate) → remove from the outbox.
      while (outbox.size() > 0) {
        const batch = outbox.takeBatch(PUSH_BATCH);
        try {
          const ops = await Promise.all(batch.map((en) => e2ee.encryptOp(en.op, dek)));
          const res = await fetch("/api/sync2/push", {
            method: "POST",
            headers: { "content-type": "application/json" },
            // budgetId = the PER-REQUEST tenant assertion (see the v1 push below); a legacy
            // replica that cannot name its budget sends none — the server then cannot check
            body: JSON.stringify({
              epoch: e2ee.getTierMeta().epoch,
              budgetId: e2eeReplicaBudgetId() || undefined,
              ops,
            }),
          });
          if (res.status === 401) throw unauthorized();
          await throwIfTierMismatch(res); // flip/epoch → re-bootstrap; ops STAY in the outbox
          await throwIfBudgetMismatch(res); // not the session's budget → nothing was written
          if (!res.ok) throw new Error(`sync2 push: ${res.status}`);
          outbox.removeAcked(batch.map((en) => en.op.opId));
          notePeersMayNeedUpdate(); // canon after push → rehydrate other tabs
        } finally {
          outbox.clearInFlight();
        }
      }

      // PULL v2 — ciphertext delta (own pending ops skipped + outbox replay)
      await doPullE2ee(dek);

      // CONSUMER of the durable resync obligation — as in v1 (doFullResync goes by tier)
      if (resyncPending) {
        await doFullResync();
        clearResyncPending();
      }
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
        const res = await fetch("/api/sync/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: await getClientId(),
            budgetId: store.getBudgetId() || undefined,
            ops: batch.map((e) => e.op),
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
        const body = (await res.json()) as PushResponse;
        if (body.budgetId !== store.getBudgetId()) {
          // new data epoch — DURABLE resync obligation; we're inside a cycle, so
          // execute right away and STOP (ops stay in the outbox — server idempotency
          // makes re-sending them safe). A transient snapshot blip won't lose the
          // obligation here: markResyncPending is persisted BEFORE doFullResync.
          markResyncPending();
          await doFullResync();
          clearResyncPending();
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
        if (acked.length > 0) notePeersMayNeedUpdate(); // canon after push → rehydrate other tabs
        // loop defense: a batch that settled nothing = a server bug
        if (batch.length > 0 && settled === 0) throw new Error("push: response without batch results");
      } finally {
        outbox.clearInFlight();
      }
    }

    // PULL — delta with pending-guard (don't overwrite entities with ops in the outbox)
    await doPull();

    // CONSUMER of the durable resync obligation (rejected / new epoch from pull / full-import).
    // Always AFTER push+pull; on success clears the flag, on failure leaves it (retry).
    if (resyncPending) {
      await doFullResync();
      clearResyncPending();
    }

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
    setState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error");
    scheduleRetry();
    return false;
  }
}

/**
 * 409 budget_mismatch mid-push: the server refused the batch because the budget the replica
 * named is not the one the session owns — nothing was written. Which of the two causes it was
 * can only be settled by RE-VERIFYING the identity from scratch (the per-cycle verdict is what
 * the mismatch just called into question):
 *  - the cookie was swapped mid-cycle → the stamp now names another account → foreign replica
 *    (wipe + reload), or an unstamped replica fails its ownership proof → no write at all.
 *    Critically, we do NOT fullResync here: that would bootstrap the OTHER user's budget and
 *    replay this replica's outbox onto it — the very cross-tenant write we just refused.
 *  - the same user's budget was rotated (wipe+reseed, DB restore, budget reattached after the
 *    2.0 upgrade) → the identity still checks out → a new data epoch → fresh snapshot + replay.
 */
async function handleBudgetMismatch(): Promise<boolean> {
  identityVerifiedFor = null; // the cached verdict predates the mismatch — prove it again
  try {
    if (!(await ensureIdentity())) return true; // foreign (wipe in flight) / unproven → no write
    markResyncPending(); // durable: a blip must not lose the obligation (see doPull)
    await doFullResync();
    clearResyncPending();
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
    void persist.persistLedger(store.snapshotForPersist());
    notePeersMayNeedUpdate();
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
  lastSyncAt = new Date().toISOString();
  // D6: "last sync" is written ONLY here (persistLedger doesn't stamp it),
  // so offline local edits don't masquerade as a fresh synchronization.
  void persist.putMeta("lastSyncAt", lastSyncAt);
  setState("synced");
  if (broadcastPending) {
    broadcastPending = false;
    postMsg("updated"); // this cycle changed data → other tabs rehydrate from IDB
  }
}

/* ── syncNow — single-flight with coalescing (dirty flag) ────────────── */

let running: Promise<void> | null = null;
let dirty = false;

export function syncNow(reason: string): Promise<void> {
  void reason; // diagnostics (dev: window.__sync.lastReason)
  if (import.meta.env.DEV) lastReason = reason;
  // Local-mode GATE: no cycle whatsoever (push/pull/snapshot). All
  // triggers (boot/poke/focus/online/interval/leader/peer-poke) still call syncNow
  // — here they bail harmlessly. The outbox grows and flushes on resume.
  if (localMode !== "off") {
    setState("local");
    return Promise.resolve();
  }
  // Foreign replica (another account signed in on this device): local data has been wiped
  // and the page is reloading — nothing may reach the network in the meantime.
  if (identityBlocked) return Promise.resolve();
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

/* ── Local mode: state switching + server replica replacement ──────────
 *
 * NO half-state GUARANTEE (paramount — we never lose data):
 *  - enableWiped: the "wiped" flag is set ONLY after a confirmed server wipe;
 *    failure → we stay "off" (synced), server untouched (replace is atomic),
 *  - disableLocal from "wiped": local data is uploaded to the server BEFORE lifting the flag;
 *    failure → the flag stays "wiped" (nothing uploaded, replace is atomic),
 *  - enablePaused/disableLocal from "paused": does NOT touch the server destructively —
 *    paused→off is exactly offline→online (outbox flush + pull). */

/**
 * POST /sync/replace — full replacement of the server replica with the given ledger. Returns
 * the cursor (maxSeq after the write). Throws with the server message (apiErrorMessage-compatible)
 * on !ok — the whole server operation is atomic (either the entire replace or nothing).
 */
async function replaceServer(ledger: ClientLedger): Promise<{ budgetId: string; cursor: number }> {
  // MULTI-TENANT GUARD — /sync/replace is reachable OUTSIDE a cycle ("disable local mode"
  // uploads the mirror, "delete server data" wipes it, a JSON import replaces it), so the
  // check cannot live in doCycle alone: replacing ANOTHER account's budget with this replica
  // is the worst write of all. The verdict for an already-verified session is reused, so
  // inside a cycle this costs one cheap /api/auth/get-session.
  await assertOwnReplica(); // wiped/unverified — no write
  const res = await fetch("/api/sync/replace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ledger }),
  });
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res); // e2ee tier: replace v1 unavailable (import → /sync2/reset, T4)
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`); // UI: apiErrorMessage extracts { error }
  }
  return (await res.json()) as { budgetId: string; cursor: number };
}

/** Delete the budget's data on the server (empty replace). Does NOT touch the local mirror. */
async function wipeServer(): Promise<void> {
  await replaceServer(EMPTY_LEDGER);
}

/**
 * Upload the ENTIRE local mirror to the server (server := local). On success: the queue is
 * moot (outbox.clearAll — server == local), cursor := the returned maxSeq
 * (a pull from that point fetches nothing) and budgetId := the canonical one from the server
 * (consistent epoch — the next pull won't force a needless fullResync). Also fulfills the durable
 * replace obligation (backup import). Throws on failure (server untouched, the flag stays up).
 */
export async function pushLocalToServer(): Promise<void> {
  const ledger = store.getLedger();
  if (!ledger) throw new Error("Brak lokalnej repliki do wysłania.");
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
export async function resetServerE2ee(dek?: Uint8Array): Promise<void> {
  // MULTI-TENANT GUARD — as in replaceServer: /sync2/reset DELETES the session user's whole
  // journal and swaps their checkpoint, and it is reachable outside a cycle (disable local
  // mode, JSON import). Two independently-e2ee budgets both sit at epoch 1, so the server's
  // epoch check would happily accept another account's ciphertext here.
  await assertOwnReplica(); // wiped/unverified — no write
  const ledger = store.getLedger();
  if (!ledger) throw new Error("Brak lokalnej repliki do wysłania.");
  const key = dek ?? e2ee.getDek();
  if (!key) throw new Error("Brak klucza szyfrowania na tym urządzeniu (odblokuj budżet).");
  const snapshotBlob = await e2ee.encryptSnapshot(ledger, key);
  const res = await fetch("/api/sync2/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epoch: e2ee.getTierMeta().epoch, uptoCursor: store.getCursor(), snapshotBlob }),
  });
  if (res.status === 401) throw unauthorized();
  await throwIfTierMismatch(res); // flip meanwhile → tierMeta fresh; the cycle retries on the right path
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`); // UI: apiErrorMessage extracts { error }
  }
  outbox.clearAll(); // server == ciphertext of local → pre-import ops are moot
  e2ee.resetOpsCounter(); // fresh checkpoint — the counter to the next one starts from zero
  clearReplacePending(); // replace obligation fulfilled
}

/** Broadcast the local-mode change to other tabs (best-effort). */
function broadcastLocalMode(mode: LocalMode): void {
  try {
    channel?.postMessage({ type: "localmode", mode });
  } catch {
    /* best-effort — channel closed during unload */
  }
}

/**
 * Set local mode: module flag + localStorage + broadcast to other tabs +
 * UI state. "off" → "synced" state (a real cycle finalizes it via syncNow); paused/wiped
 * → "local" state.
 */
function applyLocalMode(mode: LocalMode): void {
  localMode = mode;
  try {
    localStorage.setItem(LOCAL_MODE_KEY, mode);
  } catch {
    /* ignore — the flag lives in session memory anyway */
  }
  broadcastLocalMode(mode);
  setState(mode === "off" ? "synced" : "local");
}

/**
 * "Work offline" (paused) — NON-DESTRUCTIVE and immediate: sync suspended,
 * server data STAYS, outbox PRESERVED (flushes on resume). No network.
 */
export function enablePaused(): void {
  applyLocalMode("paused");
}

/**
 * "Enable local mode and delete server data" (wiped) — DESTRUCTIVE for the server.
 *
 * ORDER is critical for "we never lose data": FIRST we raise the gate
 * (the "wiped" flag + broadcast to other tabs), ONLY THEN we wipe the server.
 * Otherwise the wipe would run with the gate DOWN and a concurrent cycle — from the
 * interval / focus / online / visible / poke, or a cycle ALREADY in flight — would pull
 * in the wipe's DELETEs (budgetId unchanged, resetRequired=false) and clear the local
 * mirror: catastrophe (local EMPTY and server EMPTY). The "wiped" gate (a) blocks every
 * NEW cycle (syncNow) and in ALL tabs (broadcast), (b) makes an in-flight cycle
 * bail in its dirty loop. An in-flight cycle may however be in the
 * middle of doPull (no mode re-check) — so we let it FINISH (await running) on
 * the PRE-wipe state, BEFORE we wipe the server. Only then the wipe.
 *
 * Wipe failure (replace atomic ⇒ server untouched) → we go back to "off"
 * (synced, local data intact) and rethrow; no cycle started in the meantime
 * (the gate was up, and the in-flight cycle finished), so the return to "off" is clean.
 */
export async function enableWiped(): Promise<void> {
  applyLocalMode("wiped"); // gate UP (this tab + others) BEFORE destroying the server
  if (running) await running.catch(() => {}); // finish the in-flight cycle on the PRE-wipe state
  try {
    await wipeServer(); // atomic: success ⇒ server empty; failure ⇒ server untouched
  } catch (e) {
    applyLocalMode("off"); // clean failure → back to "off" (server and local untouched)
    throw e;
  }
  outbox.clearAll(); // server empty; local mirror canonical (comes back via "Disable local mode")
}

/**
 * "Disable local mode" — resume synchronization.
 *  - from "wiped": upload local data to the (empty) server, ONLY THEN lift the flag;
 *    failure → the flag stays "wiped" (rethrow; nothing uploaded),
 *  - from "paused": lift the flag and run a cycle (outbox flush + pull) — exactly
 *    offline→online; server untouched, no replace.
 */
export async function disableLocal(): Promise<void> {
  if (localMode === "wiped") {
    await pushLocalToServer(); // throws on failure → localMode stays "wiped"
    applyLocalMode("off");
  } else if (localMode === "paused") {
    applyLocalMode("off");
    void syncNow("resume");
  }
}

/* ── poke — new op in the outbox (debounce catches a reorder burst) ───── */

let pokeTimer: ReturnType<typeof setTimeout> | undefined;

export function poke(): void {
  resetBackoff(); // new op = new chance, try right after the debounce
  bumpStatus(); // pending count changed
  postMsg("poke"); // notify the leader to sync right away (multi-tab)
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => void syncNow("enqueue"), POKE_DEBOUNCE_MS);
}

/* ── Boot (App.tsx) ──────────────────────────────────────────────────── */

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
    lastSyncAt = (await idbGet<string>("meta", "lastSyncAt")) ?? lastSyncAt;
  } catch (e) {
    console.warn("reading lastSyncAt failed", e);
  }
  try {
    resyncPending = (await idbGet<boolean>("meta", "resyncPending")) ?? resyncPending;
  } catch (e) {
    console.warn("reading resyncPending failed", e);
  }
  try {
    // the durable replace obligation (backup import) MUST survive a reload — otherwise
    // after a restart doCycle would pull instead of pushLocalToServer and revert the import
    replacePending = (await idbGet<boolean>("meta", "replacePending")) ?? replacePending;
  } catch (e) {
    console.warn("reading replacePending failed", e);
  }
}

/**
 * Boot in LOCAL MODE (paused/wiped): we operate EXCLUSIVELY off the local replica —
 * NO fetchSnapshot/pull (respect the offline/privacy choice). No local
 * data (rare: "Clear local data" while in local mode) → empty ledger, so the
 * UI doesn't hang on "Loading…"; the real data comes back after disabling the mode.
 */
function bootLocalReady(hydrated: "ready" | "empty"): void {
  if (hydrated === "empty" || !store.getLedger()) {
    store.replace(EMPTY_LEDGER, store.getCursor(), store.getBudgetId() ?? "");
  }
  replayOutbox();
  if (outbox.size() > 0) void persist.persistLedger(store.snapshotForPersist());
  store.setBootStatus("ready");
  setState("local");
}

async function boot(): Promise<void> {
  store.setBootStatus("booting");
  void getClientId(); // persist the installation identifier as early as possible
  void requestPersistentStorage(); // harden durability AS EARLY AS POSSIBLE (anti-eviction iOS)
  try {
    const [hydrated] = await Promise.all([store.hydrate(), outbox.hydrate()]);
    await loadSyncMeta();
    if (localMode !== "off") {
      lastBootSource = "local";
      bootLocalReady(hydrated); // local mode — no network
      return;
    }
    if (hydrated === "empty") {
      lastBootSource = "snapshot"; // empty replica ⇒ full snapshot (slow; also after eviction)
      // on the right path per tier; a 409 tier_mismatch along the way switches the path (max 1 retry)
      if ((await bootstrapReplica()) === "locked") {
        // e2ee budget, no DEK — the Unlock screen (T2) provides the key and does retryBoot
        store.setBootStatus("locked");
        return;
      }
    } else {
      lastBootSource = "replica"; // local-first: we started from the local replica
    }
    // REPLAY the outbox onto the mirror — heals a crash between addOutbox of an op and persist
    // (reducers are idempotent: create guards the id, update = full replacement);
    // the mirror was a PREFIX of the outbox, so the replay catches it up (never rolls back)
    replayOutbox();
    if (outbox.size() > 0) void persist.persistLedger(store.snapshotForPersist());
    store.setBootStatus("ready");
    bumpStatus();
    void syncNow("boot");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      // the backend requires login — login screen instead of a first-start
      // error; after OAuth the page returns to the origin → new boot
      enterUnauthed();
      return;
    }
    if (store.getLedger()) {
      // hydrate yielded data, only network/persist failed — we operate locally.
      lastBootSource = "replica";
      // Read the meta flags HERE too: the resync obligation from IDB must not be lost.
      await loadSyncMeta();
      replayOutbox();
      store.setBootStatus("ready");
      if (localMode !== "off") {
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

/** Boot once per module lifetime (StrictMode mounts effects 2×). */
export function bootOnce(): Promise<void> {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

/** Retry the first start (the "Try again" button). */
export function retryBoot(): Promise<void> {
  bootPromise = boot();
  return bootPromise;
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

function postMsg(type: "updated" | "poke" | "wipe"): void {
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
  request(
    name: string,
    options: { mode: "exclusive" | "shared" },
    cb: () => Promise<void>,
  ): Promise<void>;
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
      else if (msg.type === "poke" && isLeader) void syncNow("peer-poke");
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
          localMode = m;
          if (m === "off") void syncNow("peer-localmode-off");
          else setState("local");
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
  setInterval(() => {
    // only the leader polls in the background (Web Locks) — the other tabs sync on
    // interaction/enqueue; no Web Locks ⇒ isLeader=true (every tab, as before)
    if (isLeader && document.visibilityState === "visible") void syncNow("interval");
  }, INTERVAL_MS);
}

installTriggers();

/* ── Debug (dev only — also used by e2e verification) ───────────── */

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
    resyncPending: () => resyncPending,
    replacePending: () => replacePending,
    isLeader: () => isLeader,
    localMode: () => localMode,
    tierMeta: () => e2ee.getTierMeta(),
    dekLoaded: () => e2ee.getDek() !== null,
    enablePaused: () => enablePaused(),
    enableWiped: () => enableWiped(),
    disableLocal: () => disableLocal(),
  };
}
