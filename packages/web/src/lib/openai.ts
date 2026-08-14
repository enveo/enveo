/**
 * Low-level operator-AI chat transport. Vaulted plain BYOK has its own Enveo
 * route; direct OpenAI transport is introduced only by the Stage-4 E2EE
 * provider, which cannot share this server-only target by accident.
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
import { AI_PROXY_CHAT_TIMEOUT_MS, type ChatRequest } from "@enveo/shared";
import { timeoutSignal } from "./timeoutSignal";

export type ChatTarget = { kind: "server" };
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
async function responseError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof code === "string" && CODE.test(code)) return new Error(code);
  } catch {
    /* not JSON (e.g. a proxy's HTML error page) → the status decides */
  }
  if (res.status === 503) return new Error("ai_unavailable");
  return new Error("ai_upstream_error");
}

/** The one transport step (fetch → non-2xx → body): the single place a failure becomes a code.
 *  A hung upstream must become a normal transport error (code + retry), not a spinner that
 *  never resolves — the cap is the caller's (chat vs vision vs proxied, see the module comment). */
async function postChat(body: unknown, timeoutMs: number): Promise<unknown> {
  const t = timeoutSignal(timeoutMs);
  let res: Response;
  try {
    res = await fetch("/api/ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: t.signal,
    });
  } catch {
    throw t.timedOut() ? new Error("ai_timeout") : transportError();
  } finally {
    t.clear();
  }
  if (!res.ok) throw await responseError(res);
  try {
    return await res.json();
  } catch {
    throw new Error("ai_upstream_error"); // 2xx whose body is not JSON (a captive portal, a broken proxy)
  }
}

/** `timeoutMs` lets a proxied operation choose its cap; the default is the operator-chat
 *  budget (server cap + margin, so the mirror's own classified `ai_timeout` answer wins). */
export async function chatJson(req: ChatRequest, _cfg: ChatTarget, timeoutMs?: number): Promise<string> {
  const data = (await postChat(
    {
      messages: req.messages,
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    },
    timeoutMs ?? AI_PROXY_CHAT_TIMEOUT_MS,
  )) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}
