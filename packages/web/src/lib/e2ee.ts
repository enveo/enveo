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

 
export interface SnapshotCryptoContext {
  budgetId: string;
  epoch: number;
  uptoSeq: number;
}

 
export interface CipherOp {
  opId: string;
  ciphertext: string;
}

 
export const SNAPSHOT_EVERY_OPS = 200;

 

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






let dekTouched = false;
/**
 * The epoch the held DEK was last VALIDATED for — null = never validated. A DEK is trusted
 * for encryption/decryption ONLY while dekEpoch === tierMeta.epoch: adopting a NEW epoch
 * (any 409 body) leaves the key in memory but silently invalidates it, and it must be
 * re-validated against the new generation (an authenticated envelope unwrap on Unlock, or a
 * checkpoint decrypt in bootstrap/ownership proof) before any op is encrypted or decrypted
 * with it. Without this, a device that missed a key rotation would keep encrypting under the
 * DEAD key at the new epoch — the blind server accepts, and every CORRECT device's fail-closed
 * pull then freezes forever. Durable ("e2eeDekEpoch"), like the key and its provenance.
 */
let dekEpoch: number | null = null;
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
      const [d, o, t, e, n, cv, de] = await Promise.all([
        idbGet<Uint8Array | ArrayBuffer>("meta", "e2eeDek"),
        idbGet<DekOrigin>("meta", "e2eeDekOrigin"),
        idbGet<Tier>("meta", "e2eeTier"),
        idbGet<number>("meta", "e2eeEpoch"),
        idbGet<number>("meta", "e2eeOpsSinceSnap"),
        idbGet<number>("meta", "e2eeCipherVersion"),
        idbGet<number>("meta", "e2eeDekEpoch"),
      ]);
      // The key state of THIS page load wins over IDB: setDek/clearDek already told us the
      // provenance first-hand (and a re-run of hydrate must not launder it into "store").
      if (!dekTouched) {
         
        if (d instanceof Uint8Array) dek = d;
        else if (d instanceof ArrayBuffer) dek = new Uint8Array(d);
        else dek = null;
        // A key persisted by setDek() carries its origin; one persisted by a pre-2.0 build
        // does not — and that one DID come with the replica (there were no accounts yet).
        dekOrigin = dek ? (o === "session" ? "session" : "store") : null;
        // No recorded validation epoch (a pre-lifecycle install) = NOT validated: the key may
        // not encrypt anything until an authenticated unwrap/checkpoint decrypt vouches for it.
        dekEpoch = dek && typeof de === "number" ? de : null;
      }
      if (t === "plain" || t === "e2ee") tierMeta = { tier: t, epoch: e ?? 0 };
      cipherVersion = cv === 1 ? 1 : 2;  
      opsSinceSnap = n ?? 0;
    })();
    p.catch(() => {
      if (hydratePromise === p) hydratePromise = null;
    });
    hydratePromise = p;
  }
  return hydratePromise;
}

 

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
export function setDek(next: Uint8Array, validEpoch: number | null): void {
  dek = next;
  dekOrigin = "session";
  // null = the key was INSTALLED but not yet authenticated under any epoch (a pairing code on a
  // checkpoint-less budget): it may not encrypt anything until an authenticated use validates it.
  dekEpoch = validEpoch;
  dekTouched = true;
  void persist.putMeta("e2eeDek", next);
  void persist.putMeta("e2eeDekOrigin", "session");
  void persist.putMeta("e2eeDekEpoch", validEpoch);
}

/** The epoch the held DEK was last validated for (null = never). */
export const getDekEpoch = (): number | null => dekEpoch;

/** Is the held DEK VALIDATED for `epoch`? The hard precondition of every encrypt/decrypt path. */
export const isDekValidForEpoch = (epoch: number): boolean => dek !== null && dekEpoch === epoch;

/** Obtain key material for one authenticated operation. It is available only for the current
 * E2EE generation and is returned as a defensive copy so callers cannot mutate module state. */
export function requireValidatedDek(expectedEpoch: number): Uint8Array {
  if (tierMeta.tier !== "e2ee" || tierMeta.epoch !== expectedEpoch || !dek || dekEpoch !== expectedEpoch) throw new Error("locked");
  return dek.slice();
}

/**
 * Record a successful AUTHENTICATED use of the held DEK under `epoch` (an envelope unwrap or a
 * checkpoint decrypt whose AAD carried that epoch) — the only way a key becomes trusted for a
 * generation it was not handed out for.
 */
export function markDekValidated(epoch: number): void {
  if (!dek) return;
  dekEpoch = epoch;
  dekTouched = true;
  void persist.putMeta("e2eeDekEpoch", epoch);
}

 
export function clearDek(): void {
  dek = null;
  dekOrigin = null;
  dekEpoch = null;
  dekTouched = true;
  void persist.putMeta("e2eeDek", null);
  void persist.putMeta("e2eeDekOrigin", null);
  void persist.putMeta("e2eeDekEpoch", null);
  // The pending upgrade-ceremony record (sync.ts) holds a RAW candidate DEK for a possibly-live
  // generation. "Forget the key" — disable, a rotation-detected drop, any clearDek — must not
  // leave that raw key readable in IndexedDB behind the user's back.
  void persist.putMeta("e2eePendingUpgrade", null);
}

/**
 * A PEER TAB changed the key generation (upgrade / enable / disable / unlock — the "keys"
 * broadcast): drop this tab's in-memory key state and re-read everything from IDB. The plain
 * "updated" rehydrate re-reads only the LEDGER, and hydrate() is memoized with dekTouched
 * blocking a re-read — without this a second tab keeps a dead DEK and the old epoch in memory
 * and pushes poison under the new generation.
 */
export async function rehydrateKeysFromPeer(): Promise<void> {
  dekTouched = false;
  hydratePromise = null;
  await hydrate();
}

 
export function __resetDekForTests(): void {
  dek = null;
  dekOrigin = null;
  dekEpoch = null;
  dekTouched = false;
  hydratePromise = null;
}





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

 

 
export function noteOpsSeen(n: number): void {
  if (n <= 0) return;
  opsSinceSnap += n;
  void persist.putMeta("e2eeOpsSinceSnap", opsSinceSnap);
}

 
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
  if (dekEpoch !== tierMeta.epoch) return; // never encrypt with a key not validated for this epoch
  const blob = await encryptSnapshot(ledger, dek, { budgetId, epoch: tierMeta.epoch, uptoSeq: cursor });
  const res = await fetch("/api/sync2/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epoch: tierMeta.epoch, uptoSeq: cursor, blob, userId }),
  });
  if (!res.ok) return;  
  resetOpsCounter();
}
