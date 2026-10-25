import { describe, expect, it } from "bun:test";
import { importExecution, importFlow } from "./capabilities";
import type { AiStatus } from "./contracts";

const status = (over: Partial<AiStatus> = {}): AiStatus => ({
  provider: "rules",
  code: "ready",
  configured: true,
  capabilities: new Set(),
  ...over,
});

describe("AI capability decisions", () => {
  it("Without AI there is no model execution", () => {
    expect(importExecution(status())).toBe("unavailable");
  });

  it("ready model providers execute imports through their provider", () => {
    const model = status({ provider: "openai", capabilities: new Set(["custom-prompt", "screenshot-import"]) });
    expect(importExecution(model)).toBe("provider");
  });

  it("E2EE rules/Enveo or a locked Own OpenAI provider expose no model execution", () => {
    const unavailable = status({ provider: "openai", code: "tier-unavailable", configured: false, capabilities: new Set() });
    expect(importExecution(unavailable)).toBe("unavailable");
  });

  it("unlocked E2EE Own OpenAI exposes direct screenshot import", () => {
    const direct = status({
      provider: "openai",
      code: "ready",
      configured: true,
      capabilities: new Set(["custom-prompt", "screenshot-import"]),
    });
    expect(importExecution(direct)).toBe("provider");
    expect(importFlow(direct, "e2ee")).toBe("local-e2ee");
    expect(importFlow(direct, "plain")).toBe("server");
    expect(importFlow(status(), "e2ee")).toBe("unavailable");
  });
});
