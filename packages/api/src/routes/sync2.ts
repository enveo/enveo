/**
 * Sync v2 (E2EE) — the server is a blind ciphertext store: the `e2ee_ops`
 * journal (push/pull by seq) + the `e2ee_snapshots` checkpoint (bootstraps a
 * new device without replaying the whole journal). Crypto is EXCLUSIVELY
 * client-side (web/lib/crypto.ts) — no encryption here.
 *
 * Guards: every route requires tier 'e2ee' (409 tier_mismatch via
 * app.onError), and the push/pull/snapshot channels additionally require a
 * matching `epoch` (bumped on enable/disable) — a client from a previous
 * epoch gets a 409 and knows it must do a full bootstrap.
 */
import { clientLedgerSchema } from "@enveo/shared";
import { and, eq, gt, sql as dsql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireTier, type BudgetMeta } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import { wipeBudgetData, type Executor } from "../sync/apply";
import { restoreLedger } from "./sync";

export const sync2Routes = new Hono();

/* ── Input validation (exported for tests) ──────────────────────────── */

export const sync2PushInput = z.object({
  epoch: z.number().int(),
  ops: z
    .array(z.object({ opId: z.string().uuid(), ciphertext: z.string().min(8) }))
    .min(1)
    .max(500),
});

export const sync2SnapshotInput = z.object({
  epoch: z.number().int(),
  uptoSeq: z.number().int().min(0),
  blob: z.string().min(1),
});

export const e2eeEnableInput = z.object({
  wrappedDek: z.string().min(1),
  kdfParams: z.string().min(1),
  snapshotBlob: z.string().min(1),
});

export const e2eeDisableInput = z.object({
  confirm: z.literal("WYŁĄCZ-E2EE"),
  ledger: clientLedgerSchema,
});

export const sync2RekeyInput = z.object({
  wrappedDek: z.string().min(1),
  kdfParams: z.string().min(1),
});

export const sync2ResetInput = z.object({
  epoch: z.number().int(),
  uptoCursor: z.number().int().min(0).optional(),
  snapshotBlob: z.string().min(1),
});

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
const epochMismatch = (meta: BudgetMeta) =>
  ({ error: "tier_mismatch", tier: meta.tier, epoch: meta.epoch }) as const;

/* ── POST /sync2/push — append ciphertexts, idempotent by (budget,opId) ── */

sync2Routes.post("/sync2/push", async (c) => {
  const meta = await requireTier(c, "e2ee");
  const body = sync2PushInput.parse(await c.req.json());
  if (body.epoch !== meta.epoch) return c.json(epochMismatch(meta), 409);

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
  const [budget] = await db
    .select({ wrappedDek: s.budgets.wrappedDek, kdfParams: s.budgets.kdfParams })
    .from(s.budgets)
    .where(eq(s.budgets.id, meta.id));
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
    wrappedDek: budget?.wrappedDek ?? null,
    kdfParams: budget?.kdfParams ?? null,
    uptoSeq: snap?.uptoSeq ?? 0,
    blob: snap?.blob ?? null,
  });
});

sync2Routes.post("/sync2/snapshot", async (c) => {
  const meta = await requireTier(c, "e2ee");
  const body = sync2SnapshotInput.parse(await c.req.json());
  if (body.epoch !== meta.epoch) return c.json(epochMismatch(meta), 409);

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
  const body = sync2RekeyInput.parse(await c.req.json());
  await db
    .update(s.budgets)
    .set({ wrappedDek: body.wrappedDek, kdfParams: body.kdfParams })
    .where(eq(s.budgets.id, meta.id));
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
  const body = sync2ResetInput.parse(await c.req.json());
  if (body.epoch !== meta.epoch) return c.json(epochMismatch(meta), 409);

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
  const epoch = await db.transaction(async (tx) => {
    const meta = await requireTier(c, "plain", tx);
    const nextEpoch = meta.epoch + 1;
    await tx
      .update(s.budgets)
      .set({ tier: "e2ee", wrappedDek: body.wrappedDek, kdfParams: body.kdfParams, epoch: nextEpoch })
      .where(eq(s.budgets.id, meta.id));
    await tx
      .insert(s.e2eeSnapshots)
      .values({ budgetId: meta.id, uptoSeq: 0, blob: body.snapshotBlob, updatedAt: dsql`now()` })
      .onConflictDoUpdate({
        target: s.e2eeSnapshots.budgetId,
        set: { uptoSeq: 0, blob: body.snapshotBlob, updatedAt: dsql`now()` },
      });
    await wipeBudgetData(tx, meta.id); // plaintext disappears ONLY after the ciphertext is written
    return nextEpoch;
  });
  return c.json({ epoch });
});

/* ── POST /budget/e2ee/disable — e2ee → plain, ONE transaction ────────
   Restores the plaintext with the SAME logic as /sync/replace (restoreLedger);
   ciphertexts are deleted ONLY after a successful restore (rollback = nothing
   is lost). Requires the confirmation literal. */

sync2Routes.post("/budget/e2ee/disable", async (c) => {
  const body = e2eeDisableInput.parse(await c.req.json());
  const epoch = await db.transaction(async (tx) => {
    const meta = await requireTier(c, "e2ee", tx);
    const nextEpoch = meta.epoch + 1;
    await restoreLedger(tx, meta.id, body.ledger);
    await tx
      .update(s.budgets)
      .set({ tier: "plain", wrappedDek: null, kdfParams: null, epoch: nextEpoch })
      .where(eq(s.budgets.id, meta.id));
    await tx.delete(s.e2eeOps).where(eq(s.e2eeOps.budgetId, meta.id));
    await tx.delete(s.e2eeSnapshots).where(eq(s.e2eeSnapshots.budgetId, meta.id));
    return nextEpoch;
  });
  return c.json({ epoch });
});
