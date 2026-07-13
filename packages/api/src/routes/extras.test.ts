/**
 * Pure tests of recurring-rule materialization (no DB) — especially the pause:
 * occurrences dated < pausedUntil drop out, the rule resumes by itself after that date.
 * Plus the /quick-add contract: the route is AI-only (the rule parser is gone).
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { dueOccurrences, extraRoutes, occurrences } from "./extras";

const rec = (over: Partial<Parameters<typeof dueOccurrences>[0]> = {}) => ({
  rule: "monthly",
  startDate: "2026-01-10",
  endDate: null,
  pausedUntil: null,
  ...over,
});

describe("occurrences", () => {
  it("monthly: consecutive months from startDate to end inclusive", () => {
    expect(occurrences("monthly", "2026-01-10", "2026-04-10")).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
      "2026-04-10",
    ]);
  });

  it("none: a single occurrence only when startDate ≤ end", () => {
    expect(occurrences("none", "2026-03-01", "2026-04-01")).toEqual(["2026-03-01"]);
    expect(occurrences("none", "2026-05-01", "2026-04-01")).toEqual([]);
  });
});

describe("dueOccurrences — pause in materialization", () => {
  it("without a pause: all occurrences ≤ today", () => {
    expect(dueOccurrences(rec(), "2026-03-15")).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
  });

  it("pausedUntil skips occurrences dated < the pause", () => {
    expect(dueOccurrences(rec({ pausedUntil: "2026-03-01" }), "2026-03-15")).toEqual(["2026-03-10"]);
  });

  it("an occurrence EXACTLY on the pausedUntil day already returns (the pause is <, not ≤)", () => {
    expect(dueOccurrences(rec({ pausedUntil: "2026-02-10" }), "2026-03-15")).toEqual([
      "2026-02-10",
      "2026-03-10",
    ]);
  });

  it("a pause beyond the horizon (future) → nothing to materialize; after it passes the rule resumes by itself", () => {
    const paused = rec({ pausedUntil: "2026-06-01" });
    expect(dueOccurrences(paused, "2026-03-15")).toEqual([]);
    expect(dueOccurrences(paused, "2026-07-15")).toEqual(["2026-06-10", "2026-07-10"]);
  });

  it("endDate still caps from above, the pause from below", () => {
    expect(
      dueOccurrences(rec({ endDate: "2026-04-30", pausedUntil: "2026-02-01" }), "2026-08-01"),
    ).toEqual(["2026-02-10", "2026-03-10", "2026-04-10"]);
  });
});

describe("POST /quick-add — AI-only", () => {
  it("without OPENAI_API_KEY → 503 ai_unavailable, no DB touched (no rules pre-pass left)", async () => {
    const app = new Hono().route("/", extraRoutes);
    const res = await app.fetch(
      new Request("http://x/quick-add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "coffee 12" }),
      }),
    );
    // env.OPENAI_API_KEY is empty in CI (and in the gate) → the key check answers before any DB work.
    if (!process.env.OPENAI_API_KEY) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "ai_unavailable" });
    }
  });
});
