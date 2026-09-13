import { describe, expect, it } from "bun:test";
import { type ChatRequest, type ClientLedger, createDefaultBudgetPreferences, type ImportHistoryRecord, type ImportRecognitionResult } from "@enveo/shared";
import { runServerImportRecognitionAdapter } from "../../../../api/src/routes/import";
import { budgetSecretAadContext, encryptPayload, generateDek, snapshotAadContext } from "../crypto";
import { E2eeByokProvider } from "./e2eeByok";

const BUDGET = "11111111-1111-1111-1111-111111111111";
const OTHER_BUDGET = "22222222-2222-2222-2222-222222222222";
const request: ChatRequest = { messages: [{ role: "user", content: "hello" }] };
const ACCOUNT = "33333333-3333-3333-3333-333333333333";
const ledger: ClientLedger = {
  budgets: [{ id: BUDGET, name: "Budget", currency: "EUR", preferences: createDefaultBudgetPreferences() }],
  accounts: [
    {
      id: ACCOUNT,
      name: "Checking",
      color: "#000",
      icon: "wallet",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: null,
    },
  ],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
  transactions: [],
  allocations: [],
};

function fixture(
  options: {
    unlocked?: boolean;
    configured?: boolean;
    directError?: string;
    responseBudgetId?: string;
    responseEpoch?: number;
    staleOn?: "get" | "save" | "remove";
    respond?: (request: ChatRequest) => string;
  } = {},
) {
  const dek = generateDek();
  let ciphertext: string | undefined;
  const calls = {
    get: [] as string[],
    save: [] as Array<{ budgetId: string; epoch: number; ciphertext: string }>,
    remove: [] as Array<{ budgetId: string; epoch: number }>,
    direct: [] as Array<{ key: string; model: string; request: ChatRequest; timeoutMs?: number }>,
    mismatch: [] as Array<{ tier: "plain" | "e2ee"; epoch: number; cipherVersion?: number }>,
  };
  const stale = () => new Error('409 {"error":"tier_mismatch","tier":"e2ee","epoch":4,"cipherVersion":2}');
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
      if (options.staleOn === "get") throw stale();
      calls.get.push(budgetId);
      return {
        configured: options.configured ?? ciphertext !== undefined,
        budgetId: options.responseBudgetId ?? budgetId,
        epoch: options.responseEpoch ?? 3,
        ...(ciphertext ? { ciphertext } : {}),
      };
    },
    save: async (budgetId, epoch, nextCiphertext) => {
      if (options.staleOn === "save") throw stale();
      calls.save.push({ budgetId, epoch, ciphertext: nextCiphertext });
      ciphertext = nextCiphertext;
    },
    remove: async (budgetId, epoch) => {
      if (options.staleOn === "remove") throw stale();
      calls.remove.push({ budgetId, epoch });
      ciphertext = undefined;
    },
    directChat: async (key, model, req, timeoutMs) => {
      calls.direct.push({ key, model, request: req, timeoutMs });
      if (options.directError) throw new Error(options.directError);
      if (options.respond) return options.respond(req);
      if (req.messages[1] && Array.isArray(req.messages[1].content)) {
        return '{"rows":[{"rowId":"r1","imageIndex":0,"visualOrder":0,"rawTextLines":["SHOP 1"],"date":"2026-08-01","amount":1234,"currency":"EUR","direction":"unknown","postingStatus":"posted","rowRole":"financial_event","semanticKind":"unknown","relation":null,"confidence":"medium","reviewReasons":[]}]}';
      }
      if ((req.responseFormat?.json_schema as { name?: string } | undefined)?.name === "enriched_import_rows") {
        return '{"rows":[{"rowId":"r1","name":"Zakupy","place":"Shop","envelopeId":null,"categoryId":null,"semanticKind":"card_purchase","relation":null,"reviewReasons":[]}]}';
      }
      return "direct-answer";
    },
    onTierMismatch: (meta) => calls.mismatch.push(meta),
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

  it("runs both import cycles directly and returns the full recognition result without sending plaintext to Enveo", async () => {
    const f = fixture();
    await f.provider.saveCredential("sk-vision");
    const originalFetch = globalThis.fetch;
    const serverImportUrls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/import/")) serverImportUrls.push(url);
      throw new Error("unexpected_fetch");
    }) as unknown as typeof fetch;
    try {
      const result = await f.provider.extractImport({ images: ["data:image/png;base64,AA=="], locale: "pl", ledger, accountId: ACCOUNT });
      expect(result.rows).toHaveLength(1);
      expect(result.proposals).toEqual([expect.objectContaining({ rowId: "r1", date: "2026-08-01", amount: 1234, rawPlace: "SHOP 1", name: "Zakupy" })]);
      expect(f.calls.get).toEqual([BUDGET]);
      expect(f.calls.direct).toHaveLength(2);
      expect(serverImportUrls).toEqual([]);
      expect(JSON.stringify(f.calls.save)).not.toContain("SHOP 1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs the durable strict pipeline from a saved extraction without repeating cycle one", async () => {
    const f = fixture();
    await f.provider.saveCredential("sk-resume");
    const phases: string[] = [];
    const saved: ImportRecognitionResult[] = [];

    await f.provider.runDurableImport({
      images: [],
      locale: "pl",
      ledger,
      accountId: ACCOUNT,
      checkpoint: {
        rows: [
          {
            rowId: "r1",
            imageIndex: 0,
            visualOrder: 0,
            rawTextLines: ["SHOP 1"],
            date: "2026-08-01",
            amount: 1234,
            currency: "EUR",
            direction: "unknown",
            postingStatus: "posted",
            rowRole: "financial_event",
            semanticKind: "unknown",
            relation: null,
            confidence: "medium",
            reviewReasons: [],
          },
        ],
        proposals: [],
      },
      lifecycle: {
        advancePhase: async (phase) => void phases.push(phase),
        saveResult: async (result) => void saved.push(result),
      },
    });

    expect(f.calls.direct).toHaveLength(1);
    expect(f.calls.direct[0]?.request.messages[1]?.content).not.toBeArray();
    expect(phases).toEqual(["enriching", "reconciling"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.proposals[0]).toMatchObject({ rowId: "r1", name: "Zakupy", placeName: "Shop", amount: 1234, date: "2026-08-01", currency: "EUR" });
  });

  it("skips enrichment for an exact duplicate identically to the default server pipeline", async () => {
    const duplicate = {
      id: "44444444-4444-4444-8444-444444444444",
      type: "expense" as const,
      accountId: ACCOUNT,
      toAccountId: null,
      amount: 1234,
      date: "2026-08-01",
      isRefund: false,
      envelopeId: null,
      placeId: null,
      categoryId: null,
      name: "Existing shop",
      note: null,
      tag: null,
      sourceRef: "SHOP 1",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const duplicateLedger: ClientLedger = { ...ledger, transactions: [duplicate] };
    const historyRecords: ImportHistoryRecord[] = [
      {
        accountId: ACCOUNT,
        currency: "EUR",
        sourceRef: "SHOP 1",
        tag: null,
        place: null,
        name: "Existing shop",
        envelope: null,
        category: null,
        type: "expense",
        isRefund: false,
        toAccountId: null,
      },
    ];
    const respond = (modelRequest: ChatRequest): string =>
      Array.isArray(modelRequest.messages[1]?.content)
        ? '{"rows":[{"rowId":"r1","imageIndex":0,"visualOrder":0,"rawTextLines":["SHOP 1"],"date":"2026-08-01","amount":1234,"currency":"EUR","direction":"debit","postingStatus":"posted","rowRole":"financial_event","semanticKind":"card_purchase","relation":null,"confidence":"high","reviewReasons":[]}]}'
        : '{"rows":[{"rowId":"r1","name":"Duplicate shop","place":"Shop","envelopeId":null,"categoryId":null,"semanticKind":"card_purchase","relation":null,"reviewReasons":[]}]}';
    const serverRequests: Array<{ request: ChatRequest; timeoutMs: number | undefined }> = [];
    const expected = await runServerImportRecognitionAdapter({
      images: ["data:image/png;base64,AA=="],
      locale: "pl",
      today: new Date().toISOString().slice(0, 10),
      budgetCurrency: "EUR",
      accountId: ACCOUNT,
      accountRows: duplicateLedger.accounts,
      envelopeRows: duplicateLedger.envelopes,
      categoryRows: duplicateLedger.categories,
      transactionRows: duplicateLedger.transactions,
      historyRecords,
      chat: async (modelRequest, timeoutMs) => {
        serverRequests.push({ request: modelRequest, timeoutMs });
        return respond(modelRequest);
      },
    });
    const f = fixture({ respond });
    await f.provider.saveCredential("sk-duplicate-parity");

    const actual = await f.provider.extractImport({ images: ["data:image/png;base64,AA=="], locale: "pl", ledger: duplicateLedger, accountId: ACCOUNT });

    expect(serverRequests).toHaveLength(1);
    expect(f.calls.direct).toHaveLength(1);
    expect(f.calls.direct.map(({ request, timeoutMs }) => ({ request, timeoutMs }))).toEqual(serverRequests);
    expect(actual).toEqual(expected);
    expect(actual.proposals[0]).toMatchObject({ duplicateStatus: "exists", disposition: "declined", selected: false, reviewReasons: [] });
  });

  it("matches the production server adapter for permuted versions of the same logical ledger", async () => {
    const otherBudget = {
      id: OTHER_BUDGET,
      name: "Other",
      currency: "USD",
      preferences: createDefaultBudgetPreferences(),
    };
    const secondAccount = { ...ledger.accounts[0]!, id: "44444444-4444-4444-8444-444444444444", name: "Savings", type: "savings" as const, sort: 1 };
    const envelope = {
      id: "55555555-5555-4555-8555-555555555555",
      groupId: "66666666-6666-4666-8666-666666666666",
      name: "Food",
      color: "#000",
      icon: "tag",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: 0,
      archived: false,
    };
    const secondEnvelope = { ...envelope, id: "77777777-7777-4777-8777-777777777777", name: "Travel", sort: 1 };
    const category = { id: "88888888-8888-4888-8888-888888888888", name: "Groceries", archived: false };
    const secondCategory = { id: "99999999-9999-4999-8999-999999999999", name: "Restaurants", archived: false };
    const place = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Shop", archived: false };
    const unusedPlace = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Papertrail Books", archived: false };
    const archivedPlace = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Old Cafe", archived: true };
    const historicalTransaction = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      type: "expense" as const,
      accountId: ACCOUNT,
      toAccountId: null,
      amount: 999,
      date: "2026-07-01",
      isRefund: false,
      envelopeId: envelope.id,
      placeId: place.id,
      categoryId: category.id,
      name: "Past groceries",
      note: null,
      tag: "SHOP",
      sourceRef: "SHOP 1",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const reorderedLedger: ClientLedger = {
      ...ledger,
      budgets: [otherBudget, ...ledger.budgets],
      accounts: [secondAccount, ...ledger.accounts],
      envelopes: [secondEnvelope, envelope],
      categories: [secondCategory, category],
      places: [unusedPlace, archivedPlace, place],
      transactions: [historicalTransaction],
    };
    const historyRecords: ImportHistoryRecord[] = [
      {
        accountId: ACCOUNT,
        currency: "EUR",
        sourceRef: "SHOP 1",
        tag: "SHOP",
        place: "Shop",
        name: "Past groceries",
        envelope: "Food",
        category: "Groceries",
        type: "expense",
        isRefund: false,
        toAccountId: null,
      },
    ];
    const respond = (request: ChatRequest): string =>
      Array.isArray(request.messages[1]?.content)
        ? '{"rows":[{"rowId":"r1","imageIndex":0,"visualOrder":0,"rawTextLines":["SHOP 1"],"date":"2026-08-01","amount":1234,"currency":"EUR","direction":"debit","postingStatus":"unknown","rowRole":"financial_event","semanticKind":"card_purchase","relation":null,"confidence":"medium","reviewReasons":["possible_ocr_error"]}]}'
        : `{"rows":[{"rowId":"r1","name":"Zakupy","place":"Shop","envelopeId":"${envelope.id}","categoryId":"${category.id}","semanticKind":"card_purchase","relation":null,"reviewReasons":[]}]}`;
    const serverRequests: Array<{ request: ChatRequest; timeoutMs: number | undefined }> = [];
    const expected = await runServerImportRecognitionAdapter({
      images: ["data:image/png;base64,AA=="],
      locale: "pl",
      today: new Date().toISOString().slice(0, 10),
      budgetCurrency: "EUR",
      accountId: ACCOUNT,
      accountRows: [...reorderedLedger.accounts].reverse(),
      envelopeRows: [...reorderedLedger.envelopes].reverse(),
      categoryRows: [...reorderedLedger.categories].reverse(),
      placeRows: [...reorderedLedger.places].reverse(),
      transactionRows: [...reorderedLedger.transactions].reverse(),
      historyRecords: [...historyRecords].reverse(),
      chat: async (request, timeoutMs) => {
        serverRequests.push({ request, timeoutMs });
        return respond(request);
      },
    });
    const f = fixture({ respond });
    await f.provider.saveCredential("sk-parity");
    const actual = await f.provider.extractImport({ images: ["data:image/png;base64,AA=="], locale: "pl", ledger: reorderedLedger, accountId: ACCOUNT });

    expect(actual).toEqual(expected);
    expect(f.calls.direct.map(({ request, timeoutMs }) => ({ request, timeoutMs }))).toEqual(serverRequests);
    expect(f.calls.direct).toHaveLength(2);
    const context = JSON.parse(f.calls.direct[1]!.request.messages[1]!.content as string);
    expect(context.entities.places).toEqual([
      { id: place.id, name: place.name },
      { id: unusedPlace.id, name: unusedPlace.name },
    ]);
    expect(context.rows[0].historyCandidates).not.toEqual(expect.arrayContaining([expect.objectContaining({ place: unusedPlace.name })]));
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

    const wrongKind = fixture();
    const snapshotCiphertext = await encryptPayload("sk-wrong-kind", wrongKind.dek, snapshotAadContext(BUDGET, 3, 0));
    wrongKind.setCiphertext(snapshotCiphertext);
    await expect(wrongKind.provider.complete(request)).rejects.toThrow();
    expect(wrongKind.calls.direct).toEqual([]);

    for (const response of [fixture({ responseBudgetId: OTHER_BUDGET }), fixture({ responseEpoch: 4 })]) {
      await response.provider.saveCredential("sk-record-assertion");
      await expect(response.provider.complete(request)).rejects.toThrow();
      expect(response.calls.direct).toEqual([]);
    }
  });

  it("adopts a stale server epoch before save, delete or use and never calls OpenAI", async () => {
    const save = fixture({ staleOn: "save" });
    await expect(save.provider.saveCredential("sk-stale-save")).rejects.toThrow("tier_mismatch");
    expect(save.calls.mismatch).toEqual([{ tier: "e2ee", epoch: 4, cipherVersion: 2 }]);

    const remove = fixture({ staleOn: "remove" });
    await expect(remove.provider.removeCredential()).rejects.toThrow("tier_mismatch");
    expect(remove.calls.mismatch).toEqual([{ tier: "e2ee", epoch: 4, cipherVersion: 2 }]);

    const use = fixture({ staleOn: "get" });
    await expect(use.provider.complete(request)).rejects.toThrow("tier_mismatch");
    expect(use.calls.mismatch).toEqual([{ tier: "e2ee", epoch: 4, cipherVersion: 2 }]);
    expect(use.calls.direct).toEqual([]);
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
