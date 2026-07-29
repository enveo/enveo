import { aiLocaleSchema, buildImportExtractPrompt, languageDirectives, languageName, parseImportExtractResponse, supportsReasoningEffort, type ChatRequest, type ImportExtractItem } from "@enveo/shared";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireTier } from "../context";
import { db } from "../db/client";
import { env } from "../env";
import * as s from "../db/schema";
import { assertBudgetFks } from "../sync/apply";
import { confidentSourceRef, decideAssignment, type HistGroup, type HistPattern, rankPatterns } from "./import-match";
import { buildDupIndex, classifyDup } from "./import-dedupe";

/**
 * Expense import from screenshots (Apple Wallet / bank history).
 *
 * Two steps:
 *  1. POST /import/extract — screenshots → OpenAI (structured output) → items for review.
 *  2. POST /import/apply — idempotent write; duplicate = same (amount, day,
 *     envelope, tag). `dryRun: true` only marks statuses, writes nothing.
 */
export const importRoutes = new Hono();

const extractInput = z.object({
  images: z.array(z.string().regex(/^data:image\//, "expected an image data-URL")).min(1).max(6),
  /* Any BCP-47 tag (the UI ships ten languages since 2.2.0). Omitted → English, the language
     the app itself is written in; every current client sends its UI language explicitly. */
  locale: aiLocaleSchema.optional(),
});

/* ── Cycle 1: vision — only facts from the screenshot; prompt+schema+parsing in shared/aiPrompts ── */

/* ── Cycle 2: enrichment based on the user's historical categorizations ── */
const enrichedTxn = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  envelope: z.string().nullable(),
  category: z.string().nullable(),
  place: z.string().nullable(),
});
const enrichedOutput = z.object({ transactions: z.array(enrichedTxn) });

const ENRICH_JSON_SCHEMA = {
  name: "enriched_transactions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      transactions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "integer", description: "Index of the transaction from the input" },
            name: { type: "string", description: "Short name in the user's language of WHAT it was (e.g. Groceries, Fuel, Cloud fee) — NOT the store name" },
            envelope: { type: ["string", "null"], description: "Envelope name from the list or null" },
            category: { type: ["string", "null"], description: "Category name from the list or null" },
            place: { type: ["string", "null"], description: "Readable place name (e.g. Lidl) — an existing one if it matches" },
          },
          required: ["index", "name", "envelope", "category", "place"],
        },
      },
    },
    required: ["transactions"],
  },
} as const;

/** Match result for one raw description: patterns (top 5, as AI hints)
 *  plus `confident` — a SURE source_ref hit that allows a deterministic
 *  assignment and skips the AI (null when uncertain). */
export interface HistMatch {
  patterns: HistPattern[];
  confident: HistPattern | null;
}

/** Historical patterns matched against raw place descriptions.
 *  Match key: source_ref (raw bank description) → place → tag → name;
 *  source_ref is immutable on correction, so it learns from fixes (see
 *  import-match.ts). */
export async function matchHistory(budgetId: string, rawPlaces: string[]): Promise<Record<string, HistMatch>> {
  const [txns, envs, cats, plcs] = await Promise.all([
    db
      .select({ name: s.transactions.name, envelopeId: s.transactions.envelopeId, categoryId: s.transactions.categoryId, placeId: s.transactions.placeId, tag: s.transactions.tag, sourceRef: s.transactions.sourceRef, type: s.transactions.type, isRefund: s.transactions.isRefund, toAccountId: s.transactions.toAccountId })
      .from(s.transactions)
      .where(eq(s.transactions.budgetId, budgetId)),
    db.select().from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId)),
    db.select().from(s.categories).where(eq(s.categories.budgetId, budgetId)),
    db.select().from(s.places).where(eq(s.places.budgetId, budgetId)),
  ]);
  const envName = new Map(envs.map((e) => [e.id, e.name]));
  const catName = new Map(cats.map((x) => [x.id, x.name]));
  const plcName = new Map(plcs.map((x) => [x.id, x.name]));

  // group history by (similarity key, assignment pattern); source_ref as the key
  // when present — the strongest signal, stable across corrections
  const groups = new Map<string, HistGroup>();
  for (const t of txns) {
    /* Transfers are NO LONGER skipped (2026-07-12): history also teaches the TYPE —
       a "refund→transfer" correction in import editing should train future
       proposals (deterministically on a confident source_ref). */
    const sref = t.sourceRef?.trim() || null;
    const key = sref ?? (t.placeId ? plcName.get(t.placeId) : null) ?? t.tag ?? t.name;
    if (!key) continue;
    const pat = `${sref ? "src:" : ""}${key}|${t.name ?? ""}|${t.envelopeId ?? ""}|${t.categoryId ?? ""}|${t.type}|${t.isRefund ? 1 : 0}|${t.toAccountId ?? ""}`;
    const cur = groups.get(pat);
    if (cur) cur.count++;
    else
      groups.set(pat, {
        key,
        fromSourceRef: !!sref,
        place: t.placeId ? (plcName.get(t.placeId) ?? null) : null,
        name: t.name,
        envelope: t.envelopeId ? (envName.get(t.envelopeId) ?? null) : null,
        category: t.categoryId ? (catName.get(t.categoryId) ?? null) : null,
        count: 1,
        type: t.type as "expense" | "income" | "transfer",
        isRefund: t.type === "expense" && !!t.isRefund,
        toAccountId: t.type === "transfer" ? (t.toAccountId ?? null) : null,
      });
  }
  const all = [...groups.values()];

  const out: Record<string, HistMatch> = {};
  for (const raw of [...new Set(rawPlaces)]) {
    const patterns = rankPatterns(raw, all);
    const confident = confidentSourceRef(raw, all);
    if (patterns.length > 0 || confident) out[raw] = { patterns, confident };
  }
  return out;
}

/** OpenAI answered non-2xx — surfaced to the client as the `ai_upstream_error` code (+ status). */
class OpenAiError extends Error {
  constructor(readonly status: number) {
    super(`openai ${status}`);
  }
}

async function openaiJson(req: ChatRequest): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: env.OPENAI_MODEL, messages: req.messages, ...(req.responseFormat ? { response_format: req.responseFormat } : {}), ...(req.reasoningEffort && supportsReasoningEffort(env.OPENAI_MODEL) ? { reasoning_effort: req.reasoningEffort } : {}) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("openai:", res.status, detail.slice(0, 500));
    throw new OpenAiError(res.status);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "{}";
}

/* The API answers with stable machine CODES (never prose): the client owns the wording
   in every locale (web/lib/api.ts → i18n). Structured detail travels in its own field. */
importRoutes.post("/import/extract", async (c) => {
  if (!env.OPENAI_API_KEY) {
    return c.json({ error: "ai_unavailable" }, 503);
  }
  const budgetId = (await requireTier(c, "plain")).id;
  const { images, locale: rawLocale } = extractInput.parse(await c.req.json());
  const locale = rawLocale ?? "en";
  const language = languageName(locale);
  const today = new Date().toISOString().slice(0, 10);
  const [budgetRow] = await db.select({ currency: s.budgets.currency }).from(s.budgets).where(eq(s.budgets.id, budgetId));
  const currency = budgetRow?.currency ?? "EUR";

  /* ── cycle 1: facts from the screenshot (prompt+parsing from shared — parity with byok) ── */
  let found: ImportExtractItem[];
  try {
    const raw = await openaiJson(buildImportExtractPrompt(images, { envelopes: [], categories: [] }, today, locale, currency));
    found = parseImportExtractResponse(raw);
  } catch (e) {
    // upstream rejection or an unparsable answer — the details stay in the server log
    console.error("import/extract cycle 1 failed:", (e as Error).message);
    return c.json({ error: "ai_upstream_error", ...(e instanceof OpenAiError ? { status: e.status } : {}) }, 502);
  }
  if (found.length === 0) return c.json({ items: [] });

  /* ── cycle 2: similarity with history + assignments the way the user made them ── */
  const [envelopes, categories] = await Promise.all([
    db.select({ id: s.envelopes.id, name: s.envelopes.name }).from(s.envelopes).where(and(eq(s.envelopes.budgetId, budgetId), eq(s.envelopes.archived, false))),
    db.select({ id: s.categories.id, name: s.categories.name }).from(s.categories).where(eq(s.categories.budgetId, budgetId)),
  ]);
  const history = await matchHistory(budgetId, found.map((t) => t.rawPlace));

  const sysEnrich =
    "You assign bank-statement transactions EXACTLY in the style the user has assigned them historically. " +
    "Each transaction has a `patterns` field — how the user booked this place in the past ({place, name, envelope, category, count, fromSourceRef}). " +
    "OVERRIDING RULE: when a pattern has fromSourceRef=true, use IT (it is a learned correction matched to the raw bank description — " +
    "the strongest signal, INDEPENDENT of count) and ignore more numerous patterns. Only when none has fromSourceRef=true, pick " +
    "the most numerous one (highest count) that matches the transaction type. From the chosen pattern COPY VERBATIM all four fields: " +
    "name, envelope, category, place — even when name looks like an abbreviation (e.g. Vps) and category/place are null. " +
    `Only when \`patterns\` is empty, propose yourself: name — a short name in ${language} of WHAT it was (e.g. Groceries, Fuel, Cloud fee), never the raw company name with an address; ` +
    `envelope — one of the envelopes: ${envelopes.map((e) => e.name).join(", ")} — or null; ` +
    `category — one of the categories: ${categories.map((x) => x.name).join(", ")} — or null; ` +
    "place — a readable, short place name (e.g. Lidl, Netflix). Do not change amounts or dates. " +
    /* Cycle 2 is server-only (no byok twin), but it carries the SAME language contract as every
       shared prompt — the names it invents land in the user's ledger. */
    languageDirectives(locale) +
    "Return JSON.";
  // Items with a SURE source_ref hit are assigned DETERMINISTICALLY — we do NOT ask the AI
  // (a learned correction matched exactly to the raw bank description). The rest → cycle 2 (model).
  const uncertain = found.map((t, index) => ({ t, index })).filter(({ t }) => !history[t.rawPlace]?.confident);
  console.log(`import/extract: ${found.length - uncertain.length}/${found.length} confident by source_ref (no AI); ${uncertain.length} to the model`);

  let enriched = new Map<number, z.infer<typeof enrichedTxn>>();
  if (uncertain.length > 0) {
    const enrichPayload = {
      transactions: uncertain.map(({ t, index }) => ({ index, date: t.date, amount: t.amount, type: t.type, rawPlace: t.rawPlace, tag: t.tag, patterns: history[t.rawPlace]?.patterns ?? [] })),
    };
    try {
      const raw = await openaiJson({
        messages: [
          { role: "system", content: sysEnrich },
          { role: "user", content: JSON.stringify(enrichPayload) },
        ],
        responseFormat: { type: "json_schema", json_schema: ENRICH_JSON_SCHEMA },
        /* Matching against history patterns = simple comparisons — full
           gpt-5.5 reasoning only slowed the import down (cycle 1/vision STAYS
           on the default: OCR precision matters there). */
        reasoningEffort: "low",
      });
      // size only — the answer carries the user's transactions; it NEVER goes to the server log
      console.log(`import/extract cycle 2: ${raw.length} B answer`);
      enriched = new Map(enrichedOutput.parse(JSON.parse(raw)).transactions.map((t) => [t.index, t]));
    } catch (e) {
      console.warn("import/extract cycle 2 (enrichment) failed — returning raw data:", (e as Error).message);
    }
  }

  const envByName = new Map(envelopes.map((e) => [e.name.toLowerCase(), e]));
  const catByName = new Map(categories.map((x) => [x.name.toLowerCase(), x]));
  const items = found.map((t, index) => {
    const h = history[t.rawPlace];
    // sure source_ref hit → deterministic (no AI); otherwise the model decides,
    // and the best pattern fills gaps (hardOverride=false — source_ref is not forced).
    const pick = h?.confident
      ? decideAssignment(t.rawPlace, h.confident, undefined)
      : decideAssignment(t.rawPlace, h?.patterns?.[0], enriched.get(index), false);
    const envMatch = pick.envelope ? envByName.get(pick.envelope.toLowerCase()) : undefined;
    const catMatch = pick.category ? catByName.get(pick.category.toLowerCase()) : undefined;
    /* TYPE learning: only from CONFIDENT history (source_ref) — the model never
       decides the type. A transfer is proposed only with a remembered target
       account; a collision with the source account is caught by apply validation. */
    const conf = h?.confident;
    const learnedType = conf && (conf.type !== t.type || conf.isRefund) ? conf.type : null;
    const proposedType = learnedType && (learnedType !== "transfer" || conf!.toAccountId) ? learnedType : t.type;
    return {
      date: t.date,
      amount: t.amount,
      type: proposedType,
      // isRefund: a live positive-amount refund read (t.isRefund) is never suppressed by
      // history — a genuine refund from an ordinarily-non-refund merchant must not be
      // reclassified as a normal expense. Only when the live read is false does confident
      // learned history (source_ref) get to override it (the previous ?? let a
      // isRefund:false history entry beat a true live read — the bug fixed here).
      isRefund: proposedType === "expense" ? (t.isRefund || (conf?.isRefund ?? false)) : false,
      toAccountId: proposedType === "transfer" ? (conf?.toAccountId ?? null) : null,
      name: pick.name,
      tag: t.tag,
      // raw bank description — stored as metadata (source_ref), invisible
      // in the UI; used to match future imports and learn from corrections
      rawPlace: t.rawPlace,
      envelopeId: envMatch?.id ?? null,
      envelopeName: envMatch?.name ?? null,
      categoryId: catMatch?.id ?? null,
      categoryName: catMatch?.name ?? null,
      placeName: pick.place,
      // presentation-only (not stored): lets the UI warn on a foreign-currency row
      currency: t.currency,
      fxOriginal: t.fxOriginal,
    };
  });
  return c.json({ items });
});

export const applyInput = z.object({
  accountId: z.string().uuid(),
  dryRun: z.boolean().optional(),
  items: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        amount: z.number().int().positive(),
        type: z.enum(["expense", "income", "transfer"]),
        name: z.string().default(""),
        tag: z.string(),
        rawPlace: z.string().nullable().optional(), // raw bank description → source_ref
        envelopeId: z.string().uuid().nullable(),
        categoryId: z.string().uuid().nullable().optional(),
        placeName: z.string().nullable().optional(),
        // ADDITIVE extension (editing an item before adding) — old clients
        // don't send these fields and get the previous behavior.
        accountId: z.string().uuid().optional(), // overrides the global account
        toAccountId: z.string().uuid().nullable().optional(), // required for transfer
        isRefund: z.boolean().optional(), // expense only; otherwise ignored
        note: z.string().max(2000).optional(),
        /* Deliberate add despite a sure duplicate (the user edited an
           "already exists" item in review) — skips classifyDup for this item. */
        force: z.boolean().optional(),
        /* PRESENTATION-ONLY (fx/refund review, ImportSheet): accepted so the round-trip of an
           item echoed back from /import/extract validates, but never stored — there is no
           `currency`/`fx_original` column on `transactions` (money is always the budget's
           currency; source_ref already carries what we persist about the raw row). */
        currency: z.string().optional(),
        fxOriginal: z.string().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export type ApplyItem = z.infer<typeof applyInput>["items"][number];

/** Transfer validation error in a batch: a transfer without a target account
 *  or with a target account equal to the item's account. Null when all valid. */
export function findTransferError(
  items: ApplyItem[],
  globalAccountId: string,
): { error: "transfer_invalid"; index: number } | null {
  const index = items.findIndex(
    (it) => it.type === "transfer" && (!it.toAccountId || it.toAccountId === (it.accountId ?? globalAccountId)),
  );
  return index === -1 ? null : { error: "transfer_invalid", index };
}

/** Transaction insert values for an import item (without budgetId/placeId —
 *  the route adds those). Parity with txn.create: a transfer has an empty
 *  envelope and category, is_refund only for expense. */
export function applyTxnValues(it: ApplyItem, globalAccountId: string) {
  const transfer = it.type === "transfer";
  return {
    type: it.type,
    accountId: it.accountId ?? globalAccountId,
    toAccountId: transfer ? (it.toAccountId ?? null) : null,
    amount: it.amount,
    date: it.date,
    isRefund: it.type === "expense" ? (it.isRefund ?? false) : false,
    envelopeId: transfer ? null : it.envelopeId,
    categoryId: transfer ? null : (it.categoryId ?? null),
    name: it.name || null,
    note: it.note?.trim() ? it.note : null,
    tag: it.tag.trim(),
    sourceRef: it.rawPlace?.trim() || null,
  };
}

importRoutes.post("/import/apply", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = applyInput.parse(await c.req.json());

  // transfer validation BEFORE any write — whole-batch error with the item index
  const transferErr = findTransferError(body.items, body.accountId);
  if (transferErr) return c.json(transferErr, 400);

  // budget-scope guard BEFORE any write: every FK in the batch must belong to
  // the caller's budget (cross-tenant ids → ScopeViolation → 400 foreign_ref)
  for (const it of body.items) {
    await assertBudgetFks(db, budgetId, {
      accountId: it.accountId ?? body.accountId,
      toAccountId: it.toAccountId,
      envelopeId: it.envelopeId,
      categoryId: it.categoryId,
    });
  }

  const dates = [...new Set(body.items.map((i) => i.date))];
  const existing = await db
    .select({ date: s.transactions.date, amount: s.transactions.amount, sourceRef: s.transactions.sourceRef })
    .from(s.transactions)
    .where(and(eq(s.transactions.budgetId, budgetId), inArray(s.transactions.date, dates)));
  // duplicate key WITHOUT nondeterministic fields (LLM tag/envelope) — see import-dedupe.ts
  const dupIdx = buildDupIndex(existing);

  // places: match by name (case-insensitive), create missing ones at write time
  const placeRows = await db.select().from(s.places).where(eq(s.places.budgetId, budgetId));
  const placeByName = new Map(placeRows.map((p) => [p.name.toLowerCase(), p.id]));
  const resolvePlace = async (nameRaw: string | null | undefined): Promise<string | null> => {
    const name = nameRaw?.trim();
    if (!name) return null;
    const hit = placeByName.get(name.toLowerCase());
    if (hit) return hit;
    if (body.dryRun) return null; // in dryRun we create nothing
    const [row] = await db.insert(s.places).values({ budgetId, name }).returning();
    placeByName.set(name.toLowerCase(), row!.id);
    return row!.id;
  };

  let added = 0;
  let skipped = 0;
  const results: Array<(typeof body.items)[number] & { status: "added" | "exists" | "probable" }> = [];
  for (const it of body.items) {
    const status = it.force ? "new" : classifyDup({ date: it.date, amount: it.amount, rawPlace: it.rawPlace }, dupIdx);
    if (status === "exists") {
      skipped++;
      results.push({ ...it, status: "exists" });
      continue;
    }
    if (body.dryRun && status === "probable") {
      // only date+amount match (e.g. a manual entry without source_ref) — the
      // decision belongs to the user: unchecked by default, but selectable
      results.push({ ...it, status: "probable" });
      continue;
    }
    dupIdx.markSeen({ date: it.date, amount: it.amount, rawPlace: it.rawPlace }); // dedup within the batch (strong key)
    if (!body.dryRun) {
      await db.insert(s.transactions).values({
        budgetId,
        ...applyTxnValues(it, body.accountId),
        placeId: await resolvePlace(it.placeName),
      });
    }
    added++;
    results.push({ ...it, status: "added" });
  }
  return c.json({ added, skipped, dryRun: !!body.dryRun, results });
});

