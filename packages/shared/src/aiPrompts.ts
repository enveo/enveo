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
import { AI_VISION_TIMEOUT_MS } from "./aiTransport";
import { computeBudgetState, prevMonth } from "./budget";
import { type ImportHistoryRecord, type ImportHistorySelection, selectImportHistoryCandidates } from "./importHistory";
import {
  applyImportEnrichment,
  IMPORT_RELATION_KINDS,
  IMPORT_REVIEW_REASONS,
  IMPORT_SEMANTIC_KINDS,
  type ImportEnrichmentAnswer,
  type ImportEnrichmentRow,
  type ImportExtractBatch,
  type ImportRecognitionResult,
  needsImportEnrichment,
  type ReconciledImportRecognitionResult,
  reconcileImportProposals,
  validateImportExtraction,
} from "./importRecognition";
import type { Account, Category, ClientLedger, Envelope, Transaction } from "./types";

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
    "One output row means one coherent transaction-list entry, date divider, balance/summary, or other distinct text block — not each text line inside an entry. " +
    "Group its amount, merchant/payee, card suffix, and secondary text into that row's rawTextLines. Do not create separate rows for icons, loyalty/reward points, card suffixes, exchange-rate text, or status text that belongs to the same entry. " +
    "Return those coherent rows in visual order. Use imageIndex plus visualOrder to preserve where each appeared. Preserve each visible line in rawTextLines; trim only surrounding whitespace. " +
    "Rows that are labels, date dividers, balances, summaries, or other interface chrome are still visible evidence: mark them ui_metadata. Use financial_event only for a ledger money movement and supporting_detail for evidence such as a linked FX conversion. " +
    "Return exactly one financial_event for each coherent entry with a primary signed ledger amount, regardless of whether its meaning is uncertain. A reward, refund, top-up, deposit, or transfer entry is still a financial_event. Numbers in secondary text never create another financial_event. " +
    "A visible date divider applies to the transaction entries below it until the next divider; the divider itself remains ui_metadata. " +
    "For a financial_event, amount and currency come from the primary signed ledger amount printed for that entry. Amounts are positive integer minor units; never use a balance, loyalty/reward points, card suffix, or exchange rate as amount. " +
    "An explicit + or incoming label means credit; an explicit − or outgoing label means debit. Do not infer direction from semanticKind; use unknown when the direction is not visible. " +
    "Use cashback_or_reward only for explicit reward/cashback/moneyback text, merchant_refund only for explicit refund/return/chargeback text, and account_topup only for explicit top-up or account-funding text. Use transfer kinds only when transfer wording is visible. " +
    "Use null for unreadable date, amount, or currency; never invent a fact. postingStatus, rowRole, semanticKind, confidence, and reviewReasons describe only what is shown. Keep reviewReasons empty when the row is clear; add only reasons supported by a specific visible ambiguity. " +
    `currency is ISO-4217 uppercase when readable; the account currency is ${currency}. NEVER convert or guess an exchange rate. ` +
    "Express relationships by rowId: retain linked FX evidence as supporting_detail with relation kind fx_for; do not merge or discard it. Set relation to null unless the screenshot visibly establishes the link between those exact rows. " +
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

export interface ImportEnrichPromptInput {
  result: ImportRecognitionResult;
  history: Array<{ rowId: string; selection: ImportHistorySelection }>;
  envelopes: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; name: string }>;
}

export interface ImportEnrichmentConstraints {
  envelopeIds: readonly string[];
  categoryIds: readonly string[];
  accountIds: readonly string[];
}

export const IMPORT_ENRICH_JSON_SCHEMA = {
  name: "enriched_import_rows",
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
            name: { type: "string" },
            place: { type: ["string", "null"] },
            envelopeId: { type: ["string", "null"] },
            categoryId: { type: ["string", "null"] },
            semanticKind: { type: "string", enum: IMPORT_SEMANTIC_KINDS },
            relation: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: { kind: { type: "string", enum: IMPORT_RELATION_KINDS }, rowId: { type: "string" } },
              required: ["kind", "rowId"],
            },
            reviewReasons: { type: "array", items: { type: "string", enum: IMPORT_REVIEW_REASONS } },
          },
          required: ["rowId", "name", "place", "envelopeId", "categoryId", "semanticKind", "relation", "reviewReasons"],
        },
      },
    },
    required: ["rows"],
  },
} as const;

const canonicalPromptEntities = (entities: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> =>
  [...entities].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

/** Builds cycle two from validated facts and bounded, compatible history evidence. */
export function buildImportEnrichPrompt(input: ImportEnrichPromptInput, locale: AiLocale): ChatRequest {
  const proposalById = new Map(input.result.proposals.map((proposal) => [proposal.rowId, proposal]));
  const historyById = new Map(input.history.map((entry) => [entry.rowId, entry.selection]));
  const rows = input.result.rows.map((row) => ({
    ...row,
    proposal: proposalById.get(row.rowId),
    historyCandidates: historyById.get(row.rowId)?.candidates.slice(0, 5) ?? [],
    historyConflict: historyById.get(row.rowId)?.conflict ?? false,
  }));
  const system =
    "You conservatively enrich validated screenshot-import rows using compatible ledger history as evidence, never as fact. " +
    "Return one annotation per supplied row. Preserve all visible facts: never correct or replace dates, amounts, currencies, directions, posting status, raw text, row identity, transaction type, refund state, or transfer endpoint. " +
    "For envelopeId and categoryId select a supplied existing id or null; never invent an id. Relations may reference only a supplied rowId. " +
    "Return each supplied reviewReasons list unchanged; deterministic validation adds any reason caused by your semantic or relation annotation. " +
    languageDirectives(locale) +
    "Return JSON.";
  return {
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: JSON.stringify({
          rows,
          entities: {
            envelopes: canonicalPromptEntities(input.envelopes),
            categories: canonicalPromptEntities(input.categories),
            accounts: canonicalPromptEntities(input.accounts),
          },
        }),
      },
    ],
    responseFormat: { type: "json_schema", json_schema: IMPORT_ENRICH_JSON_SCHEMA },
    reasoningEffort: "low",
  };
}

const enrichAllowedKeys = new Set(["rowId", "name", "place", "envelopeId", "categoryId", "semanticKind", "relation", "reviewReasons"]);

/** Parses annotations while retaining evidence of any attempted fact rewrite. */
export function parseImportEnrichResponse(
  raw: string,
  constraints: ImportEnrichmentConstraints = { envelopeIds: [], categoryIds: [], accountIds: [] },
): ImportEnrichmentAnswer {
  const input = JSON.parse(raw) as { rows?: unknown };
  if (!Array.isArray(input.rows)) throw new Error("invalid import enrichment response");
  const rows: ImportEnrichmentRow[] = input.rows.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid import enrichment row");
    const row = value as Record<string, unknown>;
    const parsed = z
      .object({
        rowId: z.string().min(1),
        name: z.string(),
        place: z.string().nullable(),
        envelopeId: z.string().nullable(),
        categoryId: z.string().nullable(),
        semanticKind: z.enum(IMPORT_SEMANTIC_KINDS),
        relation: importRawRelation.nullable(),
        reviewReasons: z.array(z.enum(IMPORT_REVIEW_REASONS)),
      })
      .parse(row);
    return { ...parsed, factCorrectionAttempt: Object.keys(row).some((key) => !enrichAllowedKeys.has(key)) };
  });
  return {
    rows,
    allowedEnvelopeIds: [...constraints.envelopeIds],
    allowedCategoryIds: [...constraints.categoryIds],
    allowedAccountIds: [...constraints.accountIds],
  };
}

export type ImportRecognitionChat = (request: ChatRequest, timeoutMs?: number) => Promise<string>;

export interface ImportRecognitionPipelineInput {
  images: string[];
  locale: AiLocale;
  today: string;
  budgetCurrency: string;
  accountId: string;
  accounts: Account[];
  envelopes: Envelope[];
  categories: Category[];
  transactions: Transaction[];
  historyRecords: ImportHistoryRecord[];
  chat: ImportRecognitionChat;
}

const mergeReviewReasons = (...groups: ReadonlyArray<readonly (typeof IMPORT_REVIEW_REASONS)[number][]>): (typeof IMPORT_REVIEW_REASONS)[number][] => [
  ...new Set(groups.flat()),
];

/** Shared extraction → validation → history → optional enrichment pipeline. */
export async function runImportRecognitionPipeline(input: ImportRecognitionPipelineInput): Promise<ReconciledImportRecognitionResult> {
  const extractionRaw = await input.chat(
    buildImportExtractPrompt(input.images, { envelopes: [], categories: [] }, input.today, input.locale, input.budgetCurrency),
    AI_VISION_TIMEOUT_MS,
  );
  const batch = parseImportExtractResponse(extractionRaw, input.images.length);
  const validated = validateImportExtraction({ batch, budgetCurrency: input.budgetCurrency });
  let result: ReconciledImportRecognitionResult = {
    rows: validated.rows,
    proposals: reconcileImportProposals({
      proposals: validated.proposals,
      transactions: input.transactions,
      accounts: input.accounts,
      envelopes: input.envelopes,
      categories: input.categories,
      selectedAccountId: input.accountId,
    }),
  };

  const ownedAccountIds = input.accounts.filter((account) => !account.archived).map((account) => account.id);
  const history = result.proposals.map((proposal) => ({
    rowId: proposal.rowId,
    selection: selectImportHistoryCandidates({ accountId: input.accountId, ownedAccountIds, proposal }, input.historyRecords),
  }));
  result = {
    rows: result.rows,
    proposals: result.proposals.map((proposal) => {
      const selection = history.find((entry) => entry.rowId === proposal.rowId)!.selection;
      const historyReasons = [
        ...(selection.conflict ? (["history_conflict"] as const) : []),
        ...(selection.candidates.length > 1 ? (["multiple_history_candidates"] as const) : []),
      ];
      return { ...proposal, reviewReasons: mergeReviewReasons(proposal.reviewReasons, historyReasons) };
    }),
  };
  if (!needsImportEnrichment(result)) return result;

  const activeEnvelopes = input.envelopes.filter((envelope) => !envelope.archived);
  const currentAccounts = input.accounts.filter((account) => !account.archived);
  try {
    const raw = await input.chat(
      buildImportEnrichPrompt(
        {
          result,
          history,
          envelopes: activeEnvelopes.map(({ id, name }) => ({ id, name })),
          categories: input.categories.map(({ id, name }) => ({ id, name })),
          accounts: currentAccounts.map(({ id, name }) => ({ id, name })),
        },
        input.locale,
      ),
    );
    const answer = parseImportEnrichResponse(raw, {
      envelopeIds: activeEnvelopes.map((envelope) => envelope.id),
      categoryIds: input.categories.map((category) => category.id),
      accountIds: currentAccounts.map((account) => account.id),
    });
    const merged = applyImportEnrichment(result, answer);
    const annotations = new Map(merged.proposals.map((proposal) => [proposal.rowId, proposal]));
    const finalRows = result.rows.map((row) => {
      const annotation = annotations.get(row.rowId)!;
      return {
        ...row,
        semanticKind: annotation.semanticKind,
        relation: annotation.relation,
        reviewReasons: mergeReviewReasons(row.reviewReasons, annotation.reviewReasons),
      };
    });
    const final = validateImportExtraction({ batch: { rows: finalRows }, budgetCurrency: input.budgetCurrency });
    const enriched = final.proposals.map((proposal) => {
      const annotation = annotations.get(proposal.rowId)!;
      return {
        ...proposal,
        name: annotation.name,
        placeName: annotation.placeName,
        envelopeId: annotation.envelopeId,
        categoryId: annotation.categoryId,
        reviewReasons: mergeReviewReasons(proposal.reviewReasons, annotation.reviewReasons),
        selected: proposal.selected && annotation.selected,
      };
    });
    return {
      rows: result.rows,
      proposals: reconcileImportProposals({
        proposals: enriched,
        transactions: input.transactions,
        accounts: input.accounts,
        envelopes: input.envelopes,
        categories: input.categories,
        selectedAccountId: input.accountId,
      }),
    };
  } catch {
    return result;
  }
}

/** Throws on an invalid shape (like `rawOutput.parse` in the route). */
export function parseImportExtractResponse(raw: string, imageCount: number): ImportExtractBatch {
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 6) throw new Error("invalid import image count");
  const input: unknown = JSON.parse(raw);
  const parsed = importRawOutput.parse(input);
  const rows = parsed.rows.map((row) => ({
    ...row,
    rawTextLines: row.rawTextLines.map((line) => line.trim()),
    currency: row.currency?.trim().toUpperCase() ?? null,
  }));
  if (rows.some((row) => row.imageIndex >= imageCount)) throw new Error("import row imageIndex is outside the supplied images");
  const positions = rows.map((row) => `${row.imageIndex}:${row.visualOrder}`);
  if (new Set(positions).size !== positions.length) throw new Error("duplicate import visual position");
  return {
    rows: [...rows].sort((left, right) => left.imageIndex - right.imageIndex || left.visualOrder - right.visualOrder || left.rowId.localeCompare(right.rowId)),
  };
}
