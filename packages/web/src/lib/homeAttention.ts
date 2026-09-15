import { goalProgress, type StateResponse } from "@enveo/shared";
import { budgetPace, budgetSteps } from "./reportSummary";

export type AttentionRow =
  | { kind: "over"; n: number; name: string | null; amount: number }
  | { kind: "risk"; name: string; projected: number; envelopeId: string }
  | { kind: "pool"; amount: number }
  | { kind: "overAssigned"; amount: number }
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
    if (!envelope) continue;
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
