import { describe, expect, it } from "bun:test";
import { AI_MODEL_TIERS, costMultiplier, isLegacyOpenAiModel, LEGACY_OPENAI_MODELS, tierForModel } from "./aiModelTiers";
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS } from "./contexts";

describe("AI model tier registry", () => {
  it("exposes exactly three tiers, cheapest first (low → medium → high)", () => {
    expect(AI_MODEL_TIERS.map((t) => t.id)).toEqual(["low", "medium", "high"]);
    expect(AI_MODEL_TIERS.map((t) => t.model)).toEqual(["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
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

  it("prices match the live docs snapshot (Luna 2026-09-23; other tiers 2026-08-12, USD per 1M tokens)", () => {
    const [low, medium, high] = AI_MODEL_TIERS;
    expect(low!.pricePer1M).toEqual({ input: 0.1, cachedInput: 0.01, output: 0.5 });
    expect(medium!.pricePer1M).toEqual({ input: 2, cachedInput: 0.2, output: 12 });
    expect(high!.pricePer1M).toEqual({ input: 5, cachedInput: 0.5, output: 30 });
  });

  it("cost hints cover both input and output rates relative to the economical model", () => {
    expect(AI_MODEL_TIERS.map(costMultiplier)).toEqual(["1", "20–24", "50–60"]);
  });

  it("tierForModel / isLegacyOpenAiModel classify every registered id", () => {
    expect(tierForModel("gpt-5.6-terra")?.id).toBe("medium");
    expect(tierForModel("gpt-5.6-sol")?.id).toBe("high");
    expect(tierForModel("gpt-5.5")).toBeUndefined();
    expect(isLegacyOpenAiModel("gpt-5.5")).toBe(true);
    expect(isLegacyOpenAiModel("gpt-5.5-mini")).toBe(true);
    expect(isLegacyOpenAiModel("gpt-5.6-luna")).toBe(true);
    expect(isLegacyOpenAiModel("gpt-4o")).toBe(false);
  });
});
