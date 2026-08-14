import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVaultMasterKeyProvider } from "./keyProvider";

const key = (fill: number): string => Buffer.alloc(32, fill).toString("base64");
const ring = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, activeKeyId: "2026-08", keys: { "2026-08": key(8), "2026-05": key(5) }, ...overrides });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("vault master-key provider", () => {
  it("loads an active key and decrypt-only predecessors from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "enveo-vault-ring-"));
    dirs.push(dir);
    const path = join(dir, "key-ring.json");
    writeFileSync(path, ring(), { mode: 0o600 });

    const provider = loadVaultMasterKeyProvider({ nodeEnv: "production", filePath: path });
    expect(provider?.active().id).toBe("2026-08");
    expect(provider?.active().key).toEqual(new Uint8Array(Buffer.alloc(32, 8)));
    expect(provider?.byId("2026-05")).toEqual(new Uint8Array(Buffer.alloc(32, 5)));
    expect(provider?.byId("absent")).toBeNull();
  });

  it("returns defensive key copies", () => {
    const provider = loadVaultMasterKeyProvider({ nodeEnv: "development", devKeyRingJson: ring() })!;
    provider.active().key.fill(99);
    expect(provider.active().key).toEqual(new Uint8Array(Buffer.alloc(32, 8)));
  });

  it("returns null when no source is configured", () => {
    expect(loadVaultMasterKeyProvider({ nodeEnv: "production" })).toBeNull();
  });

  it.each([
    ["missing active id", { activeKeyId: "absent" }],
    ["invalid active id", { activeKeyId: "../secret" }],
    ["invalid key id", { keys: { "../secret": key(1) } }],
    ["invalid base64", { keys: { "2026-08": "not base64!" } }],
    ["wrong byte length", { keys: { "2026-08": Buffer.alloc(31).toString("base64") } }],
    ["unsupported version", { version: 2 }],
    ["unknown top-level field", { extra: true }],
  ])("rejects %s without echoing protected input", (_label, overrides) => {
    let error: unknown;
    try {
      loadVaultMasterKeyProvider({ nodeEnv: "development", devKeyRingJson: ring(overrides) });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("ai_vault_key_ring_invalid");
    expect(String(error)).not.toContain(key(8));
  });

  it("never echoes malformed source text", () => {
    const marker = "SENTINEL_MUST_NOT_LEAK";
    let error: unknown;
    try {
      loadVaultMasterKeyProvider({ nodeEnv: "development", devKeyRingJson: `{${marker}` });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("ai_vault_key_ring_invalid");
    expect(String(error)).not.toContain(marker);
  });

  it("rejects an unreadable configured file", () => {
    expect(() => loadVaultMasterKeyProvider({ nodeEnv: "production", filePath: "/definitely/absent/enveo-key-ring.json" })).toThrow(
      "ai_vault_key_ring_unreadable",
    );
  });

  it("rejects the development JSON fallback in production", () => {
    expect(() => loadVaultMasterKeyProvider({ nodeEnv: "production", devKeyRingJson: ring() })).toThrow("ai_vault_dev_key_ring_forbidden");
  });
});
