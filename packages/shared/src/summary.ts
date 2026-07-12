/**
 * Envelope summary — the SAME code computes `GET /api/envelopes/:id/summary`
 * on the server and the client's local read.
 *
 * Ported VERBATIM from packages/api/src/routes/state.ts — INCLUDING QUIRKS
 * (the numbers in the UI must not change):
 * - the 6-month series computes `spentOf` without the account onBudget filter
 *   (computeBudgetState filters — here deliberately NOT),
 * - `spentOf` skips planned and transfer,
 * - the byCat loop does NOT filter planned; splits are counted for EVERY
 *   transaction type, non-split rows only when type === "expense",
 * - name fallbacks: "Inne" (unknown id) / "Bez kategorii" (null) — Polish
 *   product strings, kept verbatim,
 * - sorted by amount descending.
 */
import { computeBudgetState, monthOf, prevMonth } from "./budget";
import type { ClientLedger, EnvelopeState, Money } from "./types";

export interface EnvelopeSummaryPoint {
  month: string;
  spent: Money;
}

export interface EnvelopeSummaryCategory {
  categoryId: string | null;
  name: string;
  amount: Money;
}

export interface EnvelopeSummary {
  envelopeId: string;
  month: string;
  series: EnvelopeSummaryPoint[];
  categories: EnvelopeSummaryCategory[];
  categoriesTotal: Money;
  carryIn: Money;
  envelope: EnvelopeState | null;
}

export interface EnvelopeSummaryOpts {
  /** Category window: [month−(n−1) … month]. Default 1 = exactly today's behavior. */
  categoryMonths?: 1 | 3 | 6 | 12;
}

/**
 * Category breakdown (window `opts.categoryMonths`, default: the selected month)
 * + a 6-month series for the envelope. Without `opts` the result is identical
 * to before (existing fields byte-for-byte — the api endpoint calls without opts).
 */
export function computeEnvelopeSummary(
  ledger: ClientLedger,
  envId: string,
  month: string,
  opts?: EnvelopeSummaryOpts,
): EnvelopeSummary {
  // expenses assigned to the envelope (splits included)
  const spentOf = (t: (typeof ledger.transactions)[number]): number => {
    if (t.planned || t.type === "transfer") return 0;
    const sign = t.isRefund ? -1 : 1;
    if (t.type === "income") return t.envelopeId === envId ? -t.amount : 0;
    if (t.items.length > 0) {
      return t.items.filter((i) => i.envelopeId === envId).reduce((x, i) => x + sign * i.amount, 0);
    }
    return t.envelopeId === envId ? sign * t.amount : 0;
  };

  // monthly series (selected + 5 back)
  const monthsBack: string[] = [month];
  for (let i = 0; i < 5; i++) monthsBack.unshift(prevMonth(monthsBack[0]!));
  const series = monthsBack.map((m) => ({
    month: m,
    spent: ledger.transactions
      .filter((t) => monthOf(t.date) === m)
      .reduce((x, t) => x + spentOf(t), 0),
  }));

  // category breakdown in the [month−(n−1) … month] window (default: month alone)
  const n = opts?.categoryMonths ?? 1;
  const monthsWindow: string[] = [month];
  for (let i = 1; i < n; i++) monthsWindow.unshift(prevMonth(monthsWindow[0]!));
  const byCat = new Map<string | null, number>();
  for (const t of ledger.transactions) {
    if (!monthsWindow.includes(monthOf(t.date))) continue;
    if (t.items.length > 0) {
      for (const it of t.items) {
        if (it.envelopeId !== envId) continue;
        byCat.set(it.categoryId, (byCat.get(it.categoryId) ?? 0) + (t.isRefund ? -it.amount : it.amount));
      }
    } else if (t.envelopeId === envId && t.type === "expense") {
      byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + (t.isRefund ? -t.amount : t.amount));
    }
  }
  const cats = ledger.categories;
  const catName = (id: string | null) => (id ? (cats.find((x) => x.id === id)?.name ?? "Inne") : "Bez kategorii");
  const categories = [...byCat.entries()]
    .map(([id, amount]) => ({ categoryId: id, name: catName(id), amount }))
    .sort((a, b) => b.amount - a.amount);

  const categoriesTotal = categories.reduce((s, c) => s + c.amount, 0);

  const state = computeBudgetState(ledger, month);
  const env = state.envelopes.find((e) => e.envelope.id === envId);

  // carry-in = envelope available at the end of the previous month (Variant A,
  // no floor at 0); 0 when the envelope is unknown / no history.
  const prevState = computeBudgetState(ledger, prevMonth(month));
  const carryIn = prevState.envelopes.find((e) => e.envelope.id === envId)?.available ?? 0;

  return { envelopeId: envId, month, series, categories, categoriesTotal, carryIn, envelope: env ?? null };
}
