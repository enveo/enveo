import { describe, expect, it } from "bun:test";
import type { BudgetSuggestProfile } from "@enveo/shared";
import { importExecution, importFlow, suggestionExecution } from "./capabilities";
import type { AiStatus } from "./contracts";

const status = (over: Partial<AiStatus> = {}): AiStatus => ({
  provider: "rules",
  code: "ready",
  configured: true,
  capabilities: new Set(["budget-suggestion"]),
  ...over,
});

describe("AI capability decisions", () => {
  for (const profile of ["cautious", "investor"] satisfies BudgetSuggestProfile[]) {
    it(`${profile} stays on local rules under Without AI`, () => {
      expect(suggestionExecution(status(), profile)).toBe("local-rules");
    });
  }

  it("custom prompts never silently fall back to rules", () => {
    expect(suggestionExecution(status(), "custom")).toBe("unavailable");
  });

  it("ready model providers execute suggestions and imports through their provider", () => {
    const model = status({ provider: "openai", capabilities: new Set(["budget-suggestion", "custom-prompt", "screenshot-import"]) });
    expect(suggestionExecution(model, "cautious")).toBe("provider");
    expect(suggestionExecution(model, "custom")).toBe("provider");
    expect(importExecution(model)).toBe("provider");
  });

  it("E2EE rules/Enveo or a locked Own OpenAI provider expose no model execution", () => {
    const unavailable = status({ provider: "openai", code: "tier-unavailable", configured: false, capabilities: new Set() });
    expect(suggestionExecution(unavailable, "cautious")).toBe("local-rules");
    expect(suggestionExecution(unavailable, "custom")).toBe("unavailable");
    expect(importExecution(unavailable)).toBe("unavailable");
  });

  it("unlocked E2EE Own OpenAI exposes direct screenshot import", () => {
    const direct = status({
      provider: "openai",
      code: "ready",
      configured: true,
      capabilities: new Set(["budget-suggestion", "custom-prompt", "screenshot-import"]),
    });
    expect(importExecution(direct)).toBe("provider");
    expect(importFlow(direct, "e2ee")).toBe("local-e2ee");
    expect(importFlow(direct, "plain")).toBe("server");
    expect(importFlow(status(), "e2ee")).toBe("unavailable");
  });
});
