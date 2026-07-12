/**
 * E2EE — client-side cryptography. The server sees only:
 * wrapped_dek + kdf_params + ciphertexts. The envelope: a DEK (AES-256-GCM, WebCrypto)
 * wrapped with a KEK from Argon2id(passphrase, salt). Ciphertext format: "v1." + b64(nonce ∥ ct).
 */
import { argon2id } from "hash-wasm";

export interface KdfParams { algo: "argon2id"; m: number; t: number; p: number; saltB64: string }
export const DEFAULT_KDF_PARAMS: Omit<KdfParams, "saltB64"> = { algo: "argon2id", m: 65536, t: 3, p: 1 };

const b64 = (u: Uint8Array): string =>
  typeof btoa === "function" ? btoa(String.fromCharCode(...u)) : Buffer.from(u).toString("base64");
const unb64 = (s: string): Uint8Array =>
  typeof atob === "function" ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(s, "base64"));

export const generateSalt = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16));
export const generateDek = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export async function deriveKek(passphrase: string, salt: Uint8Array, p: Omit<KdfParams, "saltB64">): Promise<Uint8Array> {
  return argon2id({ password: passphrase, salt, parallelism: p.p, iterations: p.t, memorySize: p.m, hashLength: 32, outputType: "binary" });
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function aesEncrypt(plain: Uint8Array, keyRaw: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyRaw);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, plain as BufferSource));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce); out.set(ct, nonce.length);
  return "v1." + b64(out);
}

async function aesDecrypt(payload: string, keyRaw: Uint8Array): Promise<Uint8Array> {
  if (!payload.startsWith("v1.")) throw new Error("unknown ciphertext format");
  const raw = unb64(payload.slice(3));
  const nonce = raw.slice(0, 12);
  const ct = raw.slice(12);
  const key = await aesKey(keyRaw);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, ct as BufferSource));
}

export const wrapDek = (dek: Uint8Array, kek: Uint8Array) => aesEncrypt(dek, kek);
export const unwrapDek = async (wrapped: string, kek: Uint8Array) => aesDecrypt(wrapped, kek);

const enc = new TextEncoder();
const dec = new TextDecoder();
export const encryptPayload = (plaintext: string, dek: Uint8Array) => aesEncrypt(enc.encode(plaintext), dek);
export const decryptPayload = async (ciphertext: string, dek: Uint8Array) => dec.decode(await aesDecrypt(ciphertext, dek));

/** Pairing code (QR/paste): "enveo1." + b64(JSON{b,d}) — never touches the server. */
export function encodePairing(dek: Uint8Array, budgetId: string): string {
  return "enveo1." + b64(enc.encode(JSON.stringify({ b: budgetId, d: b64(dek) })));
}
export function decodePairing(code: string): { dek: Uint8Array; budgetId: string } {
  if (!code.startsWith("enveo1.")) throw new Error("invalid pairing code");
  const j = JSON.parse(dec.decode(unb64(code.slice(7)))) as { b: string; d: string };
  if (!j.b || !j.d) throw new Error("invalid pairing code");
  return { budgetId: j.b, dek: unb64(j.d) };
}
