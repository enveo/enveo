/**
 * AI transport timeout budget — the ONE source of truth for both transports
 * (`packages/api/src/openaiHttp.ts` — operator and vaulted BYOK keys;
 * `packages/web/src/lib/openai.ts` — the /api/ai mirror). Before this module each side kept its own private
 * `120_000`, and the two had already started to drift in meaning (the server's cap
 * claimed to cover "vision, the slow end" while actually cutting it at chat speed).
 *
 * PURE CONSTANTS ONLY: @enveo/shared is zero-I/O, so the AbortController plumbing
 * that consumes these lives in each package (`timeoutSignal` — duplicated by design,
 * a timer factory is not shared domain).
 *
 * The relations are load-bearing, not decorative (aiTransport.test.ts pins them):
 *  - vision > chat — multi-screenshot extraction is legitimately slow; chat/suggest
 *    stays on the historical 120 s cap;
 *  - a client cap on a PROXIED path = the server-side budget it waits on
 *    + AI_PROXY_MARGIN_MS, so the server's own timeout (a classified `ai_timeout`
 *    answer) always beats the client's abort — equal caps race, and the loser is
 *    the user, who then sees a generic failure instead of the honest one.
 */

/** One upstream chat round-trip (budget suggest, import enrichment, operator/BYOK API routes). */
export const AI_CHAT_TIMEOUT_MS = 120_000;

/** One upstream vision round-trip (screenshot extraction, cycle 1) — the slow end. */
export const AI_VISION_TIMEOUT_MS = 300_000;

/** Client-side allowance ON TOP of a proxied server budget (see the module comment). */
export const AI_PROXY_MARGIN_MS = 30_000;

/** Client cap for the /api/ai mirror (server-mode chat): the server's chat cap + margin. */
export const AI_PROXY_CHAT_TIMEOUT_MS = AI_CHAT_TIMEOUT_MS + AI_PROXY_MARGIN_MS;

/** Client cap for POST /import/extract: the route runs one vision cycle plus one
 *  enrichment chat cycle back to back, so the client must outwait BOTH. */
export const AI_IMPORT_EXTRACT_TIMEOUT_MS = AI_VISION_TIMEOUT_MS + AI_CHAT_TIMEOUT_MS + AI_PROXY_MARGIN_MS;
