/**
 * The ONE validated Chat Completions response parser for operator-key calls (backlog §1).
 *
 * Both consumers go through it: the 1:1 `/api/ai/v1/chat/completions` proxy (which forwards the
 * ORIGINAL upstream JSON, `usage` included) and the internal helpers (which read only
 * `choices[0].message.content`). It extracts, without ever fabricating, the accounting metadata
 * the metered transport charges from: the response `model` and the raw `usage` subtree
 * (validated later by the price calculator — a parse success here is NOT a pricing success).
 */

export interface ParsedChatCompletion {
  /** The original upstream body, untouched — the proxy forwards this object as-is. */
  json: Record<string, unknown>;
  /** `choices[0].message.content`, or "" when absent (callers decide their own fallback). */
  content: string;
  /** Response `model` (possibly a dated snapshot), or null when absent/not a string. */
  responseModel: string | null;
  /** The raw `usage` subtree — undefined when missing. Never invented. */
  usage: unknown;
}

/** null ⇒ the 2xx body is not a JSON object at all (the caller treats it as an unreadable body). */
export function parseChatCompletion(body: unknown): ParsedChatCompletion | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const json = body as Record<string, unknown>;
  const choices = json.choices;
  let content = "";
  if (Array.isArray(choices)) {
    const message = (choices[0] as { message?: unknown } | undefined)?.message;
    const c = (message as { content?: unknown } | undefined)?.content;
    if (typeof c === "string") content = c;
  }
  return {
    json,
    content,
    responseModel: typeof json.model === "string" ? json.model : null,
    usage: json.usage,
  };
}
