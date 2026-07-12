import { allocPayload, txnPayload } from "@enveo/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireTier } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import {
  applyAllocSet,
  applyTxnCreate,
  applyTxnDelete,
  applyTxnUpdate,
  NOT_FOUND,
} from "../sync/apply";

export const txnRoutes = new Hono();

txnRoutes.post("/transactions", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = txnPayload.parse(await c.req.json());
  // DB transaction: parent + split items atomically
  const row = await db.transaction((tx) => applyTxnCreate(tx, budgetId, body));
  return c.json(row, 201);
});

txnRoutes.patch("/transactions/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const id = c.req.param("id");
  const body = txnPayload.parse(await c.req.json());
  const res = await db.transaction((tx) => applyTxnUpdate(tx, budgetId, { ...body, id }));
  if (res === NOT_FOUND) return c.json({ error: "not found" }, 404);
  return c.json(res);
});

txnRoutes.post("/transactions/:id/duplicate", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const id = c.req.param("id");
  const row = await db.transaction(async (tx) => {
    const [orig] = await tx
      .select()
      .from(s.transactions)
      .where(and(eq(s.transactions.id, id), eq(s.transactions.budgetId, budgetId)));
    if (!orig) return null;
    const items = await tx.select().from(s.txnItems).where(eq(s.txnItems.transactionId, id));
    return applyTxnCreate(tx, budgetId, {
      type: orig.type,
      accountId: orig.accountId,
      toAccountId: orig.toAccountId,
      amount: orig.amount,
      date: new Date().toISOString().slice(0, 10),
      confirmed: orig.confirmed,
      isRefund: orig.isRefund,
      envelopeId: orig.envelopeId,
      placeId: orig.placeId,
      categoryId: orig.categoryId,
      name: orig.name,
      note: orig.note,
      tag: null, // a duplicate is a new, manual transaction — it does not inherit the import key
      planned: orig.planned,
      recurrenceId: null,
      items: items.map((i) => ({ envelopeId: i.envelopeId, categoryId: i.categoryId, amount: i.amount })),
    });
  });
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row, 201);
});

txnRoutes.delete("/transactions/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  await applyTxnDelete(db, budgetId, c.req.param("id"));
  return c.body(null, 204);
});

/* ── Allocations (budgeting: "Added") ───────────────────────────────── */

txnRoutes.put("/allocations", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = allocPayload.parse(await c.req.json());
  const row = await applyAllocSet(db, budgetId, body);
  return c.json(row);
});
