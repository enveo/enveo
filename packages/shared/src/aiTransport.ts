/**
 * AI transport timeout budget — the ONE source of truth for both transports
 * (`packages/api/src/openaiHttp.ts` — operator key; `packages/web/src/lib/openai.ts` —
 * byok and the /api/ai mirror). Before this module each side kept its own private
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

 
export const AI_CHAT_TIMEOUT_MS = 120_000;

 
export const AI_VISION_TIMEOUT_MS = 300_000;

 
export const AI_PROXY_MARGIN_MS = 30_000;

 
export const AI_PROXY_CHAT_TIMEOUT_MS = AI_CHAT_TIMEOUT_MS + AI_PROXY_MARGIN_MS;

/** Client cap for POST /import/extract: the route runs one vision cycle plus one
 *  enrichment chat cycle back to back, so the client must outwait BOTH. */
export const AI_IMPORT_EXTRACT_TIMEOUT_MS = AI_VISION_TIMEOUT_MS + AI_CHAT_TIMEOUT_MS + AI_PROXY_MARGIN_MS;
