/**
 * AI prompt builders and parsers (suggest / import) — PURE,
 * no I/O and no fetch. Single source of truth for server mode (API routes)
 * and byok (web `lib/openai.ts`): prompt parity guaranteed by identical code.
 *
 * Semantics carried over VERBATIM from the API routes:
 *  - routes/budgetSuggest.ts (openAiAskModel),
 *  - routes/import.ts (cycle 1: extract; messages + json_schema).
 */
import { z } from "zod";
import type { BudgetSuggestionBasis, ProposedEnvelopeDelta } from "./aiBudget";
import { computeBudgetState, prevMonth } from "./budget";
import { IMPORT_RELATION_KINDS, IMPORT_REVIEW_REASONS, IMPORT_SEMANTIC_KINDS, type ImportExtractBatch } from "./importRecognition";
import type { ClientLedger } from "./types";

/* ── Shared chat request shape (OpenAI chat/completions) ─────────────── */

export type ChatMessage = { role: "system" | "user"; content: string | Array<Record<string, unknown>> };
/** `responseFormat` goes into the request body as `response_format`;
 *  `reasoningEffort` → `reasoning_effort` (the transport sends it ONLY to
 *  reasoning models, gpt-5… and o…, as others would reject the unknown param with 400). */
export interface ChatRequest {
  messages: ChatMessage[];
  responseFormat?: Record<string, unknown>;
  /* The enum deliberately stops at "low": some models reject "minimal"/"none" in
   * chat/completions with 400 (gpt-5.5 did for "minimal"). gpt-5.6-luna accepts a wider set
   * (none…max) — expanding is a deliberate per-model decision, not a transport change. */
  reasoningEffort?: "low" | "medium" | "high";
}

/** Whether the model accepts reasoning_effort (OpenAI reasoning families). */
export const supportsReasoningEffort = (model: string): boolean => /^(gpt-5|o\d)/.test(model);

/* ── The language the model answers in ───────────────────────────────── */

/**
 * BCP-47 tag of the UI language ("en", "pl", "pt-BR", …). ANY tag is allowed since 2.2.0: the
 * prompt NAMES the language to the model, so a user whose UI language we do not even translate
 * still gets AI-written names, notes and rationales in their own language.
 */
export type AiLocale = string;

/** The wire shape of a locale (the AI routes parse it): a well-formed BCP-47 tag, nothing else. */
export const aiLocaleSchema = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

/** English names of the languages the UI ships — pinned, because a runtime built with a trimmed
 *  ICU would leave `Intl.DisplayNames` echoing the bare tag ("de") back at us. */
const SHIPPED_LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  pl: "Polish",
  de: "German",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  nl: "Dutch",
  "pt-BR": "Brazilian Portuguese",
  cs: "Czech",
  sv: "Swedish",
};

/**
 * Locale → the language's English name, as the prompts (written in English) address the model:
 * the ten shipped languages are pinned, everything else is named by `Intl.DisplayNames`, and a
 * tag nobody can name degrades to English — we never order the model into a language we cannot
 * name (an untranslated echo like "answer in zz" is worse than English).
 */
export function languageName(locale: AiLocale): string {
  const tag = (locale ?? "").trim();
  const pinned = SHIPPED_LANGUAGE_NAMES[tag];
  if (pinned) return pinned;
  try {
    const named = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    // Intl echoes an unknown-but-well-formed tag ("zz" → "zz") instead of throwing.
    if (named && named.toLowerCase() !== tag.toLowerCase()) return named;
  } catch {
    /* malformed tag → Intl throws RangeError; fall through to the base tag / English */
  }
  const base = SHIPPED_LANGUAGE_NAMES[tag.split("-")[0]!];
  return base ?? "English";
}

/**
 * The language contract EVERY prompt carries — ONE source, so the server prompt and the BYOK
 * prompt cannot drift (the prompt-identity tests assert this): text the model WRITES is in the
 * user's language, data values we INJECT are matched as-is (translating an envelope name would
 * break the name→id lookup on the way back).
 * Ends with a trailing space — the builders concatenate sentences.
 */
export function languageDirectives(locale: AiLocale): string {
  const language = languageName(locale);
  return (
    `Write all text you GENERATE (names, notes, rationales) in ${language}. ` +
    `Injected data values (envelope, category, place and transaction names, historical labels) are in the user's language (${language}) — match against them as-is; do not translate data values. `
  );
}

/** Cut out the first JSON object from the model response (same as the API routes). */
const sliceJson = (raw: string): string => raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);

/* ── Suggest (budget proposal) ───────────────────────────────────────── */

/** Fields actually read by openAiAskModel (BudgetAiContext-like). */
export interface SuggestPromptContext {
  basis: BudgetSuggestionBasis;
  ledger: {
    envelopes: Array<{ id: string; name: string }>;
    transactions: Array<{ date: string; amount: number; type: string; envelopeId: string | null }>;
  };
  month: string;
  profile: string;
  customPrompt?: string;
  locale: AiLocale;
}

export function buildSuggestPrompt(ctx: SuggestPromptContext): ChatRequest {
  const envName = new Map(ctx.ledger.envelopes.map((e) => [e.id, e.name]));
  const candidates = ctx.basis.candidates.map((c) => ({
    envelopeId: c.envelopeId,
    name: envName.get(c.envelopeId) ?? "",
    allocatedThisMonth: c.stats.allocatedThisMonth,
    available: c.stats.available,
    monthlyTarget: c.stats.monthlyTarget,
    targetGap: c.stats.targetGap,
    medianSpend: c.stats.medianSpend,
    avgSpend: c.stats.avgSpend,
    baseDelta: c.baseDelta,
    priority: c.priority,
  }));
  const recentTransactions = [...ctx.ledger.transactions]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 40)
    .map((t) => ({ date: t.date, amount: t.amount, type: t.type, envelopeId: t.envelopeId }));

  const amountToDistribute = ctx.basis.amountToDistribute;
  const sys =
    "You are an envelope-budgeting assistant. Distribute EXACTLY the given amount (integer minor units) " +
    'across the given envelopes. Return ONLY JSON: {"items":[{"envelopeId":string,"proposedDelta":int,"rationale":string,"confidence":number}]}. ' +
    "Hard rules: the sum of proposedDelta must equal the amount exactly; use only the given envelopeId values; proposedDelta ≥ 0 (integer minor units, int); " +
    "do not create/modify/delete anything; keep rationales short. " +
    languageDirectives(ctx.locale) +
    `Profile: ${ctx.profile}. Amount to distribute: ${amountToDistribute}.` +
    " Aim to fund monthly targets (targetGap) when funds suffice, without exceeding them." +
    (ctx.customPrompt ? ` User guidance: ${ctx.customPrompt}` : "");
  const user = JSON.stringify({ amountToDistribute, candidates, recentTransactions });

  return {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    /* STRUCTURED OUTPUT (strict) instead of json_object — schema guarantee. */
    responseFormat: { type: "json_schema", json_schema: SUGGEST_JSON_SCHEMA },
    /* Splitting an amount is simple arithmetic — full default-effort reasoning can
       grind for tens of seconds with no quality gain (measured on gpt-5.5; the GPT-5.6
       migration guide's advice is the same setting or one lower). */
    reasoningEffort: "low",
  };
}

/** Strict schema of the suggest response (rules-engine profiles + AI layer). */
export const SUGGEST_JSON_SCHEMA = {
  name: "budget_suggestion",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["envelopeId", "proposedDelta", "rationale", "confidence"],
          properties: {
            envelopeId: { type: "string" },
            proposedDelta: { type: "integer", minimum: 0 },
            rationale: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
} as const;

export function parseSuggestResponse(raw: string): ProposedEnvelopeDelta[] {
  const json = JSON.parse(sliceJson(raw)) as { items?: unknown };
  const items = Array.isArray(json.items) ? json.items : [];
  return items
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      envelopeId: String(x.envelopeId ?? ""),
      proposedDelta: Number(x.proposedDelta ?? 0),
      rationale: typeof x.rationale === "string" ? x.rationale : undefined,
      confidence: typeof x.confidence === "number" ? x.confidence : undefined,
    }));
}

/* ── Agent suggest (custom profile: agent decides from month state) ──── */

/** State of one ACTIVE envelope in the selected month (agent input). */
export interface AgentSuggestEnvelope {
  id: string;
  name: string;
  group: string;
  allocated: number;
  spent: number;
  available: number;
  carryIn: number;
  monthlyTarget: number | null;
  isSavings: boolean;
}

export interface AgentSuggestContext {
  month: string;
  /** Amount to distribute (int minor units). */
  amount: number;
  envelopes: AgentSuggestEnvelope[];
  /** Full state of the PREVIOUS month (same envelopes) — reference for
   *  "how the user allocated/spent a month ago" (decision 2026-07-11: single
   *  prompt with two months instead of a tool loop). */
  prevMonth: { month: string; envelopes: AgentSuggestEnvelope[] };
  /** User prompt — the PRIMARY criterion for the agent's decision. */
  directive: string;
  locale: AiLocale;
}

/**
 * Build AgentSuggestContext from the ledger for the SELECTED month + the
 * PREVIOUS month state. Shared step for web (byok) and API (server) —
 * ctx parity guaranteed by code. amount = basis.amountToDistribute.
 */
export function buildAgentSuggestContext(args: {
  ledger: ClientLedger;
  month: string;
  basis: BudgetSuggestionBasis;
  directive: string;
  locale: AiLocale;
}): AgentSuggestContext {
  const { ledger, month, basis, directive, locale } = args;
  const groupName = new Map(ledger.groups.map((g) => [g.id, g.name]));
  const envelopesFor = (m: string): AgentSuggestEnvelope[] =>
    computeBudgetState(ledger, m)
      .envelopes.filter((e) => !e.envelope.archived)
      .map((e) => ({
        id: e.envelope.id,
        name: e.envelope.name,
        group: groupName.get(e.envelope.groupId) ?? "",
        allocated: e.allocated,
        spent: e.spent,
        available: e.available,
        carryIn: e.carryIn,
        monthlyTarget: e.envelope.monthlyTarget ?? null,
        isSavings: e.envelope.isSavings,
      }));
  const prev = prevMonth(month);
  return {
    month,
    amount: basis.amountToDistribute,
    envelopes: envelopesFor(month),
    prevMonth: { month: prev, envelopes: envelopesFor(prev) },
    directive,
    locale,
  };
}

export function buildAgentSuggestPrompt(ctx: AgentSuggestContext): ChatRequest {
  const sys =
    "You are an envelope-budgeting agent. Decide how to split the given amount (integer minor units) " +
    "across the user's envelopes based on the CURRENT month state and the PREVIOUS month state provided. " +
    "The previous month shows how the user actually allocated and spent — use it as a reference baseline. " +
    "The user's directive is the PRIMARY decision criterion — follow it even when it contradicts the previous month. " +
    'Return ONLY a JSON array: [{"envelopeId":string,"amount":int}] — no prose, no other keys. ' +
    "Hard rules: use only envelopeId values from the provided list; amount is an integer ≥ 0 (minor units, int); " +
    "you may skip envelopes (omit them entirely); do not create/modify/delete anything. " +
    languageDirectives(ctx.locale).trimEnd();
  const user = JSON.stringify({
    amountToDistribute: ctx.amount,
    currentMonth: { month: ctx.month, envelopes: ctx.envelopes },
    previousMonth: { note: "reference: how the user allocated and spent last month", ...ctx.prevMonth },
    directive: ctx.directive,
  });
  return {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    /* STRUCTURED OUTPUT (strict): guarantees valid JSON per schema —
       the array is wrapped in {items} (json_schema requires an object at root). */
    responseFormat: { type: "json_schema", json_schema: AGENT_SUGGEST_JSON_SCHEMA },
    reasoningEffort: "low",
  };
}

/** Strict schema of the agent response — items[{envelopeId, amount}]. */
export const AGENT_SUGGEST_JSON_SCHEMA = {
  name: "envelope_allocation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["envelopeId", "amount"],
          properties: { envelopeId: { type: "string" }, amount: { type: "integer", minimum: 0 } },
        },
      },
    },
  },
} as const;

/**
 * Agent response parser: JSON array → ProposedEnvelopeDelta[]. Tolerates a
 * ```json fence/prose around it (cuts out the first array); entries without a
 * valid envelopeId or without an int ≥ 0 in `amount` are skipped; unknown
 * fields ignored; garbage → [].
 */
export function parseAgentSuggestResponse(raw: string): ProposedEnvelopeDelta[] {
  /* Structured output (strict) returns {"items":[...]} — try the object
     first; a bare array remains for compatibility (older responses). */
  let parsed: unknown;
  try {
    const obj = JSON.parse(sliceJson(raw)) as { items?: unknown };
    if (Array.isArray(obj.items)) parsed = obj.items;
  } catch {
    /* not an object — try the array below */
  }
  if (!Array.isArray(parsed)) {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .filter((x) => typeof x.envelopeId === "string" && x.envelopeId !== "" && typeof x.amount === "number" && Number.isInteger(x.amount) && x.amount >= 0)
    .map((x) => ({ envelopeId: x.envelopeId as string, proposedDelta: x.amount as number }));
}

/* ── Import from screenshots (cycle 1: facts from the screenshot) ────── */

const importRawRelation = z.object({ kind: z.enum(IMPORT_RELATION_KINDS), rowId: z.string().min(1) });
const importRawRow = z.object({
  rowId: z.string().min(1),
  imageIndex: z.number().int().nonnegative(),
  visualOrder: z.number().int().nonnegative(),
  rawTextLines: z.array(z.string()),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  amount: z.number().int().positive().nullable(),
  currency: z.string().nullable(),
  direction: z.enum(["debit", "credit", "unknown"]),
  postingStatus: z.enum(["posted", "pending", "declined", "unknown"]),
  rowRole: z.enum(["financial_event", "supporting_detail", "ui_metadata"]),
  semanticKind: z.enum(IMPORT_SEMANTIC_KINDS),
  relation: importRawRelation.nullable(),
  confidence: z.enum(["low", "medium", "high"]),
  reviewReasons: z.array(z.enum(IMPORT_REVIEW_REASONS)),
});
const importRawOutput = z.object({ rows: z.array(importRawRow) }).superRefine(({ rows }, ctx) => {
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (ids.has(row.rowId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "rowId"], message: "rowId must be unique" });
    ids.add(row.rowId);
  });
});
const legacyImportRawOutput = z.object({
  transactions: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      amount: z.number().int().positive(),
      type: z.enum(["expense", "income", "refund"]),
      rawPlace: z.string(),
      tag: z.string(),
      currency: z.string(),
      fxOriginal: z.string(),
    }),
  ),
});

export const IMPORT_EXTRACT_JSON_SCHEMA = {
  name: "extracted_transactions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            rowId: { type: "string" },
            imageIndex: { type: "integer" },
            visualOrder: { type: "integer" },
            rawTextLines: { type: "array", items: { type: "string" } },
            date: { type: ["string", "null"] },
            amount: { type: ["integer", "null"] },
            currency: { type: ["string", "null"] },
            direction: { type: "string", enum: ["debit", "credit", "unknown"] },
            postingStatus: { type: "string", enum: ["posted", "pending", "declined", "unknown"] },
            rowRole: { type: "string", enum: ["financial_event", "supporting_detail", "ui_metadata"] },
            semanticKind: { type: "string", enum: IMPORT_SEMANTIC_KINDS },
            relation: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: { kind: { type: "string", enum: IMPORT_RELATION_KINDS }, rowId: { type: "string" } },
              required: ["kind", "rowId"],
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            reviewReasons: { type: "array", items: { type: "string", enum: IMPORT_REVIEW_REASONS } },
          },
          required: [
            "rowId",
            "imageIndex",
            "visualOrder",
            "rawTextLines",
            "date",
            "amount",
            "currency",
            "direction",
            "postingStatus",
            "rowRole",
            "semanticKind",
            "relation",
            "confidence",
            "reviewReasons",
          ],
        },
      },
    },
    required: ["rows"],
  },
} as const;

/** Budget reference lists (envelope/category names). Cycle 1 (extract)
 *  does not use them — the parameter keeps a shared signature for byok mode
 *  (assignments are done by cycle 2 server-side / the caller web-side). */
export interface ImportPromptRefs {
  envelopes: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
}

export function buildImportExtractPrompt(images: string[], _refs: ImportPromptRefs, today: string, locale: AiLocale, currency: string): ChatRequest {
  const sysExtract =
    "You extract facts from screenshots (Apple Wallet, bank account history, payment confirmations), not hypotheses. " +
    `Today is ${today} — resolve relative dates ("today", "yesterday") against this date; when the year is missing, assume the most recent past date. ` +
    "Return one output row for every visually distinct row, in visual order. Use imageIndex plus visualOrder to preserve where it appeared. Preserve each visible line in rawTextLines; trim only surrounding whitespace. " +
    "Rows that are labels, balances, summaries, or other interface chrome are still visible evidence: mark them ui_metadata. Use financial_event for a money movement and supporting_detail for evidence such as an FX conversion. " +
    "Use null for unreadable date, amount, or currency; never omit a visible row. Amounts are positive integer minor units. direction, postingStatus, rowRole, semanticKind, confidence, and reviewReasons describe only what is shown. " +
    `currency is ISO-4217 uppercase when readable; the account currency is ${currency}. NEVER convert or guess an exchange rate. ` +
    "Express relationships by rowId: retain linked FX evidence as supporting_detail with relation kind fx_for; do not merge or discard it. " +
    languageDirectives(locale) +
    "Return JSON.";
  return {
    messages: [
      { role: "system", content: sysExtract },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract all transactions from these screenshots." },
          ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
        ],
      },
    ],
    responseFormat: { type: "json_schema", json_schema: IMPORT_EXTRACT_JSON_SCHEMA },
  };
}

/** Legacy projection retained until the cycle-one consumers adopt ImportExtractBatch. */
export interface ImportExtractItem {
  date: string;
  amount: number;
  type: "expense" | "income";
  isRefund: boolean;
  rawPlace: string;
  tag: string;
  currency: string;
  fxOriginal: string;
}

type ImportExtractBatchWithLegacyMap = ImportExtractBatch & ImportExtractItem[];

/** Throws on an invalid shape (like `rawOutput.parse` in the route). */
export function parseImportExtractResponse(raw: string): ImportExtractBatchWithLegacyMap {
  const input: unknown = JSON.parse(raw);
  if (typeof input === "object" && input !== null && "transactions" in input && !("rows" in input)) {
    const legacy = legacyImportRawOutput.parse(input).transactions.map((item, _index) => ({
      ...item,
      tag: item.tag.trim().toUpperCase(),
      currency: item.currency.trim().toUpperCase(),
      fxOriginal: item.fxOriginal.trim(),
    }));
    return {
      rows: legacy.map((item, index) => ({
        rowId: `legacy-${index}`,
        imageIndex: 0,
        visualOrder: index,
        rawTextLines: item.rawPlace.split("\n"),
        date: item.date,
        amount: item.amount,
        currency: item.currency,
        direction: item.type === "income" ? "credit" : "debit",
        postingStatus: "posted",
        rowRole: "financial_event",
        semanticKind: item.type === "refund" ? "merchant_refund" : "unknown",
        relation: null,
        confidence: "medium",
        reviewReasons: item.type === "refund" ? [] : ["unknown_kind"],
      })),
      length: legacy.length,
      map: (callbackfn) =>
        legacy.map((item) => ({ ...item, type: item.type === "refund" ? ("expense" as const) : item.type, isRefund: item.type === "refund" })).map(callbackfn),
    } as ImportExtractBatchWithLegacyMap;
  }
  const parsed = importRawOutput.parse(input);
  const rows = parsed.rows.map((row) => ({
    ...row,
    rawTextLines: row.rawTextLines.map((line) => line.trim()),
    currency: row.currency?.trim().toUpperCase() ?? null,
  }));
  const legacy = rows
    .filter((row): row is typeof row & { date: string; amount: number; currency: string } => row.date !== null && row.amount !== null && row.currency !== null)
    .map((row) => ({
      date: row.date,
      amount: row.amount,
      type: row.direction === "credit" ? ("income" as const) : ("expense" as const),
      isRefund: row.semanticKind === "merchant_refund" || row.semanticKind === "chargeback",
      rawPlace: row.rawTextLines.join("\n"),
      tag: "",
      currency: row.currency,
      fxOriginal: "",
    }));
  return { rows, length: legacy.length, map: (callbackfn) => legacy.map(callbackfn) } as ImportExtractBatchWithLegacyMap;
}
