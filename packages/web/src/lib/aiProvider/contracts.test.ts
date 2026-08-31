import { describe, expect, it } from "bun:test";
import type { AiProvider } from "./contracts";
import { capabilitiesForProvider, UnsupportedCapabilityError } from "./contracts";

describe("AI provider contracts", () => {
  it("publishes stable capability sets for deterministic and model providers", () => {
    expect([...capabilitiesForProvider("rules")]).toEqual(["budget-suggestion"]);
    expect([...capabilitiesForProvider("enveo")]).toEqual(["budget-suggestion", "custom-prompt", "screenshot-import"]);
    expect([...capabilitiesForProvider("openai")]).toEqual(["budget-suggestion", "custom-prompt", "screenshot-import"]);
  });

  it("uses a machine-readable error when a capability is unsupported", () => {
    const error = new UnsupportedCapabilityError("screenshot-import");
    expect(error.message).toBe("ai_capability_unsupported");
    expect(error.code).toBe("ai_capability_unsupported");
    expect(error.capability).toBe("screenshot-import");
    expect(String(error)).not.toContain("OpenAI key");
  });

  it("requires behavior without exposing a credential getter", () => {
    const provider = {
      status: async () => ({
        provider: "rules" as const,
        code: "ready" as const,
        capabilities: capabilitiesForProvider("rules"),
        configured: true,
      }),
      saveCredential: async (_key: string) => undefined,
      removeCredential: async () => undefined,
      testConnection: async () => undefined,
      complete: async () => "{}",
      extractImport: async () => ({ rows: [], proposals: [] }),
    } satisfies AiProvider;

    expect("getCredential" in provider).toBe(false);
  });
});
