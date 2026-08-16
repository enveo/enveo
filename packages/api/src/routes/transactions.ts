import { allocPayload, txnPayload } from "@enveo/shared";
import { Hono } from "hono";
import { requireTier } from "../context";
import { db } from "../db/client";
import { applyAllocSet, applyTxnCreate, applyTxnDelete, applyTxnUpdate, NOT_FOUND } from "../sync/apply";

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
  await requireTier(c, "plain");
  return c.json({ error: "client_write_required" }, 410);
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
