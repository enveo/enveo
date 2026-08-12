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
  type Transaction,
} from "@enveo/shared";
import { aiTarget, hasAiTarget, previewSuggestPrompt, runImportExtract, type AiSettings } from "./ai";
import { apiErrorMessage } from "./api";
import { chatJson, type ChatTarget } from "./openai";

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
  budgets: [{ id: "b1", name: "Budżet", currency: "PLN" }],
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

/**
 * aiTarget is the SINGLE answer to "can this device talk to a model" — the AI-only entry point
 * (screenshot import) dispatches on it AND the import sheet decides on it whether to offer the
 * feature at all. Regression it exists for: an earlier entry point was shown on `aiMode !== "off"`,
 * which is TRUE for byok with an empty key — Settings switches the mode before the key is typed
 * (and clearing the field persists an empty one), so it was offered on a path that could only throw.
 */
describe("aiTarget / hasAiTarget", () => {
  const settings = (over: Partial<AiSettings>): AiSettings => ({ aiMode: "off", openaiKey: "", openaiModel: "gpt-5.5-mini", ...over });

  it("server → the /api mirror; byok WITH a key → straight to OpenAI", () => {
    expect(aiTarget(settings({ aiMode: "server" }))).toEqual({ kind: "server" });
    expect(aiTarget(settings({ aiMode: "byok", openaiKey: "sk-x" }))).toEqual({ kind: "byok", key: "sk-x", model: "gpt-5.5-mini" });
    expect(hasAiTarget(settings({ aiMode: "server" }))).toBe(true);
  });

  it("off → no target; byok WITHOUT a key → no target either (the state the import sheet must hide the feature in)", () => {
    expect(aiTarget(settings({ aiMode: "off" }))).toBeNull();
    expect(aiTarget(settings({ aiMode: "byok", openaiKey: "" }))).toBeNull();
    expect(hasAiTarget(settings({ aiMode: "byok", openaiKey: "" }))).toBe(false);
  });

  it("with no target the AI-only entry point throws a CODE (localized by apiErrorMessage), never prose", async () => {
    for (const s of [settings({ aiMode: "off" }), settings({ aiMode: "byok", openaiKey: "" })]) {
      const imp = runImportExtract({ images: ["data:image/png;base64,x"], locale: "pl", ledger: fixtureLedger(), settings: s });
      await expect(imp).rejects.toThrow("ai_consent_required");
      // the message IS the code: apiErrorMessage maps it to a sentence in the UI language (api.test.ts)
      expect(apiErrorMessage(await imp.catch((e: unknown) => e))).toBe(
        "AI is not set up on this device. Pick a mode in Settings → Artificial intelligence (with your own key, paste it there).",
      );
    }
  });
});

/**
 * REGRESSION (release blocker, originally caught on the now-removed quick-add path): a failed
 * model call must be RENDERED in the import sheet's error line, never swallowed and never leaked
 * as raw transport prose — the transport used to throw `new Error(\`OpenAI ${res.status}\`)`, so a
 * Polish user with a byok key rejected by OpenAI read "OpenAI 401" in coral. Every everyday
 * failure (offline, a rejected byok key, an answer that is not JSON) must arrive as a CODE that
 * apiErrorMessage turns into a sentence. Screenshot import (byok) is the only AI-only entry point
 * left that surfaces chatJson's errors directly to the user — suggest always falls back to rules.
 */
describe("runImportExtract (byok) failures reach the user as localized sentences", () => {
  const settings = (over: Partial<AiSettings>): AiSettings => ({ aiMode: "off", openaiKey: "", openaiModel: "gpt-5.5-mini", ...over });
  const BYOK = settings({ aiMode: "byok", openaiKey: "sk-x" });

  const run = (s: AiSettings) => runImportExtract({ images: ["data:image/png;base64,x"], locale: "pl", ledger: fixtureLedger(), settings: s });

  const failure = async (s: AiSettings, f: typeof fetch, onLine = true): Promise<{ code: string; text: string }> => {
    const e = await withFetch(
      f,
      () =>
        run(s)
          .then(() => null)
          .catch((err: unknown) => err),
      onLine,
    );
    const code = String((e as Error).message);
    return { code, text: apiErrorMessage(e) };
  };

  it("byok with an expired key → ai_key_invalid (OpenAI's {error:{message}} OBJECT never reaches the UI)", async () => {
    const { code, text } = await failure(BYOK, answering(401, { error: { message: "Incorrect API key provided: sk-x", type: "invalid_request_error" } }));
    expect(code).toBe("ai_key_invalid");
    expect(text).toBe("OpenAI rejected your key — check it in Settings → Artificial intelligence.");
  });

  it('offline (fetch rejects, navigator.onLine === false) → ai_offline, not "Failed to fetch"', async () => {
    const { code, text } = await failure(BYOK, rejecting(), false);
    expect(code).toBe("ai_offline");
    expect(text).toBe("You are offline — screenshot import needs a connection. Manual entry works without one.");
  });

  it("the network drops while online (DNS, a dead proxy) → ai_unreachable, NOT the key/model blame", async () => {
    const { code, text } = await failure(BYOK, rejecting(), true);
    expect(code).toBe("ai_unreachable");
    expect(text).toBe("Could not reach the AI service — check the network connection and try again.");
  });

  it("the model answers prose instead of JSON → ai_upstream_error, not a raw SyntaxError", async () => {
    const { code, text } = await failure(BYOK, replying("Sure! Here are the transactions."));
    expect(code).toBe("ai_upstream_error");
    expect(text).toBe("OpenAI rejected the request — check the key and the model, then try again.");
  });

  it("no failure leaks prose: every code is snake_case and localizes to a sentence", async () => {
    const cases: Array<[AiSettings, typeof fetch, boolean]> = [
      [BYOK, answering(401, { error: { message: "bad key" } }), true],
      [BYOK, answering(500, "<html>gateway error</html>"), true], // a proxy's HTML page, not JSON
      [BYOK, rejecting(), false],
      [BYOK, replying("not json"), true],
    ];
    for (const [s, f, onLine] of cases) {
      const { code, text } = await failure(s, f, onLine);
      expect(code).toMatch(/^[a-z0-9_]+$/); // no "OpenAI 401", no "Failed to fetch", no SyntaxError
      expect(text).not.toBe(code); // ERROR_KEYS knows it → the user reads a sentence, in their language
    }
  });

  it("the happy path still works (the transport refactor did not break a good answer)", async () => {
    const items = await withFetch(
      replying(
        JSON.stringify({
          transactions: [{ date: "2026-07-02", amount: 1230, type: "expense", rawPlace: "Lidl", tag: "LIDL", currency: "PLN", fxOriginal: "" }],
        }),
      ),
      () => run(BYOK),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.amount).toBe(1230);
    expect(items[0]!.tag).toBe("LIDL");
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
