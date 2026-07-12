import { describe, expect, it } from "bun:test";
import { deriveKek, generateDek, wrapDek, unwrapDek, encryptPayload, decryptPayload, encodePairing, decodePairing, generateSalt, DEFAULT_KDF_PARAMS } from "./crypto";

describe("e2ee crypto", () => {
  it("the KDF is deterministic for (passphrase, salt) and differs for others", async () => {
    const salt = generateSalt();
    const a = await deriveKek("correct horse", salt, DEFAULT_KDF_PARAMS);
    const b = await deriveKek("correct horse", salt, DEFAULT_KDF_PARAMS);
    const c = await deriveKek("wrong horse", salt, DEFAULT_KDF_PARAMS);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(c).toString("hex"));
  });

  it("envelope: wrap→unwrap restores the DEK; a wrong passphrase throws", async () => {
    const salt = generateSalt();
    const kek = await deriveKek("pass-1", salt, DEFAULT_KDF_PARAMS);
    const dek = generateDek();
    const wrapped = await wrapDek(dek, kek);
    const un = await unwrapDek(wrapped, kek);
    expect(Buffer.from(un).toString("hex")).toBe(Buffer.from(dek).toString("hex"));
    const badKek = await deriveKek("pass-2", salt, DEFAULT_KDF_PARAMS);
    await expect(unwrapDek(wrapped, badKek)).rejects.toThrow();
  });

  it("encrypt→decrypt roundtrip; ciphertext tampering throws; v1 format", async () => {
    const dek = generateDek();
    const ct = await encryptPayload(JSON.stringify({ kind: "alloc.set", payload: { a: 1 } }), dek);
    expect(ct.startsWith("v1.")).toBe(true);
    const pt = await decryptPayload(ct, dek);
    expect(JSON.parse(pt).kind).toBe("alloc.set");
    const tampered = ct.slice(0, -4) + (ct.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptPayload(tampered, dek)).rejects.toThrow();
  });

  it("the pairing code encodes and decodes the DEK + budgetId", () => {
    const dek = generateDek();
    const code = encodePairing(dek, "11111111-1111-1111-1111-111111111111");
    const dec = decodePairing(code);
    expect(dec.budgetId).toBe("11111111-1111-1111-1111-111111111111");
    expect(Buffer.from(dec.dek).toString("hex")).toBe(Buffer.from(dek).toString("hex"));
    expect(() => decodePairing("nonsens")).toThrow();
  });
});
