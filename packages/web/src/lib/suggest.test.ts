import { describe, expect, test } from "bun:test";
import type { ClientLedger, Envelope, Transaction } from "@enveo/shared";
import { rankEnvelopes, rankPlaces } from "./suggest";

const TODAY = "2026-06-30";
const DAY_MS = 86_400_000;

/** ISO date `days` before `iso` (days=0 → iso itself). */
function back(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) - days * DAY_MS).toISOString().slice(0, 10);
}

let seq = 0;
const env = (id: string, sort: number, archived = false): Envelope => ({
  id,
  groupId: "G1",
  name: id,
  color: "#000000",
  icon: "tag",
  note: null,
  monthlyTarget: null,
  isSavings: false,
  sort,
  archived,
});

const txn = (partial: Partial<Transaction> & { date: string }): Transaction => ({
  id: `t${seq++}`,
  type: "expense",
  accountId: "A1",
  toAccountId: null,
  amount: 1000,
  isRefund: false,
  envelopeId: null,
  placeId: null,
  categoryId: null,
  name: null,
  note: null,
  tag: null,
  items: [],
  createdAt: partial.date,
  ...partial,
  sourceRef: partial.sourceRef ?? null,
});

const L = (envelopes: Envelope[], transactions: Transaction[]): ClientLedger =>
  ({
    accounts: [],
    groups: [],
    envelopes,
    categories: [],
    places: [],
    allocations: [],
    transactions,
  }) as unknown as ClientLedger;

describe("rankEnvelopes", () => {
  test("recency-weighted usage beats raw count", () => {
    // Enew: 2 uses, both within 30d → weight 1 each → score 2.
    // Eold: 5 uses, all 61-90d → weight 0.25 each → score 1.25 despite the higher raw count.
    const envelopes = [env("Enew", 0), env("Eold", 1)];
    const txns = [
      ...[10, 20].map((d) => txn({ envelopeId: "Enew", date: back(TODAY, d) })),
      ...[65, 70, 75, 80, 85].map((d) => txn({ envelopeId: "Eold", date: back(TODAY, d) })),
    ];
    const ledger = L(envelopes, txns);
    expect(rankEnvelopes(ledger, TODAY, null)).toEqual(["Enew", "Eold"]);
  });

  test("amount affinity reorders envelopes with an otherwise equal score", () => {
    // Both envelopes: 2 uses within 30d → identical weighted score. Sort order alone would
    // put Ehigh first (lower sort). Amount affinity should flip that for a 4700 amount:
    // Elow's median (5000) is much closer than Ehigh's median (500000).
    const envelopes = [env("Ehigh", 0), env("Elow", 1)];
    const txns = [
      ...[10, 20].map((d) => txn({ envelopeId: "Ehigh", date: back(TODAY, d), amount: 500_000 })),
      ...[10, 20].map((d) => txn({ envelopeId: "Elow", date: back(TODAY, d), amount: 5_000 })),
    ];
    const ledger = L(envelopes, txns);
    expect(rankEnvelopes(ledger, TODAY, null)).toEqual(["Ehigh", "Elow"]); // no amount → tie broken by sort
    expect(rankEnvelopes(ledger, TODAY, 4_700)).toEqual(["Elow", "Ehigh"]); // affinity reorders
  });

  test("excludes archived envelopes even when heavily used", () => {
    const envelopes = [env("Eactive", 0), env("Earchived", 1, true)];
    const txns = [10, 20].map((d) => txn({ envelopeId: "Earchived", date: back(TODAY, d) }));
    const ledger = L(envelopes, txns);
    expect(rankEnvelopes(ledger, TODAY, null)).toEqual(["Eactive"]);
  });

  test("unused envelopes trail behind used ones, ordered by sort", () => {
    const envelopes = [env("Eb", 2), env("Ea", 1), env("Eused", 0)];
    const txns = [txn({ envelopeId: "Eused", date: back(TODAY, 10) })];
    const ledger = L(envelopes, txns);
    expect(rankEnvelopes(ledger, TODAY, null)).toEqual(["Eused", "Ea", "Eb"]);
  });

  test("an envelope with no usage in the window falls back to affinity 0.5 without crashing", () => {
    const envelopes = [env("Eempty", 0)];
    const ledger = L(envelopes, []);
    expect(rankEnvelopes(ledger, TODAY, 5_000)).toEqual(["Eempty"]);
  });

  test("usage outside the 90-day window does not count", () => {
    const envelopes = [env("Efar", 0), env("Enone", 1)];
    const txns = [txn({ envelopeId: "Efar", date: back(TODAY, 120) })];
    const ledger = L(envelopes, txns);
    // Efar's only txn is outside the window → both score 0 → tiebreak by sort.
    expect(rankEnvelopes(ledger, TODAY, null)).toEqual(["Efar", "Enone"]);
  });
});

describe("rankPlaces", () => {
  test("filters to the given envelope, ignoring other envelopes' frequency", () => {
    const txns = [
      txn({ envelopeId: "E1", placeId: "P1", date: back(TODAY, 5) }),
      txn({ envelopeId: "E1", placeId: "P1", date: back(TODAY, 4) }),
      txn({ envelopeId: "E1", placeId: "P2", date: back(TODAY, 3) }),
      // More frequent overall, but a different envelope → excluded entirely.
      txn({ envelopeId: "E2", placeId: "P3", date: back(TODAY, 2) }),
      txn({ envelopeId: "E2", placeId: "P3", date: back(TODAY, 1) }),
      txn({ envelopeId: "E2", placeId: "P3", date: back(TODAY, 1) }),
    ];
    const ledger = L([], txns);
    expect(rankPlaces(ledger, "E1", null)).toEqual(["P1", "P2"]);
  });

  test("falls back to category context when no envelope is given", () => {
    const txns = [txn({ categoryId: "C1", placeId: "P1", date: back(TODAY, 5) }), txn({ categoryId: "C2", placeId: "P2", date: back(TODAY, 5) })];
    const ledger = L([], txns);
    expect(rankPlaces(ledger, null, "C1")).toEqual(["P1"]);
  });

  test("breaks equal counts by most recent use", () => {
    const txns = [txn({ placeId: "POld", date: back(TODAY, 50) }), txn({ placeId: "PNew", date: back(TODAY, 5) })];
    const ledger = L([], txns);
    expect(rankPlaces(ledger, null, null)).toEqual(["PNew", "POld"]);
  });
});
