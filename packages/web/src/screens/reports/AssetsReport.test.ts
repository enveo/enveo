import { describe, expect, test } from "bun:test";
import type { EnvelopeView, StateResponse } from "@enveo/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetsReport } from "./AssetsReport";

const wealth: EnvelopeView = {
  id: "savings",
  groupId: "wealth",
  name: "Savings",
  color: "teal",
  icon: "bank",
  note: null,
  monthlyTarget: null,
  isSavings: true,
  sort: 0,
  archived: false,
  carryIn: 0,
  allocated: 0,
  spent: 0,
  available: 190000,
};

 
function report(net: number, envelopes = [wealth], mask = (n: number) => `«${n}»`) {
  const state: StateResponse = {
    month: "2026-09",
    toBeBudgeted: 0,
    readyToAssign: 0,
    monthIncome: 0,
    monthExpense: 0,
    accounts: [],
    groups: [],
    envelopes,
    transactions: [],
    categories: [],
    places: [],
  };
  return renderToStaticMarkup(
    createElement(AssetsReport, {
      state,
      netWorth: [{ month: state.month, total: net }],
      month: state.month,
      M: mask,
      onPrev() {},
      onNext() {},
      onBack() {},
    }),
  );
}

describe("AssetsReport composition", () => {
  test("shows the exact remainder beside wealth, with complementary shares", () => {
    const html = report(200000, [wealth, { ...wealth, id: "daily", isSavings: false, available: 40000 }, { ...wealth, id: "old", archived: true }]);
    expect(html).toContain("Remaining funds");
    expect(html).toContain("«190000»");
    expect(html).toContain("«10000»");
    expect(html).toContain("95%");
    expect(html).toContain("5%");
  });

  test.each([
    [100, 200, -100],
    [100, -50, 150],
    [0, 200, -200],
    [-100, 0, -100],
  ])("keeps signed amounts without composition shares when net=%i and wealth=%i", (net, savings, remaining) => {
    const html = report(net, [{ ...wealth, available: savings }]);
    expect(html).toContain(`«${remaining}»`);
    expect(html).not.toContain("% of net worth");
    expect(html).not.toMatch(/\d+%<\/span>/);
    expect(html).not.toContain("NaN");
  });

  test("shows all funds with no wealth envelopes, and respects the money mask", () => {
    expect(report(50000, [])).toContain("«50000»");
    expect(report(50000, [])).toContain("100%");
    const hidden = report(200000, [wealth], () => "••••");
    const [maskedWealth, maskedRemaining] = [...hidden.matchAll(/<dd\b[^>]*>(.*?)<\/dd>/g)].map((match) => match[1]);
    expect(maskedWealth).toBe("••••");
    expect(maskedRemaining).toBe("••••");
    expect(hidden).toContain("Remaining funds");
    expect(hidden).not.toContain("«10000»");
    expect(hidden).not.toContain("«190000»");
  });
});
