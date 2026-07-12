import { buildQuickAddPrompt, parseQuickAdd, parseQuickAddResponse, recurrencePayload, supportsReasoningEffort, type ChatRequest, type QuickAddResult } from "@enveo/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireTier } from "../context";
import { db } from "../db/client";
import { env } from "../env";
import * as s from "../db/schema";
import { applyRecurrenceCreate } from "../sync/apply";

export const extraRoutes = new Hono();

/* ── Server-side AI info (whether the operator set a key) ───────────── */
extraRoutes.get("/ai/info", (c) => c.json({ serverAi: Boolean(env.OPENAI_API_KEY) }));

/* ── Smart Quick-Add ────────────────────────────────────────────────── */
extraRoutes.post("/quick-add", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const { text, locale } = z
    .object({ text: z.string().min(1), locale: z.enum(["pl", "en"]).optional() })
    .parse(await c.req.json());
  const today = new Date().toISOString().slice(0, 10);

  const [envelopes, places, categories] = await Promise.all([
    db.select({ id: s.envelopes.id, name: s.envelopes.name }).from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId)),
    db.select({ id: s.places.id, name: s.places.name }).from(s.places).where(eq(s.places.budgetId, budgetId)),
    db.select({ id: s.categories.id, name: s.categories.name }).from(s.categories).where(eq(s.categories.budgetId, budgetId)),
  ]);

  const refs = { envelopes, places, categories };
  let result = parseQuickAdd(text, refs, today);

  // Optional enrichment via OpenAI (when a key is set). Fallback: rules.
  if (env.OPENAI_API_KEY && result.confidence < 1) {
    try {
      result = await enhanceWithLLM(text, refs, today, result, locale ?? "pl");
    } catch (e) {
      console.warn("quick-add LLM fallback:", (e as Error).message);
    }
  }
  return c.json(result);
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

async function enhanceWithLLM(
  text: string,
  refs: { envelopes: { id: string; name: string }[]; places: { id: string; name: string }[]; categories: { id: string; name: string }[] },
  today: string,
  base: QuickAddResult,
  locale: "pl" | "en",
): Promise<QuickAddResult> {
  const raw = await openaiChat(buildQuickAddPrompt(text, refs, today, locale));
  const fields = parseQuickAddResponse(raw);

  const matchEnv = fields.envelopeName ? refs.envelopes.find((e) => e.name.toLowerCase() === fields.envelopeName!.toLowerCase()) : null;
  const matchPlace = fields.placeName ? refs.places.find((p) => p.name.toLowerCase() === fields.placeName!.toLowerCase()) : null;

  return {
    ...base,
    amount: fields.amount ?? base.amount,
    type: fields.type,
    isRefund: fields.isRefund,
    date: fields.date ?? base.date,
    envelopeId: matchEnv?.id ?? base.envelopeId,
    envelopeName: matchEnv?.name ?? base.envelopeName,
    placeId: matchPlace?.id ?? base.placeId,
    placeName: matchPlace?.name ?? base.placeName,
    confidence: 1,
  };
}

/* ── Recurrence ─────────────────────────────────────────────────────── */
extraRoutes.post("/recurrences", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = recurrencePayload.parse(await c.req.json());
  const row = await applyRecurrenceCreate(db, budgetId, body);
  return c.json(row, 201);
});

/** Occurrence dates of a rule from startDate to `end` (inclusive). */
export function occurrences(rule: string, startDate: string, end: string): string[] {
  if (rule === "none") return startDate <= end ? [startDate] : [];
  const out: string[] = [];
  const [sy, sm, sd] = startDate.split("-").map(Number) as [number, number, number];
  let cur = new Date(Date.UTC(sy, sm - 1, sd));
  const endD = new Date(`${end}T00:00:00Z`);
  let guard = 0;
  while (cur <= endD && guard++ < 1000) {
    out.push(cur.toISOString().slice(0, 10));
    const d = new Date(cur);
    switch (rule) {
      case "weekly":
        d.setUTCDate(d.getUTCDate() + 7);
        break;
      case "monthly":
        d.setUTCMonth(d.getUTCMonth() + 1);
        break;
      case "quarterly":
        d.setUTCMonth(d.getUTCMonth() + 3);
        break;
      case "yearly":
        d.setUTCFullYear(d.getUTCFullYear() + 1);
        break;
      case "monthEnd": {
        d.setUTCMonth(d.getUTCMonth() + 2, 0); // last day of the next month
        break;
      }
      default:
        return out;
    }
    cur = d;
  }
  return out;
}

/**
 * Dates to materialize for a rule: occurrences ≤ today (capped by endDate),
 * skipping the pause window — dates < pausedUntil drop out, the rule resumes
 * by itself after that date.
 */
export function dueOccurrences(
  rec: { rule: string; startDate: string; endDate: string | null; pausedUntil: string | null },
  today: string,
): string[] {
  const cap = rec.endDate && rec.endDate < today ? rec.endDate : today;
  const dates = occurrences(rec.rule, rec.startDate, cap);
  const paused = rec.pausedUntil;
  return paused ? dates.filter((d) => d >= paused) : dates;
}

/** Creates overdue occurrences of planned transactions (date ≤ today). */
extraRoutes.post("/recurrences/materialize", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const today = new Date().toISOString().slice(0, 10);

  const templates = await db
    .select()
    .from(s.transactions)
    .where(and(eq(s.transactions.budgetId, budgetId), eq(s.transactions.planned, true)));

  let created = 0;
  for (const t of templates) {
    if (!t.recurrenceId) continue;
    const [rec] = await db.select().from(s.recurrences).where(eq(s.recurrences.id, t.recurrenceId));
    if (!rec) continue;
    const dates = dueOccurrences(rec, today);

    // already-materialized occurrences of this rule
    const existing = await db
      .select({ date: s.transactions.date })
      .from(s.transactions)
      .where(and(eq(s.transactions.recurrenceId, rec.id), eq(s.transactions.planned, false)));
    const done = new Set(existing.map((e) => e.date));

    for (const date of dates) {
      if (done.has(date)) continue;
      await db.insert(s.transactions).values({
        budgetId,
        type: t.type,
        accountId: t.accountId,
        toAccountId: t.toAccountId,
        amount: t.amount,
        date,
        confirmed: true,
        isRefund: t.isRefund,
        envelopeId: t.envelopeId,
        placeId: t.placeId,
        categoryId: t.categoryId,
        note: t.note,
        planned: false,
        recurrenceId: rec.id,
      });
      created++;
    }
  }
  return c.json({ created });
});
