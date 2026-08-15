import { afterEach, describe, expect, it } from "bun:test";
import type { ChatRequest } from "@enveo/shared";
import { byokChat, byokTransportDeps } from "./transport";

const originalFetch = byokTransportDeps.fetchChat;
afterEach(() => {
  byokTransportDeps.fetchChat = originalFetch;
});

describe("user-funded BYOK transport", () => {
  it("uses only the supplied vault credential/model and returns the original response", async () => {
    let seenKey = "";
    let seenPayload: unknown;
    byokTransportDeps.fetchChat = async (payload, options) => {
      seenKey = options.apiKey;
      seenPayload = payload;
      return Response.json({ model: "gpt-5.6-luna", choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: 3 } });
    };
    const request: ChatRequest = { messages: [{ role: "user", content: "hello" }], reasoningEffort: "low" };
    const outcome = await byokChat({ apiKey: "sk-user-funded", model: "gpt-5.6-luna", request });
    expect(seenKey).toBe("sk-user-funded");
    expect(seenPayload).toEqual({ model: "gpt-5.6-luna", messages: request.messages, reasoning_effort: "low" });
    expect(outcome).toEqual({
      kind: "ok",
      content: "answer",
      json: { model: "gpt-5.6-luna", choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: 3 } },
    });
  });

  it("classifies upstream rejection and unreadable success without logging bodies", async () => {
    byokTransportDeps.fetchChat = async () => new Response("SENSITIVE_UPSTREAM_BODY", { status: 401 });
    expect(await byokChat({ apiKey: "sk-x", model: "gpt-5.6-luna", request: { messages: [{ role: "user", content: "x" }] } })).toEqual({
      kind: "upstream_error",
      status: 401,
    });
    byokTransportDeps.fetchChat = async () => new Response("not json", { status: 200 });
    expect(await byokChat({ apiKey: "sk-x", model: "gpt-5.6-luna", request: { messages: [{ role: "user", content: "x" }] } })).toEqual({
      kind: "invalid_body",
    });
  });

  it("omits reasoning_effort for a model that does not support it", async () => {
    let payload: Record<string, unknown> | undefined;
    byokTransportDeps.fetchChat = async (body) => {
      payload = body as Record<string, unknown>;
      return Response.json({ choices: [] });
    };
    await byokChat({ apiKey: "sk-x", model: "gpt-4o", request: { messages: [{ role: "user", content: "x" }], reasoningEffort: "high" } });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
