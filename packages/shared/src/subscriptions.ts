/**
 * Subscription detection — pure selectors computed locally from the replica (no I/O).
 *
 * Candidates: expenses (expense, !planned, !isRefund) grouped by placeId,
 * fallback: normalized name (lowercase/trim). Monthly: ≥3 occurrences,
 * median gap 28–32 days; yearly: ≥2, 350–380 days; amounts ±15% of the median.
 * Groups with a transaction that has a recurrenceId, or with an existing
 * PLANNED transaction under the same key, are skipped (confirmed ones don't come back).
 */
import type { ClientLedger, Money, Transaction } from "./types";

export interface SubscriptionOccurrence {
  date: string; // YYYY-MM-DD
  amount: Money;
}

export interface SubscriptionProposal {
  key: string; // "place:<id>" | "name:<normalized>"
  label: string;
  amount: Money; // median of occurrence amounts
  cycle: "monthly" | "yearly";
  monthlyCost: Money; // monthly = amount; yearly = round(amount/12)
  lastDate: string;
  nextExpected: string; // lastDate + median gap
  occurrences: SubscriptionOccurrence[]; // ascending by date
  envelopeId: string | null; // most frequent envelope of the occurrences
  accountId: string; // most frequent account of the occurrences
  placeId: string | null;
  name: string | null;
  status: "active" | "stale"; // stale = overdue by > 40% of the cycle
}

const DAY_MS = 86_400_000;

const toUTC = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

const addDays = (iso: string, days: number): string =>
  new Date(toUTC(iso) + days * DAY_MS).toISOString().slice(0, 10);

const daysBetween = (a: string, b: string): number => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);

/** Median; for an even count — the rounded mean of the two middle values. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Most frequent element (tie → first encountered). */
function mostFrequent<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/** Transaction group key: place, fallback normalized name; null → outside detection. */
function groupKeyOf(t: Transaction): string | null {
  if (t.placeId) return `place:${t.placeId}`;
  const norm = t.name?.trim().toLowerCase();
  return norm ? `name:${norm}` : null;
}

const MONTHLY = { minCount: 3, minGap: 28, maxGap: 32 } as const;
const YEARLY = { minCount: 2, minGap: 350, maxGap: 380 } as const;
const AMOUNT_TOLERANCE = 0.15; // ±15% of the median
const STALE_FACTOR = 1.4; // overdue by > 40% of the cycle

export function detectSubscriptions(ledger: ClientLedger, todayISO: string): SubscriptionProposal[] {
  const groups = new Map<string, Transaction[]>();
  const plannedKeys = new Set<string>(); // keys for which a planned transaction exists
  for (const t of ledger.transactions) {
    if (t.type !== "expense") continue;
    if (t.planned) {
      // planned ones are not occurrences, but they mute the group (dedupe with already-confirmed)
      if (t.placeId) plannedKeys.add(`place:${t.placeId}`);
      const norm = t.name?.trim().toLowerCase();
      if (norm) plannedKeys.add(`name:${norm}`);
      continue;
    }
    if (t.isRefund) continue;
    const key = groupKeyOf(t);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const proposals: SubscriptionProposal[] = [];
  for (const [key, txns] of groups) {
    if (plannedKeys.has(key)) continue;
    if (txns.some((t) => t.recurrenceId !== null)) continue; // rule already confirmed

    txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const gaps: number[] = [];
    for (let i = 1; i < txns.length; i++) gaps.push(daysBetween(txns[i - 1]!.date, txns[i]!.date));
    if (gaps.length === 0) continue;
    const cycleDays = median(gaps);

    let cycle: "monthly" | "yearly";
    if (txns.length >= MONTHLY.minCount && cycleDays >= MONTHLY.minGap && cycleDays <= MONTHLY.maxGap) {
      cycle = "monthly";
    } else if (txns.length >= YEARLY.minCount && cycleDays >= YEARLY.minGap && cycleDays <= YEARLY.maxGap) {
      cycle = "yearly";
    } else {
      continue;
    }

    const amount = median(txns.map((t) => t.amount));
    if (txns.some((t) => Math.abs(t.amount - amount) > AMOUNT_TOLERANCE * amount)) continue;

    const last = txns[txns.length - 1]!;
    const name = mostFrequent(txns.map((t) => t.name?.trim()).filter((n): n is string => !!n)) ?? null;
    const placeId = last.placeId;
    const placeName = placeId ? (ledger.places.find((p) => p.id === placeId)?.name ?? null) : null;
    proposals.push({
      key,
      label: placeName ?? last.name?.trim() ?? name ?? key,
      amount,
      cycle,
      monthlyCost: cycle === "monthly" ? amount : Math.round(amount / 12),
      lastDate: last.date,
      nextExpected: addDays(last.date, cycleDays),
      occurrences: txns.map((t) => ({ date: t.date, amount: t.amount })),
      envelopeId:
        mostFrequent(txns.map((t) => t.envelopeId).filter((e): e is string => e !== null)) ?? null,
      accountId: mostFrequent(txns.map((t) => t.accountId))!,
      placeId,
      name: last.name ?? name,
      status: daysBetween(last.date, todayISO) > cycleDays * STALE_FACTOR ? "stale" : "active",
    });
  }
  return proposals.sort((a, b) => b.monthlyCost - a.monthlyCost || a.label.localeCompare(b.label));
}

/* ── Upcoming payments ───────────────────────────────────────────────── */

/** Upcoming payment: EXCLUSIVELY a planned transaction (zero forecasts from detection). */
export interface UpcomingPayment {
  txn: Transaction;
  label: string; // name ?? place name ?? envelope name
}

/**
 * Planned transactions in the [today, today+horizonDays] window (bounds inclusive),
 * sorted ascending by date.
 */
export function upcomingPayments(
  ledger: ClientLedger,
  todayISO: string,
  horizonDays = 30,
): UpcomingPayment[] {
  const end = addDays(todayISO, horizonDays);
  return ledger.transactions
    .filter((t) => t.planned && t.date >= todayISO && t.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((t) => {
      const place = t.placeId ? ledger.places.find((p) => p.id === t.placeId)?.name : undefined;
      const envelope = t.envelopeId
        ? ledger.envelopes.find((e) => e.id === t.envelopeId)?.name
        : undefined;
      return { txn: t, label: t.name?.trim() || place || envelope || "" };
    });
}
