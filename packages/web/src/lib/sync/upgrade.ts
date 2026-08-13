/**
 * The MANDATORY v1→v2 E2EE upgrade CEREMONY (workflow §3c-3 — a map-extension module: this
 * machinery shipped with E2EE ciphertext v2, after the split's module map was written, and its
 * responsibility — a durable ceremony intent plus a full-budget key rotation — fits none of
 * the mapped modules without redesign). Single owner of the persisted ceremony-intent record.
 *
 * This is a REAL data-key rotation, not the same-DEK password rewrap of /sync2/rekey: a fresh
 * DEK + salt + KEK are generated, the epoch increments, the complete LOCAL ledger (outbox
 * effects included — they are already applied to the mirror) becomes the new v2 checkpoint at
 * uptoSeq 0, and the server atomically swaps envelope + journal + checkpoint. Old pairing
 * codes and the old DEK die with the rotation; other devices hit an epoch mismatch and unlock
 * with the new password or a freshly minted pairing code.
 *
 * Preconditions enforced here: proven replica ownership (assertOwnReplica — an unstamped or
 * foreign replica must not perform this full-budget overwrite) and a replica that names its
 * budget. The UI enforces the fresh-backup acknowledgement before calling. The old server key
 * envelope is deliberately NOT used or required.
 *
 * NOTHING local changes until the server confirms: a failed or interrupted request leaves
 * both sides on the old generation and retrying is safe (the server is idempotent for a
 * repeated identical attempt and refuses a stale epoch).
 */
import { DEFAULT_KDF_PARAMS, dekWrapAadContext, deriveKek, freshKdfParams, generateDek, generateSalt, wrapDek } from "../crypto";
import * as e2ee from "../e2ee";
import { idbGet } from "../idb";
import * as outbox from "../outbox";
import * as persist from "../persist";
import { store } from "../store";
import { type PendingE2eeUpgrade, TierMismatchError } from "./contracts";
import { syncNow } from "./cycle";
import { assertOwnReplica } from "./identity";
import { broadcastKeysChanged } from "./multitab";
import { clearReplacePending } from "./obligations";
import { e2eeReplicaBudgetId } from "./replica";
import { throwIfBudgetMismatch, throwIfTierMismatch, unauthorized } from "./transport";

/** The durable CEREMONY-INTENT record — type + rationale in sync/contracts.ts (PendingE2eeUpgrade). */
async function loadPendingE2eeUpgrade(): Promise<PendingE2eeUpgrade | null> {
  const raw = await idbGet<(Omit<PendingE2eeUpgrade, "dek"> & { dek: Uint8Array | ArrayBuffer }) | null>("meta", "e2eePendingUpgrade").catch(() => null);
  if (!raw?.budgetId || !raw.wrappedDek || !raw.snapshotBlob) return null;
  // structured clone preserves Uint8Array; defensively accept ArrayBuffer too (see e2ee.hydrate)
  const dek = raw.dek instanceof Uint8Array ? raw.dek : raw.dek instanceof ArrayBuffer ? new Uint8Array(raw.dek) : null;
  if (!dek) return null;
  return { ...raw, dek };
}

/** Does an interrupted upgrade ceremony await completion? (The panel offers Resume/Discard.) */
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

/**
 * The ceremony itself (client side) — the only boundary a legacy pre-AAD E2EE budget may
 * cross; see the module header for the full contract.
 *
 * `password` starts a NEW ceremony intent; `null` RESUMES a pending one (materials come from
 * the persisted record — the interrupted attempt's password stays the operative one, and the
 * record's expectedEpoch is immune to 409-driven tierMeta adoption in between).
 *
 * NOTHING local changes until the server confirms; a stale-epoch 409 means another device
 * changed the generation — that intent can never commit (our own committed-but-unconfirmed
 * attempt answers 200 via the server's envelope comparison instead), so the record is dropped
 * and the caller re-syncs.
 */
export async function upgradeServerE2eeV2(password: string | null): Promise<void> {
  const userId = await assertOwnReplica(); // foreign/unverified — no write
  const budgetId = e2eeReplicaBudgetId();
  if (!budgetId) throw new Error("foreign_replica");
  let pending = await loadPendingE2eeUpgrade();
  if (pending && pending.budgetId !== budgetId) {
    // a record for a different replica (account switch since) — never send it for this budget
    await discardPendingE2eeUpgrade();
    pending = null;
  }
  if (!pending) {
    if (password === null) throw new Error("no_encryption_key"); // resume with nothing to resume
    const ledger = store.getLedger();
    if (!ledger) throw new Error("no_local_replica"); // error CODES — lib/api.ts owns the wording
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
      opIds: outbox.snapshot().map((en) => en.op.opId), // their effects are inside the snapshot
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
    await throwIfBudgetMismatch(res); // the session was swapped mid-upload → nothing was written
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
    throw new Error(`${res.status} ${txt}`); // UI: apiErrorMessage extracts { error }
  }
  const body = (await res.json()) as { epoch: number };
  // COMMIT — only after server success: install the new generation on this device.
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
  clearReplacePending(); // the upgrade IS a full server replace from local
  await persist.putMeta("e2eePendingUpgrade", null); // the intent is fulfilled
  await broadcastKeysChanged(); // peer tabs drop dead key state; stale devices hit the 409 → Unlock
  void syncNow("e2ee-upgrade-v2");
}
