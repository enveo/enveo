/**
 * The fetch layer for the byok mode — calls OpenAI DIRECTLY from the browser
 * (the user's key from localStorage, never through our server). Prompts and
 * parsing live in @enveo/shared/aiPrompts (parity with the server mode).
 */
import { supportsReasoningEffort, type AssistantToolsMessage, type ChatRequest, type ChatToolsRequest } from "@enveo/shared";

/** Transport target: OpenAI with the user's key (byok) OR the mirror on our API
 *  (server — an operator-key proxy; the server picks the model, reasoning_effort
 *  is always forwarded, the server gates by its own model). Wire 1:1. */
export type ChatTarget = { kind: "byok"; key: string; model: string } | { kind: "server" };

export async function chatJson(req: ChatRequest, cfg: ChatTarget): Promise<string> {
  const url = cfg.kind === "byok" ? "https://api.openai.com/v1/chat/completions" : "/api/ai/v1/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.kind === "byok") headers.authorization = `Bearer ${cfg.key}`;
  const sendEffort = req.reasoningEffort && (cfg.kind === "server" || supportsReasoningEffort(cfg.model));
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(cfg.kind === "byok" ? { model: cfg.model } : {}),
      messages: req.messages,
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(sendEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Chat with tools (the agent loop) — returns the FULL message
 *  `{content, tool_calls}` from choices[0]; errors signaled as in chatJson. */
export async function chatTools(req: ChatToolsRequest, cfg: { key: string; model: string }): Promise<AssistantToolsMessage> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: req.messages,
      tools: req.tools,
      tool_choice: req.toolChoice,
      parallel_tool_calls: req.parallelToolCalls,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: AssistantToolsMessage }> };
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content ?? null, ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}) };
}
