/**
 * AI function dispatch per mode (`settings.aiMode`) — PURE functions without
 * hooks (settings passed explicitly):
 *
 *  - off:    local rule engine — ZERO network — for the budget SUGGESTION only.
 *            Screenshot import is AI-only, so in this mode the UI gates it behind
 *            the consent sheet instead of running it.
 *  - byok:   prompt from shared → OpenAI directly from the browser (lib/openai.ts),
 *            the user's key; a failed SUGGESTION falls back to rules — import has
 *            nothing to fall back to and surfaces the error.
 *  - server: SUGGEST since v1.25.0 uses the same local path as byok, only the chat
 *            goes through /api/ai/chat (operator-key proxy — no replica
 *            and no computation on the server); the import still via /api routes.
 *
 * PRIVACY CONTRACT: in the off and byok modes suggest generation does NOT touch
 * /api/* — the only egress in byok is api.openai.com.
 */
import {
  AI_VISION_TIMEOUT_MS,
  buildAgentSuggestContext,
  buildAgentSuggestPrompt,
  buildBudgetSuggestionBasis,
  buildImportExtractPrompt,
  buildRulesBudgetSuggestion,
  buildSuggestPrompt,
  normalizeAgentSuggestion,
  normalizeBudgetSuggestion,
  parseAgentSuggestResponse,
  parseImportExtractResponse,
  parseSuggestResponse,
  type AiLocale,
  type BudgetSuggestProfile,
  type BudgetSuggestResponse,
  type BudgetSuggestionBasis,
  type ChatMessage,
  type ChatRequest,
  type ClientLedger,
  type NormalizedBudgetSuggestion,
} from "@enveo/shared";
import { api, type ImportItem } from "./api";
import type { Settings } from "./contexts";
import { browserLocales, currencyForLocales } from "./currency";
import { chatJson, type ChatTarget } from "./openai";

/** Settings subset read by the dispatch (device-only, from localStorage). */
export type AiSettings = Pick<Settings, "aiMode" | "openaiKey" | "openaiModel">;

/* The UI language goes to the prompt builders AS IS (a `Lang` is a BCP-47 tag and AiLocale takes
   any of them since 2.2.0): the model names, notes and rationales come back in the user's
   language, whether or not we ship a dictionary for it. */

/**
 * No usable model on this device (AI off, or byok with no key yet). Carries a CODE, not prose:
 * it reaches the user through apiErrorMessage() like every other client-side sentinel, and
 * lib/api.ts owns the wording in each locale (a sentence thrown here would render English in a
 * Polish UI — the regression api.test.ts guards).
 */
export class AiConsentRequired extends Error {
  constructor() {
    super("ai_consent_required");
    this.name = "AiConsentRequired";
  }
}

/**
 * The SINGLE decision "can this device talk to a model, and how" — used by every AI entry point
 * AND by the UI that offers them (the import sheet). Keeping one function is the point:
 * `aiMode !== "off"` is NOT the same question. Settings switches the mode to `byok` before a key
 * is typed (and clearing the field persists an empty one), so byok-without-key is an everyday
 * state in which there is no target — the UI must hide AI-only entry points instead of letting
 * the user run into an error.
 */
export function aiTarget(settings: AiSettings): ChatTarget | null {
  if (settings.aiMode === "server") return { kind: "server" };
  if (settings.aiMode === "byok" && settings.openaiKey) return { kind: "byok", key: settings.openaiKey, model: settings.openaiModel };
  return null;
}

/** Is any AI-only feature (screenshot import) usable right now? */
export const hasAiTarget = (settings: AiSettings): boolean => aiTarget(settings) !== null;

/**
 * The model answered something that is not our schema (empty, truncated, prose instead of JSON):
 * a CODE, not the raw SyntaxError from JSON.parse. The import sheet renders what it catches, so
 * an unwrapped parse error would print "Unexpected token < in JSON at position 0" at the user —
 * lib/api.ts maps ai_upstream_error to a sentence in their language instead.
 */
function parseOrFail<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new Error("ai_upstream_error");
  }
}

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/* ── Budget suggestion ─────────────────────────────────────────────── */

/**
 * The ONLY shared basis→ctx→buildSuggestPrompt step — used by runSuggest
 * (byok path) AND previewSuggestPrompt. Thanks to this the prompt preview is
 * EXACTLY what we send (zero drift; identity test in ai.test.ts).
 */
function buildSuggestChat(args: {
  ledger: ClientLedger;
  month: string;
  profile: BudgetSuggestProfile;
  customPrompt?: string;
  locale: AiLocale;
}): { basis: BudgetSuggestionBasis; request: ChatRequest } {
  const { ledger, month, profile, customPrompt, locale } = args;
  const basis = buildBudgetSuggestionBasis({ ledger, month, profile, customPrompt });
  return { basis, request: buildSuggestPrompt({ basis, ledger, month, profile, customPrompt, locale }) };
}

/**
 * Shared AGENT-path step (custom profile, SINGLE PROMPT with two months —
 * decision 2026-07-11: simpler and faster than a tool loop): basis→ctx→
 * buildAgentSuggestPrompt — used by runSuggest (byok) AND
 * previewSuggestPrompt (zero drift; the preview is again 1:1 with the send).
 */
function buildAgentChat(args: {
  ledger: ClientLedger;
  month: string;
  customPrompt?: string;
  locale: AiLocale;
}): { basis: BudgetSuggestionBasis; request: ChatRequest } {
  const { ledger, month, customPrompt, locale } = args;
  const basis = buildBudgetSuggestionBasis({ ledger, month, profile: "custom", customPrompt });
  const ctx = buildAgentSuggestContext({ ledger, month, basis, directive: customPrompt ?? "", locale });
  return { basis, request: buildAgentSuggestPrompt(ctx) };
}

/** Message content as a string (suggest always builds strings). */
const messageText = (m: ChatMessage | undefined): string =>
  typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");

/**
 * A 1:1 preview of the suggestion prompt (the "Suggest" sheet → 👁): the
 * system/user message contents are built with THE SAME code as the real AI call — for
 * predefined profiles (buildSuggestChat) and custom ones (buildAgentChat, single
 * prompt with two months). Zero drift — identity test in ai.test.ts.
 */
export function previewSuggestPrompt(
  ledger: ClientLedger,
  month: string,
  profile: BudgetSuggestProfile,
  customPrompt: string | undefined,
  locale: AiLocale,
): { system: string; user: string } {
  const { request } =
    profile === "custom"
      ? buildAgentChat({ ledger, month, customPrompt, locale })
      : buildSuggestChat({ ledger, month, profile, customPrompt, locale });
  return {
    system: messageText(request.messages.find((m) => m.role === "system")),
    user: messageText(request.messages.find((m) => m.role === "user")),
  };
}

export async function runSuggest(args: {
  ledger: ClientLedger;
  month: string;
  profile: BudgetSuggestProfile;
  customPrompt?: string;
  locale: AiLocale;
  settings: AiSettings;
}): Promise<BudgetSuggestResponse> {
  const { ledger, month, profile, customPrompt, locale, settings } = args;
  /* Since v1.25.0 ONE path in all modes: the prompt (envelope snapshots of
     2 months / rules candidates) is built LOCALLY from the replica — i.e. from
     what you see on screen — and only the model transport differs:
       byok   → straight to api.openai.com with the user's key,
       server → via /api/ai/chat (a narrow operator-key proxy),
       off    → no model (pure rules).
     The /budget/suggest route stays on the server only for old clients. */
  const target = aiTarget(settings);
  const llm: ((req: ChatRequest) => Promise<string>) | null = target ? (req) => chatJson(req, target) : null;

  /* off | byok — LOCALLY (no /api/*). Response assembly like in
     generateSuggestion on the server side (the wrap is 10 lines; the server
     remains the source of truth for the server mode). */
  const generatedAt = new Date().toISOString();
  const agent = profile === "custom" ? buildAgentChat({ ledger, month, customPrompt, locale }) : null;
  const chat = agent ?? buildSuggestChat({ ledger, month, profile, customPrompt, locale });
  const basis = chat.basis;
  const empty = (warnings: string[]): NormalizedBudgetSuggestion => ({
    amountToDistribute: basis.amountToDistribute,
    distributed: 0,
    undistributedRemainder: 0,
    repaired: false,
    items: [],
    warnings,
  });
  const wrap = (norm: NormalizedBudgetSuggestion, source: BudgetSuggestResponse["source"]): BudgetSuggestResponse => ({
    month,
    profile,
    source,
    amountToDistribute: basis.amountToDistribute,
    undistributedRemainder: norm.undistributedRemainder,
    generatedAt,
    items: norm.items,
    warnings: norm.undistributedRemainder > 0 ? [...norm.warnings, "warn.capped"] : norm.warnings,
  });

  if (basis.amountToDistribute <= 0) {
    return wrap(
      { amountToDistribute: 0, distributed: 0, undistributedRemainder: 0, repaired: false, items: [], warnings: ["warn.nothingToDistribute"] },
      "rules",
    );
  }
  /* Custom profile = AGENT (single prompt: current + previous month):
     requires AI; NO silent fallback to rules (the user's directive must not
     "vanish" into history candidates). */
  if (agent) {
    if (!llm) return wrap(empty(["agent_requires_ai"]), "rules");
    try {
      const raw = await llm(agent.request);
      const norm = normalizeAgentSuggestion(parseAgentSuggestResponse(raw), basis, basis.amountToDistribute);
      return wrap(norm, norm.repaired ? "ai_repaired" : "ai");
    } catch {
      return wrap(empty(["warn.aiUnavailable"]), "rules");
    }
  }

  const request = chat.request;
  if (!llm) return wrap(buildRulesBudgetSuggestion(basis), "rules");

  try {
    const raw = await llm(request);
    const norm = normalizeBudgetSuggestion(basis, parseSuggestResponse(raw));
    return wrap(norm, norm.repaired ? "ai_repaired" : "ai");
  } catch {
    const rules = buildRulesBudgetSuggestion(basis);
    return wrap({ ...rules, warnings: [...rules.warnings, "warn.aiUnavailable"] }, "rules");
  }
}

/* ── Screenshot import ───────────────────────────────────────────────── */

export async function runImportExtract(args: {
  images: string[];
  locale: AiLocale;
  ledger: ClientLedger;
  settings: AiSettings;
}): Promise<ImportItem[]> {
  const { images, locale, ledger, settings } = args;
  /* DELIBERATE difference vs suggest: in the server mode the import GOES via the
     /import/extract route — (1) vision (images as content-parts) doesn't go
     through the /api/ai mirror (content=string, limit), (2) cycle 2 (assignments
     from history) is inherently server-side. In local-only+server it works like
     byok: facts yes, assignments empty (DB wiped). */
  if (settings.aiMode === "server") return (await api.importExtract(images, locale)).items;
  const target = aiTarget(settings);
  if (target?.kind !== "byok") throw new AiConsentRequired(); // off, or byok with an empty key

  /* byok: cycle 1 (facts from the screenshot) via the user's key; historical
     assignments (cycle 2) are server-only — items come back unassigned,
     the user fills them in the review sheet. */
  const refs = {
    envelopes: ledger.envelopes.filter((e) => !e.archived).map((e) => ({ id: e.id, name: e.name })),
    categories: ledger.categories.map((c) => ({ id: c.id, name: c.name })),
  };
  // SAME currency the server would read for this budget (falls back to the browser locale on a
  // fresh/wiped replica, exactly like useCurrency()) — the prompt-identity tests require the
  // byok request to stay byte-identical to the server's for the same budget.
  const currency = ledger.budgets[0]?.currency ?? currencyForLocales(browserLocales());
  // vision cap, not the chat cap: multi-screenshot extraction is the slow end (shared budget)
  const raw = await chatJson(buildImportExtractPrompt(images, refs, todayISO(), locale, currency), target, AI_VISION_TIMEOUT_MS);
  return parseOrFail(() => parseImportExtractResponse(raw)).map((t) => ({
    date: t.date,
    amount: t.amount,
    type: t.type,
    isRefund: t.isRefund,
    name: "",
    tag: t.tag,
    rawPlace: t.rawPlace,
    envelopeId: null,
    envelopeName: null,
    categoryId: null,
    categoryName: null,
    placeName: null,
    currency: t.currency,
    fxOriginal: t.fxOriginal,
  }));
}
