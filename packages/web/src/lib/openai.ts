/**
 * Low-level chat transport with explicit targets. Operator AI uses Enveo's mirror;
 * E2EE BYOK uses OpenAI directly so plaintext prompts and credentials never reach Enveo.
 *
 * ERROR CONTRACT (as everywhere in lib/*): a failure leaves this module as a snake_case CODE —
 * never prose, never a status line. Screenshot import is AI-only, so these errors are RENDERED
 * to the user (the import sheet's error line) instead of being swallowed by a rules fallback; a
 * thrown `OpenAI 503` put an English developer string in a Polish UI. lib/api.ts (ERROR_KEYS)
 * owns the wording in every locale. The codes:
 *   ai_offline        — fetch never left the device (a local-first PWA is offline all the time)
 *   ai_timeout        — OUR timer cut a round-trip that exceeded its cap (the model hung)
 *   ai_unreachable    — fetch rejected while online (DNS, a dropped connection, a dead server)
 *   ai_unavailable    — the mirror has no operator key (503 {"error":"ai_unavailable"})
 *   ai_key_invalid    — byok: OpenAI rejected the user's key (401/403)
 *   ai_upstream_error — anything else: an upstream rejection, or an answer we cannot read
 * api.test.ts guards this file: no template-literal throws (that is how the prose got in).
 *
 * TIMEOUTS come from @enveo/shared/aiTransport (ONE budget with the server —
 * openaiHttp.ts consumes the same constants). This transport is PROXIED, so the
 * client waits the server's cap PLUS a margin — the server's classified answer
 * must always beat the client's abort. `AbortSignal.timeout` is absent on
 * WebKit < 16 (iOS 15 Safari) — timeoutSignal builds it from parts.
 */
import { AI_CHAT_TIMEOUT_MS, AI_PROXY_CHAT_TIMEOUT_MS, type ChatRequest, type OpenAiModel } from "@enveo/shared";
import { runServerWriteOperation } from "./serverWriteOperations";
import { timeoutSignal } from "./timeoutSignal";

export type ChatTarget = { kind: "server" } | { kind: "direct"; apiKey: string; model: OpenAiModel };
const CODE = /^[a-z0-9_]+$/;

/** fetch() rejected — there is no response at all (offline, DNS, a dropped connection). */
function transportError(): Error {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return new Error(offline ? "ai_offline" : "ai_unreachable");
}

/**
 * A non-2xx answer → a code. Our mirror already speaks codes (`{"error":"ai_unavailable"}`,
 * `{"error":"upstream"}`) so those pass straight through to the dictionary; OpenAI answers with an
 * `{error:{message,…}}` OBJECT, which must never reach the UI — there the status decides.
 */
async function responseError(res: Response, target: ChatTarget): Promise<Error> {
  const body = await res.text().catch(() => "");
  if (target.kind === "server") {
    try {
      const code = (JSON.parse(body) as { error?: unknown }).error;
      if (typeof code === "string" && CODE.test(code)) return new Error(code);
    } catch {
      /* not JSON (e.g. a proxy's HTML error page) → the status decides */
    }
    if (res.status === 503) return new Error("ai_unavailable");
  } else {
    if (res.status === 401 || res.status === 403) return new Error("ai_key_invalid");
    if (res.status === 404) return new Error("ai_model_unavailable");
  }
  return new Error("ai_upstream_error");
}

/** The one transport step (fetch → non-2xx → body): the single place a failure becomes a code.
 *  A hung upstream must become a normal transport error (code + retry), not a spinner that
 *  never resolves — the cap is the caller's (chat vs vision vs proxied, see the module comment). */
async function postChatImpl(body: unknown, timeoutMs: number, target: ChatTarget): Promise<unknown> {
  const t = timeoutSignal(timeoutMs);
  let res: Response;
  try {
    res = await fetch(target.kind === "server" ? "/api/ai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...(target.kind === "direct" ? { authorization: `Bearer ${target.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: t.signal,
    });
  } catch {
    throw t.timedOut() ? new Error("ai_timeout") : transportError();
  } finally {
    t.clear();
  }
  if (!res.ok) throw await responseError(res, target);
  try {
    return await res.json();
  } catch {
    throw new Error("ai_upstream_error"); // 2xx whose body is not JSON (a captive portal, a broken proxy)
  }
}

function postChat(body: unknown, timeoutMs: number, target: ChatTarget): Promise<unknown> {
  return runServerWriteOperation("openai-post", () => postChatImpl(body, timeoutMs, target));
}

/** `timeoutMs` lets a proxied operation choose its cap; the default is the operator-chat
 *  budget (server cap + margin, so the mirror's own classified `ai_timeout` answer wins). */
export async function chatJson(req: ChatRequest, target: ChatTarget, timeoutMs?: number): Promise<string> {
  const data = (await postChat(
    {
      ...(target.kind === "direct" ? { model: target.model } : {}),
      messages: req.messages,
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    },
    timeoutMs ?? (target.kind === "direct" ? AI_CHAT_TIMEOUT_MS : AI_PROXY_CHAT_TIMEOUT_MS),
    target,
  )) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

/** E2EE BYOK transport. The plaintext key is request-scoped and reaches only OpenAI's
 * Authorization header; prompts and screenshots never transit Enveo. */
export function directChatJson(req: ChatRequest, apiKey: string, model: OpenAiModel, timeoutMs?: number): Promise<string> {
  return chatJson(req, { kind: "direct", apiKey, model }, timeoutMs);
}
