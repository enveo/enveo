import { aiLocaleSchema, buildQuickAddPrompt, parseQuickAddResponse, supportsReasoningEffort, type ChatRequest, type QuickAddAiFields } from "@enveo/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireTier } from "../context";
import { db } from "../db/client";
import { env } from "../env";
import * as s from "../db/schema";

export const extraRoutes = new Hono();

/* ── Server-side AI info (whether the operator set a key) ───────────── */
extraRoutes.get("/ai/info", (c) => c.json({ serverAi: Boolean(env.OPENAI_API_KEY) }));

/* ── Smart Quick-Add — AI-only ───────────────────────────────────────
   The rule-based parser is gone (its PL/EN word tables could not be localized),
   so there is nothing to fall back to: no operator key ⇒ 503 ai_unavailable, the
   same contract as /import/extract. Current clients build the very same prompt in
   the browser (web/lib/ai.ts, byok or the /api/ai mirror) — this route only serves
   PWAs that have not updated yet, so it keeps answering the legacy shape (names
   resolved to ids here). `categoryId`/`note` were rules-only fields and stay null. */
extraRoutes.post("/quick-add", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "ai_unavailable" }, 503);
  const budgetId = (await requireTier(c, "plain")).id;
  /* locale: any BCP-47 tag (the UI ships ten languages since 2.2.0); omitted → English. */
  const { text, locale } = z
    .object({ text: z.string().min(1), locale: aiLocaleSchema.optional() })
    .parse(await c.req.json());
  const today = new Date().toISOString().slice(0, 10);

  const [envelopes, places] = await Promise.all([
    db.select({ id: s.envelopes.id, name: s.envelopes.name }).from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId)),
    db.select({ id: s.places.id, name: s.places.name }).from(s.places).where(eq(s.places.budgetId, budgetId)),
  ]);

  let fields: QuickAddAiFields;
  try {
    const raw = await openaiChat(buildQuickAddPrompt(text, { envelopes, places }, today, locale ?? "en"));
    fields = parseQuickAddResponse(raw);
  } catch (e) {
    // upstream rejection or an unparsable answer — the details stay in the server log
    console.error("quick-add failed:", (e as Error).message);
    return c.json({ error: "ai_upstream_error" }, 502);
  }

  const envMatch = fields.envelopeName ? envelopes.find((e) => e.name.toLowerCase() === fields.envelopeName!.toLowerCase()) : null;
  const placeMatch = fields.placeName ? places.find((p) => p.name.toLowerCase() === fields.placeName!.toLowerCase()) : null;
  return c.json({
    amount: fields.amount,
    type: fields.type,
    isRefund: fields.isRefund,
    date: fields.date ?? today,
    envelopeId: envMatch?.id ?? null,
    envelopeName: envMatch?.name ?? null,
    placeId: placeMatch?.id ?? null,
    placeName: placeMatch?.name ?? null,
    categoryId: null,
    note: null,
    confidence: 1,
  });
});

/** Local fetch layer (operator key) — prompt/parsing in shared/aiPrompts. */
async function openaiChat(req: ChatRequest): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      messages: req.messages,
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(req.reasoningEffort && supportsReasoningEffort(env.OPENAI_MODEL) ? { reasoning_effort: req.reasoningEffort } : {}),
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "{}";
}
