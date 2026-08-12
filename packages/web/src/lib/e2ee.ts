/**
 * e2ee.ts — client-side key store and E2EE tier state.
 *
 * - The DEK lives in module memory + IDB meta ("e2eeDek"), together with its PROVENANCE
 *   ("e2eeDekOrigin" — see DekOrigin: the multi-tenant guard in sync.ts may only trust a key
 *   that came with the replica); tier/epoch in meta ("e2eeTier"/"e2eeEpoch") — hydrate once at
 *   boot (StrictMode-safe).
 * - Encryption/decryption of ops and snapshots: thin wrappers over
 *   crypto.ts (AES-GCM, ciphertext format v2 with MANDATORY authenticated context — the
 *   caller supplies the budgetId/epoch/uptoSeq it EXPECTS, and a ciphertext moved to another
 *   op identity, budget, epoch or checkpoint position fails to decrypt). The server NEVER
 *   sees plaintext — the outbox stays plaintext locally, we encrypt EXCLUSIVELY at push
 *   (thanks to this backlogged ops survive tier flips).
 * - Checkpoint: op counter since the last snapshot (meta "e2eeOpsSinceSnap");
 *   maybeUploadSnapshot() every SNAPSHOT_EVERY_OPS ops sends an encrypted
 *   replica to POST /api/sync2/snapshot (best-effort — it's an optimization
 *   of a new device's bootstrap, not correctness).
 *
 * Zero dependencies on store/sync (the caller provides the replica/cursor) — no cycles.
 */
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { decryptPayload, encryptPayload, opAadContext, snapshotAadContext } from "./crypto";
import { idbGet } from "./idb";
import * as persist from "./persist";

export type Tier = "plain" | "e2ee";

export interface TierMeta {
  tier: Tier;
  epoch: number;
}

/** The E2EE ciphertext wire format of the SERVER's budget, as last reported by it
 *  (the 409 e2ee_upgrade_required body or a v2 snapshot response). 1 = legacy pre-AAD
 *  ciphertext — every normal sync2 channel refuses it until the explicit upgrade
 *  ceremony (fresh DEK, next epoch) has run; 2 = the current authenticated format. */
export type CipherVersion = 1 | 2;

/** Caller-EXPECTED context for op encryption/decryption (the opId comes from each row). */
export interface OpCryptoContext {
  budgetId: string;
  epoch: number;
}

/** Caller-EXPECTED context for a checkpoint blob — binds it to its claimed position. */
export interface SnapshotCryptoContext {
  budgetId: string;
  epoch: number;
  uptoSeq: number;
}

/** A sync2 channel row (push body / pull response). */
export interface CipherOp {
  opId: string;
  ciphertext: string;
}

/** How many journal ops between fresh snapshot checkpoints. */
export const SNAPSHOT_EVERY_OPS = 200;

/* ── Module state (hydrated from IDB meta at boot) ────────────────────── */

/**
 * Where the DEK on this device came from — DURABLE (IDB meta "e2eeDekOrigin"), because the
 * multi-tenant guard in sync.ts leans on it and a page reload must not launder it:
 *
 *  - "store"   — the key was already in IDB when this page load started, i.e. it arrived
 *                TOGETHER with the replica (persisted by an earlier install of the app, or by
 *                a pre-2.0 build that had no notion of provenance). Only such a key says
 *                anything about WHO the local replica belongs to.
 *  - "session" — the key was unwrapped from the SESSION budget's key envelope (Unlock,
 *                E2EE enable, password change). It decrypts the session's budget BY
 *                CONSTRUCTION, no matter whose replica sits on this device — it proves
 *                nothing about ownership, and it must not start proving something after the
 *                next reload just because setDek() also persisted it.
 */
export type DekOrigin = "store" | "session";

let dek: Uint8Array | null = null;
let dekOrigin: DekOrigin | null = null;
/**
 * Has setDek()/clearDek() run in THIS page load? hydrate() drops its memoization when the IDB
 * read rejects, so its body CAN run again later (retryBoot after a transient failure — and the
 * Unlock flow calls retryBoot right after setDek). Re-reading the key state then would
 * overwrite the provenance we know first-hand with what happens to sit in IDB.
 */
let dekTouched = false;
let tierMeta: TierMeta = { tier: "plain", epoch: 0 };
let cipherVersion: CipherVersion = 2;
let opsSinceSnap = 0;

let hydratePromise: Promise<void> | null = null;

/**
 * One-time load of the DEK + its provenance + tier/epoch + checkpoint counter from IDB meta.
 * On rejection (transient IDB) it clears the cache so retryBoot can try
 * again (same pattern as store.hydrate / outbox.hydrate).
 */
export function hydrate(): Promise<void> {
  if (!hydratePromise) {
    const p = (async () => {
      const [d, o, t, e, n, cv] = await Promise.all([
        idbGet<Uint8Array | ArrayBuffer>("meta", "e2eeDek"),
        idbGet<DekOrigin>("meta", "e2eeDekOrigin"),
        idbGet<Tier>("meta", "e2eeTier"),
        idbGet<number>("meta", "e2eeEpoch"),
        idbGet<number>("meta", "e2eeOpsSinceSnap"),
        idbGet<number>("meta", "e2eeCipherVersion"),
      ]);
      // The key state of THIS page load wins over IDB: setDek/clearDek already told us the
      // provenance first-hand (and a re-run of hydrate must not launder it into "store").
      if (!dekTouched) {
        // structured clone preserves Uint8Array; defensively accept ArrayBuffer too
        if (d instanceof Uint8Array) dek = d;
        else if (d instanceof ArrayBuffer) dek = new Uint8Array(d);
        else dek = null;
        // A key persisted by setDek() carries its origin; one persisted by a pre-2.0 build
        // does not — and that one DID come with the replica (there were no accounts yet).
        dekOrigin = dek ? (o === "session" ? "session" : "store") : null;
      }
      if (t === "plain" || t === "e2ee") tierMeta = { tier: t, epoch: e ?? 0 };
      cipherVersion = cv === 1 ? 1 : 2; // absent = 2 (fresh installs and every post-upgrade budget)
      opsSinceSnap = n ?? 0;
    })();
    p.catch(() => {
      if (hydratePromise === p) hydratePromise = null;
    });
    hydratePromise = p;
  }
  return hydratePromise;
}

/* ── DEK ─────────────────────────────────────────────────────────────── */

export const getDek = (): Uint8Array | null => dek;

/**
 * Did the DEK arrive TOGETHER with the local replica (origin "store") rather than being
 * unwrapped from the session budget's key envelope (origin "session" — Unlock / enable /
 * password change)? Only the former says anything about WHO the replica belongs to: a DEK
 * taken from the session's envelope decrypts that session's budget by construction, no matter
 * whose replica sits on the device. The multi-tenant guard in sync.ts relies on this, so the
 * answer must survive a reload — hence the durable "e2eeDekOrigin" meta.
 */
export const isDekFromStore = (): boolean => dek !== null && dekOrigin === "store";

/**
 * Remember a DEK obtained in THIS page load from the SESSION's key envelope (Unlock, enable,
 * password change) — memory + IDB meta, best-effort on the persist chain. Its provenance is
 * persisted alongside it: such a key is NOT evidence of the replica's ownership, now or after
 * any number of reloads.
 */
export function setDek(next: Uint8Array): void {
  dek = next;
  dekOrigin = "session";
  dekTouched = true;
  void persist.putMeta("e2eeDek", next);
  void persist.putMeta("e2eeDekOrigin", "session");
}

/** Remove the DEK (disabling E2EE / "forget the key"). */
export function clearDek(): void {
  dek = null;
  dekOrigin = null;
  dekTouched = true;
  void persist.putMeta("e2eeDek", null);
  void persist.putMeta("e2eeDekOrigin", null);
}

/** Test hook (unit tests only): forget the key state, so hydrate() re-runs as on a fresh load. */
export function __resetDekForTests(): void {
  dek = null;
  dekOrigin = null;
  dekTouched = false;
  hydratePromise = null;
}

/**
 * Test hook (unit tests only): drop ONLY the memoized hydrate — exactly what a rejected IDB
 * read does in production, which lets hydrate's body run again in the SAME page load.
 */
export function __forgetHydrationForTests(): void {
  hydratePromise = null;
}

/* ── Tier + epoch ────────────────────────────────────────────────────── */

export const getTierMeta = (): TierMeta => tierMeta;

/** Set tier/epoch (from a 409 tier_mismatch response or enable/disable). */
export function setTierMeta(next: TierMeta): void {
  tierMeta = next;
  void persist.putMeta("e2eeTier", next.tier);
  void persist.putMeta("e2eeEpoch", next.epoch);
}

/** The server budget's ciphertext format as last reported (see CipherVersion). */
export const getCipherVersion = (): CipherVersion => cipherVersion;

/** Record the server's reported format (409 e2ee_upgrade_required → 1; upgrade success / v2
 *  snapshot → 2). Durable: the Settings upgrade action must survive a reload. */
export function setCipherVersion(next: CipherVersion): void {
  cipherVersion = next;
  void persist.putMeta("e2eeCipherVersion", next);
}

/* ── Encrypting ops and snapshots ───────────────────────────────────── */

/** An outbox op → a push v2 row: opId in the clear (idempotency) AND inside the authenticated
 *  context — the ciphertext cannot later be paired with another op's clear opId. */
export async function encryptOp(op: SyncOp, key: Uint8Array, ctx: OpCryptoContext): Promise<CipherOp> {
  return {
    opId: op.opId,
    ciphertext: await encryptPayload(JSON.stringify({ kind: op.kind, payload: op.payload }), key, opAadContext(ctx.budgetId, ctx.epoch, op.opId)),
  };
}

/** Pull v2 rows → SyncOp[] (input order = journal order). `ctx` is the budget/epoch the CALLER
 *  expects (locally bound values — never the response's own metadata); each row's outer opId is
 *  its claimed identity, and decryption fails unless the ciphertext was made for exactly it. */
export async function decryptOps(rows: readonly CipherOp[], key: Uint8Array, ctx: OpCryptoContext): Promise<SyncOp[]> {
  return Promise.all(
    rows.map(async (r) => {
      const body = JSON.parse(await decryptPayload(r.ciphertext, key, opAadContext(ctx.budgetId, ctx.epoch, r.opId))) as {
        kind: SyncOp["kind"];
        payload: SyncOp["payload"];
      };
      return { opId: r.opId, kind: body.kind, payload: body.payload } as SyncOp;
    }),
  );
}

/** The whole replica (ClientLedger) as one ciphertext — checkpoint / enable / upgrade. The AAD
 *  binds the blob to (budgetId, epoch, uptoSeq): a checkpoint replayed at another position or
 *  under another generation fails to decrypt. */
export function encryptSnapshot(ledger: ClientLedger, key: Uint8Array, ctx: SnapshotCryptoContext): Promise<string> {
  return encryptPayload(JSON.stringify(ledger), key, snapshotAadContext(ctx.budgetId, ctx.epoch, ctx.uptoSeq));
}

export async function decryptSnapshot(blob: string, key: Uint8Array, ctx: SnapshotCryptoContext): Promise<ClientLedger> {
  return JSON.parse(await decryptPayload(blob, key, snapshotAadContext(ctx.budgetId, ctx.epoch, ctx.uptoSeq))) as ClientLedger;
}

/* ── Checkpoint (op counter + snapshot upload) ────────────────────── */

/** Add journal ops (pull v2) to the counter since the last checkpoint. */
export function noteOpsSeen(n: number): void {
  if (n <= 0) return;
  opsSinceSnap += n;
  void persist.putMeta("e2eeOpsSinceSnap", opsSinceSnap);
}

/** Reset the counter (a fresh checkpoint was sent — also at enable in T3). */
export function resetOpsCounter(): void {
  opsSinceSnap = 0;
  void persist.putMeta("e2eeOpsSinceSnap", 0);
}

/**
 * Every SNAPSHOT_EVERY_OPS ops: encrypt the current replica and send a checkpoint
 * (POST /api/sync2/snapshot with uptoSeq = the current cursor). Best-effort: failure
 * (network / 409 of a new epoch) breaks nothing — the journal is the source of truth,
 * and push/pull handle an epoch change anyway.
 *
 * `userId` = the tenant the CALLER verified in this cycle (sync.ts ensureIdentity), carried in
 * the body as the PER-REQUEST owner assertion. This is a WRITE that overwrites the whole
 * checkpoint of the budget the server resolves from the session cookie — and it is fired in the
 * BACKGROUND, seconds after that verification, while the cookie is shared by every tab: a
 * mid-cycle sign-in as somebody else would otherwise store THIS budget's ciphertext (and this
 * device's uptoSeq) as THEIR checkpoint, which their next new-device bootstrap could not decrypt.
 * The server refuses a session it did not verify (409) — hence, per the contract above, a no-op.
 *
 * `budgetId` = the budget this replica is bound to (the snapshot AAD needs it, and a replica
 * that cannot name its budget must not write — fail-closed, not optional legacy compatibility).
 */
export async function maybeUploadSnapshot(ledger: ClientLedger | null, cursor: number, userId: string, budgetId: string): Promise<void> {
  if (opsSinceSnap < SNAPSHOT_EVERY_OPS) return;
  if (!dek || !ledger || tierMeta.tier !== "e2ee" || !budgetId) return;
  const blob = await encryptSnapshot(ledger, dek, { budgetId, epoch: tierMeta.epoch, uptoSeq: cursor });
  const res = await fetch("/api/sync2/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epoch: tierMeta.epoch, uptoSeq: cursor, blob, userId }),
  });
  if (!res.ok) return; // best-effort — we'll try at the next threshold
  resetOpsCounter();
}
