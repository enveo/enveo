import { type ChatRequest, supportsReasoningEffort } from "@enveo/shared";
import { parseChatCompletion } from "../aiSpend/chatCompletion";
import { openAiChatFetch } from "../openaiHttp";

export type ByokChatOutcome =
  | { kind: "ok"; json: Record<string, unknown>; content: string }
  | { kind: "upstream_error"; status: number }
  | { kind: "invalid_body" };

export const byokTransportDeps = { fetchChat: openAiChatFetch };

export class ByokUpstreamError extends Error {
  constructor(readonly status: number) {
    super("ai_upstream_error");
  }
}

export class ByokInvalidBodyError extends Error {
  constructor() {
    super("ai_upstream_error");
  }
}

/**
 * User-funded transport: no operator key, spend counter, safety identifier, or response-body
 * logging. The caller supplies a request-scoped credential opened from the vault.
 */
export async function byokChat(options: { apiKey: string; model: string; request: ChatRequest; timeoutMs?: number }): Promise<ByokChatOutcome> {
  const response = await byokTransportDeps.fetchChat(
    {
      model: options.model,
      messages: options.request.messages,
      ...(options.request.responseFormat ? { response_format: options.request.responseFormat } : {}),
      ...(options.request.reasoningEffort && supportsReasoningEffort(options.model) ? { reasoning_effort: options.request.reasoningEffort } : {}),
    },
    { apiKey: options.apiKey, timeoutMs: options.timeoutMs },
  );
  if (!response.ok) return { kind: "upstream_error", status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "invalid_body" };
  }
  const parsed = parseChatCompletion(body);
  if (!parsed) return { kind: "invalid_body" };
  return { kind: "ok", json: parsed.json, content: parsed.content };
}

export async function byokChatContent(options: { apiKey: string; model: string; request: ChatRequest; timeoutMs?: number }): Promise<string> {
  const outcome = await byokChat(options);
  if (outcome.kind === "upstream_error") throw new ByokUpstreamError(outcome.status);
  if (outcome.kind === "invalid_body") throw new ByokInvalidBodyError();
  return outcome.content;
}
