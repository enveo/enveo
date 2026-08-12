/**
 * Sync v2 (E2EE) — the server is a blind ciphertext store: the `e2ee_ops`
 * journal (push/pull by seq) + the `e2ee_snapshots` checkpoint (bootstraps a
 * new device without replaying the whole journal). Crypto is EXCLUSIVELY
 * client-side (web/lib/crypto.ts) — no encryption here. The server validates
 * SHAPES only (the "v2." prefix, versions, epochs); it never decrypts and
 * never sees the AAD semantics the clients authenticate with.
 *
 * Guards: every route requires tier 'e2ee' (409 tier_mismatch via
 * app.onError) AND ciphertext format 2 (409 e2ee_upgrade_required — a legacy
 * pre-AAD budget may neither be read nor extended; the only way forward is the
 * explicit /budget/e2ee/upgrade-v2 ceremony below). The push/pull/snapshot
 * channels additionally require a matching `epoch` (bumped on enable/disable/
 * upgrade) — a client from a previous epoch gets a 409 and knows it must do a
 * full bootstrap. Every WRITE channel carries a per-request tenant assertion
 * (budgetId on push, userId on the routes that overwrite a whole budget:
 * snapshot, reset, rekey, enable, disable, upgrade) — the target budget is
 * resolved from the session cookie alone, the cookie is shared by every tab on
 * the device, and `epoch` does NOT distinguish tenants (two independently-
 * encrypted budgets both sit at epoch 1). Since format v2 the assertions are
 * REQUIRED: the "v2." prefix already rejects every pre-v2 client, so there is
 * no legacy body left that could legitimately omit them.
 */
import { clientLedgerSchema, E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import { and, sql as dsql, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type BudgetMeta, requireTier, sessionUserId, TierMismatch } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import { type Executor, wipeBudgetData } from "../sync/apply";
import { budgetAssertionFails, ownerAssertionFails, restoreLedger } from "./sync";

export const sync2Routes = new Hono();

/* ── Input validation (exported for tests) ──────────────────────────── */

/** A v2 ciphertext value: "v2." + base64(nonce ∥ ct ∥ tag). The server checks the PREFIX only —
 *  it stays blind to the contents. "v1." (and anything else) is a 400 at the boundary: an old
 *  client must not extend the journal/checkpoint/envelope with unauthenticated ciphertext. */
const v2Ciphertext = z.string().min(8).startsWith("v2.");

export const sync2PushInput = z.object({
  epoch: z.number().int(),
  /** The budget the CLIENT believes it is writing to (budgetAssertionFails — the per-REQUEST
   *  tenant assertion; `epoch` does NOT distinguish tenants: two independently-encrypted
   *  budgets both sit at epoch 1). REQUIRED since v2 — the op AAD is built from it, so a
   *  replica that cannot name its budget cannot have produced these rows. */
  budgetId: z.string().uuid(),
  ops: z
    .array(z.object({ opId: z.string().uuid(), ciphertext: v2Ciphertext }))
    .min(1)
    .max(500),
});

/**
 * The tenant the CLIENT verified right before the upload (ownerAssertionFails — the per-REQUEST
 * assertion for the full-budget OVERWRITE routes; `epoch` does NOT distinguish tenants, and this
 * file's own routes say so). REQUIRED since v2 (see the module header).
 */
const ownerAssertion = { userId: z.string().min(1) };

export const sync2SnapshotInput = z.object({
  ...ownerAssertion,
  epoch: z.number().int(),
  uptoSeq: z.number().int().min(0),
  blob: v2Ciphertext,
});

export const e2eeEnableInput = z.object({
  ...ownerAssertion,
  /** The budget the client encrypted FOR (the wrap/snapshot AAD name it) — asserted, not trusted. */
  budgetId: z.string().uuid(),
  /** The epoch the client encrypted FOR: enable bumps the epoch, and the ciphertexts are bound
   *  to the NEW one, so the server must refuse a stale expectation instead of installing an
   *  envelope no future device could open (409 with the current meta; the client retries). */
  nextEpoch: z.number().int().min(1),
  wrappedDek: v2Ciphertext,
  kdfParams: z.string().min(1),
  snapshotBlob: v2Ciphertext,
});

export const e2eeDisableInput = z.object({
  ...ownerAssertion,
  /** Locale-independent ASCII wire constant (@enveo/shared) — the word the USER types is
   *  localized and compared on the device; a localized literal here would make the flow
   *  untypeable on a keyboard without Ł/Ą. */
  confirm: z.literal(E2EE_DISABLE_CONFIRM),
  ledger: clientLedgerSchema,
});

export const sync2RekeyInput = z.object({
  ...ownerAssertion,
  /** The epoch the new envelope's AAD was built for. REQUIRED: a rekey landing on any OTHER
   *  generation would permanently brick every future unlock — the v2 wrap hard-fails under a
   *  different epoch — so the server refuses a stale expectation before overwriting the
   *  budget's ONLY envelope. Safe to require: every client that can produce a v2 wrap is v2. */
  expectedEpoch: z.number().int().min(0),
  wrappedDek: v2Ciphertext,
  kdfParams: z.string().min(1),
});

export const sync2ResetInput = z.object({
  ...ownerAssertion,
  epoch: z.number().int(),
  uptoCursor: z.number().int().min(0).optional(),
  snapshotBlob: v2Ciphertext,
});

/** The mandatory v1→v2 upgrade ceremony — the ONLY route a legacy-format budget may write.
 *  Everything is REQUIRED: both tenant assertions, the epoch expectation and format-2 v2
 *  ciphertexts (a fresh envelope + a fresh checkpoint; the old envelope is never reused). */
export const e2eeUpgradeV2Input = z.object({
  budgetId: z.string().uuid(),
  userId: z.string().min(1),
  expectedEpoch: z.number().int().min(0),
  cipherVersion: z.literal(2),
  wrappedDek: v2Ciphertext,
  kdfParams: z.string().min(1),
  snapshotBlob: v2Ciphertext,
});

/** 409 in the budget_mismatch shape — the client re-proves its identity and writes nothing. */
const ownerMismatch = (budgetId: string) => ({ error: "budget_mismatch", budgetId }) as const;

/* ── Helpers ────────────────────────────────────────────────────────── */

/** The budget's e2ee journal cursor: COALESCE(MAX(seq),0). */
async function maxE2eeSeq(x: Executor, budgetId: string): Promise<number> {
  const [row] = await x
    .select({ cursor: dsql<number>`COALESCE(MAX(${s.e2eeOps.seq}), 0)`.mapWith(Number) })
    .from(s.e2eeOps)
    .where(eq(s.e2eeOps.budgetId, budgetId));
  return row?.cursor ?? 0;
}

/** 409 in the tier_mismatch shape with the CURRENT epoch — the client bootstraps. */
const epochMismatch = (meta: BudgetMeta) => ({ error: "tier_mismatch", tier: meta.tier, epoch: meta.epoch }) as const;

/** 409 for a LEGACY (pre-AAD, format 1) budget: no normal sync2 channel may read or extend it.
 *  The body NAMES the budget — the client's ownership proof needs the id before the upgrade
 *  ceremony may write, and nothing else on a v1 budget will hand it over. */
const upgradeRequired = (meta: BudgetMeta) =>
  ({ error: "e2ee_upgrade_required", tier: "e2ee", epoch: meta.epoch, cipherVersion: 1, budgetId: meta.id }) as const;

/* ── POST /sync2/push — append ciphertexts, idempotent by (budget,opId) ── */

sync2Routes.post("/sync2/push", async (c) => {
  const meta = await requireTier(c, "e2ee");
  if (meta.cipherVersion !== 2) return c.json(upgradeRequired(meta), 409);
  const body = sync2PushInput.parse(await c.req.json());
  if (body.epoch !== meta.epoch) return c.json(epochMismatch(meta), 409);
  // the session's budget is not the one this replica is pushing to → write NOTHING
  if (budgetAssertionFails(body.budgetId, meta.id)) {
    return c.json({ error: "budget_mismatch", budgetId: meta.id }, 409);
  }

  const cursor = await db.transaction(async (tx) => {
    await tx
      .insert(s.e2eeOps)
      .values(body.ops.map((op) => ({ budgetId: meta.id, opId: op.opId, ciphertext: op.ciphertext })))
      .onConflictDoNothing({ target: [s.e2eeOps.budgetId, s.e2eeOps.opId] });
    return maxE2eeSeq(tx, meta.id);
  });
  return c.json({ cursor, epoch: meta.epoch });
});

/* ── GET /sync2/pull?since=N&epoch=E — journal delta ────────────────── */

sync2Routes.get("/sync2/pull", async (c) => {
  const meta = await requireTier(c, "e2ee");
  if (meta.cipherVersion !== 2) return c.json(upgradeRequired(meta), 409);
  const since = Number(c.req.query("since"));
  const epoch = Number(c.req.query("epoch"));
  if (!Number.isInteger(since) || since < 0 || !Number.isInteger(epoch)) {
    return c.json({ error: "since (≥0) and epoch must be integers" }, 400);
  }
  if (epoch !== meta.epoch) return c.json(epochMismatch(meta), 409);

  const rows = await db
    .select({ seq: s.e2eeOps.seq, opId: s.e2eeOps.opId, ciphertext: s.e2eeOps.ciphertext })
    .from(s.e2eeOps)
    .where(and(eq(s.e2eeOps.budgetId, meta.id), gt(s.e2eeOps.seq, since)))
    .orderBy(s.e2eeOps.seq)
    .limit(1000);
  const cursor = await maxE2eeSeq(db, meta.id);
  return c.json({ cursor, epoch: meta.epoch, ops: rows });
});

/* ── GET/POST /sync2/snapshot — checkpoint (new-device bootstrap) ───── */

sync2Routes.get("/sync2/snapshot", async (c) => {
  const meta = await requireTier(c, "e2ee");
  // Even the READ is refused on a legacy budget: the new client cannot decrypt "v1." anyway
  // (fail-closed, no legacy fallback), and the 409 body names everything the upgrade flow
  // needs (budgetId, epoch, cipherVersion) — Unlock renders the dedicated upgrade state.
  if (meta.cipherVersion !== 2) return c.json(upgradeRequired(meta), 409);
  const [budget] = await db.select({ wrappedDek: s.budgets.wrappedDek, kdfParams: s.budgets.kdfParams }).from(s.budgets).where(eq(s.budgets.id, meta.id));
  const [snap] = await db
    .select({ uptoSeq: s.e2eeSnapshots.uptoSeq, blob: s.e2eeSnapshots.blob })
    .from(s.e2eeSnapshots)
    .where(eq(s.e2eeSnapshots.budgetId, meta.id));
  return c.json({
    // The session's budget, named: the v2 channel is otherwise budget-blind, and the client's
    // multi-tenant guard must be able to tell whether the local replica IS this budget before
    // it pushes anything (an unstamped replica of another account must never write here).
    budgetId: meta.id,
    epoch: meta.epoch,
    cipherVersion: meta.cipherVersion,
    wrappedDek: budget?.wrappedDek ?? null,
    kdfParams: budget?.kdfParams ?? null,
    uptoSeq: snap?.uptoSeq ?? 0,
    blob: snap?.blob ?? null,
  });
});

sync2Routes.post("/sync2/snapshot", async (c) => {
  const meta = await requireTier(c, "e2ee");
  if (meta.cipherVersion !== 2) return c.json(upgradeRequired(meta), 409);
  const body = sync2SnapshotInput.parse(await c.req.json());
  if (body.epoch !== meta.epoch) return c.json(epochMismatch(meta), 409);
  // PER-REQUEST tenant assertion — this route UPSERTS the resolved budget's only checkpoint,
  // overwriting both `blob` and `uptoSeq`, and it is the one e2ee write channel a client fires
  // in the BACKGROUND (maybeUploadSnapshot, fire-and-forget, seconds after the client's identity
  // check): a cookie swapped mid-cycle would drop THIS device's ciphertext (encrypted with the
  // other budget's DEK) onto the session budget's checkpoint — its owner's next new-device
  // bootstrap would then fail to decrypt, and the stale uptoSeq would skip journal rows. `epoch`
  // cannot catch it: two independently-encrypted budgets both sit at epoch 1.
  if (ownerAssertionFails(body.userId, sessionUserId(c))) return c.json(ownerMismatch(meta.id), 409);

  await db
    .insert(s.e2eeSnapshots)
    .values({ budgetId: meta.id, uptoSeq: body.uptoSeq, blob: body.blob, updatedAt: dsql`now()` })
    .onConflictDoUpdate({
      target: s.e2eeSnapshots.budgetId,
      set: { uptoSeq: body.uptoSeq, blob: body.blob, updatedAt: dsql`now()` },
    });
  return c.json({ epoch: meta.epoch, uptoSeq: body.uptoSeq });
});

/* ── POST /sync2/rekey — new key envelope (password change) ───────────
   Swaps wrappedDek+kdfParams WITHOUT changing the DEK or the epoch: the
   ciphertexts in the journal/checkpoint stay valid; only the password
   wrapping of the key changes. The server still sees nothing in plaintext. */

sync2Routes.post("/sync2/rekey", async (c) => {
  const meta = await requireTier(c, "e2ee");
  // A rekey REWRAPS the same DEK under the same epoch — meaningless for a legacy envelope the
  // new client can neither unwrap nor rebuild; the upgrade ceremony rotates the key instead.
  if (meta.cipherVersion !== 2) return c.json(upgradeRequired(meta), 409);
  const body = sync2RekeyInput.parse(await c.req.json());
  // The new envelope is BOUND to the epoch the client built its AAD for — installing it under
  // any other generation would brick every future unlock. Refuse a stale expectation with the
  // current meta; the client refreshes and re-runs the whole flow (fresh unwrap included).
  if (body.expectedEpoch !== meta.epoch) return c.json(epochMismatch(meta), 409);
  // PER-REQUEST tenant assertion — this route re-keys the resolved budget's envelope, and the
  // client derives the KEK with Argon2id before calling it: a multi-second window in which the
  // shared cookie can be swapped, after which this device's password would lock ANOTHER account.
  if (ownerAssertionFails(body.userId, sessionUserId(c))) return c.json(ownerMismatch(meta.id), 409);
  await db.update(s.budgets).set({ wrappedDek: body.wrappedDek, kdfParams: body.kdfParams }).where(eq(s.budgets.id, meta.id));
  return c.json({ epoch: meta.epoch });
});

/* ── POST /sync2/reset — compaction / rebuild after a JSON import ─────
   Epoch UNCHANGED (this is NOT a tier flip): in one transaction we delete the
   budget's entire e2ee_ops journal and swap the checkpoint for a fresh
   ciphertext of the whole replica. The seq sequence (bigserial) does NOT
   rewind after delete, so subsequent pushes get seq > uptoCursor — a pull
   from the old cursor loses nothing. */

sync2Routes.post("/sync2/reset", async (c) => {
  const meta = await requireTier(c, "e2ee");
  if (meta.cipherVersion !== 2) return c.json(upgradeRequired(meta), 409);
  const body = sync2ResetInput.parse(await c.req.json());
  if (body.epoch !== meta.epoch) return c.json(epochMismatch(meta), 409);
  // PER-REQUEST tenant assertion — this route DELETES the resolved budget's whole journal and
  // swaps its checkpoint; the cookie may have been swapped while the ciphertext was uploading.
  if (ownerAssertionFails(body.userId, sessionUserId(c))) return c.json(ownerMismatch(meta.id), 409);

  const uptoSeq = body.uptoCursor ?? 0;
  await db.transaction(async (tx) => {
    await tx.delete(s.e2eeOps).where(eq(s.e2eeOps.budgetId, meta.id));
    await tx
      .insert(s.e2eeSnapshots)
      .values({ budgetId: meta.id, uptoSeq, blob: body.snapshotBlob, updatedAt: dsql`now()` })
      .onConflictDoUpdate({
        target: s.e2eeSnapshots.budgetId,
        set: { uptoSeq, blob: body.snapshotBlob, updatedAt: dsql`now()` },
      });
  });
  return c.json({ epoch: meta.epoch, uptoSeq });
});

/* ── POST /budget/e2ee/enable — plain → e2ee, ONE transaction ─────────
   Order is CRITICAL: first write the ciphertexts (wrapped_dek + kdf_params
   + checkpoint), wipe the plaintext ONLY after them — a rollback at any
   point leaves the data untouched. */

sync2Routes.post("/budget/e2ee/enable", async (c) => {
  const body = e2eeEnableInput.parse(await c.req.json());
  const result = await db.transaction(async (tx) => {
    const meta = await requireTier(c, "plain", tx);
    // PER-REQUEST tenant assertions — BEFORE anything: this route replaces the resolved budget's
    // plaintext with THIS device's ciphertext and re-keys it under THIS device's wrappedDek.
    // Both the budget AND the owner are asserted since v2 (the ciphertexts NAME the budget in
    // their authenticated context, so installing them on another budget bricks its bootstrap).
    if (ownerAssertionFails(body.userId, sessionUserId(c))) return { mismatch: true, id: meta.id } as const;
    if (budgetAssertionFails(body.budgetId, meta.id)) return { mismatch: true, id: meta.id } as const;
    const nextEpoch = meta.epoch + 1;
    // The client's ciphertexts are BOUND to the epoch it expected — installing them under any
    // other value would produce an envelope/checkpoint no device could ever open. Refuse a
    // stale expectation with the current meta; the client recomputes and retries.
    if (body.nextEpoch !== nextEpoch) return { mismatch: false, stale: true, meta } as const;
    await tx
      .update(s.budgets)
      .set({ tier: "e2ee", wrappedDek: body.wrappedDek, kdfParams: body.kdfParams, epoch: nextEpoch, cipherVersion: 2 })
      .where(eq(s.budgets.id, meta.id));
    await tx
      .insert(s.e2eeSnapshots)
      .values({ budgetId: meta.id, uptoSeq: 0, blob: body.snapshotBlob, updatedAt: dsql`now()` })
      .onConflictDoUpdate({
        target: s.e2eeSnapshots.budgetId,
        set: { uptoSeq: 0, blob: body.snapshotBlob, updatedAt: dsql`now()` },
      });
    await wipeBudgetData(tx, meta.id); // plaintext disappears ONLY after the ciphertext is written
    return { mismatch: false, stale: false, id: meta.id, epoch: nextEpoch } as const;
  });
  if (result.mismatch) return c.json(ownerMismatch(result.id), 409);
  if (result.stale) return c.json(epochMismatch(result.meta), 409);
  return c.json({ epoch: result.epoch });
});

/* ── POST /budget/e2ee/disable — e2ee → plain, ONE transaction ────────
   Restores the plaintext with the SAME logic as /sync/replace (restoreLedger);
   ciphertexts are deleted ONLY after a successful restore (rollback = nothing
   is lost). Requires the confirmation literal. */

sync2Routes.post("/budget/e2ee/disable", async (c) => {
  const body = e2eeDisableInput.parse(await c.req.json());
  const result = await db.transaction(async (tx) => {
    const meta = await requireTier(c, "e2ee", tx);
    // A LEGACY budget must cross the upgrade boundary first — every normal sync2 route
    // requires format 2, and disable is one of them (fail-closed, no side door).
    if (meta.cipherVersion !== 2) return { kind: "legacy", meta } as const;
    // PER-REQUEST tenant assertion — BEFORE restoreLedger, which wipes the resolved budget and
    // rebuilds it from the ledger in this body (the widest write in the whole API).
    if (ownerAssertionFails(body.userId, sessionUserId(c))) return { kind: "mismatch", id: meta.id } as const;
    const nextEpoch = meta.epoch + 1;
    await restoreLedger(tx, meta.id, body.ledger);
    await tx.update(s.budgets).set({ tier: "plain", wrappedDek: null, kdfParams: null, epoch: nextEpoch }).where(eq(s.budgets.id, meta.id));
    await tx.delete(s.e2eeOps).where(eq(s.e2eeOps.budgetId, meta.id));
    await tx.delete(s.e2eeSnapshots).where(eq(s.e2eeSnapshots.budgetId, meta.id));
    return { kind: "done", id: meta.id, epoch: nextEpoch } as const;
  });
  if (result.kind === "legacy") return c.json(upgradeRequired(result.meta), 409);
  if (result.kind === "mismatch") return c.json(ownerMismatch(result.id), 409);
  return c.json({ epoch: result.epoch });
});

/* ── POST /budget/e2ee/upgrade-v2 — the MANDATORY legacy upgrade ceremony ──
   The ONLY route a format-1 budget may write. One transaction, serialized on
   the budget row itself (SELECT … FOR UPDATE): install the fresh v2 envelope,
   set cipher_version=2, bump the epoch, DELETE the entire legacy journal and
   replace the checkpoint with the fresh v2 blob at upto_seq=0 — a real
   data-key rotation built from the client's trusted local replica. Any
   failure rolls back all four effects. Concurrent/repeated attempts produce
   either one winner or an idempotent already-upgraded answer (the SAME
   committed envelope), never two epoch increments.

   LOCK ORDER (see CLAUDE.md § Operation lock): updating `budgets` fires
   log_change() → the SHARED changes-cursor lock, acquired here AFTER the row
   lock. That cannot deadlock against the v1 barrier routes: they take the
   EXCLUSIVE changes lock FIRST and then only READ budgets (MVCC — a plain
   select never waits on a row lock), so no cycle exists. The lazy-creation
   operation lock is never taken on this path (an e2ee budget exists by
   definition — requireTier's fast path resolves it). */

sync2Routes.post("/budget/e2ee/upgrade-v2", async (c) => {
  const body = e2eeUpgradeV2Input.parse(await c.req.json());
  const result = await db.transaction(async (tx) => {
    const meta = await requireTier(c, "e2ee", tx);
    // PER-REQUEST tenant assertions — BEFORE any mutation. Both are REQUIRED on this route:
    // it overwrites the session budget's entire E2EE state, and the ceremony (Argon2id +
    // encrypting the whole replica) takes seconds in which the shared cookie can be swapped.
    if (ownerAssertionFails(body.userId, sessionUserId(c))) return { kind: "mismatch", id: meta.id } as const;
    if (budgetAssertionFails(body.budgetId, meta.id)) return { kind: "mismatch", id: meta.id } as const;
    // Serialize concurrent ceremonies on the budget row; re-read the state UNDER the lock.
    const [row] = await tx
      .select({ tier: s.budgets.tier, epoch: s.budgets.epoch, cipherVersion: s.budgets.cipherVersion, wrappedDek: s.budgets.wrappedDek })
      .from(s.budgets)
      .where(eq(s.budgets.id, meta.id))
      .for("update");
    if (row?.tier !== "e2ee") throw new TierMismatch({ id: meta.id, tier: "plain", epoch: row?.epoch ?? 0, cipherVersion: 2 });
    if (row.cipherVersion === 2) {
      // Already format 2. The RETRY of this device's own committed attempt (response lost) is
      // recognized by the identical envelope + the expected epoch bump → idempotent success.
      // Anything else (another device won, or the budget was upgraded long ago) is a stale
      // generation: refuse with the current epoch — the loser re-bootstraps via Unlock.
      if (row.epoch === body.expectedEpoch + 1 && row.wrappedDek === body.wrappedDek) {
        return { kind: "done", id: meta.id, epoch: row.epoch } as const;
      }
      return { kind: "stale", meta: { ...meta, epoch: row.epoch } } as const;
    }
    if (row.epoch !== body.expectedEpoch) return { kind: "stale", meta: { ...meta, epoch: row.epoch } } as const;
    const nextEpoch = row.epoch + 1;
    await tx
      .update(s.budgets)
      .set({ wrappedDek: body.wrappedDek, kdfParams: body.kdfParams, cipherVersion: 2, epoch: nextEpoch })
      .where(eq(s.budgets.id, meta.id));
    await tx.delete(s.e2eeOps).where(eq(s.e2eeOps.budgetId, meta.id)); // the ENTIRE legacy journal
    await tx
      .insert(s.e2eeSnapshots)
      .values({ budgetId: meta.id, uptoSeq: 0, blob: body.snapshotBlob, updatedAt: dsql`now()` })
      .onConflictDoUpdate({
        target: s.e2eeSnapshots.budgetId,
        set: { uptoSeq: 0, blob: body.snapshotBlob, updatedAt: dsql`now()` },
      });
    return { kind: "done", id: meta.id, epoch: nextEpoch } as const;
  });
  if (result.kind === "mismatch") return c.json(ownerMismatch(result.id), 409);
  if (result.kind === "stale") return c.json(epochMismatch(result.meta), 409);
  return c.json({ budgetId: result.id, epoch: result.epoch, cipherVersion: 2, uptoSeq: 0 });
});
