import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS, runAgentTool, TOOL_RESULT_LIMIT } from "./aiTools";
import { computeBudgetState } from "./budget";
import { goalProgress } from "./goals";
import { computeSpendingByDimension } from "./reports";
import { computeStateResponse } from "./stateResponse";
import { acc, alloc, asClientLedger, env, grp, tx } from "./test-helpers";
import type { ClientLedger } from "./types";

/** Deterministic seed ledger: 2 accounts, 2 groups, 4 envelopes (target,
 *  savings, archived with a target), split/refund/income/transfer,
 *  transactions and allocations in 2026-04..2026-07, category/place dictionaries. */
function seedLedger(): ClientLedger {
  const g1 = grp({ id: "G1", name: "Życie" });
  const g2 = grp({ id: "G2", name: "Majątek" });
  const a1 = acc({ id: "A1", onBudget: true, initialBalance: 5_000_00 });
  const a2 = acc({ id: "A2", onBudget: false, initialBalance: 1_000_00 });
  const e1 = env("G1", { id: "E1", name: "Jedzenie" });
  const e2 = env("G1", { id: "E2", name: "Rachunki", monthlyTarget: 300_00 });
  const e3 = env("G2", { id: "E3", name: "Oszczędności", isSavings: true, monthlyTarget: 500_00 });
  const e4 = env("G1", { id: "E4", name: "Stare hobby", archived: true, monthlyTarget: 100_00 });
  const ledger = asClientLedger({
    accounts: [a1, a2],
    groups: [g1, g2],
    envelopes: [e1, e2, e3, e4],
    allocations: [
      alloc("E1", "2026-04", 400_00),
      alloc("E1", "2026-05", 450_00),
      alloc("E1", "2026-06", 420_00),
      alloc("E2", "2026-05", 300_00),
      alloc("E2", "2026-06", 150_00),
      alloc("E3", "2026-06", 500_00),
      alloc("E1", "2026-07", 100_00),
      alloc("E2", "2026-07", 120_00),
    ],
    transactions: [
      tx({ type: "income", accountId: "A1", amount: 6_000_00, date: "2026-04-01" }),
      tx({ type: "expense", accountId: "A1", envelopeId: "E1", amount: 380_00, date: "2026-04-12", placeId: "P1", categoryId: "C1" }),
      tx({ type: "expense", accountId: "A1", envelopeId: "E2", amount: 290_00, date: "2026-05-05", placeId: "P2" }),
      // split: food + bills
      tx({
        type: "expense",
        accountId: "A1",
        amount: 100_00,
        date: "2026-05-20",
        placeId: "P1",
        items: [
          { id: "I1", envelopeId: "E1", amount: 60_00, categoryId: "C1" },
          { id: "I2", envelopeId: "E2", amount: 40_00, categoryId: null },
        ],
      }),
      // refund
      tx({ type: "expense", accountId: "A1", envelopeId: "E1", amount: 30_00, isRefund: true, date: "2026-06-02" }),
      tx({ type: "expense", accountId: "A1", envelopeId: "E1", amount: 210_00, date: "2026-06-15", placeId: "P2", categoryId: "C2" }),
      // expense from a net-worth envelope (excluded in spending/cashflow)
      tx({ type: "expense", accountId: "A1", envelopeId: "E3", amount: 500_00, date: "2026-06-20" }),
      // income straight into an envelope (lowers spent)
      tx({ type: "income", accountId: "A1", envelopeId: "E1", amount: 50_00, date: "2026-06-25" }),
      tx({ type: "transfer", accountId: "A1", toAccountId: "A2", amount: 200_00, date: "2026-06-28" }),
      tx({ type: "expense", accountId: "A1", envelopeId: "E1", amount: 75_00, date: "2026-07-03", placeId: "P1", categoryId: "C1" }),
      // off-budget account — does not count toward envelope spent
      tx({ type: "expense", accountId: "A2", envelopeId: "E1", amount: 44_00, date: "2026-07-04" }),
    ],
  });
  ledger.categories = [
    { id: "C1", name: "Spożywcze" },
    { id: "C2", name: "Chemia" },
  ];
  ledger.places = [
    { id: "P1", name: "Biedronka" },
    { id: "P2", name: "Lidl" },
  ];
  return ledger;
}

/** Ledger with many envelopes (long names) for truncation tests. */
function bigLedger(n = 200): ClientLedger {
  const g = grp({ id: "G1", name: "Grupa" });
  const envelopes = Array.from({ length: n }, (_, i) =>
    env("G1", {
      id: `ENV_${String(i).padStart(3, "0")}`,
      name: `Koperta o zdecydowanie za długiej nazwie numer ${i}`,
      monthlyTarget: 100_00 + i,
    }),
  );
  return asClientLedger({
    accounts: [acc({ id: "A1", onBudget: true, initialBalance: 10_000_00 })],
    groups: [g],
    envelopes,
    allocations: envelopes.map((e, i) => alloc(e.id, "2026-06", 10_00 + i)),
    transactions: [],
  });
}

const ledger = seedLedger();

describe("AGENT_TOOLS — definitions", () => {
  test("5 tools, all strict:true in OpenAI format", () => {
    expect(AGENT_TOOLS.map((t) => t.function.name)).toEqual([
      "get_month_state",
      "get_history",
      "get_spending",
      "get_goals",
      "submit_allocation",
    ]);
    for (const t of AGENT_TOOLS) {
      expect(t.type).toBe("function");
      expect(t.function.strict).toBe(true);
      const params = t.function.parameters as { type: string; additionalProperties: boolean; properties: Record<string, unknown>; required: string[] };
      expect(params.type).toBe("object");
      expect(params.additionalProperties).toBe(false);
      // strict: every property in required
      expect([...params.required].sort()).toEqual(Object.keys(params.properties).sort());
    }
  });
});

describe("runAgentTool — numeric parity", () => {
  test.each(["2026-06", "2026-07"] as const)("get_month_state ≡ computeStateResponse (%s)", (month) => {
    const { result, truncated } = runAgentTool(ledger, "get_month_state", { month });
    expect(truncated).toBeUndefined();
    const r = result as { month: string; toBeBudgeted: number; envelopes: Array<Record<string, unknown>> };
    const s = computeStateResponse(ledger, month);
    expect(r.month).toBe(month);
    expect(r.toBeBudgeted).toBe(s.toBeBudgeted);
    expect(r.envelopes.length).toBe(s.envelopes.length);
    const groupName = new Map(s.groups.map((g) => [g.id, g.name]));
    for (let i = 0; i < s.envelopes.length; i++) {
      const want = s.envelopes[i]!;
      expect(r.envelopes[i]).toEqual({
        id: want.id,
        name: want.name,
        group: groupName.get(want.groupId) ?? null,
        allocated: want.allocated,
        spent: want.spent,
        available: want.available,
        carryIn: want.carryIn,
        monthlyTarget: want.monthlyTarget,
        isSavings: want.isSavings,
      });
    }
  });

  test.each(["envelope", "group", "category", "place"] as const)("get_spending ≡ computeSpendingByDimension (%s)", (dimension) => {
    const { result } = runAgentTool(ledger, "get_spending", { dimension, fromMonth: "2026-04", toMonth: "2026-07" });
    expect(result).toEqual(computeSpendingByDimension(ledger, "2026-04", "2026-07", dimension));
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });

  test("get_goals ≡ goalProgress; excludes envelopes without a target and archived ones", () => {
    const month = "2026-06";
    const { result } = runAgentTool(ledger, "get_goals", { month });
    const rows = result as Array<{ envelopeId: string; name: string; target: number; allocated: number; pct: number; funded: boolean; missing: number }>;
    // E1 has no target, E4 archived → only E2 and E3
    expect(rows.map((r) => r.envelopeId).sort()).toEqual(["E2", "E3"]);
    const state = computeBudgetState(ledger, month);
    for (const row of rows) {
      const e = state.envelopes.find((x) => x.envelope.id === row.envelopeId)!;
      const gp = goalProgress({ monthlyTarget: e.envelope.monthlyTarget, allocated: e.allocated })!;
      expect(row.target).toBe(e.envelope.monthlyTarget!);
      expect(row.allocated).toBe(e.allocated);
      expect(row.pct).toBe(gp.pct);
      expect(row.funded).toBe(gp.funded);
      expect(row.missing).toBe(gp.missing);
    }
    // concrete values: E2 funded 150/300 → 50%, missing 150_00
    const e2 = rows.find((r) => r.envelopeId === "E2")!;
    expect(e2).toMatchObject({ pct: 50, funded: false, missing: 150_00 });
  });

  test("get_history — window before ctx.month (oldest first), sums match the ledger", () => {
    const { result } = runAgentTool(ledger, "get_history", { months: 3 }, { month: "2026-07" });
    const r = result as { months: string[]; envelopes: Array<{ id: string; name: string; allocated: number[]; spent: number[] }> };
    expect(r.months).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(r.envelopes.length).toBe(ledger.envelopes.length);
    for (const e of r.envelopes) {
      expect(e.allocated.length).toBe(3);
      expect(e.spent.length).toBe(3);
      for (let i = 0; i < r.months.length; i++) {
        const m = r.months[i]!;
        const st = computeBudgetState(ledger, m).envelopes.find((x) => x.envelope.id === e.id)!;
        expect(e.allocated[i]).toBe(st.allocated);
        expect(e.spent[i]).toBe(st.spent);
        // parity with the raw ledger allocations
        const rawAlloc = ledger.allocations.filter((a) => a.envelopeId === e.id && a.month === m).reduce((s, a) => s + a.amount, 0);
        expect(e.allocated[i]).toBe(rawAlloc);
      }
    }
    // concrete values for E1 (refund + split + income→envelope in 2026-06)
    const e1 = r.envelopes.find((x) => x.id === "E1")!;
    expect(e1.allocated).toEqual([400_00, 450_00, 420_00]);
    expect(e1.spent).toEqual([380_00, 60_00, 210_00 - 30_00 - 50_00]);
  });
});

describe("runAgentTool — validation (error as result, no throw)", () => {
  const errOf = (res: { result: unknown }) => (res.result as { error?: string }).error;

  test("get_month_state: month '2026-13' → {error}", () => {
    const res = runAgentTool(ledger, "get_month_state", { month: "2026-13" });
    expect(errOf(res)).toContain("get_month_state");
    expect(res.truncated).toBeUndefined();
  });

  test("get_goals: month in a wrong format → {error}", () => {
    expect(errOf(runAgentTool(ledger, "get_goals", { month: "czerwiec" }))).toBeString();
  });

  test("get_spending: dimension 'foo' → {error}", () => {
    const res = runAgentTool(ledger, "get_spending", { dimension: "foo", fromMonth: "2026-04", toMonth: "2026-06" });
    expect(errOf(res)).toContain("dimension");
  });

  test("get_history: months 0 → {error}", () => {
    expect(errOf(runAgentTool(ledger, "get_history", { months: 0 }))).toContain("months");
  });

  test("get_history: months 25 → {error}", () => {
    expect(errOf(runAgentTool(ledger, "get_history", { months: 25 }))).toContain("months");
  });

  test("non-object arguments (garbage after parsing) → {error}, no throw", () => {
    expect(errOf(runAgentTool(ledger, "get_month_state", "junk"))).toBeString();
    expect(errOf(runAgentTool(ledger, "get_history", null))).toBeString();
    expect(errOf(runAgentTool(ledger, "get_month_state", undefined))).toBeString();
  });

  test("unknown tool → {error}", () => {
    expect(errOf(runAgentTool(ledger, "drop_database", {}))).toContain("drop_database");
  });

  test("submit_allocation is NOT executed by the executor → {error}", () => {
    const res = runAgentTool(ledger, "submit_allocation", { items: [{ envelopeId: "E1", amount: 100 }], rationale: null });
    expect(errOf(res)).toBeString();
  });
});

describe("runAgentTool — truncation (8000-char limit)", () => {
  test("get_month_state on 200 envelopes → truncated:true, valid JSON ≤ limit, list prefix", () => {
    const big = bigLedger(200);
    const full = computeStateResponse(big, "2026-06");
    const res = runAgentTool(big, "get_month_state", { month: "2026-06" });
    expect(res.truncated).toBe(true);
    const json = JSON.stringify(res.result);
    expect(json.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    const parsed = JSON.parse(json) as { month: string; toBeBudgeted: number; envelopes: Array<{ id: string }> };
    expect(parsed.month).toBe("2026-06");
    expect(parsed.toBeBudgeted).toBe(full.toBeBudgeted);
    expect(parsed.envelopes.length).toBeGreaterThan(0);
    expect(parsed.envelopes.length).toBeLessThan(200);
    // the first N envelopes in original order
    for (let i = 0; i < parsed.envelopes.length; i++) {
      expect(parsed.envelopes[i]!.id).toBe(full.envelopes[i]!.id);
    }
  });

  test("get_goals (bare array) on 200 envelopes with targets → truncated:true, ≤ limit", () => {
    const big = bigLedger(200);
    const res = runAgentTool(big, "get_goals", { month: "2026-06" });
    expect(res.truncated).toBe(true);
    const rows = res.result as Array<{ envelopeId: string }>;
    expect(JSON.stringify(rows).length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
    expect(rows[0]!.envelopeId).toBe("ENV_000");
  });

  test("get_history on 200 envelopes → truncated:true, months untouched", () => {
    const big = bigLedger(200);
    const res = runAgentTool(big, "get_history", { months: 6 }, { month: "2026-07" });
    expect(res.truncated).toBe(true);
    const r = res.result as { months: string[]; envelopes: unknown[] };
    expect(r.months.length).toBe(6);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    expect(r.envelopes.length).toBeLessThan(200);
  });

  test("small result → no truncated", () => {
    const res = runAgentTool(ledger, "get_month_state", { month: "2026-06" });
    expect(res.truncated).toBeUndefined();
    expect(JSON.stringify(res.result).length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
  });
});
