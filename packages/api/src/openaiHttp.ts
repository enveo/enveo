/**
 * The ONE fetch layer for every operator-key OpenAI call (budget suggest, the
 * /ai proxy, screenshot import). Attaches the bearer key and a hard timeout —
 * a hung upstream must abort instead of pinning the incoming HTTP request (and
 * the client's spinner) forever.
 *
 * FAILURE CLASSES ARE TYPED so routes can answer with DISTINCT stable codes
 * (web/lib/api.ts owns the wording in every locale — a timeout must never render
 * as "check the key and the model"):
 *   UpstreamTimeoutError — the round-trip exceeded its cap        → ai_timeout (504)
 *   UpstreamNetworkError — fetch rejected before any answer       → ai_unreachable (502)
 *   an HTTP Response (any status) is RETURNED — the caller judges it (`upstream` /
 *   `ai_upstream_error` with the real upstream status).
 * `transportFailureJson` is the one mapping both /ai proxies and /import/extract
 * share, so the routes cannot drift apart again.
 *
 * `AbortSignal.timeout` is deliberately NOT used: the same semantics are built from
 * AbortController + setTimeout (`timeoutSignal`) for parity with the web transport,
 * where WebKit < 16 (iOS 15 Safari) lacks `AbortSignal.timeout` entirely. The timer
 * is cleared on settle — no timer retained for the full cap after a fast answer.
 */
import { AI_CHAT_TIMEOUT_MS } from "@enveo/shared";

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** The upstream round-trip exceeded its cap (the abort came from OUR timer). */
export class UpstreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`openai timeout after ${timeoutMs}ms`);
  }
}

/** fetch rejected with no response at all (DNS, connection refused, reset). */
export class UpstreamNetworkError extends Error {
  constructor(cause: unknown) {
    super(`openai unreachable: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

/** OpenAI answered non-2xx — thrown by route-local helpers that need the body parsed,
 *  carried to the client as `upstream`/`ai_upstream_error` with the REAL status. */
export class UpstreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`openai ${status}`);
  }
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/**
 * `AbortSignal.timeout` built from parts (see the module comment). `timedOut()`
 * distinguishes OUR abort from any other rejection — `AbortController.abort(reason)`
 * is itself missing on the WebKit versions this exists for, so a flag, not a reason.
 * Call `clear()` once the request settles (a `finally`), or the timer outlives it.
 */
export function timeoutSignal(ms: number, timers: Timers = REAL_TIMERS): { signal: AbortSignal; timedOut: () => boolean; clear: () => void } {
  const ctl = new AbortController();
  let fired = false;
  const handle = timers.setTimeout(() => {
    fired = true;
    ctl.abort();
  }, ms);
  return { signal: ctl.signal, timedOut: () => fired, clear: () => timers.clearTimeout(handle) };
}

/** The classified transport failures every AI route answers identically; an upstream
 *  non-2xx (a returned Response) keeps each route's historical code and is not ours. */
export function transportFailureJson(e: unknown): { body: { error: "ai_timeout" | "ai_unreachable" }; status: 504 | 502 } | null {
  if (e instanceof UpstreamTimeoutError) return { body: { error: "ai_timeout" }, status: 504 };
  if (e instanceof UpstreamNetworkError) return { body: { error: "ai_unreachable" }, status: 502 };
  return null;
}

async function openAiAuthorizedFetch(url: string, init: Omit<RequestInit, "signal">, opts: { apiKey: string; timeoutMs?: number }): Promise<Response> {
  const ms = opts.timeoutMs ?? AI_CHAT_TIMEOUT_MS;
  const t = timeoutSignal(ms);
  try {
    return await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${opts.apiKey}` },
      signal: t.signal,
    });
  } catch (e) {
    throw t.timedOut() ? new UpstreamTimeoutError(ms) : new UpstreamNetworkError(e);
  } finally {
    t.clear();
  }
}

export async function openAiChatFetch(payload: unknown, opts: { apiKey: string; url?: string; timeoutMs?: number }): Promise<Response> {
  return openAiAuthorizedFetch(
    opts.url ?? OPENAI_CHAT_URL,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    opts,
  );
}

/** Credential/model probe: a free metadata read, never a chat completion. */
export async function openAiModelFetch(model: string, opts: { apiKey: string; baseUrl?: string; timeoutMs?: number }): Promise<Response> {
  const base = (opts.baseUrl ?? OPENAI_MODELS_URL).replace(/\/$/, "");
  return openAiAuthorizedFetch(`${base}/${encodeURIComponent(model)}`, { method: "GET" }, opts);
}
