import { describe, expect, test } from "bun:test";
import { detectSubscriptions, upcomingPayments } from "./subscriptions";
import { env, tx } from "./test-helpers";
import type { ClientLedger, Place, Transaction } from "./types";

const TODAY = "2026-07-08";

const mkLedger = (transactions: Transaction[], places: Place[] = []): ClientLedger => ({
  accounts: [],
  envelopes: [],
  groups: [],
  allocations: [],
  transactions,
  budgets: [],
  categories: [],
  places,
  recurrences: [],
});

/** 4 payments every 30±2 days, same place, amounts 4299±200 (median 4299). */
function netflixTxns(over: Partial<Transaction> = {}): Transaction[] {
  const spec: Array<[string, number]> = [
    ["2026-04-05", 4399],
    ["2026-05-03", 4299], // +28
    ["2026-06-02", 4199], // +30
    ["2026-07-04", 4299], // +32
  ];
  return spec.map(([date, amount]) =>
    tx({ date, amount, placeId: "pl_netflix", accountId: "acc1", envelopeId: "env_subs", name: "Netflix", ...over }),
  );
}

describe("detectSubscriptions", () => {
  test("4 payments every 30±2 days, same place → a monthly proposal (median, nextExpected, active)", () => {
    const ledger = mkLedger(netflixTxns(), [{ id: "pl_netflix", name: "Netflix" }]);
    const out = detectSubscriptions(ledger, TODAY);
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.key).toBe("place:pl_netflix");
    expect(p.label).toBe("Netflix");
    expect(p.cycle).toBe("monthly");
    expect(p.amount).toBe(4299); // median of amounts
    expect(p.monthlyCost).toBe(4299);
    expect(p.lastDate).toBe("2026-07-04");
    expect(p.nextExpected).toBe("2026-08-03"); // lastDate + 30 days (median gap)
    expect(p.status).toBe("active");
    expect(p.accountId).toBe("acc1");
    expect(p.envelopeId).toBe("env_subs");
    expect(p.placeId).toBe("pl_netflix");
    expect(p.occurrences.map((o) => o.date)).toEqual(["2026-04-05", "2026-05-03", "2026-06-02", "2026-07-04"]);
    expect(p.occurrences.map((o) => o.amount)).toEqual([4399, 4299, 4199, 4299]);
  });

  test("irregular purchases (gaps 3–20 days) → NO proposal", () => {
    const dates = ["2026-06-01", "2026-06-05", "2026-06-20", "2026-06-28"];
    const ledger = mkLedger(
      dates.map((date) => tx({ date, amount: 4299, placeId: "pl_shop", accountId: "acc1" })),
      [{ id: "pl_shop", name: "Sklep" }],
    );
    expect(detectSubscriptions(ledger, TODAY)).toHaveLength(0);
  });

  test("2 payments every ~365 days → yearly, monthlyCost = round(amount/12)", () => {
    const ledger = mkLedger(
      [
        tx({ date: "2025-07-01", amount: 29900, placeId: "pl_dom", accountId: "acc1" }),
        tx({ date: "2026-07-01", amount: 29900, placeId: "pl_dom", accountId: "acc1" }),
      ],
      [{ id: "pl_dom", name: "Domena" }],
    );
    const out = detectSubscriptions(ledger, TODAY);
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.cycle).toBe("yearly");
    expect(p.amount).toBe(29900);
    expect(p.monthlyCost).toBe(2492); // round(29900/12)
    expect(p.nextExpected).toBe("2027-07-01");
    expect(p.status).toBe("active");
  });

  test("last payment 50 days ago with a 30-day cycle → stale status", () => {
    const dates = ["2026-02-18", "2026-03-20", "2026-04-19", "2026-05-19"]; // last = TODAY - 50 days
    const ledger = mkLedger(
      dates.map((date) => tx({ date, amount: 4299, placeId: "pl_netflix", accountId: "acc1" })),
      [{ id: "pl_netflix", name: "Netflix" }],
    );
    const out = detectSubscriptions(ledger, TODAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("stale");
  });

  test("dedupe: a group transaction with a recurrenceId → group skipped", () => {
    const txns = netflixTxns();
    txns[3] = { ...txns[3]!, recurrenceId: "rec1" };
    const ledger = mkLedger(txns, [{ id: "pl_netflix", name: "Netflix" }]);
    expect(detectSubscriptions(ledger, TODAY)).toHaveLength(0);
  });

  test("dedupe: an existing PLANNED transaction with the same place → group skipped", () => {
    const txns = [
      ...netflixTxns(),
      tx({ date: "2026-08-03", amount: 4299, placeId: "pl_netflix", planned: true, confirmed: false }),
    ];
    const ledger = mkLedger(txns, [{ id: "pl_netflix", name: "Netflix" }]);
    expect(detectSubscriptions(ledger, TODAY)).toHaveLength(0);
  });

  test("refunds do not count as occurrences (and do not break detection)", () => {
    const txns = [
      ...netflixTxns(),
      tx({ date: "2026-06-15", amount: 99999, placeId: "pl_netflix", isRefund: true }),
    ];
    const ledger = mkLedger(txns, [{ id: "pl_netflix", name: "Netflix" }]);
    const out = detectSubscriptions(ledger, TODAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.occurrences).toHaveLength(4);
  });

  test("planned transactions alone create no proposal", () => {
    const ledger = mkLedger(netflixTxns({ planned: true, confirmed: false }), [
      { id: "pl_netflix", name: "Netflix" },
    ]);
    expect(detectSubscriptions(ledger, TODAY)).toHaveLength(0);
  });

  test("grouping by normalized name when placeId is missing", () => {
    const names = ["Spotify ", "spotify", "SPOTIFY", "Spotify"];
    const dates = ["2026-04-08", "2026-05-08", "2026-06-07", "2026-07-07"];
    const ledger = mkLedger(
      dates.map((date, i) => tx({ date, amount: 2399, placeId: null, name: names[i]!, accountId: "acc1" })),
    );
    const out = detectSubscriptions(ledger, TODAY);
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.key).toBe("name:spotify");
    expect(p.label).toBe("Spotify"); // name from the most recent occurrence
    expect(p.placeId).toBeNull();
    expect(p.name).toBe("Spotify");
    expect(p.cycle).toBe("monthly");
  });

  test("without placeId and without a name → transactions skipped", () => {
    const dates = ["2026-04-08", "2026-05-08", "2026-06-07", "2026-07-07"];
    const ledger = mkLedger(dates.map((date) => tx({ date, amount: 2399, placeId: null, name: null })));
    expect(detectSubscriptions(ledger, TODAY)).toHaveLength(0);
  });

  test("amounts diverging >15% from the median → NO proposal", () => {
    const spec: Array<[string, number]> = [
      ["2026-04-05", 4000],
      ["2026-05-05", 4000],
      ["2026-06-04", 6000], // +50% off the 4000 median
      ["2026-07-04", 4000],
    ];
    const ledger = mkLedger(
      spec.map(([date, amount]) => tx({ date, amount, placeId: "pl_x", accountId: "acc1" })),
      [{ id: "pl_x", name: "X" }],
    );
    expect(detectSubscriptions(ledger, TODAY)).toHaveLength(0);
  });

  test("envelopeId/accountId = most frequent in the group", () => {
    const txns = netflixTxns();
    txns[0] = { ...txns[0]!, accountId: "accOTHER", envelopeId: null };
    const ledger = mkLedger(txns, [{ id: "pl_netflix", name: "Netflix" }]);
    const p = detectSubscriptions(ledger, TODAY)[0]!;
    expect(p.accountId).toBe("acc1");
    expect(p.envelopeId).toBe("env_subs");
  });
});

describe("upcomingPayments", () => {
  const planned = (over: Partial<Transaction>) =>
    tx({ planned: true, confirmed: false, accountId: "acc1", amount: 4299, ...over });

  test("only planned within the [today, today+30] horizon, sorted ascending by date", () => {
    const ledger = mkLedger([
      planned({ id: "P_later", date: "2026-07-20", name: "Później" }),
      planned({ id: "P_today", date: "2026-07-08", name: "Dziś" }), // lower bound inclusive
      planned({ id: "P_boundary", date: "2026-08-07", name: "Granica" }), // today+30 inclusive
      planned({ id: "P_too_far", date: "2026-08-08", name: "Za horyzontem" }),
      planned({ id: "P_yesterday", date: "2026-07-07", name: "Wczoraj" }), // the past — outside
      tx({ id: "T_regular", date: "2026-07-15", name: "Zwykła", accountId: "acc1", amount: 100 }), // not planned
    ]);
    const out = upcomingPayments(ledger, TODAY);
    expect(out.map((u) => u.txn.id)).toEqual(["P_today", "P_later", "P_boundary"]);
  });

  test("horizonDays narrows the window", () => {
    const ledger = mkLedger([
      planned({ id: "P1", date: "2026-07-10" }),
      planned({ id: "P2", date: "2026-07-20" }),
    ]);
    expect(upcomingPayments(ledger, TODAY, 7).map((u) => u.txn.id)).toEqual(["P1"]);
  });

  test("label: name ?? place ?? envelope", () => {
    const ledger: ClientLedger = {
      ...mkLedger(
        [
          planned({ id: "P_name", date: "2026-07-10", name: "Netflix", placeId: "pl1", envelopeId: "e1" }),
          planned({ id: "P_place", date: "2026-07-11", name: null, placeId: "pl1", envelopeId: "e1" }),
          planned({ id: "P_env", date: "2026-07-12", name: null, placeId: null, envelopeId: "e1" }),
        ],
        [{ id: "pl1", name: "Miejsce X" }],
      ),
      envelopes: [env("g1", { id: "e1", name: "Subskrypcje" })],
    };
    expect(upcomingPayments(ledger, TODAY).map((u) => u.label)).toEqual([
      "Netflix",
      "Miejsce X",
      "Subskrypcje",
    ]);
  });
});
