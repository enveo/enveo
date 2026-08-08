/**
 * The one fetch layer for operator-key OpenAI calls (suggest, proxy, import).
 * The contract under test: a hung upstream ABORTS after timeoutMs (a vision call
 * must not pin the incoming HTTP request forever), and a healthy upstream gets
 * the bearer key + JSON body unchanged.
 */
import { describe, expect, it } from "bun:test";
import { openAiChatFetch } from "./openaiHttp";

describe("openAiChatFetch", () => {
  it("aborts a hung upstream after timeoutMs instead of hanging forever", async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      await expect(
        openAiChatFetch({ messages: [] }, { apiKey: "k", url: `http://127.0.0.1:${hang.port}/`, timeoutMs: 60 }),
      ).rejects.toThrow();
    } finally {
      hang.stop(true);
    }
  });

  it("passes the bearer key and the JSON payload through to the upstream", async () => {
    let seenAuth = "";
    let seenBody: unknown;
    const echo = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenAuth = req.headers.get("authorization") ?? "";
        seenBody = await req.json();
        return Response.json({ ok: true });
      },
    });
    try {
      const res = await openAiChatFetch({ model: "m", messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-test", url: `http://127.0.0.1:${echo.port}/`, timeoutMs: 2000 });
      expect(res.ok).toBe(true);
      expect(seenAuth).toBe("Bearer sk-test");
      expect(seenBody).toEqual({ model: "m", messages: [{ role: "user", content: "hi" }] });
    } finally {
      echo.stop(true);
    }
  });
});
