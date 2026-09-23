/** BYOK rates in USD per million tokens. Luna: official model page, 2026-09-23;
 * other tiers: 2026-08-12. Used only for relative price hints, never billing. */
import type { OpenAiModel } from "./contexts";
import { type Message, msg } from "./i18n";

export type TierId = "low" | "medium" | "high";

export interface ModelTier {
  id: TierId;
  model: OpenAiModel;

  label: Message;

  pricePer1M: { input: number; cachedInput: number; output: number };
}

export const AI_MODEL_TIERS: readonly ModelTier[] = [
  { id: "low", model: "gpt-6-luna", label: msg("Economical"), pricePer1M: { input: 0.1, cachedInput: 0.01, output: 0.5 } },
  { id: "medium", model: "gpt-5.6-terra", label: msg("Balanced"), pricePer1M: { input: 2, cachedInput: 0.2, output: 12 } },
  { id: "high", model: "gpt-5.6-sol", label: msg("Best quality"), pricePer1M: { input: 5, cachedInput: 0.5, output: 30 } },
];

/** Persisted pre-§1b choices — valid, selectable, never silently migrated. */
export const LEGACY_OPENAI_MODELS: readonly OpenAiModel[] = ["gpt-5.6-luna", "gpt-5.5", "gpt-5.5-mini"];

export const isLegacyOpenAiModel = (model: string): boolean => (LEGACY_OPENAI_MODELS as readonly string[]).includes(model);

export const tierForModel = (model: string): ModelTier | undefined => AI_MODEL_TIERS.find((t) => t.model === model);

/** Costs vary with the input/output mix; a single multiplier can understate the output cost. */
export const costMultiplier = (tier: ModelTier): string => {
  const base = AI_MODEL_TIERS[0]!.pricePer1M;
  const ratios = (Object.keys(base) as Array<keyof typeof base>).map((key) => tier.pricePer1M[key] / base[key]);
  const min = Math.floor(Math.min(...ratios));
  const max = Math.ceil(Math.max(...ratios));
  return min === max ? String(min) : `${min}–${max}`;
};
