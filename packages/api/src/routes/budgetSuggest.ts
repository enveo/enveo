import {
  type AiLocale,
  aiLocaleSchema,
  type BudgetSuggestionBasis,
  type BudgetSuggestProfile,
  type BudgetSuggestResponse,
  buildAgentSuggestContext,
  buildAgentSuggestPrompt,
  buildBudgetSuggestionBasis,
  buildRulesBudgetSuggestion,
  buildSuggestPrompt,
  type ChatRequest,
  type ClientLedger,
  clientLedgerSchema,
  type NormalizedBudgetSuggestion,
  normalizeAgentSuggestion,
  normalizeBudgetSuggestion,
  type ProposedEnvelopeDelta,
  parseAgentSuggestResponse,
  parseSuggestResponse,
  supportsReasoningEffort,
} from "@enveo/shared";
import { Hono } from "hono";
import { z } from "zod";
import { aiBudgetExhaustedBody, meteredOperatorChat, operatorChatPayload, SpendDenied } from "../aiSpend/transport";
import { requireTier, sessionUserId } from "../context";
import { db } from "../db/client";
import { env } from "../env";
import { transportFailureJson, UpstreamHttpError } from "../openaiHttp";
import { loadClientLedger } from "../repo";

const requestSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  profile: z.enum(["cautious", "historical", "investor", "custom"]),
  customPrompt: z.string().max(2000).optional(),
  /* Any BCP-47 tag (the UI ships ten languages since 2.2.0); omitted → English. */
  locale: aiLocaleSchema.optional(),
  /* OPTIONAL since v1.24.3: without a ledger the server loads the ledger from
     its OWN database (loadClientLedger — same source as snapshot). Sending the
     replica (~MB for a large ledger) stays for backwards compatibility. */
  ledger: clientLedgerSchema.optional(),
  useAi: z.boolean().optional(), // explicit client consent for server (AI) mode
});
export type BudgetSuggestInput = z.infer<typeof requestSchema>;

export interface BudgetAiContext {
  month: string;
  profile: BudgetSuggestProfile;
  customPrompt?: string;
  locale: AiLocale;
  amountToDistribute: number;
  basis: BudgetSuggestionBasis;
  ledger: ClientLedger;
}
export type AskModel = (ctx: BudgetAiContext) => Promise<ProposedEnvelopeDelta[]>;

export async function generateSuggestion(
  input: BudgetSuggestInput & { ledger: NonNullable<BudgetSuggestInput["ledger"]> },
  askModel?: AskModel,
): Promise<BudgetSuggestResponse> {
  const generatedAt = new Date().toISOString();
  const ledger = input.ledger as unknown as ClientLedger;
  const basis = buildBudgetSuggestionBasis({ ledger, month: input.month, profile: input.profile, customPrompt: input.customPrompt });

  const wrap = (norm: NormalizedBudgetSuggestion, source: BudgetSuggestResponse["source"]): BudgetSuggestResponse => ({
    month: input.month,
    profile: input.profile,
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

  /* Custom profile = AGENT (single prompt: current + previous month —
     decision 2026-07-11, instead of a tool loop): requires AI; NO silent
     fallback to rules. Parity with runSuggest (web/lib/ai.ts, byok). */
  if (input.profile === "custom") {
    const empty = (warnings: string[]): NormalizedBudgetSuggestion => ({
      amountToDistribute: basis.amountToDistribute,
      distributed: 0,
      undistributedRemainder: 0,
      repaired: false,
      items: [],
      warnings,
    });
    if (!askModel) return wrap(empty(["agent_requires_ai"]), "rules");
    try {
      const proposed = await askModel({
        month: input.month,
        profile: input.profile,
        customPrompt: input.customPrompt,
        locale: input.locale ?? "en",
        amountToDistribute: basis.amountToDistribute,
        basis,
        ledger,
      });
      const norm = normalizeAgentSuggestion(proposed, basis, basis.amountToDistribute);
      return wrap(norm, norm.repaired ? "ai_repaired" : "ai");
    } catch {
      return wrap(empty(["warn.aiUnavailable"]), "rules");
    }
  }

  if (!askModel) return wrap(buildRulesBudgetSuggestion(basis), "rules");

  try {
    const proposed = await askModel({
      month: input.month,
      profile: input.profile,
      customPrompt: input.customPrompt,
      locale: input.locale ?? "en",
      amountToDistribute: basis.amountToDistribute,
      basis,
      ledger,
    });
    const norm = normalizeBudgetSuggestion(basis, proposed);
    return wrap(norm, norm.repaired ? "ai_repaired" : "ai");
  } catch {
    const rules = buildRulesBudgetSuggestion(basis);
    return wrap({ ...rules, warnings: [...rules.warnings, "warn.aiUnavailable"] }, "rules");
  }
}

/** Local chat helper (operator key) — prompt/parsing in shared/aiPrompts; the transport is the
 *  metered one (spend check per actual attempt). Throws SpendDenied on an exhausted allowance —
 *  generateSuggestion's catch turns that into the local-rules fallback (backlog §1). */
async function openaiChat(req: ChatRequest, userId: string | undefined): Promise<string> {
  const out = await meteredOperatorChat({ userId, payload: operatorChatPayload(req) });
  if (out.kind === "denied") throw new SpendDenied(out.retryAfterSeconds);
  if (out.kind === "upstream_error") throw new UpstreamHttpError(out.status);
  if (out.kind === "invalid_body") throw new Error("openai: unreadable 2xx body");
  return out.content || "{}";
}

/** Default provider — OpenAI, bound to the SESSION USER for spend accounting. Prompt+parsing
 *  from shared (parity with byok); throws → generateSuggestion catches. Custom profile = agent
 *  prompt (single shot with two months), predefined ones = rules-engine prompt. */
export const openAiAskModelFor =
  (userId: string | undefined): AskModel =>
  async (ctx) => {
    if (ctx.profile === "custom") {
      const agentCtx = buildAgentSuggestContext({
        ledger: ctx.ledger,
        month: ctx.month,
        basis: ctx.basis,
        directive: ctx.customPrompt ?? "",
        locale: ctx.locale,
      });
      return parseAgentSuggestResponse(await openaiChat(buildAgentSuggestPrompt(agentCtx), userId));
    }
    const raw = await openaiChat(
      buildSuggestPrompt({
        basis: ctx.basis,
        ledger: ctx.ledger,
        month: ctx.month,
        profile: ctx.profile,
        customPrompt: ctx.customPrompt,
        locale: ctx.locale,
      }),
      userId,
    );
    return parseSuggestResponse(raw);
  };

/* Narrow chat proxy for Enveo AI + the operator key:
   the client builds the prompt locally (same builders as BYOK — for suggest
   these are 2-month envelope snapshots, not the replica) and sends only the
   messages; the server attaches the key and forwards. Size limit + rigid zod
   shape (no extra OpenAI fields outside the contract). Auth: the session
   middleware in index.ts gates every /api/* route, so this proxy is reachable
   only by a signed-in user. Spend protection (backlog §1): on cloud (open
   registration + operator key) every attempt runs through the metered
   transport — an approximate ~$5/user/UTC-month allowance, 429
   ai_budget_exhausted when it is used up. A normal selfhost deployment
   (trusted accounts spending the operator's own key) bypasses the counter
   entirely and stays unlimited by this mechanism. */
const aiChatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["system", "user"]), content: z.string().max(200_000) }))
    .min(1)
    .max(4),
  responseFormat: z.record(z.string(), z.unknown()).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
});

/* Trimmed OpenAI mirror (wire 1:1, snake_case) — the CLIENT's model is ignored
   (always env.OPENAI_MODEL; we don't let clients pick a model at the operator's expense). */
const openAiWireSchema = z.object({
  model: z.string().optional(),
  messages: z
    .array(z.object({ role: z.enum(["system", "user"]), content: z.string().max(200_000) }))
    .min(1)
    .max(4),
  response_format: z.record(z.string(), z.unknown()).optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

export const budgetSuggestRoutes = new Hono();

/* 1:1 proxy (v1.26.0): same path and body as OpenAI /v1/chat/completions
   (trimmed subset), response forwarded WITHOUT processing — the client uses
   identical transport code for byok and server (only base+auth differ). */
budgetSuggestRoutes.post("/ai/v1/chat/completions", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "ai_unavailable" }, 503);
  await requireTier(c, "plain");
  const req = openAiWireSchema.parse(await c.req.json());
  let out: Awaited<ReturnType<typeof meteredOperatorChat>>;
  try {
    out = await meteredOperatorChat({
      userId: sessionUserId(c),
      payload: {
        model: env.OPENAI_MODEL,
        messages: req.messages,
        ...(req.response_format ? { response_format: req.response_format } : {}),
        ...(req.reasoning_effort && supportsReasoningEffort(env.OPENAI_MODEL) ? { reasoning_effort: req.reasoning_effort } : {}),
      },
    });
  } catch (e) {
    /* timeout vs network failure on the way to OpenAI — DISTINCT stable codes since
       the AI-transport package (the old contract folded both into upstream/504). */
    const failure = transportFailureJson(e);
    if (failure) return c.json(failure.body, failure.status);
    throw e; // the metered transport only throws the two classified errors
  }
  if (out.kind === "denied") return c.json(aiBudgetExhaustedBody(out.retryAfterSeconds), 429, { "Retry-After": String(out.retryAfterSeconds) });
  if (out.kind === "upstream_error") return c.json({ error: "upstream", status: out.status }, 502);
  if (out.kind === "invalid_body") return c.json({ error: "upstream", status: 502 }, 502);
  return c.json(out.json); // the ORIGINAL upstream JSON, usage included (wire 1:1)
});

/* DEPRECATED alias (1.24.5–1.25.0) — remove once clients are refreshed. */
budgetSuggestRoutes.post("/ai/chat", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "ai_unavailable" }, 503);
  await requireTier(c, "plain");
  const req = aiChatSchema.parse(await c.req.json());
  try {
    return c.json({ content: await openaiChat(req as ChatRequest, sessionUserId(c)) });
  } catch (e) {
    if (e instanceof SpendDenied) return c.json(aiBudgetExhaustedBody(e.retryAfterSeconds), 429, { "Retry-After": String(e.retryAfterSeconds) });
    /* Same classification as /ai/v1 above — this alias used to fold EVERY failure
       (a real upstream 401 included) into {error:"upstream",status:504}. */
    const failure = transportFailureJson(e);
    if (failure) return c.json(failure.body, failure.status);
    if (e instanceof UpstreamHttpError) return c.json({ error: "upstream", status: e.status }, 502);
    return c.json({ error: "upstream", status: 504 }, 502); // an unreadable 2xx body — the historical catch-all
  }
});

budgetSuggestRoutes.post("/budget/suggest", async (c) => {
  const meta = await requireTier(c, "plain");
  const input = requestSchema.parse(await c.req.json());
  const ledger = input.ledger ?? ((await loadClientLedger(db, meta.id)) as unknown as BudgetSuggestInput["ledger"] & object);
  const useAi = Boolean(input.useAi && env.OPENAI_API_KEY);
  /* An exhausted allowance surfaces as SpendDenied inside the ask-model; generateSuggestion's
     catch keeps the existing LOCAL-RULES fallback (warn.aiUnavailable) — never a 429 here. */
  const resp = await generateSuggestion({ ...input, ledger }, useAi ? openAiAskModelFor(sessionUserId(c)) : undefined);
  return c.json(resp);
});
