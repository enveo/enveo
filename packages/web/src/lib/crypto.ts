/**
 * E2EE — client-side cryptography. The server sees only:
 * wrapped_dek + kdf_params + ciphertexts. The envelope: a DEK (AES-256-GCM, WebCrypto)
 * wrapped with a KEK from Argon2id(passphrase, salt).
 *
 * Ciphertext format v2: "v2." + b64(nonce ∥ ct ∥ GCM tag), with MANDATORY AES-GCM
 * `additionalData` — the UTF-8 bytes of the exact JSON.stringify of one fixed-position
 * tuple (E2eeAadContext below). The AAD binds each ciphertext to its authenticated
 * context (operation identity / checkpoint position / key-envelope generation), so a
 * malicious or compromised storage server cannot pair a valid ciphertext with another
 * op's clear opId, another budget/epoch, or a false checkpoint uptoSeq — decryption
 * fails instead of silently applying the wrong data.
 *
 * WHAT THE AAD DOES NOT CLAIM: PostgreSQL allocates the journal `seq` AFTER the client
 * has encrypted and pushed an op, so `seq` is deliberately absent from the op tuple.
 * This design authenticates each ciphertext's context; it does NOT cryptographically
 * authenticate the global journal ORDER the server chose.
 *
 * Fail-closed rules (part of the wire format):
 *  - "v1." (the pre-AAD format) is rejected with the stable code `legacy_ciphertext` —
 *    there is NO legacy read fallback; a v1 budget crosses the explicit upgrade ceremony
 *    (real DEK rotation) instead.
 *  - malformed/unknown/truncated input → `bad_ciphertext`;
 *  - an AES-GCM authentication failure (tamper, wrong key, wrong AAD) propagates as the
 *    WebCrypto OperationError the caller-specific UI already handles.
 *  - The tuple builder and encoder live ONLY here; there is no optional-AAD overload.
 *
 * Never log keys, plaintext, AAD values or ciphertext from this module.
 */
export interface KdfParams {
  algo: "argon2id";
  m: number;
  t: number;
  p: number;
  saltB64: string;
}
export const DEFAULT_KDF_PARAMS: Omit<KdfParams, "saltB64"> = { algo: "argon2id", m: 65536, t: 3, p: 1 };

const b64 = (u: Uint8Array): string => (typeof btoa === "function" ? btoa(String.fromCharCode(...u)) : Buffer.from(u).toString("base64"));
const unb64 = (s: string): Uint8Array =>
  typeof atob === "function" ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(s, "base64"));

export const generateSalt = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16));
export const generateDek = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/**
 * KEK derivation. `hash-wasm` is loaded through a dynamic `import()` (§3f): it is ~28 kB of
 * embedded Argon2 that only ever runs when a passphrase is turned into a key — unlocking a
 * device, enabling E2EE, a rekey or the v1→v2 upgrade — and every one of those already awaits
 * this call. It must NOT become a static import again: on a plain-tier budget the module would
 * be downloaded on every single boot and never called. Everything else in this file (AES-GCM,
 * the AAD tuples, the encoder) is WebCrypto and stays eager.
 */
export async function deriveKek(passphrase: string, salt: Uint8Array, p: Omit<KdfParams, "saltB64">): Promise<Uint8Array> {
  const { argon2id } = await import("hash-wasm");
  return argon2id({ password: passphrase, salt, parallelism: p.p, iterations: p.t, memorySize: p.m, hashLength: 32, outputType: "binary" });
}

/* ── v2 authenticated context (AAD) ──────────────────────────────────── */

/**
 * The three fixed-position AAD tuples of ciphertext format v2. Position, not property
 * names, carries meaning — the encoded AAD is the exact JSON.stringify of one of these,
 * never object-property iteration, string concatenation or locale-dependent formatting.
 */
export type E2eeAadContext =
  | readonly ["enveo-e2ee", 2, "op", string /* budgetId */, number /* epoch */, string /* opId */]
  | readonly ["enveo-e2ee", 2, "snapshot", string /* budgetId */, number /* epoch */, number /* uptoSeq */]
  | readonly ["enveo-e2ee", 2, "dek-wrap", string /* budgetId */, number /* epoch */];

/** Canonical lowercase textual UUID — validated, never normalized silently. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* Error CODE, never prose — a context that fails validation is a programmer error and
   must never be "fixed up" into a different authenticated context. */
function requireUuid(v: string): string {
  if (!CANONICAL_UUID.test(v)) throw new Error("bad_aad_context");
  return v;
}

function requireCounter(v: number): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error("bad_aad_context");
  return v;
}

/** Operation AAD: (budgetId, epoch, opId). The server-assigned `seq` is intentionally absent. */
export function opAadContext(budgetId: string, epoch: number, opId: string): E2eeAadContext {
  return ["enveo-e2ee", 2, "op", requireUuid(budgetId), requireCounter(epoch), requireUuid(opId)] as const;
}

/** Snapshot AAD: (budgetId, epoch, uptoSeq) — binds the checkpoint blob to its claimed position. */
export function snapshotAadContext(budgetId: string, epoch: number, uptoSeq: number): E2eeAadContext {
  return ["enveo-e2ee", 2, "snapshot", requireUuid(budgetId), requireCounter(epoch), requireCounter(uptoSeq)] as const;
}

/** Key-envelope AAD: (budgetId, epoch). A password change rewraps the SAME DEK under the same
 *  epoch; the mandatory v1→v2 upgrade instead generates a fresh DEK and increments the epoch. */
export function dekWrapAadContext(budgetId: string, epoch: number): E2eeAadContext {
  return ["enveo-e2ee", 2, "dek-wrap", requireUuid(budgetId), requireCounter(epoch)] as const;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The ONE encoder: AAD bytes = UTF-8 of the exact JSON.stringify of the tuple. */
const aadBytes = (ctx: E2eeAadContext): Uint8Array => enc.encode(JSON.stringify(ctx));

/* ── AES-256-GCM framing ─────────────────────────────────────────────── */

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function aesEncrypt(plain: Uint8Array, keyRaw: Uint8Array, ctx: E2eeAadContext): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyRaw);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: aadBytes(ctx) as BufferSource }, key, plain as BufferSource),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return "v2." + b64(out);
}

async function aesDecrypt(payload: string, keyRaw: Uint8Array, ctx: E2eeAadContext): Promise<Uint8Array> {
  // Error CODES, never prose: a corrupt/foreign/legacy envelope surfaces on the Unlock screen
  // through apiErrorMessage, which localizes it (ERROR_KEYS in lib/api.ts).
  if (payload.startsWith("v1.")) throw new Error("legacy_ciphertext"); // NO legacy fallback — upgrade ceremony only
  if (!payload.startsWith("v2.")) throw new Error("bad_ciphertext");
  let raw: Uint8Array;
  try {
    raw = unb64(payload.slice(3));
  } catch {
    throw new Error("bad_ciphertext");
  }
  if (raw.length < 12 + 16) throw new Error("bad_ciphertext"); // shorter than nonce + GCM tag
  const nonce = raw.slice(0, 12);
  const ct = raw.slice(12);
  const key = await aesKey(keyRaw);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: aadBytes(ctx) as BufferSource }, key, ct as BufferSource),
  );
}

/* ── Public API — every call REQUIRES its typed context ──────────────── */

export const wrapDek = (dek: Uint8Array, kek: Uint8Array, ctx: E2eeAadContext) => aesEncrypt(dek, kek, ctx);
export const unwrapDek = async (wrapped: string, kek: Uint8Array, ctx: E2eeAadContext) => aesDecrypt(wrapped, kek, ctx);

export const encryptPayload = (plaintext: string, dek: Uint8Array, ctx: E2eeAadContext) => aesEncrypt(enc.encode(plaintext), dek, ctx);
export const decryptPayload = async (ciphertext: string, dek: Uint8Array, ctx: E2eeAadContext) => dec.decode(await aesDecrypt(ciphertext, dek, ctx));

/** Fresh KDF params (new salt) as the JSON string the server stores — Unlock reads this shape. */
export function freshKdfParams(salt: Uint8Array): string {
  const kp: KdfParams = { ...DEFAULT_KDF_PARAMS, saltB64: b64(salt) };
  return JSON.stringify(kp);
}

/** Pairing code (QR/paste): "enveo1." + b64(JSON{b,d}) — never touches the server. It carries
 *  the RAW current DEK, so its version is a different axis than the ciphertext format: codes
 *  minted before a data-key rotation (the v1→v2 upgrade) die naturally with the old DEK. */
export function encodePairing(dek: Uint8Array, budgetId: string): string {
  return "enveo1." + b64(enc.encode(JSON.stringify({ b: budgetId, d: b64(dek) })));
}
export function decodePairing(code: string): { dek: Uint8Array; budgetId: string } {
  // Error CODE, never prose (Unlock already localizes this one at the call site, but the code
  // keeps a future caller that only has apiErrorMessage on the safe side).
  if (!code.startsWith("enveo1.")) throw new Error("bad_pairing_code");
  const j = JSON.parse(dec.decode(unb64(code.slice(7)))) as { b: string; d: string };
  if (!j.b || !j.d) throw new Error("bad_pairing_code");
  return { budgetId: j.b, dek: unb64(j.d) };
}
