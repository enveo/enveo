import { describe, expect, it } from "bun:test";
import { deriveSafetyIdentifier, safetyIdentifierFor } from "./safetyIdentifier";

describe("deriveSafetyIdentifier — domain-separated HMAC over the user id", () => {
  it("is deterministic for the same (secret, userId) and hex-shaped", () => {
    const a = deriveSafetyIdentifier("secret-1", "user-1");
    expect(a).toBe(deriveSafetyIdentifier("secret-1", "user-1"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never contains the raw user id and changes with either input", () => {
    const id = "9f0c2b34-user-id";
    const out = deriveSafetyIdentifier("secret-1", id);
    expect(out).not.toContain(id);
    expect(out).not.toBe(deriveSafetyIdentifier("secret-2", id));
    expect(out).not.toBe(deriveSafetyIdentifier("secret-1", "other-user"));
  });

  it("rejects empty inputs instead of deriving a degenerate identifier", () => {
    expect(() => deriveSafetyIdentifier("", "user-1")).toThrow();
    expect(() => deriveSafetyIdentifier("secret", "")).toThrow();
  });
});

describe("safetyIdentifierFor — env-gated derivation (secret passed EXPLICITLY, never read from the machine)", () => {
  it("yields null with no configured secret", () => {
    expect(safetyIdentifierFor("user-1", "")).toBeNull();
  });
  it("yields null without a session user, even with a secret", () => {
    expect(safetyIdentifierFor(undefined, "secret-1")).toBeNull();
  });
  it("derives when both are present, matching the raw HMAC", () => {
    expect(safetyIdentifierFor("user-1", "secret-1")).toBe(deriveSafetyIdentifier("secret-1", "user-1"));
  });
});
