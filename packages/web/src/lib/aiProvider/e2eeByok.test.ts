import { describe, expect, it } from "bun:test";
import type { ChatRequest, ClientLedger } from "@enveo/shared";
import { budgetSecretAadContext, encryptPayload, generateDek } from "../crypto";
import { E2eeByokProvider } from "./e2eeByok";

const BUDGET = "11111111-1111-1111-1111-111111111111";
const OTHER_BUDGET = "22222222-2222-2222-2222-222222222222";
const request: ChatRequest = { messages: [{ role: "user", content: "hello" }] };
const ledger: ClientLedger = { budgets: [], accounts: [], groups: [], envelopes: [], categories: [], places: [], transactions: [], allocations: [] };

function fixture(options: { unlocked?: boolean; configured?: boolean; directError?: string; responseBudgetId?: string; responseEpoch?: number } = {}) {
  const dek = generateDek();
  let ciphertext: string | undefined;
  const calls = {
    get: [] as string[],
    save: [] as Array<{ budgetId: string; epoch: number; ciphertext: string }>,
    remove: [] as Array<{ budgetId: string; epoch: number }>,
    direct: [] as Array<{ key: string; model: string; request: ChatRequest; timeoutMs?: number }>,
  };
  const provider = new E2eeByokProvider({
    tier: "e2ee",
    unlocked: options.unlocked ?? true,
    budgetId: BUDGET,
    model: "gpt-5.6-luna",
    currentEpoch: () => 3,
    requireDek: (epoch) => {
      if (epoch !== 3 || !(options.unlocked ?? true)) throw new Error("locked");
      return dek.slice();
    },
    get: async (budgetId) => {
      calls.get.push(budgetId);
      return {
        configured: options.configured ?? ciphertext !== undefined,
        budgetId: options.responseBudgetId ?? budgetId,
        epoch: options.responseEpoch ?? 3,
        ...(ciphertext ? { ciphertext } : {}),
      };
    },
    save: async (budgetId, epoch, nextCiphertext) => {
      calls.save.push({ budgetId, epoch, ciphertext: nextCiphertext });
      ciphertext = nextCiphertext;
    },
    remove: async (budgetId, epoch) => {
      calls.remove.push({ budgetId, epoch });
      ciphertext = undefined;
    },
    directChat: async (key, model, req, timeoutMs) => {
      calls.direct.push({ key, model, request: req, timeoutMs });
      if (options.directError) throw new Error(options.directError);
      return req.messages[1] && Array.isArray(req.messages[1].content)
        ? '{"transactions":[{"date":"2026-08-01","amount":1234,"type":"expense","rawPlace":"SHOP 1","tag":"SHOP","currency":"EUR","fxOriginal":""}]}'
        : "direct-answer";
    },
  });
  return {
    provider,
    calls,
    dek,
    setCiphertext: (value: string | undefined) => {
      ciphertext = value;
    },
  };
}

describe("E2EE Own OpenAI provider", () => {
  it("does not query credentials while locked", async () => {
    const f = fixture({ unlocked: false });
    expect(await f.provider.status()).toMatchObject({ provider: "openai", code: "locked", configured: false });
    expect(f.calls.get).toEqual([]);
    await expect(f.provider.complete(request)).rejects.toThrow("locked");
  });

  it("reports an unlocked but unconfigured budget without model capabilities", async () => {
    const f = fixture({ configured: false });
    expect(await f.provider.status()).toMatchObject({ code: "not-configured", configured: false });
    expect([...(await f.provider.status()).capabilities]).toEqual([]);
  });

  it("encrypts immediately, sends only ciphertext to Enveo and decrypts per direct operation", async () => {
    const f = fixture();
    await f.provider.saveCredential("sk-zero-knowledge");
    expect(f.calls.save).toHaveLength(1);
    expect(JSON.stringify(f.calls.save)).not.toContain("sk-zero-knowledge");
    expect(f.calls.save[0]).toMatchObject({ budgetId: BUDGET, epoch: 3 });
    expect((await f.provider.status()).code).toBe("ready");
    await f.provider.testConnection();
    expect(await f.provider.complete(request)).toBe("direct-answer");
    expect(f.calls.direct.every((call) => call.key === "sk-zero-knowledge" && call.model === "gpt-5.6-luna")).toBe(true);
    expect("key" in f.provider).toBe(false);
    expect(JSON.stringify(f.provider)).not.toContain("sk-zero-knowledge");
    await f.provider.removeCredential();
    expect(f.calls.remove).toEqual([{ budgetId: BUDGET, epoch: 3 }]);
  });

  it("extracts screenshots directly and returns normalized facts without sending them to Enveo", async () => {
    const f = fixture();
    await f.provider.saveCredential("sk-vision");
    const result = await f.provider.extractImport({ images: ["data:image/png;base64,AA=="], locale: "pl", ledger });
    expect(result.items).toEqual([
      expect.objectContaining({ date: "2026-08-01", amount: 1234, type: "expense", rawPlace: "SHOP 1", tag: "SHOP", currency: "EUR" }),
    ]);
    expect(f.calls.get).toEqual([BUDGET]);
    expect(f.calls.direct).toHaveLength(1);
  });

  it("fails closed on malformed, legacy, cross-budget and stale-epoch records", async () => {
    for (const bad of ["v1.AAAA", "v2.AAAA"]) {
      const f = fixture();
      f.setCiphertext(bad);
      await expect(f.provider.complete(request)).rejects.toThrow();
      expect(f.calls.direct).toEqual([]);
    }

    const cross = fixture();
    const valid = await encryptPayload("sk-cross", cross.dek, budgetSecretAadContext(OTHER_BUDGET, 3, "openai"));
    cross.setCiphertext(valid);
    await expect(cross.provider.complete(request)).rejects.toThrow();
    expect(cross.calls.direct).toEqual([]);

    const stale = fixture();
    const staleCiphertext = await encryptPayload("sk-stale", stale.dek, budgetSecretAadContext(BUDGET, 2, "openai"));
    stale.setCiphertext(staleCiphertext);
    await expect(stale.provider.complete(request)).rejects.toThrow();
    expect(stale.calls.direct).toEqual([]);

    for (const response of [fixture({ responseBudgetId: OTHER_BUDGET }), fixture({ responseEpoch: 4 })]) {
      await response.provider.saveCredential("sk-record-assertion");
      await expect(response.provider.complete(request)).rejects.toThrow();
      expect(response.calls.direct).toEqual([]);
    }
  });

  it("propagates a classified direct-upstream failure without retaining the key", async () => {
    const f = fixture({ directError: "ai_key_invalid" });
    await f.provider.saveCredential("sk-rejected");
    await expect(f.provider.complete(request)).rejects.toThrow("ai_key_invalid");
    expect(f.calls.direct).toHaveLength(1);
    expect("key" in f.provider).toBe(false);
    expect(JSON.stringify(f.provider)).not.toContain("sk-rejected");
  });
});
