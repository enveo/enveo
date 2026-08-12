import { describe, expect, it } from "bun:test";
import { parseChatCompletion } from "./chatCompletion";

describe("parseChatCompletion — the one validated operator-response parser", () => {
  const full = {
    id: "chatcmpl-1",
    model: "gpt-5.6-luna-2026-08-01",
    choices: [{ index: 0, message: { role: "assistant", content: '{"items":[]}' }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  };

  it("extracts content, response model and the raw usage subtree", () => {
    const p = parseChatCompletion(full)!;
    expect(p.content).toBe('{"items":[]}');
    expect(p.responseModel).toBe("gpt-5.6-luna-2026-08-01");
    expect(p.usage).toBe(full.usage);
  });

  it("preserves the ORIGINAL body object for the 1:1 proxy (usage included, nothing stripped)", () => {
    const p = parseChatCompletion(full)!;
    expect(p.json).toBe(full);
  });

  it("missing content/model/usage degrade to empty content, null model, undefined usage — never fabricated", () => {
    const p = parseChatCompletion({ choices: [] })!;
    expect(p.content).toBe("");
    expect(p.responseModel).toBeNull();
    expect(p.usage).toBeUndefined();
    expect(parseChatCompletion({ choices: [{ message: {} }], model: 42 })!.responseModel).toBeNull();
    expect(parseChatCompletion({ choices: [{ message: { content: 7 } }] })!.content).toBe("");
  });

  it("a non-object 2xx body is null (the caller answers 'unreadable body', no charge)", () => {
    expect(parseChatCompletion("html")).toBeNull();
    expect(parseChatCompletion(null)).toBeNull();
    expect(parseChatCompletion([1, 2])).toBeNull();
    expect(parseChatCompletion(undefined)).toBeNull();
  });
});
