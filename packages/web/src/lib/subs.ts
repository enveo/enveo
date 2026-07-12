/**
 * Subscription actions — a thin layer over `local.*` (mutate.ts):
 * - acceptProposal: a detection proposal → a real recurring rule
 *   + a planned template transaction (lands in Upcoming and materialization),
 * - pauseRecurrence: pausedUntil + cleanup of the already materialized
 *   planned ones within the pause window; the LAST planned one is NOT deleted, but
 *   moved to the first occurrence ≥ pausedUntil — materialization is
 *   template-driven (iterates over planned), so a rule without a template would never
 *   come back, it would vanish from "Recurring" and detection would re-propose the group,
 * - removeRecurrence: removes future planned ones + the rule; HISTORICAL
 *   transactions stay (parity with the server FK: recurrence_id → SET NULL).
 *
 * Everything synchronously on the mirror (outbox + background sync) — like local.*.
 */
import type { ClientLedger, Recurrence, SubscriptionProposal, Transaction, TxnPayload } from "@enveo/shared";
import { local } from "./mutate";
import { store } from "./store";

const todayISO = (): string => new Date().toISOString().slice(0, 10);

 
export function ruleMonthlyCost(rule: Recurrence["rule"], amount: number): number {
  switch (rule) {
    case "weekly":
      return Math.round((amount * 52) / 12);
    case "quarterly":
      return Math.round(amount / 3);
    case "yearly":
      return Math.round(amount / 12);
    default:
      return amount;  
  }
}

export interface RecurringRow {
  rec: Recurrence;
  label: string;
  amount: number;
   
  nextDate: string | null;
  lastDate: string | null;
  monthlyCost: number;
  paused: boolean;
}

 
export function recurringRows(ledger: ClientLedger, today: string): RecurringRow[] {
  const byRec = new Map<string, Transaction[]>();
  for (const txn of ledger.transactions) {
    if (!txn.recurrenceId) continue;
    const list = byRec.get(txn.recurrenceId);
    if (list) list.push(txn);
    else byRec.set(txn.recurrenceId, [txn]);
  }
  const rows: RecurringRow[] = [];
  for (const rec of ledger.recurrences) {
    const txns = byRec.get(rec.id);
    if (!txns || txns.length === 0) continue;
    txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const future = txns.filter((x) => x.planned && x.date >= today);
    const template = future[0] ?? txns[txns.length - 1]!;
    const place = template.placeId ? ledger.places.find((p) => p.id === template.placeId)?.name : undefined;
    const envelope = template.envelopeId ? ledger.envelopes.find((e) => e.id === template.envelopeId)?.name : undefined;
    rows.push({
      rec,
      label: template.name?.trim() || place || envelope || "",
      amount: template.amount,
      nextDate: future[0]?.date ?? null,
      lastDate: txns.filter((x) => !x.planned).at(-1)?.date ?? null,
      monthlyCost: ruleMonthlyCost(rec.rule, template.amount),
      paused: !!rec.pausedUntil && rec.pausedUntil > today,
    });
  }
  return rows.sort((a, b) => b.monthlyCost - a.monthlyCost || a.label.localeCompare(b.label));
}





export function monthlyRecurringCost(ledger: ClientLedger): number {
  return recurringRows(ledger, todayISO()).reduce((s, r) => s + r.monthlyCost, 0);
}

 
export function addMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}






export function acceptProposal(p: SubscriptionProposal): string {
  const recurrenceId = local.createRecurrence({
    rule: p.cycle === "monthly" ? "monthly" : "yearly",
    startDate: p.nextExpected,
  });
  local.createTxn({
    type: "expense",
    accountId: p.accountId,
    toAccountId: null,
    amount: p.amount,
    date: p.nextExpected,
    confirmed: false,
    isRefund: false,
    envelopeId: p.envelopeId,
    placeId: p.placeId,
    categoryId: null,
    name: p.name,
    note: null,
    planned: true,
    recurrenceId,
  });
  return recurrenceId;
}

 
export function txnToPayload(txn: Transaction): TxnPayload {
  return {
    type: txn.type,
    accountId: txn.accountId,
    toAccountId: txn.toAccountId,
    amount: txn.amount,
    date: txn.date,
    confirmed: txn.confirmed,
    isRefund: txn.isRefund,
    envelopeId: txn.envelopeId,
    placeId: txn.placeId,
    categoryId: txn.categoryId,
    name: txn.name,
    note: txn.note,
    tag: txn.tag,
    planned: txn.planned,
    recurrenceId: txn.recurrenceId,
    items: txn.items.length > 0 ? txn.items.map((i) => ({ envelopeId: i.envelopeId, categoryId: i.categoryId, amount: i.amount })) : undefined,
  };
}





export function nextOccurrenceOnOrAfter(rule: Recurrence["rule"], fromISO: string, minISO: string): string {
  if (rule === "none") return minISO;  
  const [y, m, d] = fromISO.split("-").map(Number) as [number, number, number];
  let cur = new Date(Date.UTC(y, m - 1, d));
  let guard = 0;
  while (cur.toISOString().slice(0, 10) < minISO && guard++ < 1000) {
    switch (rule) {
      case "weekly":
        cur.setUTCDate(cur.getUTCDate() + 7);
        break;
      case "monthly":
        cur.setUTCMonth(cur.getUTCMonth() + 1);
        break;
      case "quarterly":
        cur.setUTCMonth(cur.getUTCMonth() + 3);
        break;
      case "yearly":
        cur.setUTCFullYear(cur.getUTCFullYear() + 1);
        break;
      case "monthEnd":
        cur.setUTCMonth(cur.getUTCMonth() + 2, 0);  
        break;
    }
  }
  return cur.toISOString().slice(0, 10);
}

/**
 * Pause for N months: pausedUntil = today+N months; this rule's planned ones
 * within the pause window (date < pausedUntil) are cleaned up, BUT the last of them
 * is moved to the first occurrence ≥ pausedUntil instead of being deleted
 * — it's the materialization template (template-driven); without it the rule would never
 * come back after the pause, and detection would re-propose the group.
 */
export function pauseRecurrence(rec: Recurrence, months: number): void {
  const pausedUntil = addMonthsISO(todayISO(), months);
  local.updateRecurrence(rec.id, { pausedUntil });
  const ledger = store.getLedger();
  if (!ledger) return;
  const inWindow = ledger.transactions
    .filter((t) => t.planned && t.recurrenceId === rec.id && t.date < pausedUntil)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (inWindow.length === 0) return;
  const template = inWindow[inWindow.length - 1]!;
  for (const t of inWindow) {
    if (t.id !== template.id) local.deleteTxn(t.id);
  }
  const nextDate = nextOccurrenceOnOrAfter(rec.rule, template.date, pausedUntil);
  local.updateTxn(template.id, { ...txnToPayload(template), date: nextDate });
}





export function removeRecurrence(rec: Recurrence): void {
  const today = todayISO();
  const ledger = store.getLedger();
  if (ledger) {
    for (const t of ledger.transactions) {
      if (t.planned && t.recurrenceId === rec.id && t.date >= today) local.deleteTxn(t.id);
    }
  }
  local.deleteRecurrence(rec.id);
}
