import { accountPayload, envelopePayload, groupPayload } from "@enveo/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireTier } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import {
  applyAccountCreate,
  applyAccountDelete,
  applyAccountUpdate,
  applyCategoryCreate,
  applyEnvelopeCreate,
  applyEnvelopeDelete,
  applyEnvelopeUpdate,
  applyGroupCreate,
  applyGroupDelete,
  applyGroupUpdate,
  applyPlaceCreate,
  NOT_FOUND,
} from "../sync/apply";

export const crudRoutes = new Hono();

/* ── Accounts ───────────────────────────────────────────────────────── */

crudRoutes.post("/accounts", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = accountPayload.parse(await c.req.json());
  const row = await db.transaction((tx) => applyAccountCreate(tx, budgetId, body));
  return c.json(row, 201);
});
crudRoutes.patch("/accounts/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = accountPayload.partial().parse(await c.req.json());
  const res = await db.transaction((tx) => applyAccountUpdate(tx, budgetId, { ...body, id: c.req.param("id") }));
  if (res === NOT_FOUND) return c.json({ error: "not found" }, 404);
  return c.json(res);
});
crudRoutes.delete("/accounts/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  await applyAccountDelete(db, budgetId, c.req.param("id"));
  return c.body(null, 204);
});

/* ── Envelope groups ────────────────────────────────────────────────── */

crudRoutes.post("/groups", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = groupPayload.parse(await c.req.json());
  const row = await applyGroupCreate(db, budgetId, body);
  return c.json(row, 201);
});
crudRoutes.patch("/groups/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = groupPayload.partial().parse(await c.req.json());
  const res = await applyGroupUpdate(db, budgetId, { ...body, id: c.req.param("id") });
  if (res === NOT_FOUND) return c.json({ error: "not found" }, 404);
  return c.json(res);
});
crudRoutes.delete("/groups/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  await db.transaction((tx) => applyGroupDelete(tx, budgetId, c.req.param("id")));
  return c.body(null, 204);
});

/* ── Envelopes ──────────────────────────────────────────────────────── */

crudRoutes.post("/envelopes", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = envelopePayload.parse(await c.req.json());
  const row = await applyEnvelopeCreate(db, budgetId, body);
  return c.json(row, 201);
});
crudRoutes.patch("/envelopes/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = envelopePayload.partial().parse(await c.req.json());
  const res = await db.transaction((tx) => applyEnvelopeUpdate(tx, budgetId, { ...body, id: c.req.param("id") }));
  if (res === NOT_FOUND) return c.json({ error: "not found" }, 404);
  return c.json(res);
});
crudRoutes.delete("/envelopes/:id", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  await db.transaction((tx) => applyEnvelopeDelete(tx, budgetId, c.req.param("id")));
  return c.body(null, 204);
});

/* ── Categories / Places (autocomplete) ─────────────────────────────── */
// REST keeps today's find-by-name-return-existing; the sync path
// (client-supplied id) does a plain insert — the client dedupes in the local mirror.
const nameInput = z.object({ name: z.string().min(1) });

crudRoutes.post("/categories", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const { name } = nameInput.parse(await c.req.json());
  const existing = await db
    .select()
    .from(s.categories)
    .where(and(eq(s.categories.budgetId, budgetId), eq(s.categories.name, name)));
  if (existing[0]) return c.json(existing[0], 200);
  const row = await applyCategoryCreate(db, budgetId, { name });
  return c.json(row, 201);
});

crudRoutes.post("/places", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const { name } = nameInput.parse(await c.req.json());
  const existing = await db
    .select()
    .from(s.places)
    .where(and(eq(s.places.budgetId, budgetId), eq(s.places.name, name)));
  if (existing[0]) return c.json(existing[0], 200);
  const row = await applyPlaceCreate(db, budgetId, { name });
  return c.json(row, 201);
});
