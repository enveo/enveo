import { describe, expect, it } from "bun:test";
import type { VaultMasterKeyProvider } from "./keyProvider";
import { openCredential, type SealedCredential, sealCredential, type VaultContext } from "./vaultCrypto";

const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const provider = (activeId: string, entries: Record<string, Uint8Array>): VaultMasterKeyProvider => ({
  active: () => ({ id: activeId, key: entries[activeId]!.slice() }),
  byId: (id) => entries[id]?.slice() ?? null,
});
const originalProvider = provider("master-old", { "master-old": bytes(1) });
const context: VaultContext = { provider: "openai", userId: "user-a", budgetId: "budget-a", recordVersion: 7 };
const secret = "sk-SENTINEL_secret_value";

function mutateFrame(frame: string): string {
  const i = frame.length - 4;
  const replacement = frame[i] === "A" ? "B" : "A";
  return `${frame.slice(0, i)}${replacement}${frame.slice(i + 1)}`;
}

describe("AI credential envelope encryption", () => {
  it("round-trips a credential with no plaintext in either stored frame", () => {
    const sealed = sealCredential(secret, context, originalProvider);
    expect(sealed.framingVersion).toBe(1);
    expect(sealed.recordVersion).toBe(7);
    expect(sealed.masterKeyId).toBe("master-old");
    expect(sealed.ciphertext).toStartWith("v1.");
    expect(sealed.wrappedRecordDek).toStartWith("v1.");
    expect(JSON.stringify(sealed)).not.toContain(secret);
    expect(openCredential(sealed, context, originalProvider)).toEqual({ plaintext: secret });
  });

  it.each([
    ["credential ciphertext", (row: SealedCredential) => ({ ...row, ciphertext: mutateFrame(row.ciphertext) }), context],
    ["wrapped record DEK", (row: SealedCredential) => ({ ...row, wrappedRecordDek: mutateFrame(row.wrappedRecordDek) }), context],
    ["user AAD", (row: SealedCredential) => row, { ...context, userId: "user-b" }],
    ["budget AAD", (row: SealedCredential) => row, { ...context, budgetId: "budget-b" }],
    ["record-version AAD", (row: SealedCredential) => row, { ...context, recordVersion: 8 }],
    ["stored record version", (row: SealedCredential) => ({ ...row, recordVersion: 8 }), context],
    ["master-key id AAD", (row: SealedCredential) => ({ ...row, masterKeyId: "master-other" }), context],
  ] as const)("rejects tampering with %s", (_label, change, expectedContext) => {
    const sealed = sealCredential(secret, context, originalProvider);
    const keys = provider("master-old", { "master-old": bytes(1), "master-other": bytes(1) });
    expect(() => openCredential(change(sealed), expectedContext, keys)).toThrow(/ai_vault_(bad_ciphertext|context_mismatch)/);
  });

  it("strictly rejects malformed, legacy, and oversized framing before decrypting", () => {
    const sealed = sealCredential(secret, context, originalProvider);
    for (const ciphertext of ["v2.abc", "v1.not-base64!", `v1.${"A".repeat(20_000)}`]) {
      expect(() => openCredential({ ...sealed, ciphertext }, context, originalProvider)).toThrow("ai_vault_bad_ciphertext");
    }
  });

  it("decrypts through a previous key and returns only an active-key DEK rewrap", () => {
    const sealed = sealCredential(secret, context, originalProvider);
    const rotated = provider("master-new", { "master-new": bytes(2), "master-old": bytes(1) });
    const opened = openCredential(sealed, context, rotated);
    expect(opened.plaintext).toBe(secret);
    expect(opened.rewrappedDek?.masterKeyId).toBe("master-new");
    expect(opened.rewrappedDek?.wrappedRecordDek).not.toBe(sealed.wrappedRecordDek);

    const rewrapped = { ...sealed, ...opened.rewrappedDek };
    expect(rewrapped.ciphertext).toBe(sealed.ciphertext);
    expect(rewrapped.recordVersion).toBe(sealed.recordVersion);
    expect(openCredential(rewrapped, context, provider("master-new", { "master-new": bytes(2) }))).toEqual({ plaintext: secret });
  });

  it("fails closed when the row names a missing previous master key", () => {
    const sealed = sealCredential(secret, context, originalProvider);
    expect(() => openCredential(sealed, context, provider("master-new", { "master-new": bytes(2) }))).toThrow("ai_vault_key_unavailable");
  });

  it("uses stable errors that never echo secret or protected frames", () => {
    const sealed = sealCredential(secret, context, originalProvider);
    let error: unknown;
    try {
      openCredential({ ...sealed, ciphertext: mutateFrame(sealed.ciphertext) }, context, originalProvider);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe("Error: ai_vault_bad_ciphertext");
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(sealed.ciphertext);
  });
});
