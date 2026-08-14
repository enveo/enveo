import { describe, expect, it } from "bun:test";
import { credentialBudgetInput, credentialSaveInput, credentialTestInput, publicCredentialStatus } from "./aiCredentials";

describe("plain BYOK route contracts", () => {
  it("requires strict budget assertions and bounded credentials", () => {
    const budgetId = crypto.randomUUID();
    expect(credentialBudgetInput.safeParse({ budgetId }).success).toBe(true);
    expect(credentialBudgetInput.safeParse({}).success).toBe(false);
    expect(credentialBudgetInput.safeParse({ budgetId, extra: true }).success).toBe(false);
    expect(credentialSaveInput.safeParse({ budgetId, key: "sk-test" }).success).toBe(true);
    expect(credentialSaveInput.safeParse({ budgetId, key: "" }).success).toBe(false);
    expect(credentialSaveInput.safeParse({ budgetId, key: "x".repeat(4097) }).success).toBe(false);
  });

  it("accepts only registered OpenAI models for a connection test", () => {
    const budgetId = crypto.randomUUID();
    expect(credentialTestInput.safeParse({ budgetId, model: "gpt-5.6-luna" }).success).toBe(true);
    expect(credentialTestInput.safeParse({ budgetId, model: "unregistered-model" }).success).toBe(false);
  });

  it("publishes only configured/available/reason metadata", () => {
    const body = publicCredentialStatus(true, false, "vault_unavailable");
    expect(body).toEqual({ configured: true, available: false, reason: "vault_unavailable" });
    for (const forbidden of ["key", "ciphertext", "nonce", "wrappedRecordDek", "masterKeyId", "fragment"]) {
      expect(JSON.stringify(body).toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
