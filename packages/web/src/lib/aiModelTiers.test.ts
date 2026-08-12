/**
 * BYOK model tiers (backlog §1b): the raw-model-id picker became three quality/cost tiers over
 * the GPT-5.6 family. The registry here is the ONE source the pickers (Settings → AI and the
 * consent sheet) render from; prices were verified against the live model pages on 2026-08-12.
 * Legacy ids (`gpt-5.5`, `gpt-5.5-mini`) are NOT tiers: they stay valid persisted choices and
 * surface only as a "previously selected" option — never silently rewritten.
 */
import { describe, expect, it } from "bun:test";
import { AI_MODEL_TIERS, costMultiplier, isLegacyOpenAiModel, LEGACY_OPENAI_MODELS, tierForModel } from "./aiModelTiers";
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS } from "./contexts";

describe("AI model tier registry", () => {
  it("exposes exactly three tiers, cheapest first (low → medium → high)", () => {
    expect(AI_MODEL_TIERS.map((t) => t.id)).toEqual(["low", "medium", "high"]);
    expect(AI_MODEL_TIERS.map((t) => t.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
  });

  it("the fresh-settings default is the LOW tier's model (matches §1)", () => {
    expect(AI_MODEL_TIERS[0]!.model).toBe(DEFAULT_OPENAI_MODEL);
  });

  it("tiers + legacy models partition the registered union exactly (no unregistered id anywhere)", () => {
    const tierModels = AI_MODEL_TIERS.map((t) => t.model);
    const all = [...tierModels, ...LEGACY_OPENAI_MODELS].sort();
    expect(all).toEqual([...OPENAI_MODELS].sort());
    // no overlap: a legacy id must never double as a tier
    for (const m of LEGACY_OPENAI_MODELS) expect(tierForModel(m)).toBeUndefined();
  });

  it("prices match the live docs snapshot (2026-08-12, USD per 1M tokens)", () => {
    const [low, medium, high] = AI_MODEL_TIERS;
    expect(low!.pricePer1M).toEqual({ input: 0.2, cachedInput: 0.02, output: 1.2 });
    expect(medium!.pricePer1M).toEqual({ input: 2, cachedInput: 0.2, output: 12 });
    expect(high!.pricePer1M).toEqual({ input: 5, cachedInput: 0.5, output: 30 });
  });

  it("cost multipliers vs the cheapest tier are 1× / 10× / 25×", () => {
    expect(AI_MODEL_TIERS.map((t) => costMultiplier(t))).toEqual([1, 10, 25]);
  });

  it("the multiplier is HONEST: input, cached-input and output rates all scale identically", () => {
    // The UI shows ONE number per tier ("about {n}× the cost"). That is only truthful while
    // every rate scales by the same factor — if a future price change breaks the proportion,
    // this test forces the hint copy to be reconsidered, not silently kept.
    const base = AI_MODEL_TIERS[0]!.pricePer1M;
    for (const tier of AI_MODEL_TIERS) {
      const n = costMultiplier(tier);
      expect(tier.pricePer1M.input / base.input).toBe(n);
      expect(tier.pricePer1M.cachedInput / base.cachedInput).toBe(n);
      expect(tier.pricePer1M.output / base.output).toBe(n);
    }
  });

  it("tierForModel / isLegacyOpenAiModel classify every registered id", () => {
    expect(tierForModel("gpt-5.6-terra")?.id).toBe("medium");
    expect(tierForModel("gpt-5.6-sol")?.id).toBe("high");
    expect(tierForModel("gpt-5.5")).toBeUndefined();
    expect(isLegacyOpenAiModel("gpt-5.5")).toBe(true);
    expect(isLegacyOpenAiModel("gpt-5.5-mini")).toBe(true);
    expect(isLegacyOpenAiModel("gpt-5.6-luna")).toBe(false);
    expect(isLegacyOpenAiModel("gpt-4o")).toBe(false);
  });
});
