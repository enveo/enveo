import { describe, expect, it } from "bun:test";
import { CredentialBudgetMismatch, CredentialNotConfigured, createCredentialRepository } from "./repository";

describe("AI credential repository surface", () => {
  it("offers scoped operations and no plaintext read method", () => {
    const repository = createCredentialRepository({
      active: () => ({ id: "active", key: new Uint8Array(32) }),
      byId: () => new Uint8Array(32),
    });
    expect(Object.keys(repository).sort()).toEqual(["credentialStatus", "deleteCredential", "replaceServerCredential", "withServerCredential"]);
    expect("getCredential" in repository).toBe(false);
  });

  it("uses stable tenant/configuration error codes without identifiers", () => {
    expect(new CredentialBudgetMismatch().message).toBe("budget_mismatch");
    expect(new CredentialNotConfigured().message).toBe("credential_not_configured");
  });
});
