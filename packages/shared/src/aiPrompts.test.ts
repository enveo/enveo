import { describe, expect, it } from "bun:test";
import { buildBudgetSuggestionBasis } from "./aiBudget";
import {
  aiLocaleSchema,
  buildAgentSuggestContext,
  buildAgentSuggestPrompt,
  buildImportEnrichPrompt,
  buildImportExtractPrompt,
  buildSuggestPrompt,
  type ChatMessage,
  IMPORT_EXTRACT_JSON_SCHEMA,
  languageDirectives,
  languageName,
  parseAgentSuggestResponse,
  parseImportEnrichResponse,
  parseImportExtractResponse,
  parseSuggestResponse,
  runImportRecognitionPipeline,
  supportsReasoningEffort,
} from "./aiPrompts";
import type { ImportHistoryRecord } from "./importHistory";
import type { ImportRecognitionResult } from "./importRecognition";
import type { ClientLedger, Transaction } from "./types";

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
      sysOf(buildImportExtractPrompt([], { envelopes: [], categories: [] }, "2026-07-13", "de", "EUR").messages),
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

describe("buildImportExtractPrompt / parseImportExtractResponse", () => {
  const refs = { envelopes: [{ id: "E1", name: "Jedzenie" }], categories: [] };

  it("builds vision messages with data-URL image parts and a json_schema format", () => {
    const req = buildImportExtractPrompt(["data:image/png;base64,AAA"], refs, "2026-07-07", "pl", "PLN");
    const sys = sysOf(req.messages);
    expect(sys).toContain("You extract facts from screenshots");
    expect(sys).toContain("Today is 2026-07-07");
    expect(sys).toContain("Write all text you GENERATE (names, notes, rationales) in Polish.");
    expect(sys).toContain("do not translate data values");
    const content = req.messages[1]!.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Extract all transactions from these screenshots." });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "high" } });
    expect((req.responseFormat as { type: string; json_schema: { name: string } }).type).toBe("json_schema");
    expect((req.responseFormat as { type: string; json_schema: { name: string } }).json_schema.name).toBe("extracted_transactions");
  });

  it("binds the structured-output image index to the supplied screenshot count", () => {
    const req = buildImportExtractPrompt(["data:image/png;base64,AAA", "data:image/png;base64,BBB"], refs, "2026-07-07", "pl", "PLN");
    const imageIndex = (req.responseFormat as any).json_schema.schema.properties.rows.items.properties.imageIndex;

    expect(imageIndex).toEqual({ type: "integer", minimum: 0, maximum: 1 });
  });

  it("groups one coherent list entry without splitting its secondary text into invented transactions", () => {
    const sys = sysOf(buildImportExtractPrompt([], refs, "2026-07-07", "pl", "PLN").messages);
    expect(sys).toContain("One output row means one coherent transaction-list entry");
    expect(sys).toContain("Group its amount, merchant/payee, card suffix, and secondary text");
    expect(sys).toContain("Do not create separate rows for icons, loyalty/reward points");
    expect(sys).toContain("imageIndex plus visualOrder");
    expect(sys).toContain("rawTextLines");
    expect(sys).toContain("ui_metadata");
    expect(sys).toContain("relationships by rowId");
    expect(sys).toContain("facts from screenshots");
  });

  it("keeps FX evidence as a linked row instead of silently merging it", () => {
    const sys = sysOf(buildImportExtractPrompt([], refs, "2026-07-07", "pl", "PLN").messages);
    expect(sys).toContain("account currency is PLN");
    expect(sys).toContain("supporting_detail");
    expect(sys).toContain("fx_for");
    expect(sys).toContain("primary ledger amount");
    expect(sys).toContain("never use a balance, loyalty/reward points, card suffix, or exchange rate as amount");
    expect(sys).toContain("NEVER convert or guess an exchange rate");
  });

  it("anchors direction and inherited dates in visible evidence instead of semantic guesses", () => {
    const sys = sysOf(buildImportExtractPrompt([], refs, "2026-07-07", "pl", "PLN").messages);
    expect(sys).toContain("An explicit + or incoming label means credit; an explicit − or outgoing label means debit");
    expect(sys).toContain("Do not infer direction from semanticKind");
    expect(sys).toContain("unsigned amounts in the contrasting incoming style mean credit");
    expect(sys).toContain("absence of a minus or a color alone is not proof of credit");
    expect(sys).toContain("A visible date divider applies to the transaction entries below it");
  });

  it("distinguishes one ledger movement from secondary numbers inside the same entry", () => {
    const sys = sysOf(buildImportExtractPrompt([], refs, "2026-07-07", "pl", "PLN").messages);

    expect(sys).toContain("exactly one financial_event for each coherent entry with a primary ledger amount");
    expect(sys).toContain("amount is the positive magnitude without its visible sign");
    expect(sys).toContain("Store the visible sign only in direction");
    expect(sys).not.toContain("signed ledger amount");
    expect(sys).toContain("A reward, refund, top-up, deposit, or transfer entry is still a financial_event");
    expect(sys).toContain("Repeated entries remain separate even when their text and amount are identical");
    expect(sys).toContain("Count the visible primary ledger amounts before answering");
    expect(sys).toContain("An adjacent FX conversion or rate block stays a separate supporting_detail row");
    expect(sys).toContain("Classify semanticKind from the visible event wording even when another fact is missing or unsupported");
    expect(sys).toContain("A word in a merchant name or your own uncertainty is not a pending or declined marker");
    expect(sys).toContain("Use duplicate_of only when the same entry is visibly repeated across overlapping screenshots");
    expect(sys).toContain("Compare all supplied screenshots for overlap before answering");
    expect(sys).toContain("Use posted for an ordinary completed history entry with no pending or declined marker");
    expect(sys).toContain("Use unknown only when the status itself is unreadable or ambiguous");
    expect(sys).toContain("A clock, hourglass, spinner, or explicit pending word attached to an entry is a pending marker");
    expect(sys).toContain("When any digit of the primary amount is obscured, clipped, or unreadable, use amount null");
    expect(sys).toContain("Set relation to null unless the screenshot visibly establishes the link");
  });

  it("strict json_schema requires every extraction fact", () => {
    const schema = IMPORT_EXTRACT_JSON_SCHEMA.schema.properties.rows.items as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.properties.direction!.enum).toEqual(["debit", "credit", "unknown"]);
    expect(schema.properties.postingStatus!.enum).toEqual(["posted", "pending", "declined", "unknown"]);
    expect(schema.properties.rowRole!.enum).toEqual(["financial_event", "supporting_detail", "ui_metadata"]);
    expect(schema.properties.currency).toBeDefined();
    expect(schema.properties.relation).toBeDefined();
    expect(schema.properties.reviewReasons).toBeDefined();
    expect(schema.properties.imageIndex).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties.visualOrder).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties.amount).toMatchObject({ type: ["integer", "null"], exclusiveMinimum: 0 });
    expect(schema.required).toContain("currency");
    expect(schema.required).toContain("relation");
    expect(schema.required).toContain("reviewReasons");
  });

  it("throws on a malformed payload (route maps this to 502)", () => {
    expect(() =>
      parseImportExtractResponse(
        '{"rows":[{"rowId":"r1","imageIndex":0,"visualOrder":0,"rawTextLines":[],"date":"1 lipca","amount":-5,"currency":"PLN","direction":"debit","postingStatus":"posted","rowRole":"financial_event","semanticKind":"card_purchase","relation":null,"confidence":"high","reviewReasons":[]}]}',
        1,
      ),
    ).toThrow();
  });

  it("throws when a strict extraction fact is missing", () => {
    expect(() => parseImportExtractResponse('{"rows":[{"rowId":"r1"}]}', 1)).toThrow();
  });

  it("canonicalizes duplicate visual positions using the model row order as a stable tie-breaker", () => {
    const row = (rowId: string, imageIndex: number, visualOrder: number) => ({
      rowId,
      imageIndex,
      visualOrder,
      rawTextLines: [rowId],
      date: "2026-08-07",
      amount: 1234,
      currency: "PLN",
      direction: "debit",
      postingStatus: "posted",
      rowRole: "financial_event",
      semanticKind: "card_purchase",
      relation: null,
      confidence: "high",
      reviewReasons: [],
    });

    const parsed = parseImportExtractResponse(
      JSON.stringify({ rows: [row("second", 0, 5), row("first", 0, 0), row("third", 0, 5), row("next-image", 1, 8)] }),
      2,
    );

    expect(parsed.rows.map(({ rowId, imageIndex, visualOrder }) => [rowId, imageIndex, visualOrder])).toEqual([
      ["first", 0, 0],
      ["second", 0, 1],
      ["third", 0, 2],
      ["next-image", 1, 0],
    ]);
  });

  it("normalizes a zero model amount to an unknown fact instead of rejecting the whole screenshot", () => {
    const parsed = parseImportExtractResponse(
      JSON.stringify({
        rows: [
          {
            rowId: "supporting-rate",
            imageIndex: 0,
            visualOrder: 0,
            rawTextLines: ["1.00 PLN = 0.231677 EUR"],
            date: "2026-08-07",
            amount: 0,
            currency: "PLN",
            direction: "unknown",
            postingStatus: "posted",
            rowRole: "supporting_detail",
            semanticKind: "fx_conversion",
            relation: null,
            confidence: "medium",
            reviewReasons: [],
          },
        ],
      }),
      1,
    );

    expect(parsed.rows[0]!.amount).toBeNull();
  });
});

describe("buildImportEnrichPrompt / parseImportEnrichResponse", () => {
  const recognition = {
    rows: [
      {
        rowId: "r1",
        imageIndex: 0,
        visualOrder: 0,
        rawTextLines: ["LIDL 123"],
        date: "2026-08-07",
        amount: 1234,
        currency: "PLN",
        direction: "debit" as const,
        postingStatus: "posted" as const,
        rowRole: "financial_event" as const,
        semanticKind: "card_purchase" as const,
        relation: null,
        confidence: "medium" as const,
        reviewReasons: ["history_conflict" as const],
      },
    ],
    proposals: [
      {
        rowId: "r1",
        sourceRows: ["r1"],
        disposition: "candidate" as const,
        date: "2026-08-07",
        amount: 1234,
        currency: "PLN",
        type: "expense" as const,
        isRefund: false,
        toAccountId: null,
        semanticKind: "card_purchase" as const,
        relation: null,
        name: "",
        tag: "",
        rawPlace: "LIDL 123",
        envelopeId: null,
        categoryId: null,
        placeName: null,
        reviewReasons: ["history_conflict" as const],
        selected: false,
      },
    ],
  };

  it("sends validated facts, bounded history evidence, and only current entity ids", () => {
    const req = buildImportEnrichPrompt(
      {
        result: recognition,
        history: [
          {
            rowId: "r1",
            selection: {
              conflict: true,
              candidates: [
                {
                  sourceRef: "LIDL 123",
                  tag: "LIDL",
                  place: "Lidl",
                  name: "Groceries",
                  envelope: "Food",
                  category: "Daily",
                  type: "expense",
                  isRefund: false,
                  toAccountId: null,
                  count: 2,
                  match: "exact_source_ref",
                },
              ],
            },
          },
        ],
        envelopes: [{ id: "envelope-1", name: "Food" }],
        categories: [{ id: "category-1", name: "Daily" }],
        accounts: [{ id: "account-1", name: "Checking" }],
      },
      "pl",
    );
    const user = JSON.parse(req.messages[1]!.content as string) as Record<string, unknown>;
    expect(user).toMatchObject({
      entities: {
        envelopes: [{ id: "envelope-1", name: "Food" }],
        categories: [{ id: "category-1", name: "Daily" }],
        accounts: [{ id: "account-1", name: "Checking" }],
      },
    });
    expect(JSON.stringify(user)).toContain("LIDL 123");
    expect(req.reasoningEffort).toBe("low");
    expect(sysOf(req.messages)).toContain("existing id or null");
    expect(sysOf(req.messages)).toContain("Return each supplied reviewReasons list unchanged");
  });

  it("exposes only semantic annotation fields in the strict response schema", () => {
    const req = buildImportEnrichPrompt({ result: recognition, history: [], envelopes: [], categories: [], accounts: [] }, "en");
    const schema = (req.responseFormat as any).json_schema.schema.properties.rows.items;
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["categoryId", "envelopeId", "name", "place", "relation", "reviewReasons", "rowId", "semanticKind"].sort(),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("amount");
    expect(schema.properties).not.toHaveProperty("date");
    expect(schema.properties).not.toHaveProperty("currency");
    expect(schema.properties).not.toHaveProperty("direction");
  });

  it("parses semantic fields while retaining a private marker for attempted fact corrections", () => {
    const parsed = parseImportEnrichResponse(
      JSON.stringify({
        rows: [
          {
            rowId: "r1",
            name: "Groceries",
            place: "Lidl",
            envelopeId: "envelope-1",
            categoryId: null,
            semanticKind: "card_purchase",
            relation: null,
            reviewReasons: [],
            amount: 1,
          },
        ],
      }),
      { envelopeIds: ["envelope-1"], categoryIds: [], accountIds: ["account-1"] },
    );
    expect(parsed.rows[0]).toMatchObject({ rowId: "r1", name: "Groceries", envelopeId: "envelope-1", factCorrectionAttempt: true });
    expect(parsed.allowedEnvelopeIds).toEqual(["envelope-1"]);
  });
});

describe("runImportRecognitionPipeline", () => {
  const extracted = (
    semanticKind: "card_purchase" | "unknown" | "incoming_transfer" | "account_topup" = "card_purchase",
    postingStatus: "posted" | "unknown" = "posted",
  ) =>
    JSON.stringify({
      rows: [
        {
          rowId: "r1",
          imageIndex: 0,
          visualOrder: 0,
          rawTextLines: ["LIDL 123"],
          date: "2026-08-07",
          amount: 1234,
          currency: "PLN",
          direction: semanticKind === "unknown" ? "unknown" : semanticKind === "incoming_transfer" || semanticKind === "account_topup" ? "credit" : "debit",
          postingStatus,
          rowRole: "financial_event",
          semanticKind,
          relation: null,
          confidence: "medium",
          reviewReasons: [],
        },
      ],
    });
  const history = (accountId: string, envelope: string): ImportHistoryRecord => ({
    accountId,
    currency: "PLN",
    sourceRef: "LIDL 123",
    tag: "LIDL",
    place: "Lidl",
    name: "Groceries",
    envelope,
    category: null,
    type: "expense",
    isRefund: false,
    toAccountId: null,
  });
  const base = {
    images: ["data:image/png;base64,AA=="],
    locale: "pl",
    today: "2026-08-16",
    budgetCurrency: "PLN",
    accountId: "account-1",
    accounts: [
      {
        id: "account-1",
        name: "Checking",
        color: "#000",
        icon: "wallet",
        type: "checking" as const,
        onBudget: true,
        initialBalance: 0,
        archived: false,
        sort: 0,
        automaticEnvelopeId: null,
      },
      {
        id: "account-2",
        name: "Savings",
        color: "#000",
        icon: "wallet",
        type: "savings" as const,
        onBudget: true,
        initialBalance: 0,
        archived: false,
        sort: 1,
        automaticEnvelopeId: null,
      },
    ],
    envelopes: [
      {
        id: "envelope-1",
        groupId: "group-1",
        name: "Food",
        color: "#000",
        icon: "tag",
        note: null,
        monthlyTarget: null,
        isSavings: false,
        sort: 0,
        archived: false,
      },
    ],
    categories: [],
    transactions: [],
    historyRecords: [] as ImportHistoryRecord[],
  };

  it("skips cycle two for a straightforward posted purchase", async () => {
    const requests: ChatRequest[] = [];
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async (request) => {
        requests.push(request);
        return extracted();
      },
    });
    expect(requests).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ rowId: "r1", semanticKind: "card_purchase", name: "", selected: true });
  });

  it("skips unnecessary enrichment for a straightforward exact duplicate", async () => {
    const requests: ChatRequest[] = [];
    const duplicate: Transaction = {
      id: "default-duplicate",
      type: "expense",
      accountId: "account-1",
      toAccountId: null,
      amount: 1234,
      date: "2026-08-07",
      isRefund: false,
      envelopeId: null,
      placeId: null,
      categoryId: null,
      name: "Existing",
      note: null,
      tag: null,
      sourceRef: "LIDL 123",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-08-07T00:00:00.000Z",
    };
    const result = await runImportRecognitionPipeline({
      ...base,
      transactions: [duplicate],
      chat: async (request) => {
        requests.push(request);
        if (requests.length === 1) return extracted();
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "Duplicate enrichment",
              place: "Lidl",
              envelopeId: null,
              categoryId: null,
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: [],
            },
          ],
        });
      },
    });

    expect(requests).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ duplicateStatus: "exists", disposition: "declined", selected: false, reviewReasons: [] });
  });

  it("checkpoints cycle one and resumes without screenshots or another extraction request", async () => {
    const phases: string[] = [];
    let checkpoint: ImportRecognitionResult | undefined;
    await runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      chat: async () => extracted(),
      lifecycle: {
        afterUpstream: async () => phases.push("upstream"),
        saveExtraction: async (result) => {
          checkpoint = result;
          phases.push("checkpoint");
        },
        advancePhase: async (phase) => phases.push(phase),
      },
    });
    expect(phases).toEqual(["upstream", "checkpoint", "reconciling"]);
    if (!checkpoint) throw new Error("expected durable extraction checkpoint");

    const resumedPhases: string[] = [];
    const resumed = await runImportRecognitionPipeline({
      ...base,
      images: [],
      checkpoint,
      pipelineMode: "durable",
      chat: async () => {
        throw new Error("resume_must_not_extract_again");
      },
      lifecycle: { advancePhase: async (phase) => resumedPhases.push(phase) },
    });

    expect(resumedPhases).toEqual(["reconciling"]);
    expect(resumed.proposals[0]).toMatchObject({ rowId: "r1", selected: true });
  });

  it("stores validated extraction before history and stores enriched Stage A before live-ledger reconciliation", async () => {
    const saved: { extraction?: ImportRecognitionResult; result?: ImportRecognitionResult } = {};
    let calls = 0;
    const duplicate: Transaction = {
      id: "transaction-1",
      type: "expense",
      accountId: "account-1",
      toAccountId: null,
      amount: 1234,
      date: "2026-08-07",
      isRefund: false,
      envelopeId: null,
      placeId: null,
      categoryId: null,
      name: "Existing",
      note: null,
      tag: null,
      sourceRef: "LIDL 123",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-08-07T00:00:00.000Z",
    };

    const returned = await runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      transactions: [duplicate],
      historyRecords: [history("account-1", "Food"), history("account-1", "Travel")],
      chat: async () => {
        calls++;
        if (calls === 1) return extracted("unknown");
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "Fresh enrichment",
              place: "Lidl",
              envelopeId: "envelope-1",
              categoryId: null,
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: [],
            },
          ],
        });
      },
      lifecycle: {
        saveExtraction: async (value) => {
          saved.extraction = value;
        },
        saveResult: async (value) => {
          saved.result = value;
        },
      },
    });

    expect(saved.extraction?.proposals[0]).toMatchObject({
      name: "",
      envelopeId: null,
      disposition: "unresolved",
      selected: true,
      reviewReasons: ["unknown_kind"],
    });
    expect(saved.extraction?.proposals[0]?.reviewReasons).not.toContain("history_conflict");
    expect(saved.result?.proposals[0]).toMatchObject({
      name: "Fresh enrichment",
      envelopeId: "envelope-1",
      disposition: "candidate",
      selected: false,
    });
    expect(Object.hasOwn(saved.result?.proposals[0] ?? {}, "duplicateStatus")).toBe(false);
    expect(returned.proposals[0]).toMatchObject({ duplicateStatus: "exists", disposition: "declined", selected: false });
  });

  it("keeps a durable exact duplicate as pre-reconcile Stage A while returning current reconciliation", async () => {
    const duplicate: Transaction = {
      id: "durable-duplicate",
      type: "expense",
      accountId: "account-1",
      toAccountId: null,
      amount: 1234,
      date: "2026-08-07",
      isRefund: false,
      envelopeId: null,
      placeId: null,
      categoryId: null,
      name: "Existing",
      note: null,
      tag: null,
      sourceRef: "LIDL 123",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-08-07T00:00:00.000Z",
    };
    let calls = 0;
    let durableResult: ImportRecognitionResult | undefined;
    const returned = await runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      cycleTwoFailureMode: "strict",
      transactions: [duplicate],
      chat: async () => {
        calls++;
        if (calls > 1) throw new Error("durable duplicate should not enrich from live reconciliation");
        return extracted();
      },
      lifecycle: { saveResult: async (value) => (durableResult = value) },
    });

    expect(calls).toBe(1);
    expect(durableResult?.proposals[0]).toMatchObject({ disposition: "candidate", selected: true, reviewReasons: [] });
    expect(Object.hasOwn(durableResult?.proposals[0] ?? {}, "duplicateStatus")).toBe(false);
    expect(returned.proposals[0]).toMatchObject({ duplicateStatus: "exists", disposition: "declined", selected: false });
  });

  it("reconciles a resumed raw checkpoint against the changed ledger instead of creation-time proposal state", async () => {
    let rawCheckpoint: ImportRecognitionResult | undefined;
    await runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      chat: async () => extracted(),
      lifecycle: { saveExtraction: async (value) => (rawCheckpoint = value) },
    });
    if (!rawCheckpoint) throw new Error("expected raw checkpoint");
    const contaminatedCheckpoint: ImportRecognitionResult = {
      ...rawCheckpoint,
      proposals: rawCheckpoint.proposals.map((proposal) => ({
        ...proposal,
        disposition: "declined",
        selected: false,
        envelopeId: "creation-time-envelope",
        reviewReasons: [...proposal.reviewReasons, "history_conflict"],
      })),
    };
    const resumed = await runImportRecognitionPipeline({
      ...base,
      images: [],
      checkpoint: contaminatedCheckpoint,
      pipelineMode: "durable",
      transactions: [],
      chat: async () => {
        throw new Error("resume_must_not_extract_or_enrich");
      },
    });

    expect(resumed.proposals[0]).toMatchObject({
      envelopeId: null,
      duplicateStatus: "new",
      disposition: "candidate",
      selected: true,
    });
    expect(resumed.proposals[0]?.reviewReasons).not.toContain("history_conflict");
  });

  it("recomputes history and enrichment from current records when a raw checkpoint resumes", async () => {
    let rawCheckpoint: ImportRecognitionResult | undefined;
    await runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      chat: async () => extracted("card_purchase", "unknown"),
      lifecycle: { saveExtraction: async (value) => (rawCheckpoint = value) },
    });
    if (!rawCheckpoint) throw new Error("expected raw checkpoint");

    let enrichmentPrompt = "";
    const resumed = await runImportRecognitionPipeline({
      ...base,
      images: [],
      checkpoint: rawCheckpoint,
      pipelineMode: "durable",
      historyRecords: [history("account-1", "Food"), history("account-1", "Travel")],
      chat: async (request) => {
        enrichmentPrompt = request.messages[1]!.content as string;
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "From current history",
              place: "Lidl",
              envelopeId: null,
              categoryId: null,
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: [],
            },
          ],
        });
      },
    });

    expect(enrichmentPrompt).toContain("Food");
    expect(enrichmentPrompt).toContain("Travel");
    expect(resumed.proposals[0]?.name).toBe("From current history");
    expect(resumed.proposals[0]?.reviewReasons).toEqual(expect.arrayContaining(["history_conflict", "multiple_history_candidates"]));
  });

  it.each([
    ["upstream", new Error("cycle-two-network")],
    ["malformed", null],
  ] as const)("propagates %s cycle-two failures in durable strict mode", async (_kind, upstreamError) => {
    let calls = 0;
    const run = runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      cycleTwoFailureMode: "strict",
      chat: async () => {
        calls++;
        if (calls === 1) return extracted("unknown");
        if (upstreamError) throw upstreamError;
        return '{"rows":null}';
      },
    });

    if (upstreamError) {
      await expect(run).rejects.toThrow("cycle-two-network");
    } else {
      await expect(run).rejects.toMatchObject({ name: "ImportEnrichmentMalformedError" });
    }
  });

  it("uses only the selected account's compatible history and constrains cycle-two ids", async () => {
    const requests: ChatRequest[] = [];
    const result = await runImportRecognitionPipeline({
      ...base,
      historyRecords: [history("account-1", "Food"), history("account-1", "Travel"), history("account-2", "Secret")],
      chat: async (request) => {
        requests.push(request);
        if (requests.length === 1) return extracted();
        const user = request.messages[1]!.content as string;
        expect(user).toContain("Food");
        expect(user).toContain("Travel");
        expect(user).not.toContain("Secret");
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "Zakupy",
              place: "Lidl",
              envelopeId: "envelope-1",
              categoryId: null,
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: [],
            },
          ],
        });
      },
    });
    expect(requests).toHaveLength(2);
    expect(result.proposals[0]).toMatchObject({ name: "Zakupy", envelopeId: "envelope-1", selected: true });
    expect(result.proposals[0]!.reviewReasons).toEqual(expect.arrayContaining(["history_conflict", "multiple_history_candidates"]));
  });

  it.each(["unknown", "credit"])("uses prior reimbursements as reviewable counterevidence for a purchase with %s direction", async (direction) => {
    // given: the image has no sign, and a matching earlier entry was a reimbursement
    let calls = 0;
    const refundHistory = { ...history("account-1", "Food"), isRefund: true };
    const result = await runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      historyRecords: [refundHistory],
      chat: async (request) => {
        if (++calls === 1) {
          const batch = JSON.parse(extracted());
          batch.rows[0].direction = direction;
          return JSON.stringify(batch);
        }
        const input = JSON.parse(request.messages[1]!.content as string);
        expect(input.rows[0].historyCandidates).toMatchObject([{ isRefund: true }]);
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "Reimbursement",
              place: null,
              envelopeId: null,
              categoryId: null,
              semanticKind: "merchant_refund",
              relation: null,
              reviewReasons: [],
            },
          ],
        });
      },
    });
    // then: the proposed refund needs a human selection and never rewrites the read sign
    expect(result.rows[0]?.direction).toBe(direction);
    expect(result.proposals[0]).toMatchObject({ type: "expense", isRefund: true, selected: false });
    expect(result.proposals[0]?.reviewReasons).toContain("history_conflict");
    expect(result.proposals[0]?.reviewReasons).not.toContain("inconsistent_direction");
  });

  it("offers a completed but unselected income proposal after resolving an unsigned unknown entry", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      pipelineMode: "durable",
      historyRecords: [{ ...history("account-1", "Food"), type: "income" }],
      chat: async (request) => {
        if (++calls === 1) return extracted("unknown");
        const input = JSON.parse(request.messages[1]!.content as string);
        expect(input.rows[0].historyCandidates).toMatchObject([{ type: "income" }]);
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "Invoice payment",
              place: null,
              envelopeId: null,
              categoryId: null,
              semanticKind: "incoming_transfer",
              relation: null,
              reviewReasons: [],
            },
          ],
        });
      },
    });
    expect(result.proposals[0]).toMatchObject({ type: "income", disposition: "candidate", selected: false });
    expect(result.proposals[0]?.reviewReasons).not.toContain("unknown_kind");
  });

  it("does not let an enrichment annotation turn a visible debit into a refund", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async () =>
        ++calls === 1
          ? extracted("card_purchase", "unknown")
          : JSON.stringify({
              rows: [
                {
                  rowId: "r1",
                  name: "Refund guess",
                  place: null,
                  envelopeId: null,
                  categoryId: null,
                  semanticKind: "merchant_refund",
                  relation: null,
                  reviewReasons: [],
                },
              ],
            }),
    });
    expect(result.rows[0]?.direction).toBe("debit");
    expect(result.proposals[0]).toMatchObject({ type: "expense", isRefund: false });
    expect(result.proposals[0]?.reviewReasons).toContain("fact_correction");
  });

  it("keeps cycle-two fact corrections selected and visible after final validation and reconciliation", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async () => {
        calls++;
        if (calls === 1) {
          const value = JSON.parse(extracted()) as { rows: Array<Record<string, unknown>> };
          value.rows[0]!.semanticKind = "unknown";
          return JSON.stringify(value);
        }
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "Groceries",
              place: null,
              envelopeId: null,
              categoryId: null,
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: [],
              amount: 1,
            },
          ],
        });
      },
    });

    expect(calls).toBe(2);
    expect(result.proposals[0]).toMatchObject({ type: "expense", selected: true });
    expect(result.proposals[0]!.reviewReasons).toEqual(expect.arrayContaining(["fact_correction"]));
  });

  it("keeps action warnings on the selected financial row instead of its unselected supporting evidence", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async () => {
        calls++;
        if (calls === 1) {
          return JSON.stringify({
            rows: [
              {
                rowId: "fx",
                imageIndex: 0,
                visualOrder: 0,
                rawTextLines: ["100 EUR", "430 PLN"],
                date: "2026-08-07",
                amount: 43000,
                currency: "PLN",
                direction: "debit",
                postingStatus: "posted",
                rowRole: "supporting_detail",
                semanticKind: "fx_conversion",
                relation: null,
                confidence: "medium",
                reviewReasons: [],
              },
              {
                rowId: "purchase",
                imageIndex: 0,
                visualOrder: 1,
                rawTextLines: ["100 EUR", "MERCHANT"],
                date: "2026-08-07",
                amount: 10000,
                currency: "EUR",
                direction: "debit",
                postingStatus: "posted",
                rowRole: "financial_event",
                semanticKind: "unknown",
                relation: null,
                confidence: "medium",
                reviewReasons: [],
              },
            ],
          });
        }
        return JSON.stringify({
          rows: [
            {
              rowId: "fx",
              name: "",
              place: null,
              envelopeId: null,
              categoryId: null,
              semanticKind: "fx_conversion",
              relation: { kind: "fx_for", rowId: "purchase" },
              reviewReasons: ["relation_changes_ledger_shape"],
            },
            {
              rowId: "purchase",
              name: "Purchase",
              place: null,
              envelopeId: null,
              categoryId: null,
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: ["relation_changes_ledger_shape"],
            },
          ],
        });
      },
    });

    expect(calls).toBe(2);
    expect(result.proposals.find((proposal) => proposal.rowId === "fx")).toMatchObject({ selected: false, reviewReasons: [] });
    expect(result.proposals.find((proposal) => proposal.rowId === "purchase")?.reviewReasons).toContain("relation_changes_ledger_shape");
  });

  it("builds byte-identical cycle-two prompts for permutations of set-like ledger context", async () => {
    const envelope2 = { ...base.envelopes[0]!, id: "envelope-2", name: "Travel", sort: 1 };
    const categories = [
      { id: "category-1", name: "Groceries" },
      { id: "category-2", name: "Restaurants" },
    ];
    const histories = [history("account-1", "Food"), history("account-1", "Travel")];
    const cycleTwoContent = async (reverse: boolean): Promise<string> => {
      const requests: ChatRequest[] = [];
      await runImportRecognitionPipeline({
        ...base,
        accounts: reverse ? [...base.accounts].reverse() : [...base.accounts],
        envelopes: reverse ? [envelope2, ...base.envelopes] : [...base.envelopes, envelope2],
        categories: reverse ? [...categories].reverse() : categories,
        historyRecords: reverse ? [...histories].reverse() : histories,
        chat: async (request) => {
          requests.push(request);
          if (requests.length === 1) return extracted();
          return JSON.stringify({
            rows: [
              {
                rowId: "r1",
                name: "Groceries",
                place: "Lidl",
                envelopeId: "envelope-1",
                categoryId: "category-1",
                semanticKind: "card_purchase",
                relation: null,
                reviewReasons: [],
              },
            ],
          });
        },
      });
      expect(requests).toHaveLength(2);
      return requests[1]!.messages[1]!.content as string;
    };

    expect(await cycleTwoContent(false)).toBe(await cycleTwoContent(true));
  });

  it("returns validated raw proposals when cycle two fails", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async () => {
        calls++;
        if (calls === 1) return extracted("unknown");
        throw new Error("cycle-two-down");
      },
    });
    expect(calls).toBe(2);
    expect(result.proposals[0]).toMatchObject({ name: "", envelopeId: null, disposition: "unresolved", selected: true });
    expect(result.proposals[0]!.reviewReasons).toContain("unknown_kind");
  });

  it("keeps an incoming-transfer fallback mapped to selected income when cycle two fails", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async () => {
        calls++;
        if (calls === 1) return extracted("incoming_transfer");
        throw new Error("cycle-two-down");
      },
    });

    expect(calls).toBe(2);
    expect(result.proposals[0]).toMatchObject({ type: "income", disposition: "candidate", selected: true });
    expect(result.proposals[0]!.reviewReasons).toContain("possible_transfer");
  });

  it("keeps an account-top-up fallback mapped to selected income when cycle two fails", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async () => {
        calls++;
        if (calls === 1) return extracted("account_topup");
        throw new Error("cycle-two-down");
      },
    });

    expect(calls).toBe(2);
    expect(result.proposals[0]).toMatchObject({ type: "income", disposition: "candidate", selected: true });
    expect(result.proposals[0]!.reviewReasons).toContain("possible_transfer");
  });

  it("keeps an unknown posting status selected for review after the full pipeline", async () => {
    let calls = 0;
    const result = await runImportRecognitionPipeline({
      ...base,
      chat: async () => {
        calls++;
        if (calls === 1) return extracted("card_purchase", "unknown");
        return JSON.stringify({
          rows: [
            {
              rowId: "r1",
              name: "Groceries",
              place: "Lidl",
              envelopeId: "envelope-1",
              categoryId: null,
              semanticKind: "card_purchase",
              relation: null,
              reviewReasons: [],
            },
          ],
        });
      },
    });

    expect(calls).toBe(2);
    expect(result.proposals[0]).toMatchObject({ disposition: "candidate", selected: true });
    expect(result.proposals[0]!.reviewReasons).toContain("unknown_posting_status");
  });
});

describe("reasoningEffort — fast responses for suggest", () => {
  it("suggest (rules+AI) and agent set low; import extract does NOT (OCR precision)", () => {
    const ledger = fixture();
    const basis = buildBudgetSuggestionBasis({ ledger, month: "2026-07", profile: "custom", customPrompt: "x" });
    const agentReq = buildAgentSuggestPrompt(buildAgentSuggestContext({ ledger, month: "2026-07", basis, directive: "x", locale: "pl" }));
    expect(agentReq.reasoningEffort).toBe("low");
    const sugReq = buildSuggestPrompt({ basis, ledger, month: "2026-07", profile: "cautious", locale: "pl" });
    expect(sugReq.reasoningEffort).toBe("low");
    const impReq = buildImportExtractPrompt([], { envelopes: [], categories: [] }, "2026-07-11", "pl", "PLN");
    expect(impReq.reasoningEffort).toBeUndefined();
  });
  it("supportsReasoningEffort: gpt-5*/o* yes, others no", () => {
    expect(supportsReasoningEffort("gpt-5.5")).toBe(true);
    expect(supportsReasoningEffort("gpt-5.5-mini")).toBe(true);
    expect(supportsReasoningEffort("gpt-5.6-luna")).toBe(true); // the operator default since backlog §1
    // §1b BYOK tiers — live docs (2026-08-12) list reasoning none…max for both; the effort
    // enum Enveo sends stays low/medium/high (a valid subset), only the gate matters here.
    expect(supportsReasoningEffort("gpt-5.6-terra")).toBe(true);
    expect(supportsReasoningEffort("gpt-5.6-sol")).toBe(true);
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
