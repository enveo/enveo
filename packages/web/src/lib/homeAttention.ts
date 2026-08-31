/**
 * Pure derivation of the "Needs attention" widget's rows — no DOM, no I/O, no store reads.
 * Imported ONLY by `components/widgetsBoard.tsx`, so it stays inside that lazy chunk rather than
 * joining the eager closure (§3f) — see that file's own header comment for the bundle rule.
 *
 * Six row kinds, in a FIXED order (over → risk → pool → overAssigned → goals → debt) — ported
 * from the approved design mock's own `attentionAll` derivation (`Wide App Demo v3.dc.html:3679-
 * 3720`, the mockup pr5-context.md's Ground Truth section points at), reading app ids and the
 * house's own shared math instead of the mock's demo-local shortcuts (F1 in pr5-context.md).
 *
 * - `over` / `goals` / `debt` are each ONE aggregate row (`n` + a total `amount`); `name` carries
 *   the single subject's name only when `n === 1`, else `null` — the same singular-vs-count split
 *   the mock's own label string encodes ("X is overspent" vs "{n} envelopes are overspent"), just
 *   returned as data instead of pre-formatted English so the caller's `t()`/`tp()` build the copy.
 * - `risk` is NOT aggregated: one row per at-risk envelope (mirrors `triage.risk.forEach` in the
 *   mock) — each carries its own `projected`, which is a DIFFERENT number from a budget step's own
 *   `amount` (the top-up needed to clear the step), so it is read straight off `budgetPace`, never
 *   approximated from the step.
 * - `pool` / `overAssigned` are mutually exclusive by construction (`readyToAssign`'s sign) and
 *   both absent when it is exactly zero — "sitting at zero" is not a warning, same idea used
 *   everywhere else amounts are classified in this codebase (`left < 0`, never `>= 0` alone).
 *
 * `over` / `risk` both come from `budgetSteps` — the SAME classifier the Budgets report's own
 * checklist uses (`left < 0`, never `pct > 100`; a zero-budget overspent envelope still counts,
 * see `reportSummary.budgetUsage`). `budgetSteps` is called with NO `ignored` set: decision #2 in
 * pr5-context.md keeps a dismissed step's "ignore" flag report-local (`BudgetsReport`'s own
 * component state), so a step dismissed there still surfaces here — the widget shows the plan as
 * the report would with zero ignores.
 *
 * **`state.accounts` must already be GLOBAL, current-month balances** — this function trusts its
 * caller for that, exactly like every other account-balance consumer in this codebase (accounts
 * are global, envelopes are monthly; see `AccountsWidget`/`NetWorthWidget` in `widgets.tsx`, which
 * both recompute `computeStateResponse(ledger, currentMonth()).accounts` regardless of the viewed
 * month). A `state` built from a non-current viewed month would otherwise leak a stale "debt" row
 * whenever the Start screen has paged away from the current month.
 */
import { goalProgress, type StateResponse } from "@enveo/shared";
import { budgetPace, budgetSteps } from "./reportSummary";

export type AttentionRow =
  | { kind: "over"; n: number; name: string | null; amount: number }
  | { kind: "risk"; name: string; projected: number; envelopeId: string }
  | { kind: "pool"; amount: number } // readyToAssign > 0 → Suggest
  | { kind: "overAssigned"; amount: number } // readyToAssign < 0 → Budget
  | { kind: "goals"; n: number; amount: number }
  | { kind: "debt"; n: number; name: string | null; amount: number };

export function attentionRows(state: StateResponse, progress: number): AttentionRow[] {
  const rows: AttentionRow[] = [];
  const steps = budgetSteps(state.envelopes, progress);
  const envById = new Map(state.envelopes.map((e) => [e.id, e]));

  const overSteps = steps.filter((s) => s.kind === "over");
  if (overSteps.length > 0) {
    rows.push({
      kind: "over",
      n: overSteps.length,
      name: overSteps.length === 1 ? overSteps[0]!.name : null,
      amount: overSteps.reduce((sum, s) => sum + s.amount, 0),
    });
  }

  for (const step of steps) {
    if (step.kind !== "risk") continue;
    const envelope = envById.get(step.envelopeId);
    if (!envelope) continue; // defensive — budgetSteps derives its ids from this same list
    rows.push({ kind: "risk", name: step.name, projected: budgetPace(envelope, progress).projected, envelopeId: step.envelopeId });
  }

  if (state.readyToAssign > 0) rows.push({ kind: "pool", amount: state.readyToAssign });
  if (state.readyToAssign < 0) rows.push({ kind: "overAssigned", amount: -state.readyToAssign });

  const shortGoals = state.envelopes
    .filter((e) => !e.archived)
    .flatMap((e) => {
      const gp = goalProgress(e);
      return gp && gp.missing > 0 ? [gp.missing] : [];
    });
  if (shortGoals.length > 0) {
    rows.push({ kind: "goals", n: shortGoals.length, amount: shortGoals.reduce((sum, missing) => sum + missing, 0) });
  }

  const debtAccounts = state.accounts.filter((a) => !a.archived && a.balance < 0);
  if (debtAccounts.length > 0) {
    rows.push({
      kind: "debt",
      n: debtAccounts.length,
      name: debtAccounts.length === 1 ? debtAccounts[0]!.name : null,
      amount: debtAccounts.reduce((sum, a) => sum + -a.balance, 0),
    });
  }

  return rows;
}
