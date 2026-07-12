import { describe, expect, it } from "bun:test";
import type { Account, ClientLedger } from "@enveo/shared";
import { generateSuggestion } from "./budgetSuggest";

const onAcc = (initial: number): Account => ({ id: "A0", name: "K", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: initial, archived: false, sort: 0 });

function fixture(): ClientLedger {
  return {
    accounts: [onAcc(1000_00)],
    groups: [{ id: "G0", name: "Grupa", sort: 0 }],
    envelopes: [
      { id: "E1", groupId: "G0", name: "Jedzenie", color: "#fff", icon: "tag", note: null, sort: 0, archived: false, monthlyTarget: null },
      { id: "E2", groupId: "G0", name: "Obligacje", color: "#fff", icon: "tag", note: null, sort: 1, archived: false, monthlyTarget: null },
    ],
    categories: [],
    places: [],
    recurrences: [],
    allocations: [],
    transactions: [],
  };
}

const req = (over: Partial<{ profile: string }> = {}) => ({
  month: "2026-07",
  profile: (over.profile ?? "historical") as "historical",
  ledger: fixture(),
});

describe("generateSuggestion — rules path", () => {
  it("returns rules-only when no askModel and distributes the full amount", async () => {
    const r = await generateSuggestion(req());
    expect(r.source).toBe("rules");
    expect(r.amountToDistribute).toBe(1000_00);
    expect(r.items.reduce((s, i) => s + i.proposedDelta, 0)).toBe(1000_00);
  });

  it("returns an empty proposal with a warning when toBeBudgeted <= 0", async () => {
    const ledger = fixture();
    ledger.accounts[0]!.initialBalance = 0; // nothing to distribute
    const r = await generateSuggestion({ month: "2026-07", profile: "historical", ledger });
    expect(r.amountToDistribute).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("uses askModel output (source ai) and does not leak transactions in the response", async () => {
    const r = await generateSuggestion(req(), async () => [{ envelopeId: "E1", proposedDelta: 1000_00, rationale: "test", confidence: 0.9 }]);
    expect(r.source).toBe("ai");
    expect(r.items.find((i) => i.envelopeId === "E1")!.proposedDelta).toBe(1000_00);
    expect(JSON.stringify(r)).not.toContain("recentTransactions");
  });

  it("repairs an under-sum AI proposal (source ai_repaired)", async () => {
    const r = await generateSuggestion(req({ profile: "investor" }), async () => [{ envelopeId: "E1", proposedDelta: 100_00 }]);
    expect(r.source).toBe("ai_repaired");
    expect(r.items.reduce((s, i) => s + i.proposedDelta, 0)).toBe(1000_00);
  });

  it("falls back to rules when askModel throws", async () => {
    const r = await generateSuggestion(req(), async () => { throw new Error("boom"); });
    expect(r.source).toBe("rules");
    expect(r.warnings).toContain("warn.aiUnavailable");
  });
});

describe("generateSuggestion — agent path (profile=custom, single prompt)", () => {
  const custom = (customPrompt = "pomiń Obligacje") => ({
    month: "2026-07",
    profile: "custom" as const,
    customPrompt,
    ledger: fixture(),
  });

  it("without askModel (no key / no useAi) returns agent_requires_ai and NO silent rules", async () => {
    const r = await generateSuggestion(custom());
    expect(r.items).toEqual([]);
    expect(r.warnings).toContain("agent_requires_ai");
    expect(r.source).toBe("rules");
    expect(r.undistributedRemainder).toBe(0);
  });

  it("scales ONLY within envelopes chosen by the agent (never tops up skipped ones)", async () => {
    const r = await generateSuggestion(custom(), async () => [{ envelopeId: "E1", proposedDelta: 60_00 }]);
    expect(r.source).toBe("ai_repaired"); // rescaled to Σ=amount
    expect(r.items.map((i) => i.envelopeId)).toEqual(["E1"]);
    expect(r.items[0]!.proposedDelta).toBe(1000_00);
  });

  it("empty agent answer → agent_empty warning, items=[], no rules fallback", async () => {
    const r = await generateSuggestion(custom(), async () => []);
    expect(r.items).toEqual([]);
    expect(r.warnings).toContain("agent_empty");
  });

  it("askModel throwing → empty result with warn.aiUnavailable (no rules fallback for custom)", async () => {
    const r = await generateSuggestion(custom(), async () => { throw new Error("boom"); });
    expect(r.items).toEqual([]);
    expect(r.warnings).toContain("warn.aiUnavailable");
    expect(r.source).toBe("rules");
  });
});

import { openAiAskModel } from "./budgetSuggest";

describe("openAiAskModel — custom = single prompt with two months (globalThis.fetch stub)", () => {
  const jsonResponse = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });

  it("ONE call; payload contains currentMonth + previousMonth + directive; result = only agent envelopes", async () => {
    const realFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return jsonResponse('[{"envelopeId":"E1","amount":60000},{"envelopeId":"E2","amount":40000}]');
    }) as unknown as typeof globalThis.fetch;

    try {
      const r = await generateSuggestion(
        { month: "2026-07", profile: "custom", customPrompt: "pomiń Obligacje", ledger: fixture() },
        openAiAskModel,
      );

      expect(bodies.length).toBe(1); // SINGLE prompt — exactly one call
      const msgs = bodies[0]!.messages as Array<{ role: string; content: string }>;
      const user = JSON.parse(msgs.find((m) => m.role === "user")!.content) as Record<string, any>;
      expect(user.currentMonth.month).toBe("2026-07");
      expect(user.previousMonth.month).toBe("2026-06");
      expect(user.previousMonth.note).toContain("reference");
      expect(user.directive).toBe("pomiń Obligacje");
      expect(bodies[0]!.tools).toBeUndefined(); // no tools — a pure single shot
      expect(bodies[0]!.reasoning_effort).toBe("low"); // gpt-5.5: low thinking budget

      expect(r.source).toBe("ai");
      expect(r.items.map((i) => i.envelopeId).sort()).toEqual(["E1", "E2"]);
      expect(r.items.reduce((s, i) => s + i.proposedDelta, 0)).toBe(1000_00);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("transport error (non-2xx) → warn.aiUnavailable, empty items (stub restored)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    try {
      const r = await generateSuggestion(
        { month: "2026-07", profile: "custom", customPrompt: "x", ledger: fixture() },
        openAiAskModel,
      );
      expect(r.items).toEqual([]);
      expect(r.warnings).toContain("warn.aiUnavailable");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

it("response carries target fields and undistributedRemainder", async () => {
  const ledger = fixture();
  ledger.envelopes[0]!.monthlyTarget = 100_00; // E1 = "Jedzenie" (food), target 100 zł
  const r = await generateSuggestion({ month: "2026-07", profile: "historical", ledger });
  const item = r.items.find((i) => i.envelopeId === "E1")!;
  expect(item.monthlyTarget).toBe(100_00);
  expect(item.targetGap).toBe(100_00);
  expect(typeof item.meetsTarget).toBe("boolean");
  expect(typeof r.undistributedRemainder).toBe("number");
});

describe("POST /ai/chat — operator-key proxy (local-only mode)", () => {
  it("without OPENAI_API_KEY → 503 ai_unavailable (no fetch call)", async () => {
    const { budgetSuggestRoutes } = await import("./budgetSuggest");
    const { Hono } = await import("hono");
    const app = new Hono().route("/", budgetSuggestRoutes);
    const res = await app.fetch(new Request("http://x/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }));
    // env.OPENAI_API_KEY empty in tests → 503; with an env key the test would need a stub
    if (!process.env.OPENAI_API_KEY) expect(res.status).toBe(503);
  });
});
