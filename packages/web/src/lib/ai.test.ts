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
import { previewSuggestPrompt } from "./ai";

const MONTH = "2026-07";

const txn = (over: Partial<Transaction> & Pick<Transaction, "id" | "type" | "amount" | "date">): Transaction => ({
  accountId: "acc1",
  toAccountId: null,
  confirmed: true,
  isRefund: false,
  envelopeId: null,
  placeId: null,
  categoryId: null,
  name: null,
  note: null,
  tag: null,
  planned: false,
  recurrenceId: null,
  items: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

/** Fixture: an account + 2 envelopes + income and expenses (pattern from e2ee.test.ts). */
const fixtureLedger = (): ClientLedger => ({
  accounts: [
    { id: "acc1", name: "Konto", color: "#111111", icon: "bank", type: "checking", onBudget: true, initialBalance: 0, archived: false, sort: 0 },
  ],
  groups: [{ id: "grp1", name: "Życie", sort: 0 }],
  envelopes: [
    { id: "env1", groupId: "grp1", name: "Jedzenie", color: "#22aa22", icon: "food", note: null, monthlyTarget: null, isSavings: false, sort: 0, archived: false },
    { id: "env2", groupId: "grp1", name: "Transport", color: "#2222aa", icon: "car", note: null, monthlyTarget: null, isSavings: false, sort: 1, archived: false },
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
  recurrences: [],
  budgets: [{ id: "b1", name: "Budżet", currency: "PLN" }],
});

describe("previewSuggestPrompt", () => {
  it("returns {system, user}: language directive + Profile + fixture envelope names", () => {
    const preview = previewSuggestPrompt(fixtureLedger(), MONTH, "cautious", undefined, "pl");
    expect(typeof preview.system).toBe("string");
    expect(typeof preview.user).toBe("string");
    expect(preview.system).toContain("Write all user-facing text");
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
