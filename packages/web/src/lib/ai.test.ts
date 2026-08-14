/**
 * previewSuggestPrompt — the budget suggestion prompt preview MUST be
 * EXACTLY the prompt that runSuggest will send (one shared
 * basis→ctx→builder step; string identity test below). The custom profile
 * goes via the AGENT prompt (buildAgentSuggestPrompt), predefined ones —
 * via the rules-engine prompt (buildSuggestPrompt).
 */
import { describe, expect, it } from "bun:test";
import {
  buildAgentSuggestContext,
  buildAgentSuggestPrompt,
  buildBudgetSuggestionBasis,
  buildSuggestPrompt,
  type ClientLedger,
  createDefaultBudgetPreferences,
  type Transaction,
} from "@enveo/shared";
import { previewSuggestPrompt, runImportExtract, runSuggest } from "./ai";
import type { AiCapability, AiProvider, AiProviderKind } from "./aiProvider/contracts";
import { RulesProvider } from "./aiProvider/rules";
import { apiErrorMessage } from "./api";
import { type ChatTarget, chatJson } from "./openai";

/** Runs `fn` with fetch (and optionally navigator.onLine) stubbed; always restores both. */
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
/** The model replied 200 with `content` (as OpenAI wraps it). */
const replying = (content: string): typeof fetch => answering(200, { choices: [{ message: { content } }] });
const rejecting = (): typeof fetch =>
  (async () => {
    throw new TypeError("Failed to fetch"); // what a browser throws with no network
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
});

/** Fixture: an account + 2 envelopes + income and expenses (pattern from e2ee.test.ts). */
const fixtureLedger = (): ClientLedger => ({
  accounts: [{ id: "acc1", name: "Konto", color: "#111111", icon: "bank", type: "checking", onBudget: true, initialBalance: 0, archived: false, sort: 0 }],
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

describe("previewSuggestPrompt", () => {
  it("returns {system, user}: language directive + Profile + fixture envelope names", () => {
    const preview = previewSuggestPrompt(fixtureLedger(), MONTH, "cautious", undefined, "pl");
    expect(typeof preview.system).toBe("string");
    expect(typeof preview.user).toBe("string");
    expect(preview.system).toContain("Write all text you GENERATE (names, notes, rationales) in Polish.");
    // "Profile: <id>" lives in the builder's system message (parity with the real call)
    expect(`${preview.system}\n${preview.user}`).toContain("Profile: cautious");
    expect(preview.user).toContain("Jedzenie");
    expect(preview.user).toContain("Transport");
  });

  it("customPrompt variant: the user directive reaches the preview (agent prompt)", () => {
    const custom = "wszystko na Jedzenie";
    const preview = previewSuggestPrompt(fixtureLedger(), MONTH, "custom", custom, "pl");
    expect(`${preview.system}\n${preview.user}`).toContain(custom);
    // custom profile = agent, not the rules engine
    expect(preview.system).toContain("envelope-budgeting agent");
  });

  it("IDENTITY (predefined profiles): the preview === the message contents from buildSuggestPrompt", () => {
    const ledger = fixtureLedger();
    for (const profile of ["cautious", "historical", "investor"] as const) {
      const preview = previewSuggestPrompt(ledger, MONTH, profile, undefined, "pl");
      const basis = buildBudgetSuggestionBasis({ ledger, month: MONTH, profile });
      const req = buildSuggestPrompt({ basis, ledger, month: MONTH, profile, locale: "pl" });
      expect(preview.system).toBe(req.messages[0]!.content as string);
      expect(preview.user).toBe(req.messages[1]!.content as string);
    }
  });

  it("IDENTITY (custom): the preview === buildAgentSuggestPrompt with the same ctx (single prompt, zero drift)", () => {
    const ledger = fixtureLedger();
    const customPrompt = "wszystko na Jedzenie";
    const preview = previewSuggestPrompt(ledger, MONTH, "custom", customPrompt, "pl");
    const basis = buildBudgetSuggestionBasis({ ledger, month: MONTH, profile: "custom", customPrompt });
    const ctx = buildAgentSuggestContext({ ledger, month: MONTH, basis, directive: customPrompt, locale: "pl" });
    const req = buildAgentSuggestPrompt(ctx);
    expect(preview.system).toBe(req.messages[0]!.content as string);
    expect(preview.user).toBe(req.messages[1]!.content as string);
    // the user message carries BOTH months — the current one and the previous one as reference
    const user = JSON.parse(preview.user) as Record<string, any>;
    expect(user.currentMonth.month).toBe(MONTH);
    expect(user.previousMonth.note).toContain("reference");
  });
});

function providerStub(kind: AiProviderKind, capabilities: readonly AiCapability[], overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    status: async () => ({ provider: kind, code: "ready", configured: true, capabilities: new Set(capabilities) }),
    saveCredential: async () => {},
    removeCredential: async () => {},
    testConnection: async () => {},
    complete: async () => "",
    extractImport: async () => ({ items: [] }),
    ...overrides,
  };
}

describe("provider-neutral AI workflows", () => {
  it("rules suggestions never call a model transport", async () => {
    let calls = 0;
    const provider = providerStub("rules", ["budget-suggestion"], {
      complete: async () => {
        calls += 1;
        throw new Error("must_not_fetch");
      },
    });
    const result = await runSuggest({ ledger: fixtureLedger(), month: MONTH, profile: "cautious", locale: "pl", provider });
    expect(result.source).toBe("rules");
    expect(calls).toBe(0);
  });

  it("custom prompts require the explicit model capability and do not silently execute rules", async () => {
    const result = await runSuggest({
      ledger: fixtureLedger(),
      month: MONTH,
      profile: "custom",
      customPrompt: "all to food",
      locale: "pl",
      provider: new RulesProvider(),
    });
    expect(result.items).toEqual([]);
    expect(result.warnings).toContain("agent_requires_ai");
  });

  it("screenshot import delegates once to the selected provider", async () => {
    const seenLedgers: ClientLedger[] = [];
    const item = {
      date: "2026-07-02",
      amount: 1230,
      type: "expense" as const,
      isRefund: false,
      name: "",
      tag: "LIDL",
      rawPlace: "Lidl",
      envelopeId: null,
      envelopeName: null,
      categoryId: null,
      categoryName: null,
      placeName: null,
      currency: "PLN",
      fxOriginal: "",
    };
    const provider = providerStub("openai", ["screenshot-import"], {
      extractImport: async (input) => {
        seenLedgers.push(input.ledger);
        return { items: [item] };
      },
    });
    const ledger = fixtureLedger();
    expect(await runImportExtract({ images: ["data:image/png;base64,x"], locale: "pl", ledger, provider })).toEqual([item]);
    expect(seenLedgers).toEqual([ledger]);
  });

  it("unsupported screenshot import throws a stable localized code", async () => {
    const run = runImportExtract({ images: ["data:image/png;base64,x"], locale: "pl", ledger: fixtureLedger(), provider: new RulesProvider() });
    await expect(run).rejects.toThrow("ai_consent_required");
    expect(apiErrorMessage(await run.catch((error: unknown) => error))).toBe(
      "AI is not configured. Choose server AI or an existing own key in Settings → Artificial intelligence.",
    );
  });
});

/**
 * chatJson({kind:"server"}) — the /api/ai/v1/chat/completions mirror transport. LIVE even after
 * quick-add's removal: runSuggest's server mode still goes through it (budgetSuggest.ts POSTs the
 * very same {error:"ai_unavailable"}/{error:"upstream",status} shapes tested here) — runSuggest
 * just SWALLOWS the failure into a rules fallback instead of rendering it, so nothing above
 * exercises responseError's server branch. Regression this guards: server-kind must NOT get the
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
