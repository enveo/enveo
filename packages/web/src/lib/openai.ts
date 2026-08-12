/**
 * The fetch layer for the byok mode — calls OpenAI DIRECTLY from the browser
 * (the user's key from localStorage, never through our server). Prompts and
 * parsing live in @enveo/shared/aiPrompts (parity with the server mode).
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
 * openaiHttp.ts consumes the same constants): byok talks to OpenAI directly and
 * uses the operation's own cap (chat vs vision); the server mirror is PROXIED, so
 * the client waits the server's cap PLUS a margin — the server's classified answer
 * must always beat the client's abort. `AbortSignal.timeout` is absent on
 * WebKit < 16 (iOS 15 Safari) — timeoutSignal builds it from parts.
 */
import { AI_CHAT_TIMEOUT_MS, AI_PROXY_CHAT_TIMEOUT_MS, supportsReasoningEffort, type ChatRequest } from "@enveo/shared";
import { timeoutSignal } from "./timeoutSignal";

/** Transport target: OpenAI with the user's key (byok) OR the mirror on our API
 *  (server — an operator-key proxy; the server picks the model, reasoning_effort
 *  is always forwarded, the server gates by its own model). Wire 1:1. */
export type ChatTarget = { kind: "byok"; key: string; model: string } | { kind: "server" };

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
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
async function responseError(res: Response, kind: ChatTarget["kind"]): Promise<Error> {
  const body = await res.text().catch(() => "");
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof code === "string" && CODE.test(code)) return new Error(code);
  } catch {
    /* not JSON (e.g. a proxy's HTML error page) → the status decides */
  }
  if (res.status === 503) return new Error("ai_unavailable");
  if (kind === "byok" && (res.status === 401 || res.status === 403)) return new Error("ai_key_invalid");
  return new Error("ai_upstream_error");
}

/** The one transport step (fetch → non-2xx → body): the single place a failure becomes a code.
 *  A hung upstream must become a normal transport error (code + retry), not a spinner that
 *  never resolves — the cap is the caller's (chat vs vision vs proxied, see the module comment). */
async function postChat(url: string, headers: Record<string, string>, body: unknown, kind: ChatTarget["kind"], timeoutMs: number): Promise<unknown> {
  const t = timeoutSignal(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: t.signal });
  } catch {
    throw t.timedOut() ? new Error("ai_timeout") : transportError();
  } finally {
    t.clear();
  }
  if (!res.ok) throw await responseError(res, kind);
  try {
    return await res.json();
  } catch {
    throw new Error("ai_upstream_error"); // 2xx whose body is not JSON (a captive portal, a broken proxy)
  }
}

/** `timeoutMs` — only vision calls (screenshot extraction, byok) override it; the default is
 *  the operation-correct chat cap: server mode goes through the mirror (server cap + margin,
 *  so the mirror's own classified `ai_timeout` answer wins), byok talks to OpenAI directly. */
export async function chatJson(req: ChatRequest, cfg: ChatTarget, timeoutMs?: number): Promise<string> {
  const url = cfg.kind === "byok" ? OPENAI_URL : "/api/ai/v1/chat/completions";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.kind === "byok") headers.authorization = `Bearer ${cfg.key}`;
  const sendEffort = req.reasoningEffort && (cfg.kind === "server" || supportsReasoningEffort(cfg.model));
  const data = (await postChat(
    url,
    headers,
    {
      ...(cfg.kind === "byok" ? { model: cfg.model } : {}),
      messages: req.messages,
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(sendEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    },
    cfg.kind,
    timeoutMs ?? (cfg.kind === "server" ? AI_PROXY_CHAT_TIMEOUT_MS : AI_CHAT_TIMEOUT_MS),
  )) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}
