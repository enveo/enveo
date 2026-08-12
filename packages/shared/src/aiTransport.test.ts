/**
 * The AI transport timeout budget — the relations are the contract, not the exact
 * numbers: vision is the slow end and must exceed chat; every client cap on a
 * PROXIED path must exceed the server-side budget it waits on by a real margin,
 * or the two timers race and the client aborts exactly when the server's own
 * classified `ai_timeout` answer is about to arrive.
 */
import { describe, expect, it } from "bun:test";
import {
  AI_CHAT_TIMEOUT_MS,
  AI_IMPORT_EXTRACT_TIMEOUT_MS,
  AI_PROXY_CHAT_TIMEOUT_MS,
  AI_PROXY_MARGIN_MS,
  AI_VISION_TIMEOUT_MS,
} from "./aiTransport";

describe("AI transport timeout constants", () => {
  it("are positive integers (milliseconds)", () => {
    for (const v of [AI_CHAT_TIMEOUT_MS, AI_VISION_TIMEOUT_MS, AI_PROXY_MARGIN_MS, AI_PROXY_CHAT_TIMEOUT_MS, AI_IMPORT_EXTRACT_TIMEOUT_MS]) {
      expect(Number.isSafeInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("chat stays at the historical 120 s cap; vision gets strictly more", () => {
    expect(AI_CHAT_TIMEOUT_MS).toBe(120_000);
    expect(AI_VISION_TIMEOUT_MS).toBeGreaterThan(AI_CHAT_TIMEOUT_MS);
  });

  it("the proxied-chat client cap outwaits the server's chat cap by the margin", () => {
    expect(AI_PROXY_CHAT_TIMEOUT_MS).toBe(AI_CHAT_TIMEOUT_MS + AI_PROXY_MARGIN_MS);
    expect(AI_PROXY_MARGIN_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("the /import/extract client cap outwaits BOTH server cycles (vision + enrichment chat) plus the margin", () => {
    expect(AI_IMPORT_EXTRACT_TIMEOUT_MS).toBeGreaterThanOrEqual(AI_VISION_TIMEOUT_MS + AI_CHAT_TIMEOUT_MS + AI_PROXY_MARGIN_MS);
  });
});
