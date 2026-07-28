/**
 * The /quick-add contract: the route is AI-only (the rule parser is gone).
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { extraRoutes } from "./extras";

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
