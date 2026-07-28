








export interface BudgetsSummary {
  over: number;  
  near: number;  
  ok: number;  
}

type BudgetEnvelope = {
  archived: boolean;
  allocated: number;
  carryIn: number;
  spent: number;
};

 
export function budgetsSummary(envelopes: BudgetEnvelope[]): BudgetsSummary {
  const out: BudgetsSummary = { over: 0, near: 0, ok: 0 };
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    const budget = Math.max(1, e.allocated + e.carryIn);
    const pct = (Math.max(0, e.spent) / budget) * 100;
    if (pct > 100) out.over++;
    else if (pct >= 80) out.near++;
    else out.ok++;
  }
  return out;
}
