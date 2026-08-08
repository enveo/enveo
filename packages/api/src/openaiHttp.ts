/**
 * The ONE fetch layer for every operator-key OpenAI call (budget suggest, the
 * /ai proxy, screenshot import). Attaches the bearer key and a hard timeout —
 * a hung upstream must abort instead of pinning the incoming HTTP request (and
 * the client's spinner) forever. Callers map the abort onto their existing
 * error codes: it rejects like any network failure.
 */

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/** Hard cap for one upstream round-trip; vision extractions are the slow end. */
export const OPENAI_TIMEOUT_MS = 120_000;

export function openAiChatFetch(
  payload: unknown,
  opts: { apiKey: string; url?: string; timeoutMs?: number },
): Promise<Response> {
  return fetch(opts.url ?? OPENAI_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeoutMs ?? OPENAI_TIMEOUT_MS),
  });
}
