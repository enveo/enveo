/**
 * E2EE crypto core — ciphertext format v2 (AES-256-GCM with MANDATORY additionalData).
 *
 * The AAD is the UTF-8 bytes of the exact JSON.stringify of one fixed-position tuple
 * (op / snapshot / dek-wrap / budget-secret / import-job — see E2eeAadContext in crypto.ts). Moving an otherwise valid
 * ciphertext to a different operation, budget, epoch or checkpoint position MUST make
 * authentication fail. There is deliberately NO v1 read fallback: normal decrypt/unwrap
 * reject "v1." with the stable code `legacy_ciphertext` (the mandatory upgrade ceremony is
 * the only boundary a legacy budget may cross), and malformed/unknown input fails closed
 * with `bad_ciphertext`.
 *
 * NOTE for the vectors below: this change does NOT authenticate the server-assigned journal
 * order — PostgreSQL allocates `seq` after the client encrypted and pushed, so `seq` is
 * intentionally absent from the op AAD (no "changed seq fails" test exists, on purpose).
 */
import { describe, expect, it } from "bun:test";
import {
  budgetSecretAadContext,
  DEFAULT_KDF_PARAMS,
  decodePairing,
  decryptPayload,
  dekWrapAadContext,
  deriveKek,
  encodePairing,
  encryptPayload,
  generateDek,
  generateSalt,
  importApplyRowToken,
  importJobAadContext,
  opAadContext,
  plainImportApplyRowToken,
  snapshotAadContext,
  unwrapDek,
  wrapDek,
} from "./crypto";

const BUDGET_A = "11111111-1111-1111-1111-111111111111";
const BUDGET_B = "22222222-2222-2222-2222-222222222222";
const OP_1 = "33333333-3333-3333-3333-333333333333";
const OP_2 = "44444444-4444-4444-4444-444444444444";
const JOB_1 = "55555555-5555-5555-5555-555555555555";
const JOB_2 = "66666666-6666-6666-6666-666666666666";

/** A LEGACY v1 ciphertext ("v1." + b64(nonce ∥ ct), NO AAD) — produced only here: the
 *  production code has no v1 write path left, and the vector needs a real legacy value. */
async function legacyV1Encrypt(plaintext: string, keyRaw: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyRaw as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, new TextEncoder().encode(plaintext) as BufferSource),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return "v1." + btoa(String.fromCharCode(...out));
}

describe("v2 AAD tuple builders", () => {
  it("build the exact fixed-position tuples of the wire contract", () => {
    expect(JSON.stringify(opAadContext(BUDGET_A, 3, OP_1))).toBe(`["enveo-e2ee",2,"op","${BUDGET_A}",3,"${OP_1}"]`);
    expect(JSON.stringify(snapshotAadContext(BUDGET_A, 3, 42))).toBe(`["enveo-e2ee",2,"snapshot","${BUDGET_A}",3,42]`);
    expect(JSON.stringify(dekWrapAadContext(BUDGET_A, 3))).toBe(`["enveo-e2ee",2,"dek-wrap","${BUDGET_A}",3]`);
    expect(JSON.stringify(budgetSecretAadContext(BUDGET_A, 3, "openai"))).toBe(`["enveo-e2ee",2,"budget-secret","${BUDGET_A}",3,"openai"]`);
    expect(JSON.stringify(importJobAadContext(BUDGET_A, 3, JOB_1, "input"))).toBe(`["enveo-e2ee",2,"import-job","${BUDGET_A}",3,"${JOB_1}","input"]`);
  });

  it("reject a non-canonical or malformed budget/op UUID (validate, never normalize silently)", () => {
    const upper = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEFFFF0000"; // uppercase hex = NOT canonical
    expect(() => opAadContext(upper, 1, OP_1)).toThrow("bad_aad_context");
    expect(() => opAadContext("not-a-uuid", 1, OP_1)).toThrow("bad_aad_context");
    expect(() => opAadContext("", 1, OP_1)).toThrow("bad_aad_context");
    expect(() => opAadContext(BUDGET_A, 1, upper)).toThrow("bad_aad_context");
    expect(() => snapshotAadContext("xx", 1, 0)).toThrow("bad_aad_context");
    expect(() => dekWrapAadContext(`${BUDGET_A} `, 1)).toThrow("bad_aad_context");
    expect(() => budgetSecretAadContext("not-a-uuid", 1, "openai")).toThrow("bad_aad_context");
    expect(() => importJobAadContext(BUDGET_A, 1, "not-a-uuid", "input")).toThrow("bad_aad_context");
  });

  it("reject a negative, fractional or unsafe epoch/uptoSeq", () => {
    expect(() => opAadContext(BUDGET_A, -1, OP_1)).toThrow("bad_aad_context");
    expect(() => opAadContext(BUDGET_A, 1.5, OP_1)).toThrow("bad_aad_context");
    expect(() => opAadContext(BUDGET_A, Number.MAX_SAFE_INTEGER + 2, OP_1)).toThrow("bad_aad_context");
    expect(() => snapshotAadContext(BUDGET_A, 1, -1)).toThrow("bad_aad_context");
    expect(() => snapshotAadContext(BUDGET_A, 1, 0.25)).toThrow("bad_aad_context");
    expect(() => dekWrapAadContext(BUDGET_A, Number.NaN)).toThrow("bad_aad_context");
    expect(() => budgetSecretAadContext(BUDGET_A, -1, "openai")).toThrow("bad_aad_context");
    expect(() => budgetSecretAadContext(BUDGET_A, 1, "other" as never)).toThrow("bad_aad_context");
    expect(() => importJobAadContext(BUDGET_A, -1, JOB_1, "input")).toThrow("bad_aad_context");
    expect(() => importJobAadContext(BUDGET_A, 1, JOB_1, "other" as never)).toThrow("bad_aad_context");
  });
});

describe("v2 import-job ciphertext", () => {
  it("authenticates the budget, epoch, job id, and payload part", async () => {
    const dek = generateDek();
    const plaintext = "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==";
    const ciphertext = await encryptPayload(plaintext, dek, importJobAadContext(BUDGET_A, 4, JOB_1, "input"));

    expect(ciphertext.startsWith("v2.")).toBe(true);
    expect(ciphertext).not.toContain(plaintext);
    expect(await decryptPayload(ciphertext, dek, importJobAadContext(BUDGET_A, 4, JOB_1, "input"))).toBe(plaintext);
    await expect(decryptPayload(ciphertext, dek, importJobAadContext(BUDGET_B, 4, JOB_1, "input"))).rejects.toThrow();
    await expect(decryptPayload(ciphertext, dek, importJobAadContext(BUDGET_A, 5, JOB_1, "input"))).rejects.toThrow();
    await expect(decryptPayload(ciphertext, dek, importJobAadContext(BUDGET_A, 4, JOB_2, "input"))).rejects.toThrow();
    await expect(decryptPayload(ciphertext, dek, importJobAadContext(BUDGET_A, 4, JOB_1, "checkpoint"))).rejects.toThrow();
    await expect(decryptPayload(ciphertext, dek, importJobAadContext(BUDGET_A, 4, JOB_1, "result"))).rejects.toThrow();
  });
});

describe("E2EE import apply row identity", () => {
  it("derives an opaque domain-separated token without exposing model row text", async () => {
    // given: a model row id contains merchant-like private text
    const dek = generateDek();
    const sensitiveRowId = "Coffee Shop Warsaw 2026-08-24 12.34 EUR";

    // when: the client derives the durable apply identity in the crypto boundary
    const token = await importApplyRowToken(dek, BUDGET_A, 4, JOB_1, sensitiveRowId);

    // then: it is stable only for the same E2EE job context and hides the source text
    expect(token).toBe(await importApplyRowToken(dek, BUDGET_A, 4, JOB_1, sensitiveRowId));
    expect(token).not.toContain(sensitiveRowId);
    expect(token).not.toBe(await importApplyRowToken(dek, BUDGET_A, 4, JOB_2, sensitiveRowId));
    expect(token).not.toBe(await importApplyRowToken(dek, BUDGET_A, 4, JOB_1, `${sensitiveRowId}!`));
    await expect(importApplyRowToken(dek, BUDGET_A, 4, JOB_1, "")).rejects.toThrow("bad_import_row_context");
  });
});

describe("plain import apply row identity", () => {
  it("uses a job-scoped opaque digest instead of persisting model row text", async () => {
    const sensitiveRowId = "Coffee Shop Warsaw 2026-08-24 12.34 EUR";
    const token = await plainImportApplyRowToken(BUDGET_A, JOB_1, sensitiveRowId);

    expect(token).toBe(await plainImportApplyRowToken(BUDGET_A, JOB_1, sensitiveRowId));
    expect(token).not.toContain(sensitiveRowId);
    expect(token).not.toBe(await plainImportApplyRowToken(BUDGET_A, JOB_2, sensitiveRowId));
  });
});

describe("v2 budget-secret ciphertext", () => {
  it("authenticates the secret kind, budget and epoch", async () => {
    const dek = generateDek();
    const ciphertext = await encryptPayload("sk-zero-knowledge", dek, budgetSecretAadContext(BUDGET_A, 4, "openai"));
    expect(ciphertext).not.toContain("sk-zero-knowledge");
    expect(await decryptPayload(ciphertext, dek, budgetSecretAadContext(BUDGET_A, 4, "openai"))).toBe("sk-zero-knowledge");
    await expect(decryptPayload(ciphertext, dek, budgetSecretAadContext(BUDGET_B, 4, "openai"))).rejects.toThrow();
    await expect(decryptPayload(ciphertext, dek, budgetSecretAadContext(BUDGET_A, 5, "openai"))).rejects.toThrow();
  });

  it("fails closed on tamper, legacy and truncated ciphertext", async () => {
    const dek = generateDek();
    const context = budgetSecretAadContext(BUDGET_A, 4, "openai");
    const ciphertext = await encryptPayload("secret", dek, context);
    const raw = Uint8Array.from(atob(ciphertext.slice(3)), (c) => c.charCodeAt(0));
    raw[12] = (raw[12] ?? 0) ^ 0xff;
    await expect(decryptPayload(`v2.${btoa(String.fromCharCode(...raw))}`, dek, context)).rejects.toThrow();
    await expect(decryptPayload(await legacyV1Encrypt("secret", dek), dek, context)).rejects.toThrow("legacy_ciphertext");
    await expect(decryptPayload("v2.AAAA", dek, context)).rejects.toThrow("bad_ciphertext");
  });
});

describe("v2 encrypt/decrypt (payload + AAD)", () => {
  it("round-trips only with byte-identical AAD; the ciphertext is v2. and hides the plaintext", async () => {
    const dek = generateDek();
    const aad = opAadContext(BUDGET_A, 3, OP_1);
    const ct = await encryptPayload(JSON.stringify({ kind: "category.create", payload: { name: "Groceries" } }), dek, aad);
    expect(ct.startsWith("v2.")).toBe(true);
    expect(ct).not.toContain("Groceries");
    const pt = await decryptPayload(ct, dek, opAadContext(BUDGET_A, 3, OP_1));
    expect(JSON.parse(pt).kind).toBe("category.create");
  });

  it("wrong opId in the AAD fails authentication (the opId-substitution attack)", async () => {
    const dek = generateDek();
    const ct = await encryptPayload("secret", dek, opAadContext(BUDGET_A, 3, OP_1));
    await expect(decryptPayload(ct, dek, opAadContext(BUDGET_A, 3, OP_2))).rejects.toThrow();
  });

  it("wrong budget id in the AAD fails authentication (cross-budget replay)", async () => {
    const dek = generateDek();
    const ct = await encryptPayload("secret", dek, opAadContext(BUDGET_A, 3, OP_1));
    await expect(decryptPayload(ct, dek, opAadContext(BUDGET_B, 3, OP_1))).rejects.toThrow();
  });

  it("wrong epoch in the AAD fails authentication (cross-generation replay)", async () => {
    const dek = generateDek();
    const ct = await encryptPayload("secret", dek, opAadContext(BUDGET_A, 3, OP_1));
    await expect(decryptPayload(ct, dek, opAadContext(BUDGET_A, 2, OP_1))).rejects.toThrow();
  });

  it("wrong domain (op ciphertext read as snapshot, and vice versa) fails authentication", async () => {
    const dek = generateDek();
    const asOp = await encryptPayload("secret", dek, opAadContext(BUDGET_A, 3, OP_1));
    await expect(decryptPayload(asOp, dek, snapshotAadContext(BUDGET_A, 3, 0))).rejects.toThrow();
    const asSnap = await encryptPayload("secret", dek, snapshotAadContext(BUDGET_A, 3, 7));
    await expect(decryptPayload(asSnap, dek, opAadContext(BUDGET_A, 3, OP_1))).rejects.toThrow();
  });

  it("wrong snapshot uptoSeq fails authentication (checkpoint-position substitution)", async () => {
    const dek = generateDek();
    const ct = await encryptPayload("ledger", dek, snapshotAadContext(BUDGET_A, 3, 200));
    await expect(decryptPayload(ct, dek, snapshotAadContext(BUDGET_A, 3, 0))).rejects.toThrow();
    expect(await decryptPayload(ct, dek, snapshotAadContext(BUDGET_A, 3, 200))).toBe("ledger");
  });

  it("ciphertext, tag and nonce tampering all fail", async () => {
    const dek = generateDek();
    const aad = opAadContext(BUDGET_A, 1, OP_1);
    const ct = await encryptPayload("payload", dek, aad);
    const raw = Uint8Array.from(atob(ct.slice(3)), (c) => c.charCodeAt(0));
    for (const idx of [0, 13, raw.length - 1]) {
      // 0 = nonce byte, 13 = ciphertext body, last = GCM tag
      const bad = raw.slice();
      bad[idx] = (bad[idx] ?? 0) ^ 0xff;
      const tampered = "v2." + btoa(String.fromCharCode(...bad));
      await expect(decryptPayload(tampered, dek, aad)).rejects.toThrow();
    }
  });

  it("rejects v1. with the stable code legacy_ciphertext (NO legacy read fallback)", async () => {
    const dek = generateDek();
    const legacy = await legacyV1Encrypt("old data", dek);
    await expect(decryptPayload(legacy, dek, opAadContext(BUDGET_A, 1, OP_1))).rejects.toThrow("legacy_ciphertext");
  });

  it("fails closed on unknown/truncated/base64-invalid input with bad_ciphertext", async () => {
    const dek = generateDek();
    const aad = opAadContext(BUDGET_A, 1, OP_1);
    await expect(decryptPayload("v3.AAAA", dek, aad)).rejects.toThrow("bad_ciphertext");
    await expect(decryptPayload("garbage", dek, aad)).rejects.toThrow("bad_ciphertext");
    await expect(decryptPayload("", dek, aad)).rejects.toThrow("bad_ciphertext");
    await expect(decryptPayload("v2.", dek, aad)).rejects.toThrow("bad_ciphertext");
    await expect(decryptPayload("v2.AAAA", dek, aad)).rejects.toThrow("bad_ciphertext"); // shorter than nonce+tag
    await expect(decryptPayload("v2.!!!not-base64!!!", dek, aad)).rejects.toThrow("bad_ciphertext");
  });

  it("no exported API permits empty or omitted AAD (mandatory third parameter, no default)", () => {
    // Arity proves there is no defaulted/optional AAD parameter: a default would not count.
    expect(encryptPayload.length).toBe(3);
    expect(decryptPayload.length).toBe(3);
    expect(wrapDek.length).toBe(3);
    expect(unwrapDek.length).toBe(3);
  });
});

describe("v2 key envelope (dek-wrap AAD)", () => {
  it("wrap→unwrap restores the DEK under the same (budgetId, epoch); a wrong passphrase throws", async () => {
    const salt = generateSalt();
    const kek = await deriveKek("pass-1", salt, DEFAULT_KDF_PARAMS);
    const dek = generateDek();
    const ctx = dekWrapAadContext(BUDGET_A, 2);
    const wrapped = await wrapDek(dek, kek, ctx);
    expect(wrapped.startsWith("v2.")).toBe(true);
    const un = await unwrapDek(wrapped, kek, dekWrapAadContext(BUDGET_A, 2));
    expect(Buffer.from(un).toString("hex")).toBe(Buffer.from(dek).toString("hex"));
    const badKek = await deriveKek("pass-2", salt, DEFAULT_KDF_PARAMS);
    await expect(unwrapDek(wrapped, badKek, ctx)).rejects.toThrow();
  });

  it("an envelope moved to another budget or epoch fails to unwrap", async () => {
    const kek = await deriveKek("pass-1", generateSalt(), DEFAULT_KDF_PARAMS);
    const wrapped = await wrapDek(generateDek(), kek, dekWrapAadContext(BUDGET_A, 2));
    await expect(unwrapDek(wrapped, kek, dekWrapAadContext(BUDGET_B, 2))).rejects.toThrow();
    await expect(unwrapDek(wrapped, kek, dekWrapAadContext(BUDGET_A, 3))).rejects.toThrow();
  });

  it("a legacy v1 envelope is refused with legacy_ciphertext (never silently unwrapped)", async () => {
    const kek = await deriveKek("pass-1", generateSalt(), DEFAULT_KDF_PARAMS);
    const dek = generateDek();
    const legacy = await legacyV1Encrypt(String.fromCharCode(...dek), kek); // shape-compatible enough: the prefix decides
    await expect(unwrapDek(legacy, kek, dekWrapAadContext(BUDGET_A, 1))).rejects.toThrow("legacy_ciphertext");
  });
});

describe("KDF and pairing code (unchanged transports)", () => {
  it("the KDF is deterministic for (passphrase, salt) and differs for others", async () => {
    const salt = generateSalt();
    const a = await deriveKek("correct horse", salt, DEFAULT_KDF_PARAMS);
    const b = await deriveKek("correct horse", salt, DEFAULT_KDF_PARAMS);
    const c = await deriveKek("wrong horse", salt, DEFAULT_KDF_PARAMS);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(c).toString("hex"));
  });

  it("the pairing code stays enveo1. (it carries the RAW current DEK, not ciphertext — its version is a different axis)", () => {
    const dek = generateDek();
    const code = encodePairing(dek, BUDGET_A);
    expect(code.startsWith("enveo1.")).toBe(true);
    const dec = decodePairing(code);
    expect(dec.budgetId).toBe(BUDGET_A);
    expect(Buffer.from(dec.dek).toString("hex")).toBe(Buffer.from(dek).toString("hex"));
    expect(() => decodePairing("nonsense")).toThrow("bad_pairing_code");
  });
});
