/** Provider-neutral AI workflows. Provider selection, credential storage and
 * transport live behind lib/aiProvider; this module only builds and normalizes
 * domain requests. Deterministic rules remain local and perform no fetch. */
import {
  type AiLocale,
  type BudgetSuggestionBasis,
  type BudgetSuggestProfile,
  type BudgetSuggestResponse,
  buildAgentSuggestContext,
  buildAgentSuggestPrompt,
  buildBudgetSuggestionBasis,
  buildRulesBudgetSuggestion,
  buildSuggestPrompt,
  type ChatMessage,
  type ChatRequest,
  type ClientLedger,
  type NormalizedBudgetSuggestion,
  normalizeAgentSuggestion,
  normalizeBudgetSuggestion,
  parseAgentSuggestResponse,
  parseSuggestResponse,
} from "@enveo/shared";
import type { AiProvider } from "./aiProvider/contracts";
import type { ImportItem } from "./api";

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

/* ── Budget suggestion ─────────────────────────────────────────────── */

/**
 * The ONLY shared basis→ctx→buildSuggestPrompt step — used by runSuggest
 * (byok path) AND previewSuggestPrompt. Thanks to this the prompt preview is
 * EXACTLY what we send (zero drift; identity test in ai.test.ts).
 */
function buildSuggestChat(args: { ledger: ClientLedger; month: string; profile: BudgetSuggestProfile; customPrompt?: string; locale: AiLocale }): {
  basis: BudgetSuggestionBasis;
  request: ChatRequest;
} {
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
function buildAgentChat(args: { ledger: ClientLedger; month: string; customPrompt?: string; locale: AiLocale }): {
  basis: BudgetSuggestionBasis;
  request: ChatRequest;
} {
  const { ledger, month, customPrompt, locale } = args;
  const basis = buildBudgetSuggestionBasis({ ledger, month, profile: "custom", customPrompt });
  const ctx = buildAgentSuggestContext({ ledger, month, basis, directive: customPrompt ?? "", locale });
  return { basis, request: buildAgentSuggestPrompt(ctx) };
}

/** Message content as a string (suggest always builds strings). */
const messageText = (m: ChatMessage | undefined): string => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

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
    profile === "custom" ? buildAgentChat({ ledger, month, customPrompt, locale }) : buildSuggestChat({ ledger, month, profile, customPrompt, locale });
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
  provider: AiProvider;
}): Promise<BudgetSuggestResponse> {
  const { ledger, month, profile, customPrompt, locale, provider } = args;

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
  const status = await provider.status();
  /* Custom profile = AGENT (single prompt: current + previous month):
     requires AI; NO silent fallback to rules (the user's directive must not
     "vanish" into history candidates). */
  if (agent) {
    if (!status.capabilities.has("custom-prompt")) return wrap(empty(["agent_requires_ai"]), "rules");
    try {
      const raw = await provider.complete(agent.request);
      const norm = normalizeAgentSuggestion(parseAgentSuggestResponse(raw), basis, basis.amountToDistribute);
      return wrap(norm, norm.repaired ? "ai_repaired" : "ai");
    } catch {
      return wrap(empty(["warn.aiUnavailable"]), "rules");
    }
  }

  const request = chat.request;
  if (status.provider === "rules" || !status.capabilities.has("budget-suggestion")) return wrap(buildRulesBudgetSuggestion(basis), "rules");

  try {
    const raw = await provider.complete(request);
    const norm = normalizeBudgetSuggestion(basis, parseSuggestResponse(raw));
    return wrap(norm, norm.repaired ? "ai_repaired" : "ai");
  } catch {
    const rules = buildRulesBudgetSuggestion(basis);
    return wrap({ ...rules, warnings: [...rules.warnings, "warn.aiUnavailable"] }, "rules");
  }
}

/* ── Screenshot import ───────────────────────────────────────────────── */

export async function runImportExtract(args: { images: string[]; locale: AiLocale; ledger: ClientLedger; provider: AiProvider }): Promise<ImportItem[]> {
  const { images, locale, ledger, provider } = args;
  const status = await provider.status();
  if (!status.capabilities.has("screenshot-import")) throw new AiConsentRequired();
  return (await provider.extractImport({ images, locale, ledger })).items;
}
