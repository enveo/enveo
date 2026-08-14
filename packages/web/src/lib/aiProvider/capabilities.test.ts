import { describe, expect, it } from "bun:test";
import type { BudgetSuggestProfile } from "@enveo/shared";
import { importExecution, suggestionExecution } from "./capabilities";
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

  it("Stage-3 E2EE/unconfigured model providers expose no model execution", () => {
    const unavailable = status({ provider: "openai", code: "tier-unavailable", configured: false, capabilities: new Set() });
    expect(suggestionExecution(unavailable, "cautious")).toBe("local-rules");
    expect(suggestionExecution(unavailable, "custom")).toBe("unavailable");
    expect(importExecution(unavailable)).toBe("unavailable");
  });
});
