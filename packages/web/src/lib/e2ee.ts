/**
 * e2ee.ts — client-side key store and E2EE tier state.
 *
 * - The DEK lives in module memory + IDB meta ("e2eeDek"); tier/epoch in meta
 *   ("e2eeTier"/"e2eeEpoch") — hydrate once at boot (StrictMode-safe).
 * - Encryption/decryption of ops and snapshots: thin wrappers over
 *   crypto.ts (AES-GCM, "v1." format). The server NEVER sees plaintext —
 *   the outbox stays plaintext locally, we encrypt EXCLUSIVELY at push
 *   (thanks to this backlogged ops survive tier flips).
 * - Checkpoint: op counter since the last snapshot (meta "e2eeOpsSinceSnap");
 *   maybeUploadSnapshot() every SNAPSHOT_EVERY_OPS ops sends an encrypted
 *   replica to POST /api/sync2/snapshot (best-effort — it's an optimization
 *   of a new device's bootstrap, not correctness).
 *
 * Zero dependencies on store/sync (the caller provides the replica/cursor) — no cycles.
 */
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { decryptPayload, encryptPayload } from "./crypto";
import { idbGet } from "./idb";
import * as persist from "./persist";

export type Tier = "plain" | "e2ee";

export interface TierMeta {
  tier: Tier;
  epoch: number;
}

 
export interface CipherOp {
  opId: string;
  ciphertext: string;
}

 
export const SNAPSHOT_EVERY_OPS = 200;

 

let dek: Uint8Array | null = null;
let tierMeta: TierMeta = { tier: "plain", epoch: 0 };
let opsSinceSnap = 0;

let hydratePromise: Promise<void> | null = null;

/**
 * One-time load of the DEK + tier/epoch + checkpoint counter from IDB meta.
 * On rejection (transient IDB) it clears the cache so retryBoot can try
 * again (same pattern as store.hydrate / outbox.hydrate).
 */
export function hydrate(): Promise<void> {
  if (!hydratePromise) {
    const p = (async () => {
      const [d, t, e, n] = await Promise.all([
        idbGet<Uint8Array | ArrayBuffer>("meta", "e2eeDek"),
        idbGet<Tier>("meta", "e2eeTier"),
        idbGet<number>("meta", "e2eeEpoch"),
        idbGet<number>("meta", "e2eeOpsSinceSnap"),
      ]);
       
      if (d instanceof Uint8Array) dek = d;
      else if (d instanceof ArrayBuffer) dek = new Uint8Array(d);
      if (t === "plain" || t === "e2ee") tierMeta = { tier: t, epoch: e ?? 0 };
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

 
export function setDek(next: Uint8Array): void {
  dek = next;
  void persist.putMeta("e2eeDek", next);
}

 
export function clearDek(): void {
  dek = null;
  void persist.putMeta("e2eeDek", null);
}

/* ── Tier + epoch ────────────────────────────────────────────────────── */

export const getTierMeta = (): TierMeta => tierMeta;

/** Set tier/epoch (from a 409 tier_mismatch response or enable/disable). */
export function setTierMeta(next: TierMeta): void {
  tierMeta = next;
  void persist.putMeta("e2eeTier", next.tier);
  void persist.putMeta("e2eeEpoch", next.epoch);
}

 

/** An outbox op → a push v2 row: opId in the clear (idempotency), the rest in the ciphertext. */
export async function encryptOp(op: SyncOp, key: Uint8Array): Promise<CipherOp> {
  return {
    opId: op.opId,
    ciphertext: await encryptPayload(JSON.stringify({ kind: op.kind, payload: op.payload }), key),
  };
}

 
export async function decryptOps(rows: readonly CipherOp[], key: Uint8Array): Promise<SyncOp[]> {
  return Promise.all(
    rows.map(async (r) => {
      const body = JSON.parse(await decryptPayload(r.ciphertext, key)) as {
        kind: SyncOp["kind"];
        payload: SyncOp["payload"];
      };
      return { opId: r.opId, kind: body.kind, payload: body.payload } as SyncOp;
    }),
  );
}

/** The whole replica (ClientLedger) as one ciphertext — checkpoint / enable. */
export function encryptSnapshot(ledger: ClientLedger, key: Uint8Array): Promise<string> {
  return encryptPayload(JSON.stringify(ledger), key);
}

export async function decryptSnapshot(blob: string, key: Uint8Array): Promise<ClientLedger> {
  return JSON.parse(await decryptPayload(blob, key)) as ClientLedger;
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
 */
export async function maybeUploadSnapshot(ledger: ClientLedger | null, cursor: number): Promise<void> {
  if (opsSinceSnap < SNAPSHOT_EVERY_OPS) return;
  if (!dek || !ledger || tierMeta.tier !== "e2ee") return;
  const blob = await encryptSnapshot(ledger, dek);
  const res = await fetch("/api/sync2/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epoch: tierMeta.epoch, uptoSeq: cursor, blob }),
  });
  if (!res.ok) return;  
  resetOpsCounter();
}
