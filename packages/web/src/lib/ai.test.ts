import { describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences, type Transaction } from "@enveo/shared";
import { runImportExtract } from "./ai";
import type { AiCapability, AiProvider, AiProviderKind } from "./aiProvider/contracts";
import { RulesProvider } from "./aiProvider/rules";
import { apiErrorMessage } from "./api";
import { type ChatTarget, chatJson, directChatJson } from "./openai";

async function withFetch<T>(fetchStub: typeof fetch, fn: () => Promise<T>, onLine = true): Promise<T> {
  const origFetch = globalThis.fetch;
  const origNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.fetch = fetchStub;
  Object.defineProperty(globalThis, "navigator", { value: { onLine }, configurable: true });
  try {
    return await fn();
  } finally {
    globalThis.fetch = origFetch;
    if (origNav) Object.defineProperty(globalThis, "navigator", origNav);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

const answering = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const replying = (content: string): typeof fetch => answering(200, { choices: [{ message: { content } }] });
const rejecting = (): typeof fetch =>
  (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

const MONTH = "2026-07";

const txn = (over: Partial<Transaction> & Pick<Transaction, "id" | "type" | "amount" | "date">): Transaction => ({
  accountId: "acc1",
  toAccountId: null,
  isRefund: false,
  envelopeId: null,
  placeId: null,
  categoryId: null,
  name: null,
  note: null,
  tag: null,
  items: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
  sourceRef: over.sourceRef ?? null,
  allocationFromEnvelopeId: over.allocationFromEnvelopeId ?? null,
  allocationToEnvelopeId: over.allocationToEnvelopeId ?? null,
});

const fixtureLedger = (): ClientLedger => ({
  accounts: [
    {
      id: "acc1",
      name: "Konto",
      color: "#111111",
      icon: "bank",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: null,
    },
  ],
  groups: [{ id: "grp1", name: "Życie", sort: 0 }],
  envelopes: [
    {
      id: "env1",
      groupId: "grp1",
      name: "Jedzenie",
      color: "#22aa22",
      icon: "food",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: 0,
      archived: false,
    },
    {
      id: "env2",
      groupId: "grp1",
      name: "Transport",
      color: "#2222aa",
      icon: "car",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: 1,
      archived: false,
    },
  ],
  transactions: [
    txn({ id: "t1", type: "income", amount: 500000, date: "2026-07-01" }),
    txn({ id: "t2", type: "expense", amount: 12345, date: "2026-07-02", envelopeId: "env1" }),
    txn({ id: "t3", type: "expense", amount: 6789, date: "2026-07-03", envelopeId: "env2" }),
    txn({ id: "t4", type: "expense", amount: 11111, date: "2026-06-15", envelopeId: "env1", createdAt: "2026-06-15T00:00:00.000Z" }),
  ],
  allocations: [{ id: "al1", envelopeId: "env1", month: MONTH, amount: 10000 }],
  categories: [],
  places: [],
  budgets: [{ id: "b1", name: "Budżet", currency: "PLN", preferences: createDefaultBudgetPreferences() }],
});

function providerStub(kind: AiProviderKind, capabilities: readonly AiCapability[], overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    status: async () => ({ provider: kind, code: "ready", configured: true, capabilities: new Set(capabilities) }),
    saveCredential: async () => {},
    removeCredential: async () => {},
    testConnection: async () => {},
    complete: async () => "",
    extractImport: async () => ({ rows: [], proposals: [] }),
    ...overrides,
  };
}

describe("provider-neutral AI workflows", () => {
  it("screenshot import delegates the selected account and preserves the full recognition result", async () => {
    const seenLedgers: ClientLedger[] = [];
    const seenAccounts: string[] = [];
    const recognition = {
      rows: [],
      proposals: [],
    };
    const provider = providerStub("openai", ["screenshot-import"], {
      extractImport: async (input) => {
        seenLedgers.push(input.ledger);
        seenAccounts.push(input.accountId);
        return recognition;
      },
    });
    const ledger = fixtureLedger();
    expect(await runImportExtract({ images: ["data:image/png;base64,x"], locale: "pl", ledger, accountId: "account-1", provider })).toEqual(recognition);
    expect(seenLedgers).toEqual([ledger]);
    expect(seenAccounts).toEqual(["account-1"]);
  });

  it("unsupported screenshot import throws a stable localized code", async () => {
    const run = runImportExtract({
      images: ["data:image/png;base64,x"],
      locale: "pl",
      ledger: fixtureLedger(),
      accountId: "account-1",
      provider: new RulesProvider(),
    });
    await expect(run).rejects.toThrow("ai_consent_required");
    expect(apiErrorMessage(await run.catch((error: unknown) => error))).toBe(
      "AI is not configured. Choose server AI or an existing own key in Settings → Artificial intelligence.",
    );
  });
});

/**
 * chatJson({kind:"server"}) — the /api/ai/v1/chat/completions mirror transport (aiProxy.ts answers
 * with the {error:"ai_unavailable"}/{error:"upstream",status} shapes tested here). Regression this guards: server-kind must NOT get the
 * byok-only 401/403→ai_key_invalid treatment (the mirror uses the OPERATOR's key, not the user's —
 * a wrong operator key is an ai_upstream_error, not "your key was rejected").
 */
describe("chatJson (server target → the /api/ai mirror)", () => {
  const target: ChatTarget = { kind: "server" };
  const req = {
    messages: [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "usr" },
    ],
  };

  it("503 {error:ai_unavailable} passes through — the operator has no key configured", async () => {
    await withFetch(answering(503, { error: "ai_unavailable" }), async () => {
      await expect(chatJson(req, target)).rejects.toThrow("ai_unavailable");
    });
  });

  it("502 {error:upstream,status} passes through — OpenAI rejected the mirror's own call", async () => {
    await withFetch(answering(502, { error: "upstream", status: 429 }), async () => {
      await expect(chatJson(req, target)).rejects.toThrow("upstream");
    });
  });

  it("fetch rejects (no response at all) → ai_offline when offline, ai_unreachable when online — same as byok", async () => {
    await withFetch(
      rejecting(),
      async () => {
        await expect(chatJson(req, target)).rejects.toThrow("ai_offline");
      },
      false,
    );
    await withFetch(
      rejecting(),
      async () => {
        await expect(chatJson(req, target)).rejects.toThrow("ai_unreachable");
      },
      true,
    );
  });

  it("a round-trip exceeding the cap → ai_timeout — never ai_unreachable, never the key/model message", async () => {
    /* A stub that answers only when aborted — exactly what a hung model looks like to fetch. */
    const hanging: typeof fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as unknown as typeof fetch;
    await withFetch(hanging, async () => {
      const e = await chatJson(req, target, 20)
        .then(() => null)
        .catch((err: unknown) => err);
      expect(String((e as Error).message)).toBe("ai_timeout");
      expect(apiErrorMessage(e)).toBe("The AI service took too long to answer — nothing was changed. Try again in a moment.");
    });
  });

  it("a raw 401 (not the mirror's own code) → ai_upstream_error, NEVER ai_key_invalid (that mapping is byok-only)", async () => {
    await withFetch(answering(401, "unauthorized"), async () => {
      await expect(chatJson(req, target)).rejects.toThrow("ai_upstream_error");
    });
  });

  it("the happy path still works (server model reply parses like byok's)", async () => {
    const content = await withFetch(replying("hello"), () => chatJson(req, target));
    expect(content).toBe("hello");
  });
});

describe("directChatJson (E2EE BYOK → OpenAI, never Enveo)", () => {
  const req = { messages: [{ role: "user" as const, content: "private prompt" }] };

  it("sends the key only as OpenAI authorization and includes the selected model", async () => {
    let seen: { url: string; authorization: string | null; body: string } | undefined;
    const stub: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(input), authorization: headers.get("authorization"), body: String(init?.body) };
      return Response.json({ choices: [{ message: { content: "direct" } }] });
    }) as typeof fetch;
    const result = await withFetch(stub, () => directChatJson(req, "sk-direct", "gpt-5.6-luna"));
    expect(result).toBe("direct");
    expect(seen?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen?.authorization).toBe("Bearer sk-direct");
    expect(JSON.parse(seen?.body ?? "{}")).toMatchObject({ model: "gpt-5.6-luna", messages: req.messages });
    expect(seen?.body).not.toContain("sk-direct");
  });

  it("classifies direct credential/model/upstream failures without exposing OpenAI prose", async () => {
    await withFetch(answering(401, { error: { message: "secret rejected" } }), async () => {
      await expect(directChatJson(req, "sk-bad", "gpt-5.6-luna")).rejects.toThrow("ai_key_invalid");
    });
    await withFetch(answering(404, { error: { message: "model unavailable" } }), async () => {
      await expect(directChatJson(req, "sk-ok", "gpt-5.6-luna")).rejects.toThrow("ai_model_unavailable");
    });
    await withFetch(answering(429, { error: { message: "quota details" } }), async () => {
      await expect(directChatJson(req, "sk-ok", "gpt-5.6-luna")).rejects.toThrow("ai_upstream_error");
    });
  });
});
