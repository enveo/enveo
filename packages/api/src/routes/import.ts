import {
  AI_VISION_TIMEOUT_MS,
  aiLocaleSchema,
  buildImportExtractPrompt,
  type ChatRequest,
  type ImportExtractItem,
  type ImportHistoryQuery,
  type ImportHistoryRecord,
  languageDirectives,
  languageName,
  parseImportExtractResponse,
  selectImportHistoryCandidates,
} from "@enveo/shared";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { aiBudgetExhaustedBody, meteredOperatorChat, operatorChatPayload, SpendDenied } from "../aiSpend/transport";
import { requireTier, sessionUserId } from "../context";
import { db } from "../db/client";
import * as s from "../db/schema";
import { env } from "../env";
import { transportFailureJson, UpstreamHttpError } from "../openaiHttp";
import { assertBudgetFks } from "../sync/apply";
import { buildDupIndex, classifyDup } from "./import-dedupe";
import { decideAssignment } from "./import-match";
import { budgetAssertionFails } from "./sync";

/**
 * Expense import from screenshots (Apple Wallet / bank history).
 *
 * Two steps:
 *  1. POST /import/extract — screenshots → OpenAI (structured output) → items for review.
 *  2. POST /import/apply — dry-run duplicate classification for client review.
 *     Writes were retired: current clients create through their local replica.
 */
export const importRoutes = new Hono();

const extractInput = z.object({
  images: z
    .array(z.string().regex(/^data:image\//, "expected an image data-URL"))
    .min(1)
    .max(6),
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

/** Loads normalized ledger history without making an assignment decision. */
export async function loadImportHistory(budgetId: string, currency: string): Promise<ImportHistoryRecord[]> {
  const [txns, envs, cats, plcs] = await Promise.all([
    db
      .select({
        accountId: s.transactions.accountId,
        name: s.transactions.name,
        envelopeId: s.transactions.envelopeId,
        categoryId: s.transactions.categoryId,
        placeId: s.transactions.placeId,
        tag: s.transactions.tag,
        sourceRef: s.transactions.sourceRef,
        type: s.transactions.type,
        isRefund: s.transactions.isRefund,
        toAccountId: s.transactions.toAccountId,
      })
      .from(s.transactions)
      .where(eq(s.transactions.budgetId, budgetId)),
    db.select().from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId)),
    db.select().from(s.categories).where(eq(s.categories.budgetId, budgetId)),
    db.select().from(s.places).where(eq(s.places.budgetId, budgetId)),
  ]);
  const envName = new Map(envs.map((e) => [e.id, e.name]));
  const catName = new Map(cats.map((x) => [x.id, x.name]));
  const plcName = new Map(plcs.map((x) => [x.id, x.name]));

  return txns.map((transaction) => ({
    accountId: transaction.accountId,
    currency,
    sourceRef: transaction.sourceRef,
    tag: transaction.tag,
    place: transaction.placeId ? (plcName.get(transaction.placeId) ?? null) : null,
    name: transaction.name,
    envelope: transaction.envelopeId ? (envName.get(transaction.envelopeId) ?? null) : null,
    category: transaction.categoryId ? (catName.get(transaction.categoryId) ?? null) : null,
    type: transaction.type as ImportHistoryRecord["type"],
    isRefund: transaction.type === "expense" && transaction.isRefund,
    toAccountId: transaction.type === "transfer" ? transaction.toAccountId : null,
  }));
}

/** The staged adapter passes explicit selected-account and validated proposal facts to shared retrieval. */
export async function selectHistoryForImport(input: { budgetId: string; currency: string; query: ImportHistoryQuery }) {
  return selectImportHistoryCandidates(input.query, await loadImportHistory(input.budgetId, input.currency));
}

/** `timeoutMs` per cycle: vision (cycle 1) gets AI_VISION_TIMEOUT_MS — multi-screenshot
 *  extraction is legitimately slow and AI-only (no fallback to hide a premature cut);
 *  the enrichment chat (cycle 2) stays on the default chat cap. Each call is ONE metered
 *  attempt (backlog §1): cycle 1 and cycle 2 are checked/recorded separately, so a cycle-1
 *  charge that exhausts the allowance denies cycle 2 (SpendDenied → the caller's fallback). */
async function openaiJson(req: ChatRequest, userId: string | undefined, timeoutMs?: number): Promise<string> {
  const out = await meteredOperatorChat({ userId, payload: operatorChatPayload(req), timeoutMs });
  if (out.kind === "denied") throw new SpendDenied(out.retryAfterSeconds);
  if (out.kind === "upstream_error") {
    console.error("openai:", out.status, out.detail.slice(0, 500));
    throw new UpstreamHttpError(out.status);
  }
  if (out.kind === "invalid_body") throw new Error("openai: unreadable 2xx body");
  return out.content || "{}";
}

export type ImportModelChat = (request: ChatRequest, timeoutMs?: number) => Promise<string>;

export class ImportCycleOneFailure extends Error {
  constructor(readonly reason: unknown) {
    super("import_cycle_one_failed");
  }
}

/** Shared operator/BYOK import pipeline. Prompt construction and both parsing cycles stay in
 * one place; only the request-scoped model transport differs. */
export async function extractImportForBudget(input: { budgetId: string; images: string[]; locale: string; chat: ImportModelChat }) {
  const { budgetId, images, locale, chat } = input;
  const language = languageName(locale);
  const today = new Date().toISOString().slice(0, 10);
  const [budgetRow] = await db.select({ currency: s.budgets.currency }).from(s.budgets).where(eq(s.budgets.id, budgetId));
  const currency = budgetRow?.currency ?? "EUR";

  /* ── cycle 1: facts from the screenshot (prompt+parsing from shared — parity with byok) ── */
  let found: ImportExtractItem[];
  try {
    const raw = await chat(buildImportExtractPrompt(images, { envelopes: [], categories: [] }, today, locale, currency), AI_VISION_TIMEOUT_MS);
    found = parseImportExtractResponse(raw);
  } catch (reason) {
    throw new ImportCycleOneFailure(reason);
  }
  if (found.length === 0) return [];

  /* ── cycle 2: similarity with history + assignments the way the user made them ── */
  const [envelopes, categories] = await Promise.all([
    db
      .select({ id: s.envelopes.id, name: s.envelopes.name })
      .from(s.envelopes)
      .where(and(eq(s.envelopes.budgetId, budgetId), eq(s.envelopes.archived, false))),
    db.select({ id: s.categories.id, name: s.categories.name }).from(s.categories).where(eq(s.categories.budgetId, budgetId)),
  ]);
  const sysEnrich =
    "You enrich bank-statement transactions from the visible transaction facts. " +
    `Propose: name — a short name in ${language} of WHAT it was (e.g. Groceries, Fuel, Cloud fee), never the raw company name with an address; ` +
    `envelope — one of the envelopes: ${envelopes.map((e) => e.name).join(", ")} — or null; ` +
    `category — one of the categories: ${categories.map((x) => x.name).join(", ")} — or null; ` +
    "place — a readable, short place name (e.g. Lidl, Netflix). Do not change amounts or dates. " +
    /* Cycle 2 is shared by operator and vaulted-BYOK transport, and carries the SAME language
       contract as every shared prompt — the names it invents land in the user's ledger. */
    languageDirectives(locale) +
    "Return JSON.";
  const pendingEnrichment = found.map((t, index) => ({ t, index }));

  let enriched = new Map<number, z.infer<typeof enrichedTxn>>();
  if (pendingEnrichment.length > 0) {
    const enrichPayload = {
      transactions: pendingEnrichment.map(({ t, index }) => ({
        index,
        date: t.date,
        amount: t.amount,
        type: t.type,
        rawPlace: t.rawPlace,
        tag: t.tag,
      })),
    };
    try {
      const raw = await chat({
        messages: [
          { role: "system", content: sysEnrich },
          { role: "user", content: JSON.stringify(enrichPayload) },
        ],
        responseFormat: { type: "json_schema", json_schema: ENRICH_JSON_SCHEMA },
        /* Matching against history patterns = simple comparisons — full default-effort
             reasoning only slowed the import down (cycle 1/vision STAYS on the default:
             OCR precision matters there). */
        reasoningEffort: "low",
      });
      // size only — the answer carries the user's transactions; it NEVER goes to the server log
      console.log(`import/extract cycle 2: ${raw.length} B answer`);
      enriched = new Map(enrichedOutput.parse(JSON.parse(raw)).transactions.map((t) => [t.index, t]));
    } catch (e) {
      // SpendDenied lands here too: cycle 1 exhausted the allowance → skip AI enrichment and
      // return the already-extracted raw items through this existing graceful fallback.
      console.warn("import/extract cycle 2 (enrichment) failed — returning raw data:", (e as Error).message);
    }
  }

  const envByName = new Map(envelopes.map((e) => [e.name.toLowerCase(), e]));
  const catByName = new Map(categories.map((x) => [x.name.toLowerCase(), x]));
  const items = found.map((t, index) => {
    const pick = decideAssignment(t.rawPlace, enriched.get(index));
    const envMatch = pick.envelope ? envByName.get(pick.envelope.toLowerCase()) : undefined;
    const catMatch = pick.category ? catByName.get(pick.category.toLowerCase()) : undefined;
    return {
      date: t.date,
      amount: t.amount,
      type: t.type,
      isRefund: t.isRefund,
      toAccountId: null,
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
  return items;
}

/* The API answers with stable machine CODES (never prose): the client owns the wording
   in every locale (web/lib/api.ts → i18n). Structured detail travels in its own field. */
importRoutes.post("/import/extract", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "ai_unavailable" }, 503);
  const budgetId = (await requireTier(c, "plain")).id;
  const { images, locale: rawLocale } = extractInput.parse(await c.req.json());
  const userId = sessionUserId(c);
  try {
    const items = await extractImportForBudget({
      budgetId,
      images,
      locale: rawLocale ?? "en",
      chat: (request, timeoutMs) => openaiJson(request, userId, timeoutMs),
    });
    return c.json({ items });
  } catch (error) {
    if (!(error instanceof ImportCycleOneFailure)) throw error;
    const reason = error.reason;
    if (reason instanceof SpendDenied) return c.json(aiBudgetExhaustedBody(reason.retryAfterSeconds), 429, { "Retry-After": String(reason.retryAfterSeconds) });
    console.error("import/extract cycle 1 failed:", (reason as Error).message);
    const failure = transportFailureJson(reason);
    if (failure) return c.json(failure.body, failure.status);
    return c.json({ error: "ai_upstream_error", ...(reason instanceof UpstreamHttpError ? { status: reason.status } : {}) }, 502);
  }
});

export const applyInput = z.object({
  accountId: z.string().uuid(),
  /** The budget the CLIENT believes it is writing to — the same PER-REQUEST tenant
   *  assertion as /sync/push (budgetAssertionFails): the server resolves the target
   *  budget from the session cookie alone, and the cookie can be swapped in another
   *  tab while the import sheet is open. Optional: a pre-fix client omits it. */
  budgetId: z.string().uuid().optional(),
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
export function findTransferError(items: ApplyItem[], globalAccountId: string): { error: "transfer_invalid"; index: number } | null {
  const index = items.findIndex((it) => it.type === "transfer" && (!it.toAccountId || it.toAccountId === (it.accountId ?? globalAccountId)));
  return index === -1 ? null : { error: "transfer_invalid", index };
}

importRoutes.post("/import/apply", async (c) => {
  const budgetId = (await requireTier(c, "plain")).id;
  const body = applyInput.parse(await c.req.json());

  // PER-REQUEST tenant assertion BEFORE any write (same as /sync/push): the batch
  // creates FRESH transactions, which pass every FK guard — a cookie swapped in
  // another tab would land user A's extracted items in user B's budget. The client
  // names the budget it verified; a mismatch is refused and nothing is written.
  if (budgetAssertionFails(body.budgetId, budgetId)) {
    return c.json({ error: "budget_mismatch" }, 409);
  }
  if (body.dryRun !== true) return c.json({ error: "client_write_required" }, 410);

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
    if (status === "probable") {
      // only date+amount match (e.g. a manual entry without source_ref) — the
      // decision belongs to the user: unchecked by default, but selectable
      results.push({ ...it, status: "probable" });
      continue;
    }
    dupIdx.markSeen({ date: it.date, amount: it.amount, rawPlace: it.rawPlace }); // dedup within the batch (strong key)
    added++;
    results.push({ ...it, status: "added" });
  }
  return c.json({ added, skipped, dryRun: true, results });
});
