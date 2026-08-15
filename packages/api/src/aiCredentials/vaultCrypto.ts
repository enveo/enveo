import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { VaultMasterKeyProvider } from "./keyProvider";

export interface VaultContext {
  provider: "openai";
  userId: string;
  budgetId: string;
  recordVersion: number;
}

export interface SealedCredential {
  framingVersion: 1;
  ciphertext: string;
  wrappedRecordDek: string;
  masterKeyId: string;
  recordVersion: number;
}

export interface OpenedCredential {
  plaintext: string;
  rewrappedDek?: Pick<SealedCredential, "wrappedRecordDek" | "masterKeyId">;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_FRAME_CHARS = 8192;
const FRAME = /^v1\.([A-Za-z0-9+/]+={0,2})$/;

function contextOk(context: VaultContext): boolean {
  return (
    context.provider === "openai" &&
    context.userId.length > 0 &&
    context.userId.length <= 256 &&
    context.budgetId.length > 0 &&
    context.budgetId.length <= 256 &&
    Number.isSafeInteger(context.recordVersion) &&
    context.recordVersion > 0
  );
}

function credentialAad(context: VaultContext): Buffer {
  return Buffer.from(JSON.stringify(["enveo-ai-vault", 1, "credential", context.provider, context.userId, context.budgetId, context.recordVersion]), "utf8");
}

function recordDekAad(context: VaultContext, masterKeyId: string): Buffer {
  return Buffer.from(
    JSON.stringify(["enveo-ai-vault", 1, "record-dek", context.provider, context.userId, context.budgetId, context.recordVersion, masterKeyId]),
    "utf8",
  );
}

function assertKey(key: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new Error("ai_vault_key_unavailable");
  return Buffer.from(key);
}

function encryptFrame(plaintext: Uint8Array, keyBytes: Uint8Array, aad: Uint8Array): string {
  const key = assertKey(keyBytes);
  const nonce = randomBytes(NONCE_BYTES);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `v1.${Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64")}`;
  } finally {
    key.fill(0);
    nonce.fill(0);
  }
}

function decodeFrame(frame: string): Buffer {
  if (frame.length > MAX_FRAME_CHARS) throw new Error("ai_vault_bad_ciphertext");
  const match = FRAME.exec(frame);
  if (!match) throw new Error("ai_vault_bad_ciphertext");
  const body = Buffer.from(match[1]!, "base64");
  if (body.toString("base64") !== match[1] || body.byteLength < NONCE_BYTES + TAG_BYTES) {
    body.fill(0);
    throw new Error("ai_vault_bad_ciphertext");
  }
  return body;
}

function decryptFrame(frame: string, keyBytes: Uint8Array, aad: Uint8Array): Buffer {
  const key = assertKey(keyBytes);
  const body = decodeFrame(frame);
  const nonce = body.subarray(0, NONCE_BYTES);
  const tag = body.subarray(body.byteLength - TAG_BYTES);
  const ciphertext = body.subarray(NONCE_BYTES, body.byteLength - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("ai_vault_bad_ciphertext");
  } finally {
    key.fill(0);
    body.fill(0);
  }
}

export function sealCredential(credential: string, context: VaultContext, provider: VaultMasterKeyProvider): SealedCredential {
  if (!contextOk(context)) throw new Error("ai_vault_context_mismatch");
  const plaintext = Buffer.from(credential, "utf8");
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    plaintext.fill(0);
    throw new Error("ai_vault_input_invalid");
  }
  const recordDek = randomBytes(KEY_BYTES);
  const active = provider.active();
  try {
    return {
      framingVersion: 1,
      ciphertext: encryptFrame(plaintext, recordDek, credentialAad(context)),
      wrappedRecordDek: encryptFrame(recordDek, active.key, recordDekAad(context, active.id)),
      masterKeyId: active.id,
      recordVersion: context.recordVersion,
    };
  } finally {
    plaintext.fill(0);
    recordDek.fill(0);
    active.key.fill(0);
  }
}

export function openCredential(row: SealedCredential, context: VaultContext, provider: VaultMasterKeyProvider): OpenedCredential {
  if (!contextOk(context) || row.framingVersion !== 1 || row.recordVersion !== context.recordVersion || !row.masterKeyId) {
    throw new Error("ai_vault_context_mismatch");
  }
  const wrappingKey = provider.byId(row.masterKeyId);
  if (!wrappingKey) throw new Error("ai_vault_key_unavailable");

  let recordDek: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    recordDek = decryptFrame(row.wrappedRecordDek, wrappingKey, recordDekAad(context, row.masterKeyId));
    if (recordDek.byteLength !== KEY_BYTES) throw new Error("ai_vault_bad_ciphertext");
    plaintext = decryptFrame(row.ciphertext, recordDek, credentialAad(context));
    if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("ai_vault_bad_ciphertext");

    const result: OpenedCredential = { plaintext: plaintext.toString("utf8") };
    const active = provider.active();
    try {
      if (active.id !== row.masterKeyId) {
        result.rewrappedDek = {
          wrappedRecordDek: encryptFrame(recordDek, active.key, recordDekAad(context, active.id)),
          masterKeyId: active.id,
        };
      }
    } finally {
      active.key.fill(0);
    }
    return result;
  } finally {
    wrappingKey.fill(0);
    recordDek?.fill(0);
    plaintext?.fill(0);
  }
}
