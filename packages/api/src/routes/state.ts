import { computeEnvelopeSummary, computeStateResponse } from "@enveo/shared";
import { Hono } from "hono";
import { requireTier } from "../context";
import { db } from "../db/client";
import { loadClientLedger } from "../repo";

const monthParam = (raw: string | undefined): string => {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 7);
};

export const stateRoutes = new Hono();

stateRoutes.get("/state", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const month = monthParam(c.req.query("month"));
  const ledger = await loadClientLedger(db, budgetId);
  const resp = computeStateResponse(ledger, month);
  // Preserve the existing wire shape: categories/places were sent so far as
  // raw DB rows (with budgetId). The client does not use that field — local
  // reads (Phase 3) will get a clean StateResponse without it.
  return c.json({
    ...resp,
    categories: resp.categories.map((x) => ({ ...x, budgetId })),
    places: resp.places.map((x) => ({ ...x, budgetId })),
  });
});

stateRoutes.get("/envelopes/:id/summary", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const envId = c.req.param("id");
  const month = monthParam(c.req.query("month"));
  const ledger = await loadClientLedger(db, budgetId);
  return c.json(computeEnvelopeSummary(ledger, envId, month));
});
