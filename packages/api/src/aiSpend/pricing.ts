/**
 * Server-owned, versioned AI price registry + cost calculator (backlog §1).
 *
 * Money is integer NANO-USD (1 USD = 1_000_000_000 nanoUsd) in TypeScript `bigint` — never
 * floating-point dollars. At current Luna prices one token is an exact integer number of
 * nano-USD, so there is no rounding drift anywhere in the pipeline.
 *
 * Prices revalidated against the LIVE official pages on 2026-08-12
 * (https://developers.openai.com/api/docs/models/gpt-5.6-luna):
 *   input $0.20/1M = 200 nanoUsd/token; cached input $0.02/1M = 20; output $1.20/1M = 1_200;
 *   cache write = 1.25x uncached input = 250; "Prompts with >272K input tokens are priced at
 *   2x input and 1.5x output for the full request".
 *
 * The long-context rule's interaction with cached/cache-write rates is NOT specified by the
 * official docs (verified 2026-08-12), so the multiplier is applied only to a fully uncached
 * request; a long-context request that carries cached or cache-write tokens is deliberately
 * `unpriced_long_context` — the caller returns the answer, skips the charge and warns (the
 * spec's fallback: never guess a price, never penalize the user).
 *
 * Callers and clients cannot supply a price; routes cannot invent limits. The calculator's
 * outcome carries the applied price version for safe diagnostics only — the monthly counter
 * persists nothing but the integer nano-USD total.
 */

export const NANO_USD_PER_USD = 1_000_000_000n;

export interface LongContextRule {
  /** Applies when usage.prompt_tokens is STRICTLY greater than this. */
  thresholdPromptTokens: number;
  /** Full-request input rate above the threshold (uncached input only — see module comment). */
  inputNanoUsdPerToken: bigint;
  /** Full-request output rate above the threshold. */
  outputNanoUsdPerToken: bigint;
}

export interface ModelPriceEntry {
  /** The exact request `model` this entry prices (the operator's configured model). */
  requestModel: string;
  /** Response `model` values accepted for this entry: exact, or `<alias>-<snapshot suffix>`. */
  responseModelAliases: readonly string[];
  /** Effective price version — diagnostics only, never persisted with the counter. */
  priceVersion: string;
  inputNanoUsdPerToken: bigint;
  cachedInputNanoUsdPerToken: bigint;
  /** Explicit cache write (usage.prompt_tokens_details.cache_write_tokens), standard tier. */
  cacheWriteNanoUsdPerToken: bigint;
  /** Output rate — usage.completion_tokens already INCLUDES billed reasoning tokens. */
  outputNanoUsdPerToken: bigint;
  longContext: LongContextRule | null;
}

export const AI_PRICE_REGISTRY: readonly ModelPriceEntry[] = [
  {
    requestModel: "gpt-5.6-luna",
    responseModelAliases: ["gpt-5.6-luna"],
    priceVersion: "gpt-5.6-luna/2026-08-12",
    inputNanoUsdPerToken: 200n,
    cachedInputNanoUsdPerToken: 20n,
    cacheWriteNanoUsdPerToken: 250n,
    outputNanoUsdPerToken: 1_200n,
    longContext: { thresholdPromptTokens: 272_000, inputNanoUsdPerToken: 400n, outputNanoUsdPerToken: 1_800n },
  },
];

export function priceEntryFor(requestModel: string): ModelPriceEntry | null {
  return AI_PRICE_REGISTRY.find((e) => e.requestModel === requestModel) ?? null;
}

/**
 * Cloud boot guard: when the spend budget is active, a configured operator model MUST have a
 * current price entry — an `OPENAI_MODEL` override cannot silently spend at Luna's prices.
 * Called from index.ts only when `operatorAiSpendLimited(...)` is true; selfhost keeps
 * `OPENAI_MODEL` as a free override.
 */
export function assertOperatorModelPriced(model: string): void {
  if (!priceEntryFor(model)) {
    throw new Error(
      `OPENAI_MODEL="${model}" has no enabled price entry — the cloud per-user AI spend budget cannot account for it. ` +
        `Register the model's prices in aiSpend/pricing.ts or configure a priced model.`,
    );
  }
}

/** Does the response `model` (which may be a dated snapshot) belong to this priced family? */
export function responseModelMatches(entry: ModelPriceEntry, responseModel: string): boolean {
  return entry.responseModelAliases.some((a) => responseModel === a || responseModel.startsWith(`${a}-`));
}

export type CostOutcome =
  | { ok: true; nanoUsd: bigint; priceVersion: string; responseModel: string }
  | { ok: false; reason: "unknown_model" | "invalid_usage" | "unpriced_long_context" };

/** A non-negative safe integer, or null. Absent optional counters read as 0 (`?? 0` per spec). */
const counter = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The exact cost formula from actual response `usage` (never request size):
 *
 *   cached      = usage.prompt_tokens_details.cached_tokens ?? 0
 *   cacheWrite  = usage.prompt_tokens_details.cache_write_tokens ?? 0
 *   uncached    = usage.prompt_tokens - cached - cacheWrite
 *   costNanoUsd = uncached*input + cached*cachedInput + cacheWrite*cacheWrite + completion*output
 *
 * `completion_tokens` already includes billed reasoning tokens —
 * `completion_tokens_details.reasoning_tokens` is deliberately NEVER added on top.
 * Every counter must be a non-negative safe integer and the subdivisions may not exceed
 * `prompt_tokens`; anything else is `invalid_usage` (no charge, answer still returned).
 */
export function chatCostNanoUsd(entry: ModelPriceEntry, responseModel: string, usage: unknown): CostOutcome {
  if (!responseModelMatches(entry, responseModel)) return { ok: false, reason: "unknown_model" };
  if (typeof usage !== "object" || usage === null) return { ok: false, reason: "invalid_usage" };
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: unknown };
  const prompt = counter(u.prompt_tokens);
  const completion = counter(u.completion_tokens);
  if (prompt === null || completion === null) return { ok: false, reason: "invalid_usage" };
  const details = u.prompt_tokens_details;
  if (details !== undefined && (typeof details !== "object" || details === null)) return { ok: false, reason: "invalid_usage" };
  const d = (details ?? {}) as { cached_tokens?: unknown; cache_write_tokens?: unknown };
  const cached = d.cached_tokens === undefined ? 0 : counter(d.cached_tokens);
  const cacheWrite = d.cache_write_tokens === undefined ? 0 : counter(d.cache_write_tokens);
  if (cached === null || cacheWrite === null) return { ok: false, reason: "invalid_usage" };
  if (cached + cacheWrite > prompt) return { ok: false, reason: "invalid_usage" };
  const uncached = prompt - cached - cacheWrite;

  if (entry.longContext && prompt > entry.longContext.thresholdPromptTokens) {
    // The official interaction of the 2x/1.5x rule with cached/cache-write rates is unverified —
    // price only the fully uncached case; otherwise skip the charge (see module comment).
    if (cached > 0 || cacheWrite > 0) return { ok: false, reason: "unpriced_long_context" };
    const nanoUsd = BigInt(prompt) * entry.longContext.inputNanoUsdPerToken + BigInt(completion) * entry.longContext.outputNanoUsdPerToken;
    return { ok: true, nanoUsd, priceVersion: entry.priceVersion, responseModel };
  }

  const nanoUsd =
    BigInt(uncached) * entry.inputNanoUsdPerToken +
    BigInt(cached) * entry.cachedInputNanoUsdPerToken +
    BigInt(cacheWrite) * entry.cacheWriteNanoUsdPerToken +
    BigInt(completion) * entry.outputNanoUsdPerToken;
  return { ok: true, nanoUsd, priceVersion: entry.priceVersion, responseModel };
}
