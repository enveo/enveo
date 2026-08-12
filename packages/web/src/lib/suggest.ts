/**
 * Local suggestion rankings for the Add screen (spec 2026-07-21-redesign-07-v31, T2):
 * which envelope and which place the user most likely means, purely from ledger
 * history. Pure, no I/O, no Date.now — `todayISO` drives the recency window so
 * results are deterministic and testable.
 */
import type { ClientLedger } from "@enveo/shared";

const DAY_MS = 86_400_000;

function toUTC(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `date` to `todayISO` (positive when `date` is in the past). */
function daysAgo(date: string, todayISO: string): number {
  return Math.round((toUTC(todayISO) - toUTC(date)) / DAY_MS);
}

/** Recency weight for the 90-day usage window; 0 outside it (incl. future-dated txns). */
function recencyWeight(daysBack: number): number {
  if (daysBack < 0 || daysBack > 90) return 0;
  if (daysBack <= 30) return 1;
  if (daysBack <= 60) return 0.5;
  return 0.25; // 61-90
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Rank envelope ids by recency-weighted usage over the last 90 days (expense
 * transactions with that envelopeId; weight 1 for ≤30d, 0.5 for 31-60d, 0.25
 * for 61-90d) × amount affinity when `amountMinor` is a positive number
 * (closeness to the envelope's median expense amount in the window; an
 * envelope with no usage in the window falls back to affinity 0.5). Archived
 * envelopes are excluded. Sorted by score descending; ties (incl. the
 * "never used in the window" tail, which all score 0) fall back to envelope
 * `sort` ascending.
 */
export function rankEnvelopes(ledger: ClientLedger, todayISO: string, amountMinor: number | null): string[] {
  const useAffinity = amountMinor != null && amountMinor > 0;
  const scored = ledger.envelopes
    .filter((e) => !e.archived)
    .map((env) => {
      let weightSum = 0;
      const amounts: number[] = [];
      for (const t of ledger.transactions) {
        if (t.type !== "expense" || t.envelopeId !== env.id) continue;
        const w = recencyWeight(daysAgo(t.date, todayISO));
        if (w <= 0) continue;
        weightSum += w;
        amounts.push(t.amount);
      }
      let affinity = 1;
      if (useAffinity) {
        const med = median(amounts);
        affinity = med > 0 ? 1 / (1 + Math.abs(Math.log(amountMinor / med))) : 0.5;
      }
      return { id: env.id, sort: env.sort, score: weightSum * affinity };
    });
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.sort - b.sort));
  return scored.map((s) => s.id);
}

/**
 * Rank place ids by frequency among expense transactions, scoped to
 * `envelopeId` when given, else `categoryId` when given, else all expense
 * transactions (all-time — no 90-day window here). Ties in count fall back
 * to most-recently-used first.
 */
export function rankPlaces(ledger: ClientLedger, envelopeId: string | null, categoryId: string | null): string[] {
  const counts = new Map<string, { count: number; lastDate: string }>();
  for (const t of ledger.transactions) {
    if (t.type !== "expense" || !t.placeId) continue;
    if (envelopeId != null) {
      if (t.envelopeId !== envelopeId) continue;
    } else if (categoryId != null) {
      if (t.categoryId !== categoryId) continue;
    }
    const cur = counts.get(t.placeId);
    if (!cur) counts.set(t.placeId, { count: 1, lastDate: t.date });
    else {
      cur.count += 1;
      if (t.date > cur.lastDate) cur.lastDate = t.date;
    }
  }
  return [...counts.entries()].sort(([, a], [, b]) => (b.count !== a.count ? b.count - a.count : b.lastDate.localeCompare(a.lastDate))).map(([id]) => id);
}
