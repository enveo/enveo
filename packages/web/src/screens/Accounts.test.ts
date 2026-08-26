/**
 * `accountDebtShareText`/`accountTransactionCount` (Accounts.tsx, design parity wave E task 1) —
 * the wide hero card's "Card debt is {debtShare} of what you hold" caption and each card's
 * "{n} transactions · {month}" sub-line. Extracted so the three-way rounding/threshold branch
 * (no debt/no cash → "0%"; sub-1% → "under 1%"; otherwise a rounded, 100%-clamped percent) and
 * the two-sided (`accountId`/`toAccountId`) transaction membership test are pinned rather than
 * eyeballed — mirrors the `netWorthDeltaPct`/`netWorthRangeLabel` precedent this same epic set.
 */
import { describe, expect, test } from "bun:test";
import type { Transaction } from "@enveo/shared";
import type { Message } from "../lib/i18n";
import { accountDebtShareText, accountTransactionCount } from "./Accounts";

/** With `en`, `t()` returns its argument verbatim (message-as-key — see AGENTS.md's i18n
 *  convention), so an identity function is the real behavior, not a stand-in for it. */
const t = (m: Message) => m;

describe("accountDebtShareText", () => {
  test("no accounts at all (zero cash, zero debt) reads a literal '0%'", () => {
    expect(accountDebtShareText(0, 0, t)).toBe("0%");
  });

  test("cash but no debt reads a literal '0%'", () => {
    expect(accountDebtShareText(10_000_00, 0, t)).toBe("0%");
  });

  test("debt but no cash to hold it against also reads '0%' (the cashTotal<=0 guard)", () => {
    expect(accountDebtShareText(0, -5_000_00, t)).toBe("0%");
  });

  test("a debt share under 1% says 'under 1%' instead of rounding down to a bare '0%'", () => {
    // 50 / 10_000_00 * 100 = 0.5%
    expect(accountDebtShareText(10_000_00, -50, t)).toBe("under 1%");
  });

  test("exactly 1% is NOT the 'under 1%' branch — it rounds and renders numerically", () => {
    // 10_000 / 10_000_00 * 100 = 1% exactly
    expect(accountDebtShareText(10_000_00, -10_000, t)).toBe("1%");
  });

  test("a mid-range share rounds to the nearest whole percent", () => {
    // 2_500_00 / 10_000_00 * 100 = 25%
    expect(accountDebtShareText(10_000_00, -2_500_00, t)).toBe("25%");
  });

  test("debt larger than cash clamps at 100%, never exceeds it", () => {
    expect(accountDebtShareText(1_000_00, -5_000_00, t)).toBe("100%");
  });

  test("`debtTotal` is read as a magnitude regardless of sign convention (negative, as balances are stored)", () => {
    expect(accountDebtShareText(10_000_00, -2_500_00, t)).toBe(accountDebtShareText(10_000_00, 2_500_00, t));
  });
});

/** Minimal transaction fixtures — only `accountId`/`toAccountId` matter to this function. */
function tx(accountId: string, toAccountId: string | null = null): Pick<Transaction, "accountId" | "toAccountId"> {
  return { accountId, toAccountId };
}

describe("accountTransactionCount", () => {
  test("counts transactions whose accountId matches", () => {
    const transactions = [tx("A"), tx("A"), tx("B")];
    expect(accountTransactionCount(transactions, "A")).toBe(2);
  });

  test("a transfer's toAccountId counts too — touching an account is two-sided", () => {
    const transactions = [tx("A", "B")];
    expect(accountTransactionCount(transactions, "B")).toBe(1);
  });

  test("a transfer between the SAME two accounts counts once per side, not twice for one side", () => {
    const transactions = [tx("A", "B")];
    expect(accountTransactionCount(transactions, "A")).toBe(1);
    expect(accountTransactionCount(transactions, "B")).toBe(1);
  });

  test("an unrelated account is not counted", () => {
    const transactions = [tx("A", "B")];
    expect(accountTransactionCount(transactions, "C")).toBe(0);
  });

  test("an empty list counts zero", () => {
    expect(accountTransactionCount([], "A")).toBe(0);
  });
});
