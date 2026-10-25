import { type ChatRequest, supportsReasoningEffort } from "@enveo/shared";
import { Hono } from "hono";
import { z } from "zod";
import { aiBudgetExhaustedBody, meteredOperatorChat, operatorChatPayload, SpendDenied } from "../aiSpend/transport";
import { requireTier, sessionUserId } from "../context";
import { env } from "../env";
import { transportFailureJson, UpstreamHttpError } from "../openaiHttp";

async function openaiChat(req: ChatRequest, userId: string | undefined): Promise<string> {
  const out = await meteredOperatorChat({ userId, payload: operatorChatPayload(req) });
  if (out.kind === "denied") throw new SpendDenied(out.retryAfterSeconds);
  if (out.kind === "upstream_error") throw new UpstreamHttpError(out.status);
  if (out.kind === "invalid_body") throw new Error("openai: unreadable 2xx body");
  return out.content || "{}";
}

/* Narrow chat proxy for Enveo AI + the operator key:
   the client builds the prompt locally (same builders as BYOK) and sends only the
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

const openAiWireSchema = z.object({
  model: z.string().optional(),
  messages: z
    .array(z.object({ role: z.enum(["system", "user"]), content: z.string().max(200_000) }))
    .min(1)
    .max(4),
  response_format: z.record(z.string(), z.unknown()).optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

export const aiProxyRoutes = new Hono();

aiProxyRoutes.post("/ai/v1/chat/completions", async (c) => {
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
    const failure = transportFailureJson(e);
    if (failure) return c.json(failure.body, failure.status);
    throw e;
  }
  if (out.kind === "denied") return c.json(aiBudgetExhaustedBody(out.retryAfterSeconds), 429, { "Retry-After": String(out.retryAfterSeconds) });
  if (out.kind === "upstream_error") return c.json({ error: "upstream", status: out.status }, 502);
  if (out.kind === "invalid_body") return c.json({ error: "upstream", status: 502 }, 502);
  return c.json(out.json);
});

aiProxyRoutes.post("/ai/chat", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "ai_unavailable" }, 503);
  await requireTier(c, "plain");
  const req = aiChatSchema.parse(await c.req.json());
  try {
    return c.json({ content: await openaiChat(req as ChatRequest, sessionUserId(c)) });
  } catch (e) {
    if (e instanceof SpendDenied) return c.json(aiBudgetExhaustedBody(e.retryAfterSeconds), 429, { "Retry-After": String(e.retryAfterSeconds) });

    const failure = transportFailureJson(e);
    if (failure) return c.json(failure.body, failure.status);
    if (e instanceof UpstreamHttpError) return c.json({ error: "upstream", status: e.status }, 502);
    return c.json({ error: "upstream", status: 504 }, 502);
  }
});
