




import { computeBudgetState, monthOf, prevMonth } from "./budget";
import type { ClientLedger, Money, Transaction } from "./types";

export type BudgetSuggestProfile = "cautious" | "historical" | "investor" | "custom";
export type BudgetSuggestSource = "ai" | "ai_repaired" | "rules";

export interface EnvelopeBudgetStats {
  envelopeId: string;
  allocatedThisMonth: Money;
  available: Money;
  monthlyTarget: Money | null;
  targetGap: Money | null;  
  months: Money[];  
  medianSpend: Money;
  avgSpend: Money;
  recurringLike: boolean;
}

 
function spentOfEnvelope(t: Transaction, envId: string): number {
  if (t.type === "transfer") return 0;
  const sign = t.isRefund ? -1 : 1;
  if (t.type === "income") return t.envelopeId === envId ? -t.amount : 0;
  if (t.items.length > 0) {
    return t.items.filter((i) => i.envelopeId === envId).reduce((x, i) => x + sign * i.amount, 0);
  }
  return t.envelopeId === envId ? sign * t.amount : 0;
}

function medianOfSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function computeEnvelopeBudgetStats(
  ledger: ClientLedger,
  envId: string,
  month: string,
  allocatedThisMonth: Money,
  available: Money,
  monthlyTarget: Money | null,
): EnvelopeBudgetStats {
   
  const window: string[] = [];
  let m = prevMonth(month);
  for (let i = 0; i < 6; i++) {
    window.unshift(m);
    m = prevMonth(m);
  }
  const months = window.map((mm) =>
    Math.max(
      0,
      ledger.transactions.filter((t) => monthOf(t.date) === mm).reduce((x, t) => x + spentOfEnvelope(t, envId), 0),
    ),
  );
  const sorted = [...months].sort((a, b) => a - b);
  const medianSpend = medianOfSorted(sorted);
  const avgSpend = Math.round(months.reduce((x, v) => x + v, 0) / months.length);
  const recurringLike = months.filter((v) => v > 0).length >= 4;
  const targetGap = monthlyTarget != null ? Math.max(0, monthlyTarget - allocatedThisMonth) : null;
  return { envelopeId: envId, allocatedThisMonth, available, months, medianSpend, avgSpend, recurringLike, monthlyTarget, targetGap };
}

export interface BudgetSuggestionCandidate {
  envelopeId: string;
  baseDelta: Money;  
  minDelta: Money;  
  maxDelta: Money;  
  priority: number;  
  savingsLike: boolean;
  stats: EnvelopeBudgetStats;
  rationaleHints: string[];
}

export interface BudgetSuggestionBasis {
  month: string;
  profile: BudgetSuggestProfile;
  amountToDistribute: Money;  
  candidates: BudgetSuggestionCandidate[];
  remainderEnvelopeId: string | null;
}

export function byPriorityDesc(a: BudgetSuggestionCandidate, b: BudgetSuggestionCandidate): number {
  return b.priority - a.priority || (a.envelopeId < b.envelopeId ? -1 : 1);
}

function pickRemainder(cands: BudgetSuggestionCandidate[], profile: BudgetSuggestProfile): string | null {
  if (cands.length === 0) return null;
  if (profile === "investor" || profile === "cautious") {
    const sav = [...cands].filter((c) => c.savingsLike && c.stats.targetGap == null).sort(byPriorityDesc)[0];
    if (sav) return sav.envelopeId;
  } else {
    const top = [...cands].sort((a, b) => b.stats.avgSpend - a.stats.avgSpend || (a.envelopeId < b.envelopeId ? -1 : 1))[0];
    if (top && top.stats.avgSpend > 0) return top.envelopeId;
  }
  const nonTarget = [...cands].filter((c) => c.stats.targetGap == null).sort(byPriorityDesc);
  return (nonTarget[0] ?? [...cands].sort(byPriorityDesc).at(-1)!).envelopeId;
}

export function buildBudgetSuggestionBasis(input: {
  ledger: ClientLedger;
  month: string;
  profile: BudgetSuggestProfile;
  customPrompt?: string;
}): BudgetSuggestionBasis {
  const { ledger, month, profile } = input;
  const state = computeBudgetState(ledger, month);
  const amountToDistribute = Math.max(0, state.toBeBudgeted);

  const active = state.envelopes.filter((e) => !e.envelope.archived);
  const candidates: BudgetSuggestionCandidate[] = active.map((e) => {
    const stats = computeEnvelopeBudgetStats(ledger, e.envelope.id, month, e.allocated, e.available, e.envelope.monthlyTarget ?? null);
    const savingsLike = e.envelope.isSavings;
    const negNeed = Math.max(0, -e.available);
    const typical = profile === "cautious" ? stats.medianSpend : stats.avgSpend;
    const fundToTypical = Math.max(0, typical - e.allocated);

    const hints: string[] = [];
    if (negNeed > 0) hints.push("hint.coverNegative");

    let baseDelta: number;
    let priority: number;
    if (profile === "investor") {
      baseDelta = negNeed;
      priority = savingsLike ? 100 : negNeed > 0 ? 90 : stats.recurringLike ? 60 : 30;
      if (savingsLike) hints.push("hint.savingsEnvelope");
    } else {
      baseDelta = negNeed + fundToTypical;
      if (fundToTypical > 0) hints.push(profile === "cautious" ? "hint.toMedian" : "hint.toAverage");
      priority = negNeed > 0 ? 100 : stats.recurringLike ? 80 : fundToTypical > 0 ? 60 : savingsLike ? 40 : 20;
    }
    let maxDelta = amountToDistribute;
    if (stats.targetGap != null) {
      maxDelta = Math.min(stats.targetGap, amountToDistribute);
      baseDelta = maxDelta;  
      priority = Math.max(priority, negNeed > 0 ? 100 : 90);  
      hints.push("hint.monthlyTarget");
    }
    baseDelta = Math.min(baseDelta, amountToDistribute);
    return { envelopeId: e.envelope.id, baseDelta, minDelta: 0, maxDelta, priority, savingsLike, stats, rationaleHints: hints };
  });

  return { month, profile, amountToDistribute, candidates, remainderEnvelopeId: pickRemainder(candidates, profile) };
}

export interface ProposedEnvelopeDelta {
  envelopeId: string;
  proposedDelta: number;
  rationale?: string;
  confidence?: number;
}

export interface NormalizedSuggestionItem {
  envelopeId: string;
  currentAllocated: Money;
  currentAvailable: Money;
  proposedDelta: Money;
  resultingAllocated: Money;
  monthlyTarget: Money | null;
  targetGap: Money | null;
  meetsTarget: boolean;
  rationale: string;  
  rationaleCodes: string[];  
  confidence: number;
}

export interface NormalizedBudgetSuggestion {
  amountToDistribute: Money;
  distributed: Money;
  undistributedRemainder: Money;
  repaired: boolean;
  items: NormalizedSuggestionItem[];
  warnings: string[];
}

function defaultRationale(c: BudgetSuggestionCandidate): string[] {
  return c.rationaleHints.length ? [...c.rationaleHints] : ["hint.byStrategy"];
}

function buildResult(
  basis: BudgetSuggestionBasis,
  deltas: Map<string, number>,
  repaired: boolean,
  undistributedRemainder: number,
  warnings: string[],
  rationales?: Map<string, string>,
  confidences?: Map<string, number>,
  opts?: { amountToDistribute?: number; rationaleCodes?: string[] },
): NormalizedBudgetSuggestion {
  const items: NormalizedSuggestionItem[] = [];
  let distributed = 0;
  for (const c of [...basis.candidates].sort(byPriorityDesc)) {
    const d = deltas.get(c.envelopeId) ?? 0;
    if (d <= 0) continue;
    distributed += d;
    const rationale = rationales?.get(c.envelopeId);
    items.push({
      envelopeId: c.envelopeId,
      currentAllocated: c.stats.allocatedThisMonth,
      currentAvailable: c.stats.available,
      proposedDelta: d,
      resultingAllocated: c.stats.allocatedThisMonth + d,
      monthlyTarget: c.stats.monthlyTarget,
      targetGap: c.stats.targetGap,
      meetsTarget: c.stats.targetGap == null ? true : d >= c.stats.targetGap,
      rationale: rationale ?? "",
      rationaleCodes: rationale ? [] : (opts?.rationaleCodes ?? defaultRationale(c)),
      confidence: confidences?.get(c.envelopeId) ?? 1,
    });
  }
  return { amountToDistribute: opts?.amountToDistribute ?? basis.amountToDistribute, distributed, undistributedRemainder, repaired, items, warnings };
}





function largestRemainderScale(entries: [string, number][], amount: number): Map<string, number> {
  const result = new Map<string, number>();
  const total = entries.reduce((x, [, w]) => x + w, 0);
  if (total <= 0 || amount <= 0) {
    for (const [id] of entries) result.set(id, 0);
    return result;
  }
  const fracs: { id: string; frac: number }[] = [];
  let assigned = 0;
  for (const [id, w] of entries) {
    const raw = (amount * w) / total;
    const base = Math.floor(raw);
    result.set(id, base);
    assigned += base;
    fracs.push({ id, frac: raw - base });
  }
  let left = amount - assigned;
  fracs.sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : 1));
  for (const f of fracs) {
    if (left <= 0) break;
    result.set(f.id, result.get(f.id)! + 1);
    left -= 1;
  }
  return result;
}

 
function placeRemainder(basis: BudgetSuggestionBasis, deltas: Map<string, number>, remaining: number): number {
  if (remaining <= 0) return 0;
  const order: BudgetSuggestionCandidate[] = [];
  const sink = basis.remainderEnvelopeId ? basis.candidates.find((c) => c.envelopeId === basis.remainderEnvelopeId) : undefined;
  if (sink) order.push(sink);
  for (const c of [...basis.candidates].sort(byPriorityDesc)) if (!order.includes(c)) order.push(c);
  for (const c of order) {
    if (remaining <= 0) break;
    const cur = deltas.get(c.envelopeId) ?? 0;
    const room = c.maxDelta - cur;
    if (room <= 0) continue;
    const add = Math.min(room, remaining);
    deltas.set(c.envelopeId, cur + add);
    remaining -= add;
  }
  return remaining;
}

export function buildRulesBudgetSuggestion(basis: BudgetSuggestionBasis): NormalizedBudgetSuggestion {
  const deltas = new Map<string, number>();
  let remaining = basis.amountToDistribute;
  for (const c of [...basis.candidates].sort(byPriorityDesc)) {
    if (remaining <= 0) break;
    const cur = deltas.get(c.envelopeId) ?? 0;
    const give = Math.min(c.baseDelta, remaining, c.maxDelta - cur);
    if (give > 0) {
      deltas.set(c.envelopeId, cur + give);
      remaining -= give;
    }
  }
  const undistributed = placeRemainder(basis, deltas, remaining);
  return buildResult(basis, deltas, false, undistributed, []);
}

export function normalizeBudgetSuggestion(basis: BudgetSuggestionBasis, proposed: ProposedEnvelopeDelta[]): NormalizedBudgetSuggestion {
  const byId = new Map(basis.candidates.map((c) => [c.envelopeId, c]));
  const deltas = new Map<string, number>();
  const rationales = new Map<string, string>();
  const confidences = new Map<string, number>();
  let repaired = false;

  for (const p of proposed) {
    const c = byId.get(p.envelopeId);
    if (!c) {
      repaired = true;
      continue;
    }  
    const d = Math.round(p.proposedDelta ?? 0);
    if (!Number.isFinite(d) || d <= 0) {
      if (d < 0) repaired = true;
      continue;
    }
    const clamped = Math.min(Math.max(0, d), c.maxDelta);
    if (clamped !== d) repaired = true;
    deltas.set(p.envelopeId, (deltas.get(p.envelopeId) ?? 0) + clamped);
    if (p.rationale) rationales.set(p.envelopeId, p.rationale);
    if (typeof p.confidence === "number") confidences.set(p.envelopeId, p.confidence);
  }

  const sum = [...deltas.values()].reduce((x, v) => x + v, 0);
  const diff = basis.amountToDistribute - sum;
  let undistributed = 0;
  if (diff > 0) {
    undistributed = placeRemainder(basis, deltas, diff);
    repaired = true;
  } else if (diff < 0) {
    let excess = -diff;
    for (const c of [...basis.candidates].sort(byPriorityDesc).reverse()) {
      if (excess <= 0) break;
      const cur = deltas.get(c.envelopeId) ?? 0;
      if (cur <= 0) continue;
      const cut = Math.min(cur, excess);
      deltas.set(c.envelopeId, cur - cut);
      excess -= cut;
      repaired = true;
    }
  }
  return buildResult(basis, deltas, repaired, undistributed, [], rationales, confidences);
}

 








export function buildTopUpNegativesSuggestion(basis: BudgetSuggestionBasis): NormalizedBudgetSuggestion {
  const amount = basis.amountToDistribute;
  const deficits: [string, number][] = basis.candidates.filter((c) => c.stats.available < 0).map((c) => [c.envelopeId, -c.stats.available]);
  const sumDef = deficits.reduce((x, [, d]) => x + d, 0);
  const deltas = new Map<string, number>();
  const warnings: string[] = [];
  let undistributed = 0;
  if (sumDef <= amount) {
    for (const [id, def] of deficits) deltas.set(id, def);
    undistributed = amount - sumDef;
    if (undistributed > 0) warnings.push("remainder");
  } else {
    for (const [id, v] of largestRemainderScale(deficits, amount)) deltas.set(id, v);
  }
  return buildResult(basis, deltas, false, undistributed, warnings, undefined, undefined, { rationaleCodes: ["hint.topUp"] });
}

/**
 * "Like last month": delta_i = max(0, prevAllocated_i − currentAllocated_i)
 * for active envelopes (existing allocations are not taken away). Σdeltas MAY
 * exceed TBB — then an "over_tbb" warning (the user trims/unchecks in the editor).
 */
export function buildPrevMonthSuggestion(basis: BudgetSuggestionBasis, prevAllocations: Map<string, number>): NormalizedBudgetSuggestion {
  const deltas = new Map<string, number>();
  let sum = 0;
  for (const c of basis.candidates) {
    const prev = prevAllocations.get(c.envelopeId) ?? 0;
    const d = Math.max(0, prev - c.stats.allocatedThisMonth);
    if (d > 0) {
      deltas.set(c.envelopeId, d);
      sum += d;
    }
  }
  const warnings = sum > basis.amountToDistribute ? ["over_tbb"] : [];
  const undistributed = Math.max(0, basis.amountToDistribute - sum);
  return buildResult(basis, deltas, false, undistributed, warnings, undefined, undefined, { rationaleCodes: ["hint.prevMonth"] });
}

 

/**
 * Normalizes raw agent deltas: drop unknown ids, clamp negatives→0,
 * SCALING ONLY within the envelopes the agent picked, to Σ=amount
 * (largest remainder on minor units). Empty or Σ==0 → items=[] + an
 * "agent_empty" warning — NO silent fallback to rules; NEVER adds funds
 * to envelopes the agent skipped.
 */
export function normalizeAgentSuggestion(deltas: ProposedEnvelopeDelta[], basis: BudgetSuggestionBasis, amount: number): NormalizedBudgetSuggestion {
  const byId = new Map(basis.candidates.map((c) => [c.envelopeId, c]));
  const agg = new Map<string, number>();
  const rationales = new Map<string, string>();
  const confidences = new Map<string, number>();
  let repaired = false;
  for (const p of deltas) {
    if (!byId.has(p.envelopeId)) {
      repaired = true;
      continue;
    }  
    const d = Math.round(p.proposedDelta ?? 0);
    if (!Number.isFinite(d) || d <= 0) {
      if (d !== 0) repaired = true;
      continue;
    }  
    agg.set(p.envelopeId, (agg.get(p.envelopeId) ?? 0) + d);
    if (p.rationale) rationales.set(p.envelopeId, p.rationale);
    if (typeof p.confidence === "number") confidences.set(p.envelopeId, p.confidence);
  }
  const sum = [...agg.values()].reduce((x, v) => x + v, 0);
  if (sum <= 0) {
    return { amountToDistribute: amount, distributed: 0, undistributedRemainder: amount, repaired, items: [], warnings: ["agent_empty"] };
  }
  let final = agg;
  if (sum !== amount) {
    final = largestRemainderScale([...agg.entries()], amount);
    repaired = true;
  }
  return buildResult(basis, final, repaired, 0, [], rationales, confidences, { amountToDistribute: amount, rationaleCodes: [] });
}

 

export interface BudgetSuggestionItem {
  envelopeId: string;
  currentAllocated: number;
  currentAvailable: number;
  monthlyTarget: number | null;
  targetGap: number | null;
  meetsTarget: boolean;
  proposedDelta: number;
  resultingAllocated: number;
  rationale: string;  
  rationaleCodes: string[];  
  confidence: number;
}

export interface BudgetSuggestResponse {
  month: string;
  profile: BudgetSuggestProfile;
  source: BudgetSuggestSource;
  amountToDistribute: number;
  undistributedRemainder: number;
  generatedAt: string;
  items: BudgetSuggestionItem[];
  warnings: string[];
}
