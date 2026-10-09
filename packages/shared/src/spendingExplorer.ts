import type { ClientLedger, Money } from "./types";

/** Dimensions a drill-down path can narrow by. Account and period are filters, not path steps. */
export type ExploreDim = "group" | "envelope" | "category" | "place";
/** What a level's list is grouped by; "txn" lists the matching entries one by one. */
export type ExploreGrouping = ExploreDim | "account" | "month" | "txn";

/**
 * One expense contribution: a whole transaction, or one non-savings item of a split. Same rule as
 * `computeSpendingByDimension` (expenses only, refunds negative, savings envelopes excluded), so the
 * explorer's totals agree with the hub's Spending card.
 */
export interface SpendingEntry {
  /** Unique per entry: the transaction id, or `txnId:itemId` for a split item. */
  id: string;
  txnId: string;
  date: string;
  group: string | null;
  envelope: string | null;
  category: string | null;
  place: string | null;
  account: string;
  amount: Money;
  /** Set by `mergeByTransaction`: dimensions whose value differs between the merged split items. */
  mixed?: readonly ExploreDim[];
}

export interface ExploreStep {
  dim: ExploreDim;
  /** `null` is the "no envelope/category/place" bucket. */
  key: string | null;
}

export interface ExploreFilter {
  /** Inclusive 'YYYY-MM-DD' bounds. */
  from: string;
  to: string;
  account: string | null;
  path: readonly ExploreStep[];
}

export function spendingEntries(ledger: ClientLedger): SpendingEntry[] {
  const envGroup = new Map(ledger.envelopes.map((e) => [e.id, e.groupId]));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const out: SpendingEntry[] = [];
  for (const t of ledger.transactions) {
    if (t.type !== "expense") continue;
    const sign = t.isRefund ? -1 : 1;
    const base = { txnId: t.id, date: t.date, place: t.placeId, account: t.accountId };
    if (t.items.length > 0) {
      for (const it of t.items) {
        if (savings.has(it.envelopeId) || it.amount === 0) continue;
        out.push({
          ...base,
          id: `${t.id}:${it.id}`,
          group: envGroup.get(it.envelopeId) ?? null,
          envelope: it.envelopeId,
          category: it.categoryId,
          amount: sign * it.amount,
        });
      }
    } else if (!(t.envelopeId && savings.has(t.envelopeId)) && t.amount !== 0) {
      out.push({
        ...base,
        id: t.id,
        group: t.envelopeId ? (envGroup.get(t.envelopeId) ?? null) : null,
        envelope: t.envelopeId,
        category: t.categoryId,
        amount: sign * t.amount,
      });
    }
  }
  return out;
}

export function groupingKey(e: SpendingEntry, g: Exclude<ExploreGrouping, "txn">): string | null {
  return g === "month" ? e.date.slice(0, 7) : e[g];
}

export function filterEntries(entries: readonly SpendingEntry[], f: ExploreFilter): SpendingEntry[] {
  return entries.filter(
    (e) => e.date >= f.from && e.date <= f.to && (f.account === null || e.account === f.account) && f.path.every((s) => e[s.dim] === s.key),
  );
}

export const sumEntries = (entries: readonly SpendingEntry[]): Money => entries.reduce((s, e) => s + e.amount, 0);

export interface ExploreRow {
  key: string | null;
  amount: Money;
  /** Largest first, ties newest first. */
  entries: SpendingEntry[];
}

/**
 * Rows sorted by amount, largest first; months newest first. A row whose purchases and refunds net
 * to zero stays: dropping it would hide its entries, and a level would look like it had one row.
 */
export function breakdownEntries(entries: readonly SpendingEntry[], g: Exclude<ExploreGrouping, "txn">): ExploreRow[] {
  const rows = new Map<string | null, ExploreRow>();
  for (const e of entries) {
    const key = groupingKey(e, g);
    const row = rows.get(key) ?? { key, amount: 0, entries: [] };
    row.amount += e.amount;
    row.entries.push(e);
    rows.set(key, row);
  }
  for (const r of rows.values()) r.entries = sortLargest(r.entries);
  const list = [...rows.values()];
  return g === "month" ? list.sort((a, b) => (b.key ?? "").localeCompare(a.key ?? "")) : list.sort((a, b) => b.amount - a.amount);
}

export function sortLargest(entries: readonly SpendingEntry[]): SpendingEntry[] {
  return [...entries].sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

const NEXT: Record<ExploreDim, ExploreGrouping> = { group: "envelope", envelope: "category", category: "place", place: "txn" };
const PATH_ORDER: readonly ExploreDim[] = ["envelope", "group", "category", "place"];

/** Groupings that can still split the current selection. */
export function availableGroupings(f: ExploreFilter, spansMonths: boolean): ExploreGrouping[] {
  const has = (d: ExploreDim) => f.path.some((s) => s.dim === d);
  const dims = PATH_ORDER.filter((d) => !has(d) && !(d === "group" && has("envelope")));
  return [...dims, ...(f.account === null ? (["account"] as const) : []), ...(spansMonths ? (["month"] as const) : []), "txn"];
}

/** The grouping a level opens with: the natural next dimension after the last step. */
export function defaultGrouping(f: ExploreFilter, spansMonths: boolean): ExploreGrouping {
  const last = f.path.at(-1);
  const avail = availableGroupings(f, spansMonths);
  const next = last ? NEXT[last.dim] : "envelope";
  return avail.includes(next) ? next : (avail.find((g): g is ExploreDim => (PATH_ORDER as readonly string[]).includes(g)) ?? "txn");
}

/**
 * The grouping a level opens with, passing over groupings that would list a single row (rent paid
 * to one landlord), so a level never only repeats its parent. Nothing is added to the filter: the
 * skipped dimensions stay open, and a wider period that brings a second landlord shows it.
 */
export function openingGrouping(entries: readonly SpendingEntry[], f: ExploreFilter, spansMonths: boolean): ExploreGrouping {
  const list = filterEntries(entries, f);
  let cur = f;
  for (;;) {
    const g = defaultGrouping(cur, spansMonths);
    if (g === "txn" || g === "account" || g === "month") return g;
    const rows = breakdownEntries(list, g);
    if (rows.length !== 1) return g;
    cur = { ...cur, path: [...cur.path, { dim: g, key: rows[0]!.key }] };
  }
}

/**
 * One entry per transaction: the split items that matched are summed, so a receipt split across
 * two categories of one envelope is one line with its whole amount, not two smaller ones.
 */
export function mergeByTransaction(entries: readonly SpendingEntry[]): SpendingEntry[] {
  const byTxn = new Map<string, SpendingEntry>();
  for (const e of entries) {
    const m = byTxn.get(e.txnId);
    if (!m) {
      byTxn.set(e.txnId, { ...e, id: e.txnId });
      continue;
    }
    const mixed = new Set(m.mixed);
    for (const d of ["group", "envelope", "category"] as const) if (m[d] !== e[d]) mixed.add(d);
    byTxn.set(e.txnId, { ...m, amount: m.amount + e.amount, mixed: [...mixed] });
  }
  return [...byTxn.values()];
}

export interface StatementLine {
  entry: SpendingEntry;
  /** > 1 when repeated payments (same place, same amount, 3+ times) are folded into one line. */
  count: number;
  amount: Money;
}

/** A section's preview, per transaction: repeated identical payments folded, largest line first. */
export function statementLines(entries: readonly SpendingEntry[]): StatementLine[] {
  const groups = new Map<string, SpendingEntry[]>();
  for (const e of mergeByTransaction(entries)) {
    const k = `${e.place ?? ""}|${e.amount}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const lines: StatementLine[] = [];
  for (const g of groups.values()) {
    if (g.length >= 3 && g[0]!.place !== null) lines.push({ entry: g[0]!, count: g.length, amount: g[0]!.amount * g.length });
    else for (const e of g) lines.push({ entry: e, count: 1, amount: e.amount });
  }
  return lines.sort((a, b) => b.amount - a.amount || b.entry.date.localeCompare(a.entry.date));
}

/** Monthly totals over every month the range touches, oldest first. */
export function monthlyTotals(entries: readonly SpendingEntry[], from: string, to: string): Array<{ month: string; amount: Money }> {
  const months: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = nextMonth(m)) months.push(m);
  const sums = new Map(months.map((m) => [m, 0]));
  for (const e of entries) {
    const m = e.date.slice(0, 7);
    if (sums.has(m)) sums.set(m, sums.get(m)! + e.amount);
  }
  return months.map((month) => ({ month, amount: sums.get(month)! }));
}

function nextMonth(m: string): string {
  const y = +m.slice(0, 4);
  const mo = +m.slice(5, 7);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}
