import { describe, expect, it } from "bun:test";
import {
  AI_PRICE_REGISTRY,
  assertOperatorModelPriced,
  chatCostNanoUsd,
  MAX_CHARGEABLE_NANO_USD,
  type ModelPriceEntry,
  priceEntryFor,
  responseModelMatches,
} from "./pricing";

const luna = priceEntryFor("gpt-5.6-luna")!;

const usage = (prompt: number, completion: number, details?: { cached_tokens?: unknown; cache_write_tokens?: unknown }) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  ...(details ? { prompt_tokens_details: details } : {}),
});

describe("price registry", () => {
  it("prices gpt-5.6-luna at the rates revalidated on 2026-08-12 (200/20/250/1200 nanoUsd per token)", () => {
    expect(luna.inputNanoUsdPerToken).toBe(200n);
    expect(luna.cachedInputNanoUsdPerToken).toBe(20n);
    expect(luna.cacheWriteNanoUsdPerToken).toBe(250n); // 1.25x uncached input
    expect(luna.outputNanoUsdPerToken).toBe(1_200n);
    expect(luna.longContext).toEqual({ thresholdPromptTokens: 272_000, inputNanoUsdPerToken: 400n, outputNanoUsdPerToken: 1_800n });
  });

  it("an unregistered model has no entry and fails the cloud boot assert", () => {
    expect(priceEntryFor("gpt-5.5")).toBeNull();
    expect(() => assertOperatorModelPriced("gpt-5.5")).toThrow(/no enabled price entry/);
    expect(() => assertOperatorModelPriced("gpt-5.6-luna")).not.toThrow();
  });

  it("accepts the exact response model and dated snapshots of a registered alias, nothing else", () => {
    expect(responseModelMatches(luna, "gpt-5.6-luna")).toBe(true);
    expect(responseModelMatches(luna, "gpt-5.6-luna-2026-08-01")).toBe(true);
    expect(responseModelMatches(luna, "gpt-5.6")).toBe(false);
    expect(responseModelMatches(luna, "gpt-5.6-lunatic")).toBe(false);
    expect(responseModelMatches(luna, "gpt-5.5")).toBe(false);
  });

  it("every registry entry uses positive integer nano-USD rates (no floats anywhere)", () => {
    for (const e of AI_PRICE_REGISTRY) {
      for (const rate of [e.inputNanoUsdPerToken, e.cachedInputNanoUsdPerToken, e.cacheWriteNanoUsdPerToken, e.outputNanoUsdPerToken]) {
        expect(typeof rate).toBe("bigint");
        expect(rate > 0n).toBe(true);
      }
    }
  });
});

describe("chatCostNanoUsd — official fixed examples", () => {
  it("uncached input + output: 1000 in, 100 out = 320_000 nanoUsd", () => {
    const r = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(1000, 100));
    expect(r).toEqual({ ok: true, nanoUsd: 1000n * 200n + 100n * 1_200n, priceVersion: luna.priceVersion, responseModel: "gpt-5.6-luna" });
  });

  it("1M tokens cost exactly $0.20 in / $1.20 out at the standard rate (nano-USD, no drift)", () => {
    // longContext disabled for this check: 1M input tokens would otherwise (correctly) hit the 272K rule.
    const flat: ModelPriceEntry = { ...luna, longContext: null };
    const inOnly = chatCostNanoUsd(flat, "gpt-5.6-luna", usage(1_000_000, 0));
    expect(inOnly.ok && inOnly.nanoUsd).toBe(200_000_000n); // $0.20
    const outOnly = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(0, 1_000_000));
    expect(outOnly.ok && outOnly.nanoUsd).toBe(1_200_000_000n); // $1.20 (output alone does not trigger the rule)
  });

  it("cached tokens are billed at the cached rate, cache writes at 1.25x input", () => {
    const r = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(1000, 0, { cached_tokens: 600, cache_write_tokens: 100 }));
    // uncached 300*200 + cached 600*20 + cacheWrite 100*250 = 60_000 + 12_000 + 25_000
    expect(r.ok && r.nanoUsd).toBe(97_000n);
  });

  it("reasoning tokens are NOT double-counted: completion_tokens already includes them", () => {
    const withReasoning = {
      ...usage(100, 500),
      completion_tokens_details: { reasoning_tokens: 400, audio_tokens: 0 },
    };
    const r = chatCostNanoUsd(luna, "gpt-5.6-luna", withReasoning);
    expect(r.ok && r.nanoUsd).toBe(100n * 200n + 500n * 1_200n); // 500 output tokens, not 900
  });

  it("zero usage is a valid zero charge", () => {
    const r = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(0, 0));
    expect(r.ok && r.nanoUsd).toBe(0n);
  });
});

describe("chatCostNanoUsd — the 272K long-context rule", () => {
  it("at the threshold exactly, standard prices apply (the rule is strictly greater-than)", () => {
    const r = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(272_000, 10));
    expect(r.ok && r.nanoUsd).toBe(272_000n * 200n + 10n * 1_200n);
  });

  it("above the threshold with no cache tokens: 2x input and 1.5x output for the FULL request", () => {
    const r = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(272_001, 10));
    expect(r.ok && r.nanoUsd).toBe(272_001n * 400n + 10n * 1_800n);
  });

  it("above the threshold WITH cached or cache-write tokens: unpriced (docs do not define the interaction) — no charge", () => {
    expect(chatCostNanoUsd(luna, "gpt-5.6-luna", usage(300_000, 10, { cached_tokens: 5 })).ok).toBe(false);
    expect(chatCostNanoUsd(luna, "gpt-5.6-luna", usage(300_000, 10, { cached_tokens: 5 }))).toEqual({ ok: false, reason: "unpriced_long_context" });
    expect(chatCostNanoUsd(luna, "gpt-5.6-luna", usage(300_000, 10, { cache_write_tokens: 1 }))).toEqual({ ok: false, reason: "unpriced_long_context" });
  });
});

describe("chatCostNanoUsd — invalid usage and unknown models (no charge, never an error for the user)", () => {
  it("unknown response model", () => {
    expect(chatCostNanoUsd(luna, "gpt-6", usage(10, 10))).toEqual({ ok: false, reason: "unknown_model" });
    expect(chatCostNanoUsd(luna, "", usage(10, 10))).toEqual({ ok: false, reason: "unknown_model" });
  });

  it("missing or non-object usage", () => {
    expect(chatCostNanoUsd(luna, "gpt-5.6-luna", undefined)).toEqual({ ok: false, reason: "invalid_usage" });
    expect(chatCostNanoUsd(luna, "gpt-5.6-luna", null)).toEqual({ ok: false, reason: "invalid_usage" });
    expect(chatCostNanoUsd(luna, "gpt-5.6-luna", "usage")).toEqual({ ok: false, reason: "invalid_usage" });
  });

  it("negative, fractional, unsafe or non-numeric counters", () => {
    for (const bad of [
      usage(-1, 0),
      usage(0, -1),
      usage(1.5, 0),
      usage(0, 2.5),
      usage(Number.MAX_SAFE_INTEGER + 2, 0),
      { prompt_tokens: "10", completion_tokens: 0 },
      { prompt_tokens: 10 }, // completion_tokens missing
      usage(10, 0, { cached_tokens: -1 }),
      usage(10, 0, { cache_write_tokens: 1.2 }),
      usage(10, 0, { cached_tokens: "3" }),
      { prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: "x" },
    ]) {
      expect(chatCostNanoUsd(luna, "gpt-5.6-luna", bad)).toEqual({ ok: false, reason: "invalid_usage" });
    }
  });

  it("subdivisions exceeding prompt_tokens are rejected (would produce a negative uncached count)", () => {
    expect(chatCostNanoUsd(luna, "gpt-5.6-luna", usage(100, 0, { cached_tokens: 60, cache_write_tokens: 41 }))).toEqual({ ok: false, reason: "invalid_usage" });
    // exactly equal is fine — zero uncached tokens
    const r = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(100, 0, { cached_tokens: 60, cache_write_tokens: 40 }));
    expect(r.ok && r.nanoUsd).toBe(60n * 20n + 40n * 250n);
  });
});

describe("chatCostNanoUsd — arithmetic properties (seeded randomized boundary sweep)", () => {
  // Deterministic LCG so a failure reproduces; covers exactness and non-negativity across the
  // whole safe-integer input domain without a float ever entering the arithmetic.
  let seed = 0xdecaf;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const randInt = (max: number) => Math.floor(rnd() * max);

  it("cost equals the formula and is never negative over 500 random usages", () => {
    for (let i = 0; i < 500; i++) {
      const prompt = randInt(400_000);
      const completion = randInt(200_000);
      const cached = randInt(prompt + 1);
      const cacheWrite = randInt(prompt - cached + 1);
      const r = chatCostNanoUsd(luna, "gpt-5.6-luna", usage(prompt, completion, { cached_tokens: cached, cache_write_tokens: cacheWrite }));
      if (prompt > 272_000 && (cached > 0 || cacheWrite > 0)) {
        expect(r).toEqual({ ok: false, reason: "unpriced_long_context" });
        continue;
      }
      const expected =
        prompt > 272_000
          ? BigInt(prompt) * 400n + BigInt(completion) * 1_800n
          : BigInt(prompt - cached - cacheWrite) * 200n + BigInt(cached) * 20n + BigInt(cacheWrite) * 250n + BigInt(completion) * 1_200n;
      expect(r.ok && r.nanoUsd).toBe(expected);
      expect(r.ok && r.nanoUsd >= 0n).toBe(true);
    }
  });

  it("an absurd cost is capped by the checked-arithmetic ceiling — a pricing failure, never a bigint INSERT error", () => {
    // MAX_SAFE_INTEGER token counts price to ~1.26e19 nanoUsd — beyond Postgres int8 (~9.22e18).
    // The ceiling turns that into the skip-charge-and-warn path long before any SQL runs.
    const big = Number.MAX_SAFE_INTEGER;
    const entry: ModelPriceEntry = { ...luna, longContext: null };
    expect(chatCostNanoUsd(entry, "gpt-5.6-luna", usage(big, big))).toEqual({ ok: false, reason: "cost_out_of_range" });
    // exactly AT the ceiling still charges; one nano-USD above does not
    const atCeiling = MAX_CHARGEABLE_NANO_USD / 200n; // tokens whose input cost is exactly the ceiling
    const rAt = chatCostNanoUsd(entry, "gpt-5.6-luna", usage(Number(atCeiling), 0));
    expect(rAt.ok && rAt.nanoUsd).toBe(MAX_CHARGEABLE_NANO_USD);
    const above = chatCostNanoUsd(entry, "gpt-5.6-luna", { ...usage(Number(atCeiling), 0), completion_tokens: 1 });
    expect(above).toEqual({ ok: false, reason: "cost_out_of_range" });
  });
});
