/**
 * Reports — pure analytical functions computed from the replica (no I/O).
 * Reuse computeBudgetState (balances) and the spentOf rules (spending).
 */
import { computeBudgetState, monthOf, prevMonth } from "./budget";
import { goalProgress } from "./goals";
import type { ClientLedger, Money, Transaction } from "./types";

export interface NetWorthPoint {
  month: string;
  total: Money;
}

/** Sum of ALL account balances (on- and off-budget) at the end of each of `months` months up to `month`. */
export function computeNetWorthSeries(ledger: ClientLedger, month: string, months = 12): NetWorthPoint[] {
  const window: string[] = [month];
  for (let i = 0; i < months - 1; i++) window.unshift(prevMonth(window[0]!));
  return window.map((m) => ({
    month: m,
    total: computeBudgetState(ledger, m).accounts.reduce((s, a) => s + a.balance, 0),
  }));
}

export interface CashflowPoint {
  month: string;
  income: Money;
  expense: Money;
  net: Money;
}

/**
 * Income vs expense per month (all accounts; transfer skipped; refunds negative).
 * Spending assigned to net-worth envelopes (isSavings) is EXCLUDED — cashflow = earnings
 * vs real consumption, consistent with "Spending by dimension" (saving ≠ consumption).
 */
export function computeCashflowSeries(ledger: ClientLedger, month: string, months = 12): CashflowPoint[] {
  const window: string[] = [month];
  for (let i = 0; i < months - 1; i++) window.unshift(prevMonth(window[0]!));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const byMonth = new Map<string, { income: number; expense: number }>();
  for (const m of window) byMonth.set(m, { income: 0, expense: 0 });
  for (const t of ledger.transactions) {
    if (t.type === "transfer") continue;
    const b = byMonth.get(monthOf(t.date));
    if (!b) continue;
    if (t.type === "income") {
      b.income += t.amount;
      continue;
    }
    // expense — skip portions assigned to net-worth envelopes
    const sign = t.isRefund ? -1 : 1;
    if (t.items.length > 0) {
      b.expense += sign * t.items.filter((i) => !savings.has(i.envelopeId)).reduce((s, i) => s + i.amount, 0);
    } else if (!(t.envelopeId && savings.has(t.envelopeId))) {
      b.expense += sign * t.amount;
    }
  }
  return window.map((m) => {
    const b = byMonth.get(m)!;
    return { month: m, income: b.income, expense: b.expense, net: b.income - b.expense };
  });
}

export type SpendingDimension = "category" | "envelope" | "group" | "place";

export interface SpendingRow {
  key: string | null;
  name: string;
  amount: Money;
  pct: number;
}

// Polish product strings returned in rows (UI data — do not translate).
const NULL_LABEL: Record<SpendingDimension, string> = {
  category: "Bez kategorii",
  envelope: "Bez koperty",
  group: "Bez grupy",
  place: "Bez miejsca",
};

/** Expense transaction contribution to the per-dimension breakdown (parity with spentOf rules). */
function expenseByDimension(t: Transaction, dim: SpendingDimension, envGroup: Map<string, string>, savings: Set<string>): Array<[string | null, Money]> {
  if (t.type !== "expense") return [];
  const sign = t.isRefund ? -1 : 1;
  if (t.items.length > 0) {
    const items = t.items.filter((it) => !savings.has(it.envelopeId));
    if (dim === "place") {
      const amt = items.reduce((s, it) => s + it.amount, 0);
      return amt !== 0 ? [[t.placeId, sign * amt]] : [];
    }
    return items.map((it) => {
      const key = dim === "category" ? it.categoryId : dim === "group" ? (envGroup.get(it.envelopeId) ?? null) : it.envelopeId;
      return [key, sign * it.amount] as [string | null, Money];
    });
  }
  if (t.envelopeId && savings.has(t.envelopeId)) return []; // net-worth envelope — not consumption
  const key =
    dim === "place"
      ? t.placeId
      : dim === "category"
        ? t.categoryId
        : dim === "group"
          ? t.envelopeId
            ? (envGroup.get(t.envelopeId) ?? null)
            : null
          : t.envelopeId;
  return [[key, sign * t.amount]];
}

/** Spending breakdown [fromMonth, toMonth] by dimension; sorted descending, with % share. */
export function computeSpendingByDimension(ledger: ClientLedger, fromMonth: string, toMonth: string, dim: SpendingDimension): SpendingRow[] {
  const envGroup = new Map(ledger.envelopes.map((e) => [e.id, e.groupId]));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const nameOf = (key: string | null): string => {
    if (key === null) return NULL_LABEL[dim];
    if (dim === "category") return ledger.categories.find((c) => c.id === key)?.name ?? "Inne";
    if (dim === "place") return ledger.places.find((p) => p.id === key)?.name ?? "Inne";
    if (dim === "group") return ledger.groups.find((g) => g.id === key)?.name ?? "Inne";
    return ledger.envelopes.find((e) => e.id === key)?.name ?? "Inne";
  };
  const sums = new Map<string | null, number>();
  for (const t of ledger.transactions) {
    const m = monthOf(t.date);
    if (m < fromMonth || m > toMonth) continue;
    for (const [key, amt] of expenseByDimension(t, dim, envGroup, savings)) {
      sums.set(key, (sums.get(key) ?? 0) + amt);
    }
  }
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  return [...sums.entries()]
    .map(([key, amount]) => ({ key, name: nameOf(key), amount, pct: total > 0 ? amount / total : 0 }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Deterministic median: for an EVEN-length input, returns the LOWER of the
 * two middle values rather than averaging them — every input here is either
 * an integer money amount or a plain ratio, and picking an existing value
 * (vs. inventing a midpoint) keeps results exact and reproducible. Empty
 * input → 0, matching the "missing period counts as 0" convention used by
 * `spendingBaseline`/`computeEnvelopeTrends` below.
 */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export interface DailySpendingPoint {
  date: string; // YYYY-MM-DD
  total: Money;
}

/**
 * Per-calendar-day expense total for `month` — same rules as the expense side
 * of computeCashflowSeries (type "expense" only, refunds negative, portions
 * assigned to a savings envelope excluded, transfers/income ignored), reusing
 * expenseByDimension for that per-transaction contribution (the dimension
 * passed is irrelevant — we sum every returned entry regardless of key).
 * Returns EVERY day of `month` (zero-filled), so a calendar heatmap grid is
 * always complete; days-in-month is derived purely from `month` (no
 * `Date.now()`), correctly handling 28/29 (leap)/30/31-day months.
 */
export function computeDailySpending(ledger: ClientLedger, month: string): DailySpendingPoint[] {
  const envGroup = new Map(ledger.envelopes.map((e) => [e.id, e.groupId]));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const daysInMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const byDate = new Map<string, Money>();
  for (let d = 1; d <= daysInMonth; d++) byDate.set(`${month}-${String(d).padStart(2, "0")}`, 0);
  for (const t of ledger.transactions) {
    if (!byDate.has(t.date)) continue; // outside `month`
    const amt = expenseByDimension(t, "category", envGroup, savings).reduce((s, [, a]) => s + a, 0);
    if (amt !== 0) byDate.set(t.date, byDate.get(t.date)! + amt);
  }
  return [...byDate.entries()].map(([date, total]) => ({ date, total }));
}

export interface DaySpendingEnvelope {
  envelopeId: string | null;
  name: string;
  color: string;
  amount: Money;
}

export interface DaySpending {
  date: string; // YYYY-MM-DD
  total: Money;
  count: number; // contributing expense transactions
  txns: Transaction[]; // in ledger order
  byEnvelope: DaySpendingEnvelope[]; // descending by amount
}

/**
 * One calendar day, expanded — the Month report's day panel.
 *
 * The total is the same number `computeDailySpending` reports for this date, because both
 * route every transaction through `expenseByDimension`: type "expense" only, refunds negative,
 * portions assigned to a net-worth envelope excluded, transfers and income ignored. Keeping
 * that single rule is the point — the calendar cell and the panel that opens under it must
 * never disagree.
 *
 * A transaction counts once in `txns` however many envelopes its items touch; `byEnvelope`
 * splits the money. An unassigned expense keeps the dimension label the spending report
 * already uses, rather than inventing a second name for the same thing.
 */
export function computeDaySpending(ledger: ClientLedger, date: string): DaySpending {
  const envGroup = new Map(ledger.envelopes.map((e) => [e.id, e.groupId]));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const byEnvelope = new Map<string | null, Money>();
  const txns: Transaction[] = [];
  let total = 0;

  for (const t of ledger.transactions) {
    if (t.date !== date) continue;
    const parts = expenseByDimension(t, "envelope", envGroup, savings);
    const amt = parts.reduce((s, [, a]) => s + a, 0);
    if (parts.length === 0 || amt === 0) continue;
    txns.push(t);
    total += amt;
    for (const [key, a] of parts) byEnvelope.set(key, (byEnvelope.get(key) ?? 0) + a);
  }

  const rows = [...byEnvelope.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([envelopeId, amount]) => {
      const envelope = envelopeId === null ? undefined : ledger.envelopes.find((e) => e.id === envelopeId);
      return {
        envelopeId,
        name: envelope?.name ?? NULL_LABEL.envelope,
        color: envelope?.color ?? "",
        amount,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  return { date, total, count: txns.length, txns, byEnvelope: rows };
}

export interface PlaceStat {
  key: string;
  name: string;
  count: number;
  total: Money;
}

/**
 * Whether an expense transaction's contribution is ENTIRELY attributable to
 * savings envelope(s) — non-split: `t.envelopeId` is a savings envelope;
 * split: EVERY item's envelope is a savings envelope. A fully-savings
 * transaction is "not real spending" for place/largest-expense purposes (no
 * visit, no expense line). Also returns the summed NON-SAVINGS portion, for
 * callers that need a partial amount on a MIXED split (some items savings,
 * some not) — e.g. `topPlaces`, which counts the visit but sums only the
 * non-savings items rather than the full receipt.
 */
function savingsSplit(t: Transaction, savings: Set<string>): { fullySavings: boolean; nonSavingsAmount: Money } {
  if (t.items.length > 0) {
    const nonSavingsItems = t.items.filter((it) => !savings.has(it.envelopeId));
    return {
      fullySavings: nonSavingsItems.length === 0,
      nonSavingsAmount: nonSavingsItems.reduce((s, it) => s + it.amount, 0),
    };
  }
  const isSavingsEnv = !!(t.envelopeId && savings.has(t.envelopeId));
  return { fullySavings: isSavingsEnv, nonSavingsAmount: isSavingsEnv ? 0 : t.amount };
}

/**
 * Top places by transaction COUNT ("visits") over [fromMonth, toMonth]
 * (tie-break: total desc, then name asc — fully deterministic regardless of
 * replica ordering). Only expense transactions carrying a placeId; refunds
 * are excluded ENTIRELY (not netted into the total) — a refunded purchase
 * shouldn't count toward "where you shop". A transaction whose ENTIRE
 * contribution is savings-attributed doesn't count as a visit either (see
 * `savingsSplit`); for a MIXED split the visit IS counted but `total` sums
 * only the non-savings items. This list is FREQUENCY-led, and deliberately
 * differs from `computeSpendingByDimension(place)` (which nets refunds
 * rather than excluding them, and has no visit/count concept at all).
 */
export function topPlaces(ledger: ClientLedger, fromMonth: string, toMonth: string, limit = 5): PlaceStat[] {
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const byPlace = new Map<string, { count: number; total: Money }>();
  for (const t of ledger.transactions) {
    if (t.type !== "expense" || t.isRefund || !t.placeId) continue;
    const m = monthOf(t.date);
    if (m < fromMonth || m > toMonth) continue;
    const { fullySavings, nonSavingsAmount } = savingsSplit(t, savings);
    if (fullySavings) continue; // not a visit — nothing real was spent
    const b = byPlace.get(t.placeId) ?? { count: 0, total: 0 };
    b.count += 1;
    b.total += nonSavingsAmount;
    byPlace.set(t.placeId, b);
  }
  return [...byPlace.entries()]
    .map(([key, b]) => ({
      key,
      name: ledger.places.find((p) => p.id === key)?.name ?? "Inne",
      count: b.count,
      total: b.total,
    }))
    .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface LargestExpense {
  id: string;
  label: string;
  /**
   * Secondary text for the row (e.g. "US VAT · Podatki") — the transaction's envelope name, else
   * its category name; `null` when neither resolves OR when the resolved string would just repeat
   * `label` (see `contextFor`). Consumers should treat `null` as "nothing to show", not an error.
   */
  context: string | null;
  date: string;
  amount: Money;
}

/**
 * Label preference, checked against the ACTUAL fields on `Transaction`
 * (types.ts): place name → transaction `name` (the short list-title field —
 * this schema's closest thing to a "receipt title", so it outranks the
 * longer free-form `note`) → transaction note → category name → envelope
 * name → "—".
 */
function labelFor(t: Transaction, ledger: ClientLedger): string {
  if (t.placeId) {
    const place = ledger.places.find((p) => p.id === t.placeId);
    if (place) return place.name;
  }
  if (t.name) return t.name;
  if (t.note) return t.note;
  if (t.categoryId) {
    const cat = ledger.categories.find((c) => c.id === t.categoryId);
    if (cat) return cat.name;
  }
  if (t.envelopeId) {
    const e = ledger.envelopes.find((e) => e.id === t.envelopeId);
    if (e) return e.name;
  }
  return "—";
}

/**
 * `largestExpenses`' secondary "context" text: envelope name, else category name (envelope wins
 * when a transaction somehow carries both). For a SPLIT transaction, the top-level
 * `envelopeId`/`categoryId` are always null (see `applyOp.ts` — a split's fields live per-item),
 * so context instead resolves from the DOMINANT item — the largest-amount NON-SAVINGS item (ties
 * keep the earlier item); a split with no non-savings item at all (shouldn't reach here, callers
 * already exclude fully-savings transactions) yields `null`.
 *
 * FINAL RULE: whatever string this resolves to is suppressed (→ `null`) when it is IDENTICAL to
 * `label` — `labelFor`'s own last two tiers fall back to category then envelope when place/name/
 * note are all missing, so a plain-string-equality check (rather than tracking which tier produced
 * `label`) is both simpler and stricter: it also catches the coincidental case where an envelope's
 * name literally equals its category's name. This is what avoids a redundant "Podatki · Podatki"
 * row.
 */
function contextFor(t: Transaction, ledger: ClientLedger, label: string, savings: Set<string>): string | null {
  let context: string | null;
  if (t.items.length > 0) {
    const nonSavings = t.items.filter((it) => !savings.has(it.envelopeId));
    const dominant = nonSavings.length > 0 ? nonSavings.reduce((a, b) => (b.amount > a.amount ? b : a)) : null;
    context = dominant ? (ledger.envelopes.find((e) => e.id === dominant.envelopeId)?.name ?? null) : null;
  } else {
    const envelopeName = t.envelopeId ? (ledger.envelopes.find((e) => e.id === t.envelopeId)?.name ?? null) : null;
    const categoryName = t.categoryId ? (ledger.categories.find((c) => c.id === t.categoryId)?.name ?? null) : null;
    context = envelopeName ?? categoryName;
  }
  return context !== null && context !== label ? context : null;
}

/**
 * The `limit` largest INDIVIDUAL (non-refund) expense transactions in
 * `month`, amount desc (tie-break: date desc, then id asc — fully
 * deterministic regardless of replica ordering) — "individual" as opposed to
 * aggregated-by-dimension (computeSpendingByDimension). A split transaction
 * is included ONCE at its FULL `amount` (the receipt as the user typed it)
 * as long as it has ANY non-savings portion. A transaction whose ENTIRE
 * contribution is savings-attributed (see `savingsSplit`) is EXCLUDED
 * entirely — it isn't real spending, so it shouldn't surface as a "largest
 * expense".
 */
export function largestExpenses(ledger: ClientLedger, month: string, limit = 5): LargestExpense[] {
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  return ledger.transactions
    .filter((t) => t.type === "expense" && !t.isRefund && monthOf(t.date) === month && !savingsSplit(t, savings).fullySavings)
    .map((t) => {
      const label = labelFor(t, ledger);
      return { id: t.id, label, context: contextFor(t, ledger, label, savings), date: t.date, amount: t.amount };
    })
    .sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * Per-key MEDIAN monthly spend (dimension `dim`) over the `months` months
 * PRECEDING `month` (the current month itself is excluded) — a baseline to
 * compare the current month against. A key missing from a given month's
 * breakdown counts as 0 FOR THAT MONTH (not skipped), so a category spent on
 * in only 2 of 3 months still yields a median over all 3 data points.
 * CONSUMERS must treat a key ABSENT from the returned Map as 0 too — a
 * brand-new category/envelope with NO spend anywhere in the window gets no
 * entry at all (it never appeared in any month's breakdown), which is not
 * the same as "present with amount 0" but should read as the same thing.
 */
export function spendingBaseline(ledger: ClientLedger, month: string, dim: SpendingDimension, months = 3): Map<string | null, Money> {
  const priorMonths: string[] = [];
  let m = month;
  for (let i = 0; i < months; i++) {
    m = prevMonth(m);
    priorMonths.push(m);
  }
  const perMonth = priorMonths.map((pm) => computeSpendingByDimension(ledger, pm, pm, dim));
  const keys = new Set<string | null>();
  for (const rows of perMonth) for (const r of rows) keys.add(r.key);
  const result = new Map<string | null, Money>();
  for (const key of keys) {
    result.set(key, median(perMonth.map((rows) => rows.find((r) => r.key === key)?.amount ?? 0)));
  }
  return result;
}

export interface EnvelopeTrend {
  id: string;
  name: string;
  color: string;
  series: Money[];
  last: Money;
  baseline: Money;
  deltaPct: number | null;
}

/**
 * Monthly expense series per non-archived envelope over the `months`-month
 * window ending at `month` (oldest → newest; `series.at(-1) === last`),
 * reusing expenseByDimension with dim "envelope" (so, like every other
 * consumer of expenseByDimension, spending attributed to a SAVINGS envelope
 * is excluded from that envelope's own series too — a savings envelope's
 * series is therefore always all-zero and it never appears in the result).
 * Envelopes whose series is all-zero across the window are dropped — nothing
 * to trend. `baseline` = median of the months BEFORE the last one; `deltaPct`
 * is null when there's no positive baseline to divide by (new/dormant
 * envelope). Sorted by |last − baseline| desc so the biggest movers surface
 * first.
 */
export function computeEnvelopeTrends(ledger: ClientLedger, month: string, months = 6): EnvelopeTrend[] {
  const window: string[] = [month];
  for (let i = 0; i < months - 1; i++) window.unshift(prevMonth(window[0]!));
  const envGroup = new Map(ledger.envelopes.map((e) => [e.id, e.groupId]));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const perMonth = window.map((m) => {
    const sums = new Map<string, Money>();
    for (const t of ledger.transactions) {
      if (monthOf(t.date) !== m) continue;
      for (const [key, amt] of expenseByDimension(t, "envelope", envGroup, savings)) {
        if (key === null) continue;
        sums.set(key, (sums.get(key) ?? 0) + amt);
      }
    }
    return sums;
  });
  const trends: EnvelopeTrend[] = [];
  for (const envelope of ledger.envelopes) {
    if (envelope.archived) continue;
    const series = perMonth.map((sums) => sums.get(envelope.id) ?? 0);
    if (series.every((v) => v === 0)) continue;
    const last = series[series.length - 1]!;
    const baseline = median(series.slice(0, -1));
    const deltaPct = baseline > 0 ? (last - baseline) / baseline : null;
    trends.push({ id: envelope.id, name: envelope.name, color: envelope.color, series, last, baseline, deltaPct });
  }
  trends.sort((a, b) => Math.abs(b.last - b.baseline) - Math.abs(a.last - a.baseline));
  return trends;
}

/**
 * Savings rate = net / income, as a fraction (0.02 = 2%). `current` reads the
 * LAST point only, and is null when it has no income to divide by (rate is
 * undefined, not zero). `median` is the same ratio over the OTHER points,
 * income > 0 only — a zero-income month has no defined rate and is EXCLUDED
 * rather than counted as 0 (which would understate the median).
 */
export function savingsRate(points: CashflowPoint[]): { current: number | null; median: number | null } {
  if (points.length === 0) return { current: null, median: null };
  const last = points[points.length - 1]!;
  const current = last.income > 0 ? last.net / last.income : null;
  const ratios = points
    .slice(0, -1)
    .filter((p) => p.income > 0)
    .map((p) => p.net / p.income);
  return { current, median: ratios.length > 0 ? median(ratios) : null };
}

export interface GoalHistoryPoint {
  month: string; // YYYY-MM
  allocated: Money; // manual + automatic allocation in that month
  pct: number; // 0..100, clamped
  met: boolean; // allocated >= target
}

export interface GoalHistory {
  /** The target used for EVERY point. The ledger has no historical monthlyTarget, so past
   *  months are measured against today's goal — returned as data, not left to a caption, so
   *  the UI text cannot drift from the arithmetic. Changing a goal rewrites its history. */
  basis: "current-target";
  target: Money;
  points: GoalHistoryPoint[]; // oldest → newest, length = `months`
}

/**
 * Per-month funding history for one envelope's monthly goal.
 *
 * `allocated` comes from `computeBudgetState`, NOT from summing `ledger.allocations`: the
 * budget state adds automatic allocations derived from transaction flow (accounts linked to an
 * envelope, 3.8) to the manual ones, and an envelope funded that way has no `Allocation` rows
 * at all. Summing the raw table would show a flat zero history beside a correct current month.
 *
 * Returns `null` when the envelope is unknown or has no positive target — the same condition
 * under which `goalProgress` returns `null`, and `goalProgress` is what decides `pct`/`met`
 * here, so the per-month verdict and the live one can never disagree.
 */
export function computeGoalHistory(ledger: ClientLedger, envelopeId: string, month: string, months = 6): GoalHistory | null {
  const envelope = ledger.envelopes.find((e) => e.id === envelopeId);
  const target = envelope?.monthlyTarget ?? null;
  if (!envelope || target === null || target <= 0) return null;

  const window: string[] = [month];
  for (let i = 0; i < months - 1; i++) window.unshift(prevMonth(window[0]!));

  const points = window.map((m) => {
    const state = computeBudgetState(ledger, m).envelopes.find((s) => s.envelope.id === envelopeId);
    const allocated = state?.allocated ?? 0;
    const progress = goalProgress({ monthlyTarget: target, allocated });
    return { month: m, allocated, pct: progress?.pct ?? 0, met: progress?.funded ?? false };
  });

  return { basis: "current-target", target, points };
}
