/**
 * AI function dispatch per mode (`settings.aiMode`) — PURE functions without
 * hooks (settings passed explicitly):
 *
 *  - off:    local engine (rules from @enveo/shared) — ZERO network,
 *  - byok:   prompt from shared → OpenAI directly from the browser (lib/openai.ts),
 *            the user's key; error → fallback to rules (suggest/quick-add),
 *  - server: SUGGEST since v1.25.0 uses the same local path as byok, only the chat
 *            goes through /api/ai/chat (operator-key proxy — no replica
 *            and no computation on the server); quick-add/import still via /api routes.
 *
 * PRIVACY CONTRACT: in the off and byok modes suggest and quick-add generation
 * does NOT touch /api/* — the only egress in byok is api.openai.com.
 */
import {
  buildAgentSuggestContext,
  buildAgentSuggestPrompt,
  buildBudgetSuggestionBasis,
  buildImportExtractPrompt,
  buildQuickAddPrompt,
  buildRulesBudgetSuggestion,
  buildSuggestPrompt,
  normalizeAgentSuggestion,
  normalizeBudgetSuggestion,
  parseAgentSuggestResponse,
  parseImportExtractResponse,
  parseQuickAdd,
  parseQuickAddResponse,
  parseSuggestResponse,
  type BudgetSuggestProfile,
  type BudgetSuggestResponse,
  type BudgetSuggestionBasis,
  type ChatMessage,
  type ChatRequest,
  type ClientLedger,
  type NormalizedBudgetSuggestion,
  type QuickAddResult,
} from "@enveo/shared";
import { api, type ImportItem, type QuickAddResponse } from "./api";
import type { Settings } from "./contexts";
import { chatJson, type ChatTarget } from "./openai";

 
export type AiSettings = Pick<Settings, "aiMode" | "openaiKey" | "openaiModel">;

 
export class AiConsentRequired extends Error {
  constructor() {
    super("ai consent required");
    this.name = "AiConsentRequired";
  }
}

const todayISO = (): string => new Date().toISOString().slice(0, 10);

 






function buildSuggestChat(args: {
  ledger: ClientLedger;
  month: string;
  profile: BudgetSuggestProfile;
  customPrompt?: string;
  locale: "pl" | "en";
}): { basis: BudgetSuggestionBasis; request: ChatRequest } {
  const { ledger, month, profile, customPrompt, locale } = args;
  const basis = buildBudgetSuggestionBasis({ ledger, month, profile, customPrompt });
  return { basis, request: buildSuggestPrompt({ basis, ledger, month, profile, customPrompt, locale }) };
}







function buildAgentChat(args: {
  ledger: ClientLedger;
  month: string;
  customPrompt?: string;
  locale: "pl" | "en";
}): { basis: BudgetSuggestionBasis; request: ChatRequest } {
  const { ledger, month, customPrompt, locale } = args;
  const basis = buildBudgetSuggestionBasis({ ledger, month, profile: "custom", customPrompt });
  const ctx = buildAgentSuggestContext({ ledger, month, basis, directive: customPrompt ?? "", locale });
  return { basis, request: buildAgentSuggestPrompt(ctx) };
}

 
const messageText = (m: ChatMessage | undefined): string =>
  typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");







export function previewSuggestPrompt(
  ledger: ClientLedger,
  month: string,
  profile: BudgetSuggestProfile,
  customPrompt: string | undefined,
  locale: "pl" | "en",
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
  locale: "pl" | "en";
  settings: AiSettings;
}): Promise<BudgetSuggestResponse> {
  const { ledger, month, profile, customPrompt, locale, settings } = args;
  






  const llm: ((req: ChatRequest) => Promise<string>) | null =
    settings.aiMode === "server"
      ? (req) => chatJson(req, { kind: "server" })
      : settings.aiMode === "byok" && settings.openaiKey
        ? (req) => chatJson(req, { kind: "byok", key: settings.openaiKey, model: settings.openaiModel })
        : null;

  


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

 

const quickAddRefs = (ledger: ClientLedger) => ({
  envelopes: ledger.envelopes.map((e) => ({ id: e.id, name: e.name })),
  places: ledger.places.map((p) => ({ id: p.id, name: p.name })),
  categories: ledger.categories.map((c) => ({ id: c.id, name: c.name })),
});

export async function runQuickAdd(args: {
  text: string;
  locale: "pl" | "en";
  ledger: ClientLedger;
  settings: AiSettings;
}): Promise<QuickAddResponse> {
  const { text, locale, ledger, settings } = args;

  



  const target: ChatTarget | null =
    settings.aiMode === "server"
      ? { kind: "server" }
      : settings.aiMode === "byok" && settings.openaiKey
        ? { kind: "byok", key: settings.openaiKey, model: settings.openaiModel }
        : null;
  const refs = quickAddRefs(ledger);
  const today = todayISO();
  const base = parseQuickAdd(text, refs, today);
  if (!target || base.confidence >= 1) return base;

  

  try {
    const raw = await chatJson(buildQuickAddPrompt(text, refs, today, locale), target);
    const fields = parseQuickAddResponse(raw);
    const matchEnv = fields.envelopeName ? refs.envelopes.find((e) => e.name.toLowerCase() === fields.envelopeName!.toLowerCase()) : null;
    const matchPlace = fields.placeName ? refs.places.find((p) => p.name.toLowerCase() === fields.placeName!.toLowerCase()) : null;
    const merged: QuickAddResult = {
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
    return merged;
  } catch {
    return base;
  }
}

 

export async function runImportExtract(args: {
  images: string[];
  locale: "pl" | "en";
  ledger: ClientLedger;
  settings: AiSettings;
}): Promise<ImportItem[]> {
  const { images, locale, ledger, settings } = args;
  /* DELIBERATE difference vs suggest/quick-add: in the server mode the import GOES
     via the /import/extract route — (1) vision (images as content-parts) doesn't
     go through the /api/ai mirror (content=string, limit), (2) cycle 2
     (assignments from history) is inherently server-side. In local-only+server
     it works like byok: facts yes, assignments empty (DB wiped). */
  if (settings.aiMode === "server") return (await api.importExtract(images, locale)).items;
  if (settings.aiMode !== "byok" || !settings.openaiKey) throw new AiConsentRequired();

  


  const refs = {
    envelopes: ledger.envelopes.filter((e) => !e.archived).map((e) => ({ id: e.id, name: e.name })),
    categories: ledger.categories.map((c) => ({ id: c.id, name: c.name })),
  };
  const raw = await chatJson(buildImportExtractPrompt(images, refs, todayISO(), locale), { kind: "byok", key: settings.openaiKey, model: settings.openaiModel });
  return parseImportExtractResponse(raw).map((t) => ({
    date: t.date,
    amount: t.amount,
    type: t.type,
    name: "",
    tag: t.tag,
    rawPlace: t.rawPlace,
    envelopeId: null,
    envelopeName: null,
    categoryId: null,
    categoryName: null,
    placeName: null,
  }));
}
