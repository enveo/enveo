import { describe, expect, it } from "bun:test";
import { computeEnvelopeBudgetStats } from "./aiBudget";
import { alloc, asClientLedger, env, grp, tx } from "./ledger.test-support";
import type { Ledger } from "./types";

function ledgerWithSpend(envId: string, spendByMonth: Record<string, number>): Ledger {
  const g = grp();
  const e = env(g.id, { id: envId });
  const a = { id: "A0", name: "K", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 0, archived: false, sort: 0 };
  const transactions = Object.entries(spendByMonth).map(([m, amt]) =>
    tx({ type: "expense", accountId: a.id, envelopeId: envId, amount: amt, date: `${m}-10` }),
  );
  return { accounts: [a], groups: [g], envelopes: [e], allocations: [] as ReturnType<typeof alloc>[], transactions };
}

describe("computeEnvelopeBudgetStats", () => {
  it("uses the 6 fully-elapsed months before the selected month", () => {
    // selected month 2026-07 → window is 2026-01..2026-06
    const l = asClientLedger(
      ledgerWithSpend("E0", { "2026-01": 100_00, "2026-02": 100_00, "2026-03": 100_00, "2026-04": 100_00, "2026-05": 100_00, "2026-06": 100_00, "2026-07": 999_00 }),
    );
    const s = computeEnvelopeBudgetStats(l, "E0", "2026-07", 0, 0);
    expect(s.months).toEqual([100_00, 100_00, 100_00, 100_00, 100_00, 100_00]);
    expect(s.medianSpend).toBe(100_00);
    expect(s.avgSpend).toBe(100_00);
    expect(s.recurringLike).toBe(true); // spend > 0 in >= 4 of 6 months
  });

  it("marks non-recurring envelopes and floors negative months at 0", () => {
    const l = asClientLedger(ledgerWithSpend("E0", { "2026-05": 50_00 }));
    const s = computeEnvelopeBudgetStats(l, "E0", "2026-07", 0, 0);
    expect(s.months.filter((v) => v > 0).length).toBe(1);
    expect(s.recurringLike).toBe(false);
    expect(s.months.every((v) => v >= 0)).toBe(true);
  });
});

import { buildBudgetSuggestionBasis } from "./aiBudget";
import type { Account } from "./types";

const onAcc = (initial: number): Account => ({ id: "A0", name: "K", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: initial, archived: false, sort: 0 });

describe("buildBudgetSuggestionBasis", () => {
  it("amountToDistribute is max(0, toBeBudgeted); no allocations => full amount free", () => {
    const g = grp();
    const e = env(g.id, { id: "E0", name: "Jedzenie" });
    const l = asClientLedger({ accounts: [onAcc(1000_00)], groups: [g], envelopes: [e], allocations: [], transactions: [] });
    const basis = buildBudgetSuggestionBasis({ ledger: l, month: "2026-07", profile: "historical" });
    expect(basis.amountToDistribute).toBe(1000_00);
    expect(basis.candidates.map((c) => c.envelopeId)).toEqual(["E0"]);
  });

  it("cautious ranks a negative-available envelope above a normal one", () => {
    const g = grp();
    const eNeg = env(g.id, { id: "NEG", name: "Auto" });
    const eOk = env(g.id, { id: "OK", name: "Jedzenie" });
    // NEG overspent: expense 200 with only 50 allocated => available -150
    const l = asClientLedger({
      accounts: [onAcc(1000_00)],
      groups: [g],
      envelopes: [eNeg, eOk],
      allocations: [alloc("NEG", "2026-07", 50_00)],
      transactions: [tx({ type: "expense", accountId: "A0", envelopeId: "NEG", amount: 200_00, date: "2026-07-05" })],
    });
    const basis = buildBudgetSuggestionBasis({ ledger: l, month: "2026-07", profile: "cautious" });
    const neg = basis.candidates.find((c) => c.envelopeId === "NEG")!;
    const ok = basis.candidates.find((c) => c.envelopeId === "OK")!;
    expect(neg.priority).toBeGreaterThan(ok.priority);
    expect(neg.baseDelta).toBeGreaterThanOrEqual(150_00); // covers the overspend
  });

  it("investor gives savings-like envelopes top priority and picks one as remainder sink", () => {
    const g = grp();
    const eSav = env(g.id, { id: "SAV", name: "Bonds", isSavings: true });
    const eSpend = env(g.id, { id: "SPEND", name: "Jedzenie" });
    const l = asClientLedger({ accounts: [onAcc(500_00)], groups: [g], envelopes: [eSav, eSpend], allocations: [], transactions: [] });
    const basis = buildBudgetSuggestionBasis({ ledger: l, month: "2026-07", profile: "investor" });
    const sav = basis.candidates.find((c) => c.envelopeId === "SAV")!;
    const spend = basis.candidates.find((c) => c.envelopeId === "SPEND")!;
    expect(sav.savingsLike).toBe(true);
    expect(sav.priority).toBeGreaterThan(spend.priority);
    expect(basis.remainderEnvelopeId).toBe("SAV");
  });

  it("savingsLike comes from the explicit isSavings flag, not the envelope name", () => {
    const g = grp();
    const eFlag = env(g.id, { id: "SAV", name: "Someday fund", isSavings: true });
    const eName = env(g.id, { id: "NAME", name: "Oszczędności" }); // savings-sounding name, no flag
    const l = asClientLedger({ accounts: [onAcc(500_00)], groups: [g], envelopes: [eFlag, eName], allocations: [], transactions: [] });
    const basis = buildBudgetSuggestionBasis({ ledger: l, month: "2026-07", profile: "investor" });
    expect(basis.candidates.find((c) => c.envelopeId === "SAV")!.savingsLike).toBe(true);
    expect(basis.candidates.find((c) => c.envelopeId === "NAME")!.savingsLike).toBe(false);
    expect(basis.remainderEnvelopeId).toBe("SAV");
  });

  it("ignores archived envelopes", () => {
    const g = grp();
    const l = asClientLedger({
      accounts: [onAcc(100_00)],
      groups: [g],
      envelopes: [env(g.id, { id: "A", name: "Aktywna" }), env(g.id, { id: "Z", name: "Stara", archived: true })],
      allocations: [],
      transactions: [],
    });
    const basis = buildBudgetSuggestionBasis({ ledger: l, month: "2026-07", profile: "historical" });
    expect(basis.candidates.map((c) => c.envelopeId)).toEqual(["A"]);
  });
});

import fc from "fast-check";
import { buildRulesBudgetSuggestion, normalizeBudgetSuggestion } from "./aiBudget";
import { ledgerArb } from "./ledger.test-support";

const bigLedger = () => {
  const g = grp();
  const e1 = env(g.id, { id: "E1", name: "Jedzenie" });
  const e2 = env(g.id, { id: "E2", name: "Bonds", isSavings: true });
  return asClientLedger({ accounts: [onAcc(1000_00)], groups: [g], envelopes: [e1, e2], allocations: [], transactions: [] });
};

describe("buildRulesBudgetSuggestion", () => {
  it("distributes the whole amount (Σ deltas == amountToDistribute)", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: bigLedger(), month: "2026-07", profile: "historical" });
    const r = buildRulesBudgetSuggestion(basis);
    expect(r.distributed).toBe(basis.amountToDistribute);
    expect(r.items.reduce((s, i) => s + i.proposedDelta, 0)).toBe(basis.amountToDistribute);
    expect(r.items.every((i) => i.proposedDelta > 0 && Number.isInteger(i.proposedDelta))).toBe(true);
  });
});

describe("normalizeBudgetSuggestion", () => {
  it("keeps a valid full-sum proposal unchanged (repaired=false)", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: bigLedger(), month: "2026-07", profile: "historical" });
    const r = normalizeBudgetSuggestion(basis, [{ envelopeId: "E1", proposedDelta: basis.amountToDistribute }]);
    expect(r.repaired).toBe(false);
    expect(r.distributed).toBe(basis.amountToDistribute);
  });

  it("repairs an under-sum proposal by adding remainder to the sink (repaired=true)", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: bigLedger(), month: "2026-07", profile: "investor" });
    const r = normalizeBudgetSuggestion(basis, [{ envelopeId: "E1", proposedDelta: 100_00 }]);
    expect(r.repaired).toBe(true);
    expect(r.distributed).toBe(basis.amountToDistribute);
    // investor sink is the savings-like envelope E2
    expect(r.items.find((i) => i.envelopeId === "E2")!.proposedDelta).toBe(basis.amountToDistribute - 100_00);
  });

  it("drops unknown ids and clamps negatives", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: bigLedger(), month: "2026-07", profile: "historical" });
    const r = normalizeBudgetSuggestion(basis, [
      { envelopeId: "GHOST", proposedDelta: 999_00 },
      { envelopeId: "E1", proposedDelta: -50_00 },
    ]);
    expect(r.repaired).toBe(true);
    expect(r.items.some((i) => i.envelopeId === "GHOST")).toBe(false);
    expect(r.items.every((i) => i.proposedDelta >= 0)).toBe(true);
    expect(r.distributed).toBe(basis.amountToDistribute);
  });

  it("property: rules-only always distributes exactly, no negatives (all profiles)", () => {
    const profiles: BudgetSuggestProfile[] = ["cautious", "historical", "investor", "custom"];
    fc.assert(
      fc.property(ledgerArb(), fc.constantFrom(...profiles), (ledger, profile) => {
        const basis = buildBudgetSuggestionBasis({ ledger: asClientLedger(ledger), month: "2026-07", profile });
        const r = buildRulesBudgetSuggestion(basis);
        const sum = r.items.reduce((s, i) => s + i.proposedDelta, 0);
        if (basis.amountToDistribute > 0 && basis.candidates.length > 0) {
          expect(sum).toBe(basis.amountToDistribute);
        }
        expect(r.items.every((i) => i.proposedDelta > 0 && Number.isInteger(i.proposedDelta))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

import * as shared from "./index";

describe("barrel export", () => {
  it("exposes the budget suggestion engine from the package root", () => {
    expect(typeof shared.buildBudgetSuggestionBasis).toBe("function");
    expect(typeof shared.buildRulesBudgetSuggestion).toBe("function");
    expect(typeof shared.normalizeBudgetSuggestion).toBe("function");
    expect(typeof shared.computeEnvelopeBudgetStats).toBe("function");
  });
});

import { applyOp, clientLedgerSchema } from "./index";
import type { SyncOp } from "./index";

describe("monthlyTarget field", () => {
  it("envelope.create carries monthlyTarget; envelope.update sets/clears it", () => {
    const g = grp();
    const base = asClientLedger({ accounts: [], groups: [g], envelopes: [], allocations: [], transactions: [] });
    const create: SyncOp = { opId: "o1", kind: "envelope.create", payload: { id: "E9", groupId: g.id, name: "Obligacje", monthlyTarget: 500_00 } as never };
    const l1 = applyOp(base, create);
    expect(l1.envelopes[0]!.monthlyTarget).toBe(500_00);
    const clear: SyncOp = { opId: "o2", kind: "envelope.update", payload: { id: "E9", monthlyTarget: null } as never };
    const l2 = applyOp(l1, clear);
    expect(l2.envelopes[0]!.monthlyTarget).toBeNull();
  });

  it("clientLedgerSchema accepts envelopes with and without monthlyTarget", () => {
    const withT = { accounts: [], groups: [{ id: "11111111-1111-1111-1111-111111111111", name: "G", sort: 0 }], envelopes: [{ id: "22222222-2222-2222-2222-222222222222", groupId: "11111111-1111-1111-1111-111111111111", name: "E", color: "#fff", icon: "tag", note: null, sort: 0, archived: false, monthlyTarget: 100_00 }], categories: [], places: [], allocations: [], transactions: [] };
    expect(clientLedgerSchema.safeParse(withT).success).toBe(true);
    const withoutT = { ...withT, envelopes: [{ ...withT.envelopes[0], monthlyTarget: undefined }] };
    delete (withoutT.envelopes[0] as Record<string, unknown>).monthlyTarget;
    expect(clientLedgerSchema.safeParse(withoutT).success).toBe(true);
  });
});

import { buildPrevMonthSuggestion, buildTopUpNegativesSuggestion, normalizeAgentSuggestion } from "./aiBudget";
import type { BudgetSuggestionBasis, BudgetSuggestionCandidate } from "./aiBudget";

/** Hand-built basis — precise control of available/allocated per envelope. */
const mkCand = (id: string, available: number, allocated = 0): BudgetSuggestionCandidate => ({
  envelopeId: id,
  baseDelta: 0,
  minDelta: 0,
  maxDelta: Number.MAX_SAFE_INTEGER,
  priority: 50,
  savingsLike: false,
  stats: {
    envelopeId: id,
    allocatedThisMonth: allocated,
    available,
    monthlyTarget: null,
    targetGap: null,
    months: [0, 0, 0, 0, 0, 0],
    medianSpend: 0,
    avgSpend: 0,
    recurringLike: false,
  },
  rationaleHints: [],
});

const mkBasis = (candidates: BudgetSuggestionCandidate[], amountToDistribute: number): BudgetSuggestionBasis => ({
  month: "2026-07",
  profile: "custom",
  amountToDistribute,
  candidates,
  remainderEnvelopeId: null,
});

describe("buildTopUpNegativesSuggestion", () => {
  it("amount > Σdeficits: caps at zeroing, surplus goes to remainder with warning (100 vs [1,1,1])", () => {
    const basis = mkBasis([mkCand("E1", -1), mkCand("E2", -1), mkCand("E3", -1), mkCand("OK", 500)], 100);
    const r = buildTopUpNegativesSuggestion(basis);
    expect(r.items.map((i) => i.envelopeId).sort()).toEqual(["E1", "E2", "E3"]);
    expect(r.items.every((i) => i.proposedDelta === 1)).toBe(true);
    expect(r.distributed).toBe(3);
    expect(r.undistributedRemainder).toBe(97);
    expect(r.warnings).toEqual(["remainder"]);
    expect(r.items.every((i) => i.rationaleCodes.length === 1 && i.rationaleCodes[0] === "hint.topUp")).toBe(true);
  });

  it("amount < Σdeficits: proportional largest remainder, Σ == amount, delta_i ≤ deficit_i", () => {
    const basis = mkBasis([mkCand("A", -150_00), mkCand("B", -50_00)], 100_00);
    const r = buildTopUpNegativesSuggestion(basis);
    expect(r.items.find((i) => i.envelopeId === "A")!.proposedDelta).toBe(75_00);
    expect(r.items.find((i) => i.envelopeId === "B")!.proposedDelta).toBe(25_00);
    expect(r.distributed).toBe(100_00);
    expect(r.undistributedRemainder).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("largest remainder splits odd grosze deterministically and exactly", () => {
    const basis = mkBasis([mkCand("A", -7), mkCand("B", -7)], 11);
    const r = buildTopUpNegativesSuggestion(basis);
    const a = r.items.find((i) => i.envelopeId === "A")!.proposedDelta;
    const b = r.items.find((i) => i.envelopeId === "B")!.proposedDelta;
    expect(a + b).toBe(11);
    expect([a, b].sort((x, y) => x - y)).toEqual([5, 6]);
    expect(a).toBeLessThanOrEqual(7);
    expect(b).toBeLessThanOrEqual(7);
  });

  it("no negative envelopes: empty items, whole amount stays undistributed", () => {
    const basis = mkBasis([mkCand("OK1", 100), mkCand("OK2", 0)], 500);
    const r = buildTopUpNegativesSuggestion(basis);
    expect(r.items).toEqual([]);
    expect(r.distributed).toBe(0);
    expect(r.undistributedRemainder).toBe(500);
    expect(r.warnings).toEqual(["remainder"]);
  });

  it("property: Σ ≤ amount; deltas only for available<0; delta_i ≤ deficit_i; Σ == min(amount, Σdef)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ neg: fc.boolean(), mag: fc.integer({ min: 1, max: 100_000 }) }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 300_000 }),
        (envs, amount) => {
          const cands = envs.map((e, i) => mkCand(`E${i}`, e.neg ? -e.mag : e.mag));
          const r = buildTopUpNegativesSuggestion(mkBasis(cands, amount));
          const sumDef = envs.filter((e) => e.neg).reduce((s, e) => s + e.mag, 0);
          const sum = r.items.reduce((s, i) => s + i.proposedDelta, 0);
          expect(sum).toBe(Math.min(amount, sumDef));
          expect(sum + r.undistributedRemainder).toBe(amount);
          for (const it of r.items) {
            const c = cands.find((x) => x.envelopeId === it.envelopeId)!;
            expect(c.stats.available).toBeLessThan(0);
            expect(it.proposedDelta).toBeLessThanOrEqual(-c.stats.available);
            expect(Number.isInteger(it.proposedDelta) && it.proposedDelta > 0).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("buildPrevMonthSuggestion", () => {
  it("delta = max(0, prevAllocated − currentAllocated); never takes allocations away", () => {
    const basis = mkBasis([mkCand("A", 0, 100_00), mkCand("B", 0, 80_00), mkCand("C", 0, 0)], 1000_00);
    const prev = new Map([
      ["A", 300_00], // 300 − 100 → 200
      ["B", 50_00], // 50 − 80 → 0 (we take nothing away)
    ]); // C absent in prev → 0
    const r = buildPrevMonthSuggestion(basis, prev);
    expect(r.items.map((i) => i.envelopeId)).toEqual(["A"]);
    expect(r.items[0]!.proposedDelta).toBe(200_00);
    expect(r.items[0]!.rationaleCodes).toEqual(["hint.prevMonth"]);
    expect(r.warnings).toEqual([]);
    expect(r.undistributedRemainder).toBe(800_00);
  });

  it("Σdeltas > TBB: warning over_tbb, deltas NOT clamped (user trims in the editor)", () => {
    const basis = mkBasis([mkCand("A", 0, 0), mkCand("B", 0, 0)], 100_00);
    const prev = new Map([
      ["A", 300_00],
      ["B", 200_00],
    ]);
    const r = buildPrevMonthSuggestion(basis, prev);
    expect(r.distributed).toBe(500_00);
    expect(r.warnings).toEqual(["over_tbb"]);
    expect(r.undistributedRemainder).toBe(0);
  });

  it("property: delta_i == max(0, prev_i − curr_i) exactly; over_tbb iff Σ > amount", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ curr: fc.integer({ min: 0, max: 100_000 }), prev: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }) }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 200_000 }),
        (envs, amount) => {
          const cands = envs.map((e, i) => mkCand(`E${i}`, 0, e.curr));
          const prev = new Map(envs.flatMap((e, i) => (e.prev == null ? [] : [[`E${i}`, e.prev] as [string, number]])));
          const r = buildPrevMonthSuggestion(mkBasis(cands, amount), prev);
          let expectedSum = 0;
          for (const [i, e] of envs.entries()) {
            const want = Math.max(0, (e.prev ?? 0) - e.curr);
            expectedSum += want;
            const got = r.items.find((it) => it.envelopeId === `E${i}`)?.proposedDelta ?? 0;
            expect(got).toBe(want);
          }
          expect(r.distributed).toBe(expectedSum);
          expect(r.warnings.includes("over_tbb")).toBe(expectedSum > amount);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("normalizeAgentSuggestion", () => {
  it("valid proposal with Σ == amount stays unchanged (repaired=false, no hint codes)", () => {
    const basis = mkBasis([mkCand("E1", 0), mkCand("E2", 0)], 0);
    const r = normalizeAgentSuggestion([{ envelopeId: "E1", proposedDelta: 60 }, { envelopeId: "E2", proposedDelta: 40 }], basis, 100);
    expect(r.repaired).toBe(false);
    expect(r.amountToDistribute).toBe(100);
    expect(r.distributed).toBe(100);
    expect(r.items.find((i) => i.envelopeId === "E1")!.proposedDelta).toBe(60);
    expect(r.items.find((i) => i.envelopeId === "E2")!.proposedDelta).toBe(40);
    expect(r.items.every((i) => i.rationaleCodes.length === 0)).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("under-sum scales UP only within the agent's set — never tops up omitted envelopes", () => {
    const basis = mkBasis([mkCand("E1", 0), mkCand("E2", 0), mkCand("OMITTED", -999_00)], 0);
    const r = normalizeAgentSuggestion([{ envelopeId: "E1", proposedDelta: 30 }, { envelopeId: "E2", proposedDelta: 10 }], basis, 100);
    expect(r.repaired).toBe(true);
    expect(r.items.some((i) => i.envelopeId === "OMITTED")).toBe(false);
    expect(r.items.find((i) => i.envelopeId === "E1")!.proposedDelta).toBe(75);
    expect(r.items.find((i) => i.envelopeId === "E2")!.proposedDelta).toBe(25);
    expect(r.distributed).toBe(100);
  });

  it("over-sum scales DOWN proportionally to Σ == amount", () => {
    const basis = mkBasis([mkCand("E1", 0), mkCand("E2", 0)], 0);
    const r = normalizeAgentSuggestion([{ envelopeId: "E1", proposedDelta: 300 }, { envelopeId: "E2", proposedDelta: 100 }], basis, 100);
    expect(r.items.find((i) => i.envelopeId === "E1")!.proposedDelta).toBe(75);
    expect(r.items.find((i) => i.envelopeId === "E2")!.proposedDelta).toBe(25);
    expect(r.distributed).toBe(100);
    expect(r.repaired).toBe(true);
  });

  it("unknown ids dropped and negatives clamped; nothing valid left → agent_empty, items=[]", () => {
    const basis = mkBasis([mkCand("E1", 0)], 0);
    const r = normalizeAgentSuggestion([{ envelopeId: "GHOST", proposedDelta: 100 }, { envelopeId: "E1", proposedDelta: -50 }], basis, 100);
    expect(r.items).toEqual([]);
    expect(r.warnings).toEqual(["agent_empty"]);
    expect(r.distributed).toBe(0);
    expect(r.undistributedRemainder).toBe(100);
  });

  it("empty proposal → agent_empty (no silent rules fallback)", () => {
    const basis = mkBasis([mkCand("E1", -500)], 0);
    const r = normalizeAgentSuggestion([], basis, 100);
    expect(r.items).toEqual([]);
    expect(r.warnings).toEqual(["agent_empty"]);
  });

  it("property: Σ items == amount; item set ⊆ agent's valid set; positive ints only", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.record({ idx: fc.integer({ min: 0, max: 9 }), d: fc.integer({ min: -1000, max: 100_000 }) }), { maxLength: 8 }),
        fc.integer({ min: 1, max: 200_000 }),
        (n, proposals, amount) => {
          const cands = Array.from({ length: n }, (_, i) => mkCand(`E${i}`, 0));
          const ps = proposals.map((p) => ({ envelopeId: `E${p.idx}`, proposedDelta: p.d }));
          const r = normalizeAgentSuggestion(ps, mkBasis(cands, 0), amount);
          const validSet = new Set(ps.filter((p) => p.proposedDelta > 0 && Number(p.envelopeId.slice(1)) < n).map((p) => p.envelopeId));
          const sum = r.items.reduce((s, i) => s + i.proposedDelta, 0);
          if (validSet.size === 0) {
            expect(r.warnings).toContain("agent_empty");
            expect(r.items).toEqual([]);
          } else {
            expect(sum).toBe(amount);
            for (const it of r.items) expect(validSet.has(it.envelopeId)).toBe(true);
          }
          expect(r.items.every((i) => Number.isInteger(i.proposedDelta) && i.proposedDelta > 0)).toBe(true);
          expect(r.amountToDistribute).toBe(amount);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("monthlyTarget in the engine", () => {
  const ledgerWithTarget = (target: number, allocated = 0) => {
    const g = grp();
    const e1 = env(g.id, { id: "OBL", name: "Obligacje", monthlyTarget: target });
    const e2 = env(g.id, { id: "FOOD", name: "Jedzenie" });
    const a = { id: "A0", name: "K", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 1000_00, archived: false, sort: 0 };
    const allocations = allocated > 0 ? [alloc("OBL", "2026-07", allocated)] : [];
    return asClientLedger({ accounts: [a], groups: [g], envelopes: [e1, e2], allocations, transactions: [] });
  };

  it("targetGap is contribution-based (target − allocated this month)", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: ledgerWithTarget(500_00, 200_00), month: "2026-07", profile: "historical" });
    const obl = basis.candidates.find((c) => c.envelopeId === "OBL")!;
    expect(obl.stats.targetGap).toBe(300_00);
    expect(obl.maxDelta).toBe(300_00); // capped at the gap
  });

  it("rules fund a target within budget; delta never exceeds the gap", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: ledgerWithTarget(500_00), month: "2026-07", profile: "historical" });
    const r = buildRulesBudgetSuggestion(basis);
    const obl = r.items.find((i) => i.envelopeId === "OBL")!;
    expect(obl.proposedDelta).toBe(500_00);
    expect(obl.meetsTarget).toBe(true);
    expect(r.distributed + r.undistributedRemainder).toBe(basis.amountToDistribute);
  });

  it("AI overshoot on a target is clamped to the gap", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: ledgerWithTarget(500_00), month: "2026-07", profile: "historical" });
    const r = normalizeBudgetSuggestion(basis, [{ envelopeId: "OBL", proposedDelta: 900_00 }]);
    expect(r.items.find((i) => i.envelopeId === "OBL")!.proposedDelta).toBe(500_00);
    expect(r.repaired).toBe(true);
  });

  it("rules suggestion for a targeted envelope yields rationaleCodes with hint.monthlyTarget and empty rationale", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: ledgerWithTarget(500_00), month: "2026-07", profile: "historical" });
    const r = buildRulesBudgetSuggestion(basis);
    const obl = r.items.find((i) => i.envelopeId === "OBL")!;
    expect(obl.rationaleCodes).toContain("hint.monthlyTarget");
    expect(obl.rationale).toBe("");
  });

  it("AI free-text rationale passes through with empty rationaleCodes", () => {
    const basis = buildBudgetSuggestionBasis({ ledger: bigLedger(), month: "2026-07", profile: "historical" });
    const r = normalizeBudgetSuggestion(basis, [{ envelopeId: "E1", proposedDelta: basis.amountToDistribute, rationale: "bo tak" }]);
    const e1 = r.items.find((i) => i.envelopeId === "E1")!;
    expect(e1.rationale).toBe("bo tak");
    expect(e1.rationaleCodes).toEqual([]);
  });

  it("when every envelope is a fully-funded target, leftover is undistributed (no cap exceeded)", () => {
    const g = grp();
    const e1 = env(g.id, { id: "T1", name: "Obligacje", monthlyTarget: 100_00 });
    const a = { id: "A0", name: "K", color: "#fff", icon: "wallet", type: "checking", onBudget: true, initialBalance: 300_00, archived: false, sort: 0 };
    const basis = buildBudgetSuggestionBasis({ ledger: asClientLedger({ accounts: [a], groups: [g], envelopes: [e1], allocations: [], transactions: [] }), month: "2026-07", profile: "investor" });
    const r = buildRulesBudgetSuggestion(basis);
    expect(r.distributed).toBe(100_00);
    expect(r.undistributedRemainder).toBe(200_00);
    expect(r.items.every((i) => i.proposedDelta <= 100_00)).toBe(true);
  });
});
