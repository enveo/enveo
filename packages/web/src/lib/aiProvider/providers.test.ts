import { describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences } from "@enveo/shared";
import { providerOptionsForTier } from "../../screens/settings/Ai";
import { prepareLedgerForE2eeEnable } from "../../screens/settings/DataSection";
import { E2eeByokProvider } from "./e2eeByok";
import { EnveoAiProvider } from "./enveo";
import { createAiProvider } from "./factory";
import { PlainByokProvider } from "./plainByok";
import { RulesProvider } from "./rules";

const request = { messages: [{ role: "user" as const, content: "hello" }] };
const input = {
  accountId: "account-a",
  images: ["data:image/png;base64,AA=="],
  locale: "pl",
  ledger: { budgets: [], accounts: [], groups: [], envelopes: [], categories: [], places: [], transactions: [], allocations: [] },
};

describe("AI provider implementations", () => {
  it("rules performs no transport and rejects model-only capabilities with a stable code", async () => {
    const provider = new RulesProvider();
    expect(await provider.status()).toMatchObject({ provider: "rules", code: "ready", configured: true });
    expect([...(await provider.status()).capabilities]).toEqual(["budget-suggestion"]);
    await expect(provider.complete(request)).rejects.toThrow("ai_capability_unsupported");
    await expect(provider.extractImport(input)).rejects.toThrow("ai_capability_unsupported");
  });

  it("Enveo AI uses operator routes only for a plain budget", async () => {
    const calls: string[] = [];
    const dependencies = {
      info: async () => ({ serverAi: true }),
      complete: async () => {
        calls.push("complete");
        return "operator";
      },
      extract: async () => {
        calls.push("extract");
        return { rows: [], proposals: [] };
      },
    };
    const plain = new EnveoAiProvider({ tier: "plain", ...dependencies });
    expect((await plain.status()).code).toBe("ready");
    expect(await plain.complete(request)).toBe("operator");
    expect(await plain.extractImport(input)).toEqual({ rows: [], proposals: [] });
    expect(calls).toEqual(["complete", "extract"]);

    const e2ee = new EnveoAiProvider({ tier: "e2ee", ...dependencies });
    expect(await e2ee.status()).toMatchObject({ code: "tier-unavailable", configured: false });
    await expect(e2ee.complete(request)).rejects.toThrow("ai_capability_unsupported");
  });

  it("plain BYOK saves once and all later operations name the budget without retaining the key", async () => {
    const calls: Array<[string, unknown]> = [];
    const provider = new PlainByokProvider({
      tier: "plain",
      budgetId: "budget-a",
      model: "gpt-5.6-luna",
      status: async (budgetId) => {
        calls.push(["status", budgetId]);
        return { configured: true, available: true };
      },
      save: async (budgetId, key) => void calls.push(["save", { budgetId, key }]),
      remove: async (budgetId) => void calls.push(["remove", budgetId]),
      test: async (budgetId, model) => void calls.push(["test", { budgetId, model }]),
      complete: async (budgetId, model) => {
        calls.push(["complete", { budgetId, model }]);
        return "vault";
      },
      extract: async (budgetId, model) => {
        calls.push(["extract", { budgetId, model }]);
        return { rows: [], proposals: [] };
      },
    });
    expect((await provider.status()).code).toBe("ready");
    await provider.saveCredential("sk-once");
    await provider.testConnection();
    expect(await provider.complete(request)).toBe("vault");
    expect(await provider.extractImport(input)).toEqual({ rows: [], proposals: [] });
    await provider.removeCredential();
    expect("key" in provider).toBe(false);
    expect(JSON.stringify(provider)).not.toContain("sk-once");
    expect(calls.map(([name]) => name)).toEqual(["status", "save", "test", "complete", "extract", "remove"]);
  });

  it("factory selects behavior from tier and budget preferences", () => {
    const preferences = createDefaultBudgetPreferences();
    expect(createAiProvider({ tier: "plain", budgetId: "b", unlocked: true, preferences: { ...preferences, aiProvider: "rules" } })).toBeInstanceOf(
      RulesProvider,
    );
    expect(createAiProvider({ tier: "plain", budgetId: "b", unlocked: true, preferences: { ...preferences, aiProvider: "enveo" } })).toBeInstanceOf(
      EnveoAiProvider,
    );
    expect(createAiProvider({ tier: "plain", budgetId: "b", unlocked: true, preferences: { ...preferences, aiProvider: "openai" } })).toBeInstanceOf(
      PlainByokProvider,
    );
    const unavailable = createAiProvider({ tier: "e2ee", budgetId: "b", unlocked: true, preferences: { ...preferences, aiProvider: "openai" } });
    expect(unavailable).toBeInstanceOf(E2eeByokProvider);
  });

  it("offers Enveo AI only while the budget is plain", () => {
    // Break caught: an E2EE settings screen could offer a provider that must send
    // plaintext through the server and is therefore unavailable by design.
    expect(providerOptionsForTier("plain")).toEqual(["rules", "enveo", "openai"]);
    expect(providerOptionsForTier("e2ee")).toEqual(["rules", "openai"]);
  });

  it("puts the Enveo-to-rules downgrade inside the snapshot used by E2EE enable", () => {
    // Break caught: flipping the tier before the replicated preference changes leaves
    // an encrypted budget selected on an impossible server-AI provider.
    const preferences = { ...createDefaultBudgetPreferences(), aiProvider: "enveo" as const };
    const ledger: ClientLedger = {
      budgets: [{ id: "budget-a", name: "Budget", currency: "EUR", preferences }],
      accounts: [],
      groups: [],
      envelopes: [],
      categories: [],
      places: [],
      transactions: [],
      allocations: [],
    };

    const prepared = prepareLedgerForE2eeEnable(ledger);

    expect(prepared.budgets[0]!.preferences.aiProvider).toBe("rules");
    expect(ledger.budgets[0]!.preferences.aiProvider).toBe("enveo");
    expect(
      prepareLedgerForE2eeEnable({ ...ledger, budgets: [{ ...ledger.budgets[0]!, preferences: { ...preferences, aiProvider: "openai" } }] }).budgets[0]!
        .preferences.aiProvider,
    ).toBe("openai");
  });
});
