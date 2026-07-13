import { describe, expect, it } from "bun:test";
import type { ClientLedger } from "./types";
import { buildBudgetSuggestionBasis } from "./aiBudget";
import {
  aiLocaleSchema,
  buildAgentLoopMessages,
  buildAgentSuggestContext,
  buildAgentSuggestPrompt,
  buildImportExtractPrompt,
  buildQuickAddPrompt,
  buildSuggestPrompt,
  languageDirectives,
  languageName,
  parseAgentSuggestResponse,
  supportsReasoningEffort,
  parseImportExtractResponse,
  parseQuickAddResponse,
  parseSuggestResponse,
  type ChatMessage,
} from "./aiPrompts";

function fixture(): ClientLedger {
  return {
    accounts: [{ id: "A0", name: "Konto", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 1000_00, archived: false, sort: 0 }],
    groups: [{ id: "G0", name: "Grupa", sort: 0 }],
    envelopes: [
      { id: "E1", groupId: "G0", name: "Jedzenie", color: "#fff", icon: "tag", note: null, sort: 0, archived: false, monthlyTarget: null, isSavings: false },
      { id: "E2", groupId: "G0", name: "Obligacje", color: "#fff", icon: "tag", note: null, sort: 1, archived: false, monthlyTarget: null, isSavings: true },
    ],
    budgets: [],
    categories: [],
    places: [{ id: "P1", name: "Lidl" }],
    recurrences: [],
    allocations: [],
    transactions: [],
  };
}

const sysOf = (m: ChatMessage[]): string => m[0]!.content as string;

describe("buildSuggestPrompt", () => {
  const ledger = fixture();
  const basis = buildBudgetSuggestionBasis({ ledger, month: "2026-07", profile: "historical" });
  const req = buildSuggestPrompt({ basis, ledger, month: "2026-07", profile: "historical", locale: "pl" });

  it("keeps the language directives verbatim and carries the amount", () => {
    const sys = sysOf(req.messages);
    expect(sys).toContain("Write all text you GENERATE (names, notes, rationales) in Polish.");
    expect(sys).toContain("do not translate data values");
    expect(sys).toContain(`Amount to distribute: ${basis.amountToDistribute}.`);
    expect(basis.amountToDistribute).toBe(1000_00);
  });

  it("sends candidates with envelope names and requests STRICT json_schema", () => {
    expect((req.responseFormat as any).type).toBe("json_schema");
    expect((req.responseFormat as any).json_schema.strict).toBe(true);
    const user = JSON.parse(req.messages[1]!.content as string) as { amountToDistribute: number; candidates: Array<{ name: string }> };
    expect(user.amountToDistribute).toBe(basis.amountToDistribute);
    expect(user.candidates.map((c) => c.name)).toContain("Jedzenie");
  });

  it("appends custom guidance and switches language for en", () => {
    const en = buildSuggestPrompt({ basis, ledger, month: "2026-07", profile: "custom", customPrompt: "prefer savings", locale: "en" });
    const sys = sysOf(en.messages);
    expect(sys).toContain("Write all text you GENERATE (names, notes, rationales) in English.");
    expect(sys).toContain("User guidance: prefer savings");
  });
});

/* Since 2.2.0 the UI ships ten languages, so a prompt may no longer say "Polish or English".
   The locale is ANY BCP-47 tag and the prompt names that language to the model. */
describe("languageName / languageDirectives — any BCP-47 locale", () => {
  it("names every shipped language in English (the language the prompts are written in)", () => {
    expect(languageName("en")).toBe("English");
    expect(languageName("pl")).toBe("Polish");
    expect(languageName("de")).toBe("German");
    expect(languageName("es")).toBe("Spanish");
    expect(languageName("fr")).toBe("French");
    expect(languageName("it")).toBe("Italian");
    expect(languageName("nl")).toBe("Dutch");
    expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
    expect(languageName("cs")).toBe("Czech");
    expect(languageName("sv")).toBe("Swedish");
  });

  it("names a tag we do not ship a UI for (the model can still answer in it)", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("de-AT")).toBe("Austrian German");
  });

  it("falls back to English for a missing or unnameable tag — never instructs a language it cannot name", () => {
    expect(languageName("")).toBe("English");
    expect(languageName("zz")).toBe("English"); // well-formed, unknown → Intl echoes the tag back
    expect(languageName("nonsense tag!")).toBe("English"); // Intl throws RangeError
  });

  it("gives EVERY prompt the same language contract (one source — server and byok cannot drift)", () => {
    const ledger = fixture();
    const basis = buildBudgetSuggestionBasis({ ledger, month: "2026-07", profile: "historical" });
    const contract = languageDirectives("de").trim();
    expect(contract).toContain("Write all text you GENERATE (names, notes, rationales) in German.");
    expect(contract).toContain("do not translate data values");

    const systems = [
      sysOf(buildSuggestPrompt({ basis, ledger, month: "2026-07", profile: "historical", locale: "de" }).messages),
      sysOf(buildAgentSuggestPrompt(buildAgentSuggestContext({ ledger, month: "2026-07", basis, directive: "x", locale: "de" })).messages),
      sysOf(buildQuickAddPrompt("Kaffee 12", { envelopes: [], places: [] }, "2026-07-13", "de").messages),
      sysOf(buildImportExtractPrompt([], { envelopes: [], categories: [] }, "2026-07-13", "de").messages),
      buildAgentLoopMessages({ ledger, month: "2026-07", amount: 100_00, directive: "x", locale: "de" })[0]!.content as string,
    ];
    for (const sys of systems) expect(sys).toContain(contract);
  });

  it("aiLocaleSchema (the wire shape the routes parse) takes BCP-47 tags and rejects garbage", () => {
    expect(aiLocaleSchema.parse("pt-BR")).toBe("pt-BR");
    expect(aiLocaleSchema.safeParse("en").success).toBe(true);
    expect(aiLocaleSchema.safeParse("zh-Hant-TW").success).toBe(true);
    expect(aiLocaleSchema.safeParse("").success).toBe(false);
    expect(aiLocaleSchema.safeParse("Polish, please").success).toBe(false);
  });
});

describe("parseSuggestResponse", () => {
  it("parses items into deltas", () => {
    const out = parseSuggestResponse('{"items":[{"envelopeId":"e","proposedDelta":100,"rationale":"x","confidence":0.5}]}');
    expect(out).toEqual([{ envelopeId: "e", proposedDelta: 100, rationale: "x", confidence: 0.5 }]);
  });

  it("tolerates prose around the JSON and missing optional fields", () => {
    const out = parseSuggestResponse('Sure! {"items":[{"envelopeId":"e2","proposedDelta":50}]} done');
    expect(out).toEqual([{ envelopeId: "e2", proposedDelta: 50, rationale: undefined, confidence: undefined }]);
  });

  it("returns [] when items are absent", () => {
    expect(parseSuggestResponse("{}")).toEqual([]);
  });
});

describe("buildAgentSuggestContext / buildAgentSuggestPrompt", () => {
  const ledger = fixture();
  const basis = buildBudgetSuggestionBasis({ ledger, month: "2026-07", profile: "custom", customPrompt: "pomiń Obligacje" });
  const ctx = buildAgentSuggestContext({ ledger, month: "2026-07", basis, directive: "pomiń Obligacje", locale: "pl" });

  it("ctx: month state per active envelope (group by NAME) + PREVIOUS month + amount from basis", () => {
    expect(ctx.month).toBe("2026-07");
    expect(ctx.amount).toBe(basis.amountToDistribute);
    expect(ctx.envelopes).toEqual([
      { id: "E1", name: "Jedzenie", group: "Grupa", allocated: 0, spent: 0, available: 0, carryIn: 0, monthlyTarget: null, isSavings: false },
      { id: "E2", name: "Obligacje", group: "Grupa", allocated: 0, spent: 0, available: 0, carryIn: 0, monthlyTarget: null, isSavings: true },
    ]);
    expect(ctx.prevMonth.month).toBe("2026-06");
    expect((ctx.prevMonth.envelopes as Array<{ id: string }>).map((e) => e.id)).toEqual(["E1", "E2"]);
    expect(ctx.directive).toBe("pomiń Obligacje");
  });

  it("prompt: agent role + hard rules + language directives; STRICT json_schema {items}", () => {
    const req = buildAgentSuggestPrompt(ctx);
    const sys = sysOf(req.messages);
    expect(sys).toContain("You are an envelope-budgeting agent.");
    expect(sys).toContain("The user's directive is the PRIMARY decision criterion");
    expect(sys).toContain('[{"envelopeId":string,"amount":int}]');
    expect(sys).toContain("use only envelopeId values from the provided list");
    expect(sys).toContain("you may skip envelopes");
    expect(sys).toContain("Write all text you GENERATE (names, notes, rationales) in Polish.");
    expect(sys).toContain("do not translate data values");
    expect((req.responseFormat as any).json_schema.strict).toBe(true);
    expect((req.responseFormat as any).json_schema.schema.properties.items).toBeDefined();
  });

  it("user message: the amount, BOTH months (current + previous as reference) and the directive", () => {
    const req = buildAgentSuggestPrompt(ctx);
    const user = JSON.parse(req.messages[1]!.content as string) as Record<string, any>;
    expect(user.amountToDistribute).toBe(basis.amountToDistribute);
    expect(user.currentMonth.month).toBe("2026-07");
    expect((user.currentMonth.envelopes as Array<{ name: string }>).map((e) => e.name)).toEqual(["Jedzenie", "Obligacje"]);
    expect(user.previousMonth.month).toBe("2026-06");
    expect(user.previousMonth.note).toContain("reference");
    expect((user.previousMonth.envelopes as Array<{ id: string }>).map((e) => e.id)).toEqual(["E1", "E2"]);
    expect(user.directive).toBe("pomiń Obligacje");
  });

  it("locale en: the language directive switches like in the other prompts", () => {
    const en = buildAgentSuggestPrompt({ ...ctx, locale: "en" });
    expect(sysOf(en.messages)).toContain("Write all text you GENERATE (names, notes, rationales) in English.");
  });
});

describe("parseAgentSuggestResponse", () => {
  it("parses a plain JSON array into ProposedEnvelopeDelta[]", () => {
    const out = parseAgentSuggestResponse('[{"envelopeId":"E1","amount":6000},{"envelopeId":"E2","amount":4000}]');
    expect(out).toEqual([
      { envelopeId: "E1", proposedDelta: 6000 },
      { envelopeId: "E2", proposedDelta: 4000 },
    ]);
  });

  it("tolerates a ```json fence and prose around the array", () => {
    const out = parseAgentSuggestResponse('Sure!\n```json\n[{"envelopeId":"E1","amount":100}]\n```\ndone');
    expect(out).toEqual([{ envelopeId: "E1", proposedDelta: 100 }]);
  });

  it("drops entries with negative/non-integer/missing amounts or missing envelopeId; ignores unknown fields", () => {
    const out = parseAgentSuggestResponse(
      '[{"envelopeId":"E1","amount":100,"note":"extra"},{"envelopeId":"E2","amount":-5},{"envelopeId":"E1","amount":1.5},{"amount":7},{"envelopeId":"","amount":3},"junk",{"envelopeId":"E2","amount":0}]',
    );
    expect(out).toEqual([
      { envelopeId: "E1", proposedDelta: 100 },
      { envelopeId: "E2", proposedDelta: 0 },
    ]);
  });

  it("returns [] for garbage, non-array JSON and missing brackets", () => {
    expect(parseAgentSuggestResponse("total nonsense")).toEqual([]);
    expect(parseAgentSuggestResponse('{"items":1}')).toEqual([]);
    expect(parseAgentSuggestResponse("[not json]")).toEqual([]);
  });
});

describe("buildQuickAddPrompt / parseQuickAddResponse", () => {
  const refs = { envelopes: [{ id: "E1", name: "Jedzenie" }], places: [{ id: "P1", name: "Lidl" }] };

  it("builds the parser prompt with today, refs and verbatim language directives", () => {
    const req = buildQuickAddPrompt("Lidl 12,50 wczoraj", refs, "2026-07-07", "pl");
    const sys = sysOf(req.messages);
    expect(sys).toContain("You are a budget transaction parser.");
    expect(sys).toContain("Write all text you GENERATE (names, notes, rationales) in Polish.");
    expect(sys).toContain("do not translate data values");
    expect(sys).toContain("Today: 2026-07-07.");
    expect(sys).toContain("Available envelopes: Jedzenie.");
    expect(sys).toContain("Places: Lidl.");
    expect(req.messages[1]).toEqual({ role: "user", content: "Lidl 12,50 wczoraj" });
    expect(req.responseFormat).toEqual({ type: "json_object" }); // quick-add deliberately non-strict (many nullable fields)
  });

  it("parses valid fields", () => {
    const out = parseQuickAddResponse('{"amount":1250,"type":"income","isRefund":true,"date":"2026-07-06","envelopeName":"Jedzenie","placeName":"Lidl"}');
    expect(out).toEqual({ amount: 1250, type: "income", isRefund: true, date: "2026-07-06", envelopeName: "Jedzenie", placeName: "Lidl" });
  });

  it("nulls invalid fields so the caller keeps its base values", () => {
    const out = parseQuickAddResponse('{"amount":"12","type":"weird","date":"jutro"}');
    expect(out).toEqual({ amount: null, type: "expense", isRefund: false, date: null, envelopeName: null, placeName: null });
  });
});

describe("buildImportExtractPrompt / parseImportExtractResponse", () => {
  const refs = { envelopes: [{ id: "E1", name: "Jedzenie" }], categories: [] };

  it("builds vision messages with data-URL image parts and a json_schema format", () => {
    const req = buildImportExtractPrompt(["data:image/png;base64,AAA"], refs, "2026-07-07", "pl");
    const sys = sysOf(req.messages);
    expect(sys).toContain("You extract transactions from screenshots");
    expect(sys).toContain("Today is 2026-07-07");
    expect(sys).toContain("Write all text you GENERATE (names, notes, rationales) in Polish.");
    expect(sys).toContain("do not translate data values");
    const content = req.messages[1]!.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Extract all transactions from these screenshots." });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "high" } });
    expect((req.responseFormat as { type: string; json_schema: { name: string } }).type).toBe("json_schema");
    expect((req.responseFormat as { type: string; json_schema: { name: string } }).json_schema.name).toBe("extracted_transactions");
  });

  it("parses transactions and normalizes the tag to UPPERCASE", () => {
    const out = parseImportExtractResponse('{"transactions":[{"date":"2026-07-01","amount":1299,"type":"expense","rawPlace":"LIDL SP Z OO WARSZAWA","tag":" lidl "}]}');
    expect(out).toEqual([{ date: "2026-07-01", amount: 1299, type: "expense", rawPlace: "LIDL SP Z OO WARSZAWA", tag: "LIDL" }]);
  });

  it("throws on a malformed payload (route maps this to 502)", () => {
    expect(() => parseImportExtractResponse('{"transactions":[{"date":"1 lipca","amount":-5,"type":"expense","rawPlace":"x","tag":"X"}]}')).toThrow();
  });
});

describe("reasoningEffort — fast responses for suggest/quick-add", () => {
  it("suggest (rules+AI), agent and quick-add set low; import extract does NOT (OCR precision)", () => {
    const ledger = fixture();
    const basis = buildBudgetSuggestionBasis({ ledger, month: "2026-07", profile: "custom", customPrompt: "x" });
    const agentReq = buildAgentSuggestPrompt(buildAgentSuggestContext({ ledger, month: "2026-07", basis, directive: "x", locale: "pl" }));
    expect(agentReq.reasoningEffort).toBe("low");
    const sugReq = buildSuggestPrompt({ basis, ledger, month: "2026-07", profile: "cautious", locale: "pl" });
    expect(sugReq.reasoningEffort).toBe("low");
    const qaReq = buildQuickAddPrompt("kawa 12", { envelopes: [], places: [], categories: [] }, "2026-07-11", "pl");
    expect(qaReq.reasoningEffort).toBe("low");
    const impReq = buildImportExtractPrompt([], { envelopes: [], categories: [] }, "2026-07-11", "pl");
    expect(impReq.reasoningEffort).toBeUndefined();
  });
  it("supportsReasoningEffort: gpt-5*/o* yes, others no", () => {
    expect(supportsReasoningEffort("gpt-5.5")).toBe(true);
    expect(supportsReasoningEffort("gpt-5.5-mini")).toBe(true);
    expect(supportsReasoningEffort("o3-mini")).toBe(true);
    expect(supportsReasoningEffort("gpt-4o")).toBe(false);
  });
});

describe("parseAgentSuggestResponse — structured output {items}", () => {
  it("parses a strict json_schema response (object with items)", () => {
    const out = parseAgentSuggestResponse('{"items":[{"envelopeId":"E1","amount":6000},{"envelopeId":"E2","amount":4000}]}');
    expect(out).toEqual([
      { envelopeId: "E1", proposedDelta: 6000 },
      { envelopeId: "E2", proposedDelta: 4000 },
    ]);
  });
  it("a bare array still works (compatibility)", () => {
    expect(parseAgentSuggestResponse('[{"envelopeId":"E1","amount":100}]')).toEqual([{ envelopeId: "E1", proposedDelta: 100 }]);
  });
});
