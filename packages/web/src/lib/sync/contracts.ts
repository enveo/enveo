/**
 * Shared CONTRACTS of the sync engine (workflow §3c-3): types, wire-shape interfaces,
 * constants and error classes. NO mutable singleton state lives here — every module of
 * `lib/sync/` (and the facade) may import this file; nothing here imports a sibling.
 */
import type { ClientLedger } from "@enveo/shared";
import type { Tier } from "../e2ee";
import type { PullChange } from "../store";

export interface SnapshotResponse extends ClientLedger {
  budgetId: string;
  cursor: number;
}

export interface PullResponse {
  budgetId: string;
  cursor: number;
  resetRequired: boolean;
  changes: PullChange[];
}

export interface PushResponse {
  budgetId: string;
  results: Array<{ opId: string; status: "applied" | "duplicate" | "rejected"; error?: string }>;
}

/** GET /sync2/snapshot — `budgetId` is absent on servers older than 2.0. */
export interface E2eeSnapshotResponse {
  budgetId?: string | null;
  epoch: number;
  wrappedDek: string | null;
  kdfParams: string | null;
  uptoSeq: number;
  blob: string | null;
}

export const PUSH_BATCH = 100;
export const BACKOFF_MAX_MS = 60_000;
export const POKE_DEBOUNCE_MS = 300;
export const INTERVAL_MS = 60_000;

/**
 * HTTP 401 (missing/expired session) — a "please log in" signal,
 * NOT a network failure: no retry/backoff loop. During boot → BootStatus "unauthed"
 * (login screen), while running → SyncState "unauthed" (badge).
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized: 401");
    this.name = "UnauthorizedError";
  }
}

/**
 * HTTP 409 { error: "tier_mismatch", tier, epoch } — the budget is in a DIFFERENT tier
 * (or a different e2ee epoch) than the called channel assumes. It's a "switch path" signal,
 * NOT a failure: throwIfTierMismatch updates tierMeta from the body BEFORE throwing,
 * and the catcher does a hard re-bootstrap (fresh snapshot on the right path).
 */
export class TierMismatchError extends Error {
  constructor(
    public readonly tier: Tier,
    public readonly epoch: number,
  ) {
    super(`tier_mismatch: ${tier}/${epoch}`);
    this.name = "TierMismatchError";
  }
}

/**
 * HTTP 409 { error: "e2ee_upgrade_required", tier, epoch, cipherVersion: 1, budgetId } — the
 * session's budget still holds LEGACY (pre-AAD, "v1.") ciphertext, and every normal sync2
 * channel refuses to read or extend it. This is fail-closed BY DESIGN: the only way forward is
 * the explicit upgrade ceremony (fresh DEK, next epoch, new v2 checkpoint from the trusted
 * local replica — lib/e2eeUpgrade.ts). It is NOT a tier mismatch: re-bootstrapping would just
 * hit the same 409, so the handler records the server's format (cipherVersion meta) and stops
 * the cycle without touching the replica, the cursor or the outbox.
 */
export class E2eeUpgradeRequiredError extends Error {
  constructor(
    public readonly epoch: number,
    public readonly budgetId: string | null,
  ) {
    super("e2ee_upgrade_required");
    this.name = "E2eeUpgradeRequiredError";
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
export class BudgetMismatchError extends Error {
  constructor(public readonly serverBudgetId: string | null) {
    super(`budget_mismatch: ${serverBudgetId ?? "?"}`);
    this.name = "BudgetMismatchError";
  }
}

/* ── Local mode (offline / privacy) ─────────────────────────────────────
 *
 * Tri-state (NOT a boolean) — key to the "we never lose data" promise:
 *  - "off"    — normal synchronization with the server,
 *  - "paused" — offline by choice: sync SUSPENDED, server data STAYS,
 *               the outbox grows and flushes on resume (safe, no network),
 *  - "wiped"  — privacy: data DELETED from the server (a deliberate, separate choice);
 *               local mirror untouched, on disable we upload it back. */
export type LocalMode = "off" | "paused" | "wiped";

/** Empty ledger — server wipe (/sync/replace) and UI init when there is no local replica. */
export const EMPTY_LEDGER: ClientLedger = {
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  budgets: [],
};

/* ── Boot diagnostics (where the replica started from — shown in Settings) ──
 *  "replica"  — hydrate from IDB yielded data: fast, local-first works,
 *  "snapshot" — empty replica ⇒ full fetchSnapshot: slow (this is also what
 *               a cold start AFTER iOS IDB eviction looks like),
 *  "local"    — local mode (no network),
 *  null       — before boot / first-start error. */
export type BootSource = "replica" | "snapshot" | "local" | null;

/**
 * "unverified" is deliberately its OWN state and not a flavour of "error": the app is working
 * perfectly (local-first), the server is reachable, and nothing is broken — we simply cannot yet
 * prove that this device's replica belongs to the signed-in account, so we send NOTHING. Folding
 * that into "error" made the UI lie twice: a generic red badge suggesting a fault to retry, and —
 * once anything was queued — the reassuring "⇄ N" pill promising the changes "will send
 * themselves", which they never would. See enterUnverified and the Sync section in Settings.
 *
 * The UI does NOT key off this state, though: it is transient (every re-proof passes through
 * "syncing" on its way back here). What it reads is the sticky SyncStatus.ownerUnproven below.
 */
export type SyncState = "synced" | "syncing" | "offline" | "error" | "local" | "unauthed" | "unverified";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  deadLetters: number;
  lastSyncAt: string | null;
  localMode: LocalMode;
  /** @see ownerUnproven — the STICKY fact behind SyncState "unverified". */
  ownerUnproven: boolean;
}

export type IdentityVerdict = "unauthed" | "foreign" | "ok";

/**
 * Dependencies the TRANSPORT layer needs from higher layers (workflow §3c-3): identity owns
 * the unauthed transition and the ownership guard, multitab owns the peer broadcast — both
 * sit ABOVE transport in the module graph, so they are injected by the facade at composition
 * time instead of imported (which would be a cycle).
 */
export interface TransportDeps {
  /** Route the app to the Login screen (identity.enterUnauthed) — every 401 goes through it. */
  enterUnauthed(): void;
  /** The multi-tenant guard for full-budget overwrites; returns the VERIFIED session user id. */
  assertOwnReplica(): Promise<string>;
  /** Mark that this cycle changed data — finishSuccess broadcasts "updated" to peer tabs. */
  notePeersMayNeedUpdate(): void;
}

/**
 * Dependencies the CYCLE needs from the multi-tab layer (workflow §3c-3): the broadcast
 * channel and its pending-"updated" flag are owned by multitab, which is installed by the
 * facade — injected here so cycle stays importable without a composed facade.
 */
export interface CycleDeps {
  /** Mark that this cycle changed data — finishSuccess broadcasts "updated" at the end. */
  notePeersMayNeedUpdate(): void;
  /** finishSuccess: if this cycle changed data, post "updated" so peer tabs rehydrate. */
  broadcastUpdatedIfPending(): void;
  /** poke: notify a possibly-live leader tab to sync right away. */
  postPokeToPeers(): void;
}

/**
 * Dependencies the local-mode TRANSITIONS need from higher layers (workflow §3c-3): the
 * status setters (status.ts imports this module's flag, so importing status back would be a
 * cycle), the multi-tab broadcast, and the server-write operations — injected EXPLICITLY by
 * the facade at composition time, exactly as the module map prescribes.
 */
export interface LocalModeDeps {
  setState(s: SyncState): void;
  setOwnerUnproven(v: boolean): void;
  broadcastLocalMode(mode: LocalMode): void;
  /** Delete the budget's data on the server (empty /sync/replace) — see enableWiped. */
  wipeServer(): Promise<void>;
  /** Upload the ENTIRE local mirror to the server (server := local) — see disableLocal. */
  pushLocalToServer(): Promise<void>;
  /** Resolve once the in-flight cycle (if any) has finished — see enableWiped's ordering. */
  awaitInFlightCycle(): Promise<void>;
  syncNow(reason: string): Promise<void>;
  /** An EMPTY replica bound to NO budget can only destroy — see disableLocal. */
  isEmptyUnboundReplica(): boolean;
}

/**
 * The durable CEREMONY-INTENT record (v1→v2 E2EE upgrade). Materials (salt/DEK/KEK, wrapped
 * envelope, snapshot blob) are generated ONCE per ceremony and persisted BEFORE the first POST,
 * so a RETRY — after a network failure, a crash, or a server commit whose response was lost —
 * re-sends the byte-identical body. That is what makes the server's idempotency branch (same
 * envelope + expected epoch bump ⇒ 200) actually reachable: fresh materials on every call would
 * turn a committed-but-unconfirmed upgrade into an unrecoverable stale-epoch loop, with the
 * server's copy encrypted under the password typed in the INTERRUPTED attempt.
 */
export interface PendingE2eeUpgrade {
  budgetId: string;
  expectedEpoch: number;
  nextEpoch: number;
  dek: Uint8Array;
  wrappedDek: string;
  kdfParams: string;
  snapshotBlob: string;
  /** The outbox ops whose effects are INSIDE snapshotBlob — commit acks exactly these, never
   *  clearAll: an edit made in another tab during the (seconds-long) ceremony must survive. */
  opIds: string[];
}
