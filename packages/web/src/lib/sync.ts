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

/**
 * "unverified" is deliberately its OWN state and not a flavour of "error": the app is working
 * perfectly (local-first), the server is reachable, and nothing is broken — we simply cannot yet
 * prove that this device's replica belongs to the signed-in account, so we send NOTHING. Folding
 * that into "error" made the UI lie twice: a generic red badge suggesting a fault to retry, and —
 * once anything was queued — the reassuring "⇄ N" pill promising the changes "will send
 * themselves", which they never would. See enterUnverified and the Sync section in Settings.
 */
export type SyncState =
  | "synced"
  | "syncing"
  | "offline"
  | "error"
  | "local"
  | "unauthed"
  | "unverified";

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
  identityVerifiedFor = null; // the cached verdict predates the server's answer — prove it again
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
async function doPullE2ee(dek: Uint8Array, userId: string): Promise<void> {
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
    // Checkpoint every SNAPSHOT_EVERY_OPS ops — best-effort, doesn't block the cycle. It is a
    // WRITE (it overwrites the session budget's whole checkpoint), so it carries the tenant this
    // cycle verified: fired in the background, it is the LAST thing to reach the server in a
    // cycle and the widest open window for a cookie swapped in another tab.
    void e2ee.maybeUploadSnapshot(store.getLedger(), store.getCursor(), userId).catch(() => {});
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
let identityBlocked = false; // foreign replica → no network write until the human decides

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

/** Test hook (unit tests only): cancel a pending retry so it cannot fire into the next test. */
export function __resetBackoff(): void {
  resetBackoff();
}

/** Test hook (unit tests only): set the local-mode flag without touching the server. */
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
  identityBlocked = true; // no cycle may touch the network until the human decides
  console.warn("sync: the local replica belongs to a different account — every server write is refused");
  store.setBootStatus("foreign"); // ForeignReplicaScreen: [Export backup] / [Remove and continue]
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
  outbox.clearAll(); // in-memory queue too: nothing of the previous owner's may go out
  if (localMode !== "off") applyLocalMode("off"); // the mode was the previous owner's choice
  await persist.flushed(); // let queued writes land BEFORE the stores are cleared
  await wipeLocalData(); // clears IDB (mirror, outbox, DEK), tells other tabs, reloads
}

/**
 * Where EVERY sign-out lands (auth.signOutKeepingReplica calls this once the session is gone —
 * from Settings and from ForeignReplicaScreen alike): back to Login WITHOUT touching the replica.
 * The owner (or the same human after a server rebuild handed them a new user id) signs back in,
 * their stamp matches again, and the ledger plus every queued op resume where they stopped.
 *
 * A sign-out does NOT wipe (spec §3, owner's decision): the replica may be the last copy of the
 * budget (local mode "wiped" deleted the server's on purpose) and the outbox may hold ops the
 * server has never seen — a window.confirm is not consent to destroy them. What protects the NEXT
 * account to sign in on this device is the guard, not a wipe: bootOwnerOk refuses to render a
 * replica stamped by somebody else, and ensureIdentity refuses to write it anywhere.
 */
export function enterLoginKeepingReplica(): void {
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
 * Is the budget the SESSION owns provably EMPTY — i.e. is there anything a write from this
 * replica could destroy? A READ (GET /sync/snapshot; it does NOT touch the mirror — fetchSnapshot
 * does). The budget ROW itself is ignored: it always exists (it is what `budgets` carries).
 */
async function sessionBudgetIsEmpty(): Promise<boolean> {
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
    snap.places.length === 0 &&
    snap.recurrences.length === 0
  );
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
        if (!dek || !e2ee.isDekFromStore() || !server.blob) return "unknown";
        try {
          await e2ee.decryptSnapshot(server.blob, dek);
          return "ours"; // the session's checkpoint opens with the replica's own key
        } catch {
          return "unknown"; // …it does not: a stale key OR another budget — indistinguishable
        }
      }
      const local = store.getBudgetId();
      // An UNBOUND replica (no budgetId): it points at no account — neither this one nor
      // another. Adopt it only where being wrong costs nothing: an EMPTY session budget has
      // nothing to lose. Against a session budget that holds data, an unbound replica is exactly
      // the "adopt + overwrite" hole this guard exists to close (it can arrive on the device via
      // "Clear local data" in local mode, or an offline start, and it may be another user's).
      if (!local) return !bornE2ee && (await sessionBudgetIsEmpty()) ? "ours" : "unknown";
      const server = await fetchServerBudgetId();
      if (!server) return "unknown";
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
 * disable). Returns the VERIFIED session user id, which every full-budget overwrite then carries
 * in its request body (the per-REQUEST owner assertion — see replaceServer); null means the
 * caller must NOT write (foreign replica awaiting the human's decision, or an owner we could not
 * establish). Throws UnauthorizedError when there is no session. Network failures propagate to
 * the normal backoff — being offline is NOT being signed out.
 */
async function ensureIdentity(): Promise<string | null> {
  const sessionUserId = await fetchSessionUserId(); // 5xx/network THROWS (≠ "signed out")
  // unauthorized() routes the app to Login — crucial for the writers OUTSIDE doCycle
  // (assertOwnReplica / replaceServer / resetServerE2ee), which have no 401 handler of their own
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
      enterUnverified(); // inconclusive → no write, no wipe, no adoption; retried next cycle
      return null;
    }
    await persist.putMeta("userId", sessionUserId); // stamp the owner next to the replica
    identityVerifiedFor = sessionUserId;
  }
  // The session is back (e.g. the user signed in in ANOTHER tab) while this tab sits on
  // Login: the replica is intact and belongs to this account → back into the app.
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
  // Foreign replica detected in an earlier cycle — no write until the human decides its fate
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
      await doPullE2ee(dek, userId);

      // CONSUMER of the durable resync obligation — as in v1 (resyncVerified goes by tier, and
      // re-proves the session first: a resync REPLACES the mirror with the session's budget)
      if (resyncPending && !(await resyncVerified())) return true;
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
    // Always AFTER push+pull; on success clears the flag, on failure leaves it (retry). It goes
    // through resyncVerified: a resync REPLACES this replica with the SESSION's budget, and the
    // pull that asked for it may have been answered under a cookie swapped in another tab.
    if (resyncPending && !(await resyncVerified())) return true;

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
  // Foreign replica (another account signed in on this device): the app is on
  // ForeignReplicaScreen and nothing of the previous owner's may reach this account's budget.
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
  const userId = await assertOwnReplica(); // foreign/unverified — no write
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
 * An EMPTY replica that is bound to NO budget: it carries no data and names no server budget, so
 * it can prove nothing and restore nothing — the only thing a full-budget replace built from it
 * can do is DESTROY the session user's budget. It is reachable: "Clear local data" while in local
 * mode leaves exactly this (bootLocalReady puts an EMPTY_LEDGER with no budgetId in place), and
 * so does the discard of a foreign replica.
 */
function isEmptyUnboundReplica(): boolean {
  if (store.getBudgetId()) return false;
  const l = store.getLedger();
  if (!l) return true;
  return (
    l.accounts.length === 0 &&
    l.groups.length === 0 &&
    l.envelopes.length === 0 &&
    l.transactions.length === 0 &&
    l.allocations.length === 0 &&
    l.categories.length === 0 &&
    l.places.length === 0 &&
    l.recurrences.length === 0
  );
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
  // Nothing to upload, everything to lose: an empty replica bound to no budget can only wipe the
  // session user's budget (see isEmptyUnboundReplica). Refuse — the callers that can legitimately
  // reach this state (disableLocal) resume a normal sync instead, and "delete server data"
  // (enableWiped) goes through replaceServer directly, so a DELIBERATE empty replace still works.
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
export async function resetServerE2ee(dek?: Uint8Array): Promise<void> {
  // MULTI-TENANT GUARD — as in replaceServer: /sync2/reset DELETES the session user's whole
  // journal and swaps their checkpoint, and it is reachable outside a cycle (disable local
  // mode, JSON import). Two independently-e2ee budgets both sit at epoch 1, so the server's
  // epoch check would happily accept another account's ciphertext here.
  const userId = await assertOwnReplica(); // foreign/unverified — no write
  const ledger = store.getLedger();
  if (!ledger) throw new Error("Brak lokalnej repliki do wysłania.");
  const key = dek ?? e2ee.getDek();
  if (!key) throw new Error("Brak klucza szyfrowania na tym urządzeniu (odblokuj budżet).");
  const snapshotBlob = await e2ee.encryptSnapshot(ledger, key);
  const res = await fetch("/api/sync2/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // userId = the PER-REQUEST owner assertion (see replaceServer): encrypting and uploading a
    // whole replica takes seconds, and the epoch does NOT distinguish tenants (two independently
    // encrypted budgets both sit at epoch 1) — the server refuses a session it did not verify.
    body: JSON.stringify({
      epoch: e2ee.getTierMeta().epoch,
      uptoCursor: store.getCursor(),
      snapshotBlob,
      userId,
    }),
  });
  if (res.status === 401) throw unauthorized();
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
 *    failure → the flag stays "wiped" (rethrow; nothing uploaded). EXCEPT when there is nothing
 *    to upload: an empty replica bound to no budget (the mirror was cleared while the mode was
 *    on) would REPLACE the session user's budget with an empty ledger — the one and only thing
 *    such a replica can do. Then we simply resume normal sync and let the boot bootstrap from
 *    the server (whatever it holds, it survives),
 *  - from "paused": lift the flag and run a cycle (outbox flush + pull) — exactly
 *    offline→online; server untouched, no replace.
 */
export async function disableLocal(): Promise<void> {
  if (localMode === "wiped") {
    if (isEmptyUnboundReplica()) {
      applyLocalMode("off"); // nothing to restore — do NOT push an empty ledger over the server
      if (typeof location !== "undefined") location.reload(); // boot bootstraps from the server
      return;
    }
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
  if (!stamped) return true; // no stamp: nothing to compare (the cycle's proveOwnership decides,
  // and until it can, it refuses every server WRITE — see proveOwnership)
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
    if (localMode !== "off") return true; // see the contract above
    enterUnauthed(); // Login BEFORE the data is on screen; the replica and the outbox stay
    return false;
  }
  identityVerifiedFor = sessionUser; // same account — the first cycle needn't re-read the stamp
  return true;
}

async function boot(): Promise<void> {
  store.setBootStatus("booting");
  void getClientId(); // persist the installation identifier as early as possible
  void requestPersistentStorage(); // harden durability AS EARLY AS POSSIBLE (anti-eviction iOS)
  try {
    const [hydrated] = await Promise.all([store.hydrate(), outbox.hydrate()]);
    await loadSyncMeta();
    // Whose replica is this? BEFORE it reaches the UI (and before any bootstrap) — see bootOwnerOk
    if (!(await bootOwnerOk())) return;
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
