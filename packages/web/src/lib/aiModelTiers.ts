/**
 * BYOK model tiers (backlog §1b) — the ONE registry both pickers (Settings → AI and the AI
 * consent sheet) render from. Three quality/cost tiers over the GPT-5.6 family; ids, prices
 * and capabilities were verified against the live OpenAI model pages on 2026-08-12 (all three
 * take text+image input, speak Chat Completions, support structured outputs and reasoning).
 *
 * Prices are recorded in USD per 1M tokens EXACTLY as the docs print them — they exist to
 * derive the relative cost hint, never to bill anything (BYOK spend lands on the user's own
 * OpenAI account). The whole family scales uniformly (input, cached input and output all
 * 1×/10×/25× of Luna), which is what makes a single "about {n}× the cost" hint honest;
 * aiModelTiers.test.ts fails if a price change ever breaks that proportion.
 *
 * Legacy ids (`gpt-5.5`, `gpt-5.5-mini`) are deliberately NOT tiers: a persisted legacy choice
 * stays valid and selected (loadSettings merges it over the defaults) and surfaces in the UI
 * as a "previously selected" option — it is never silently rewritten to a tier.
 */
import type { OpenAiModel } from "./contexts";
import { type Message, msg } from "./i18n";

export type TierId = "low" | "medium" | "high";

export interface ModelTier {
  id: TierId;
  model: OpenAiModel;
  /** Localized whole-phrase tier label (message-as-key — rendered via t()). */
  label: Message;
  /** USD per 1M tokens from the live model page — the source of the cost-hint multiplier. */
  pricePer1M: { input: number; cachedInput: number; output: number };
}

/** Cheapest first — the order the pickers render, and index 0 anchors the cost multiplier. */
export const AI_MODEL_TIERS: readonly ModelTier[] = [
  { id: "low", model: "gpt-5.6-luna", label: msg("Economical"), pricePer1M: { input: 0.2, cachedInput: 0.02, output: 1.2 } },
  { id: "medium", model: "gpt-5.6-terra", label: msg("Balanced"), pricePer1M: { input: 2, cachedInput: 0.2, output: 12 } },
  { id: "high", model: "gpt-5.6-sol", label: msg("Best quality"), pricePer1M: { input: 5, cachedInput: 0.5, output: 30 } },
];

/** Persisted pre-§1b choices — valid, selectable, never silently migrated. */
export const LEGACY_OPENAI_MODELS: readonly OpenAiModel[] = ["gpt-5.5", "gpt-5.5-mini"];

export const isLegacyOpenAiModel = (model: string): boolean => (LEGACY_OPENAI_MODELS as readonly string[]).includes(model);

export const tierForModel = (model: string): ModelTier | undefined => AI_MODEL_TIERS.find((t) => t.model === model);

/** Whole-multiple cost factor vs the cheapest tier (1 for the cheapest itself). */
export const costMultiplier = (tier: ModelTier): number => Math.round(tier.pricePer1M.input / AI_MODEL_TIERS[0]!.pricePer1M.input);
