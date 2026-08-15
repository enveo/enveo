import { describe, expect, it } from "bun:test";
import {
  byokChatInput,
  byokImportInput,
  credentialBudgetInput,
  credentialSaveInput,
  credentialTestInput,
  e2eeCredentialDeleteInput,
  e2eeCredentialSaveInput,
  publicCredentialStatus,
} from "./aiCredentials";

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

  it("bounds provider workloads and requires the budget/model on every request", () => {
    const budgetId = crypto.randomUUID();
    expect(byokChatInput.safeParse({ budgetId, model: "gpt-5.6-luna", messages: [{ role: "user", content: "hello" }], reasoningEffort: "low" }).success).toBe(
      true,
    );
    expect(byokChatInput.safeParse({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hello" }] }).success).toBe(false);
    expect(byokChatInput.safeParse({ budgetId, model: "gpt-5.6-luna", messages: [] }).success).toBe(false);
    expect(byokImportInput.safeParse({ budgetId, model: "gpt-5.6-luna", images: ["data:image/png;base64,AA=="], locale: "pl" }).success).toBe(true);
    expect(byokImportInput.safeParse({ budgetId, model: "gpt-5.6-luna", images: ["https://foreign/image.png"], locale: "pl" }).success).toBe(false);
  });
});

describe("zero-knowledge E2EE credential route contracts", () => {
  const budgetId = crypto.randomUUID();

  it("requires a budget assertion, exact non-negative epoch and bounded v2 ciphertext", () => {
    expect(e2eeCredentialSaveInput.safeParse({ budgetId, expectedEpoch: 2, ciphertext: "v2.AAAA" }).success).toBe(true);
    expect(e2eeCredentialSaveInput.safeParse({ budgetId, expectedEpoch: -1, ciphertext: "v2.AAAA" }).success).toBe(false);
    expect(e2eeCredentialSaveInput.safeParse({ budgetId, expectedEpoch: 2, ciphertext: "v1.AAAA" }).success).toBe(false);
    expect(e2eeCredentialSaveInput.safeParse({ budgetId, expectedEpoch: 2, ciphertext: "v2." }).success).toBe(false);
    expect(e2eeCredentialSaveInput.safeParse({ budgetId, expectedEpoch: 2, ciphertext: `v2.${"A".repeat(8190)}` }).success).toBe(false);
    expect(e2eeCredentialSaveInput.safeParse({ budgetId, expectedEpoch: 2, ciphertext: "v2.AAAA", extra: true }).success).toBe(false);
    expect(e2eeCredentialDeleteInput.safeParse({ budgetId, expectedEpoch: 2 }).success).toBe(true);
    expect(e2eeCredentialDeleteInput.safeParse({ budgetId }).success).toBe(false);
  });
});
