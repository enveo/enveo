import { readFileSync } from "node:fs";

export interface VaultMasterKeyProvider {
  active(): { id: string; key: Uint8Array };
  byId(id: string): Uint8Array | null;
}

export interface VaultMasterKeyProviderConfig {
  nodeEnv: string;
  filePath?: string;
  devKeyRingJson?: string;
}

type KeyRingDocument = { version: 1; activeKeyId: string; keys: Record<string, string> };

const KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/;

function invalid(): never {
  throw new Error("ai_vault_key_ring_invalid");
}

function strictDocument(source: string): KeyRingDocument {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.length !== 3 || fields[0] !== "activeKeyId" || fields[1] !== "keys" || fields[2] !== "version") return invalid();
  if (record.version !== 1 || typeof record.activeKeyId !== "string" || !KEY_ID.test(record.activeKeyId)) return invalid();
  if (!record.keys || typeof record.keys !== "object" || Array.isArray(record.keys)) return invalid();
  const keys = record.keys as Record<string, unknown>;
  const ids = Object.keys(keys);
  if (ids.length === 0 || !Object.hasOwn(keys, record.activeKeyId)) return invalid();
  for (const id of ids) {
    const encoded = keys[id];
    if (!KEY_ID.test(id) || typeof encoded !== "string" || !BASE64.test(encoded)) return invalid();
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== encoded) return invalid();
  }
  return value as KeyRingDocument;
}

/**
 * Loads the small key ring once at process startup. Production accepts only a file path; the
 * explicitly development-only JSON seam exists for local tests and disposable stacks. Errors
 * are stable codes and never include source text or decoded key material.
 */
export function loadVaultMasterKeyProvider(config: VaultMasterKeyProviderConfig): VaultMasterKeyProvider | null {
  const filePath = config.filePath?.trim();
  const devJson = config.devKeyRingJson?.trim();
  if (config.nodeEnv === "production" && devJson) throw new Error("ai_vault_dev_key_ring_forbidden");
  if (!filePath && !devJson) return null;

  let source: string;
  if (filePath) {
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      throw new Error("ai_vault_key_ring_unreadable");
    }
  } else {
    source = devJson!;
  }

  const document = strictDocument(source);
  const keys = new Map<string, Uint8Array>();
  for (const [id, encoded] of Object.entries(document.keys)) keys.set(id, Uint8Array.from(Buffer.from(encoded, "base64")));
  const activeKey = keys.get(document.activeKeyId);
  if (!activeKey) return invalid();

  return {
    active: () => ({ id: document.activeKeyId, key: activeKey.slice() }),
    byId: (id) => keys.get(id)?.slice() ?? null,
  };
}
