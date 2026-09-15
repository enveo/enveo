import { describe, expect, test } from "bun:test";
import type { Transaction } from "@enveo/shared";
import {
  createTransactionSearchIndex,
  matchesTransactionFilters,
  matchesTransactionQuery,
  parseSearchAmount,
  type TransactionFilters,
  transactionFilterReferences,
} from "./transactionSearch";

const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: "transaction-1",
  type: "expense",
  accountId: "account-checking",
  toAccountId: null,
  amount: 1_000,
  date: "2026-08-15",
  isRefund: false,
  envelopeId: "envelope-groceries",
  placeId: null,
  categoryId: "category-groceries",
  name: null,
  note: null,
  tag: null,
  items: [],
  createdAt: "2026-08-15T10:00:00.000Z",
  ...overrides,
  sourceRef: overrides.sourceRef ?? null,
  allocationFromEnvelopeId: overrides.allocationFromEnvelopeId ?? null,
  allocationToEnvelopeId: overrides.allocationToEnvelopeId ?? null,
});

const index = createTransactionSearchIndex({
  accounts: [
    { id: "account-checking", name: "Main account" },
    { id: "account-savings", name: "Savings" },
  ],
  envelopes: [{ id: "envelope-groceries", name: "Food" }],
  categories: [
    { id: "category-groceries", name: "Groceries" },
    { id: "category-chemicals", name: "Household chemicals" },
  ],
  places: [
    { id: "place-linden", name: "Linden Market" },
    { id: "place-zone-51", name: "Strefa 51" },
    { id: "place-1944", name: "1944" },
  ],
});

const filters = (overrides: Partial<TransactionFilters> = {}): TransactionFilters => ({
  accountIds: new Set(),
  envelopeIds: new Set(),
  placeIds: new Set(),
  categoryIds: new Set(),
  kinds: new Set(),
  amount: null,
  ...overrides,
});

describe("monthly transaction search", () => {
  test("a partial place name finds the transaction", () => {
    const expense = transaction({ placeId: "place-linden" });

    const matches = matchesTransactionQuery(expense, "li", index);

    expect(matches).toBe(true);
  });

  test("every user-facing transaction description participates in search", () => {
    const cases: Array<{ query: string; expense: Transaction }> = [
      { query: "coffee", expense: transaction({ name: "Morning coffee" }) },
      { query: "birthday", expense: transaction({ name: "Gift", note: "Birthday for Ada" }) },
      { query: "grocer", expense: transaction() },
      { query: "food", expense: transaction() },
      { query: "main", expense: transaction() },
      {
        query: "saving",
        expense: transaction({ type: "transfer", toAccountId: "account-savings", envelopeId: null, categoryId: null }),
      },
      {
        query: "chemical",
        expense: transaction({
          envelopeId: null,
          categoryId: null,
          items: [{ id: "item-1", envelopeId: "envelope-groceries", categoryId: "category-chemicals", amount: 1_000 }],
        }),
      },
    ];

    const results = cases.map(({ query, expense }) => matchesTransactionQuery(expense, query, index));

    expect(results).toEqual([true, true, true, true, true, true, true]);
  });

  test("text fragments and exact amounts can satisfy different query terms", () => {
    const lindenForExactAmount = transaction({ placeId: "place-linden", amount: 5_042 });
    const lindenForAnotherAmount = transaction({ placeId: "place-linden", amount: 6_000 });
    const anotherMerchantForExactAmount = transaction({ name: "Clover Market", amount: 5_042 });

    const results = [
      matchesTransactionQuery(lindenForExactAmount, "li 50,42", index),
      matchesTransactionQuery(lindenForAnotherAmount, "li 50,42", index),
      matchesTransactionQuery(anotherMerchantForExactAmount, "li 50,42", index),
      matchesTransactionQuery(lindenForExactAmount, "li 50.42", index),
    ];

    // then: every term must match, and an amount never matches only by numeric substring
    expect(results).toEqual([true, false, false, true]);
  });

  test("a locale-formatted amount with grouping spaces remains one query term", () => {
    const expense = transaction({ placeId: "place-linden", amount: 194_400 });

    expect(matchesTransactionQuery(expense, "li 1 944,00", index)).toBe(true);
  });

  test("amounts copied from supported locales preserve grouping and decimal separators", () => {
    const localeAmounts = ["1 944,00", "1\u00a0944,00", "1\u202f944,00", "1,944.00", "1.944,00", "1,944", "1.944"];

    const parsed = localeAmounts.map(parseSearchAmount);

    // then: grouping never changes the minor-unit value
    expect(parsed).toEqual(localeAmounts.map(() => 194_400));
  });

  test("amount parsing rejects malformed grouping instead of guessing", () => {
    const malformed = ["1,94,4.00", "1.944.00", "12 34,00", "1,234.567", "50abc", "-1.00"];

    // when/then: an invalid token never turns into a surprising amount match
    expect(malformed.map(parseSearchAmount)).toEqual(malformed.map(() => null));
  });

  test("locale-formatted grouped amounts work inside a multi-term query", () => {
    const expense = transaction({ placeId: "place-linden", amount: 194_400 });

    expect(matchesTransactionQuery(expense, "li 1,944.00", index)).toBe(true);
    expect(matchesTransactionQuery(expense, "li 1.944,00", index)).toBe(true);
  });

  test("search folds Polish letters that Unicode decomposition leaves intact", () => {
    const polishIndex = createTransactionSearchIndex({ ...indexSources(), places: [{ id: "place-lodz", name: "Łódź Fabryczna" }] });
    const expense = transaction({ placeId: "place-lodz" });

    expect(matchesTransactionQuery(expense, "lodz", polishIndex)).toBe(true);
  });

  test("a numeric term still matches text such as venue names", () => {
    const zone = transaction({ placeId: "place-zone-51", amount: 1_000 });
    const year = transaction({ placeId: "place-1944", amount: 1_000 });
    const unrelatedAmount = transaction({ placeId: null, name: "Dinner", amount: 15_100 });

    expect(matchesTransactionQuery(zone, "strefa 51", index)).toBe(true);
    expect(matchesTransactionQuery(year, "1944", index)).toBe(true);
    expect(matchesTransactionQuery(unrelatedAmount, "51", index)).toBe(false);
  });
});

function indexSources() {
  return {
    accounts: [
      { id: "account-checking", name: "Main account" },
      { id: "account-savings", name: "Savings" },
    ],
    envelopes: [{ id: "envelope-groceries", name: "Food" }],
    categories: [{ id: "category-groceries", name: "Groceries" }],
    places: [] as Array<{ id: string; name: string }>,
  };
}

describe("transaction filters", () => {
  test("missing fields combine with real selections using OR and other dimensions using AND", () => {
    const selected = filters({ envelopeIds: new Set([""]), categoryIds: new Set(["", "category-groceries"]), placeIds: new Set([""]) });
    const entries = [
      transaction({ envelopeId: null, categoryId: null }),
      transaction({ envelopeId: null }),
      transaction(),
      transaction({ envelopeId: null, categoryId: "category-chemicals" }),
      transaction({ envelopeId: null, placeId: "place-linden" }),
      transaction({ type: "income", envelopeId: null, categoryId: null }),
      transaction({ type: "transfer", toAccountId: "account-savings", envelopeId: null, categoryId: null }),
      transaction({ isRefund: true, envelopeId: null, categoryId: null }),
    ];
    expect(entries.map((entry) => matchesTransactionFilters(entry, selected))).toEqual([true, true, false, false, false, true, true, true]);
    expect(matchesTransactionFilters(entries[0]!, filters())).toBe(true);
    const legacy = transaction();
    for (const key of ["envelopeId", "categoryId", "placeId"] as const) Reflect.deleteProperty(legacy, key);
    expect(matchesTransactionFilters(legacy, selected)).toBe(true);
  });

  test("missing assignments inspect split items instead of the empty transaction header", () => {
    const split = transaction({
      envelopeId: null,
      categoryId: null,
      items: [
        { id: "part-1", envelopeId: "envelope-groceries", categoryId: "category-groceries", amount: 500 },
        { id: "part-2", envelopeId: "envelope-groceries", categoryId: null, amount: 500 },
      ],
    });
    expect(matchesTransactionFilters(split, filters({ categoryIds: new Set([""]) }))).toBe(true);
    expect(matchesTransactionFilters(split, filters({ envelopeIds: new Set([""]) }))).toBe(false);
    split.items[1]!.categoryId = "category-chemicals";
    expect(matchesTransactionFilters(split, filters({ categoryIds: new Set([""]) }))).toBe(false);
    expect(matchesTransactionFilters(split, filters({ categoryIds: new Set(["", "category-chemicals"]) }))).toBe(true);
  });

  test("different dimensions combine with AND while selections inside one dimension use OR", () => {
    const expense = transaction({ placeId: "place-linden", categoryId: "category-groceries" });
    const selected = filters({
      accountIds: new Set(["account-checking", "account-savings"]),
      placeIds: new Set(["place-linden"]),
      categoryIds: new Set(["category-groceries"]),
    });

    // when/then: any selected account may match, but every active dimension must match
    expect(matchesTransactionFilters(expense, selected)).toBe(true);
    expect(matchesTransactionFilters(expense, { ...selected, placeIds: new Set(["place-1944"]) })).toBe(false);
  });

  test("transfer destinations and split item assignments participate in filters", () => {
    const transfer = transaction({ type: "transfer", toAccountId: "account-savings", envelopeId: null, categoryId: null });
    const split = transaction({
      envelopeId: null,
      categoryId: null,
      items: [{ id: "item-1", envelopeId: "envelope-groceries", categoryId: "category-chemicals", amount: 1_000 }],
    });

    expect(matchesTransactionFilters(transfer, filters({ accountIds: new Set(["account-savings"]) }))).toBe(true);
    expect(matchesTransactionFilters(split, filters({ envelopeIds: new Set(["envelope-groceries"]) }))).toBe(true);
    expect(matchesTransactionFilters(split, filters({ categoryIds: new Set(["category-chemicals"]) }))).toBe(true);
  });

  test("expense, refund, income and transfer are distinct filter choices", () => {
    const expense = transaction();
    const refund = transaction({ isRefund: true });
    const income = transaction({ type: "income", envelopeId: null, categoryId: null });
    const transfer = transaction({ type: "transfer", toAccountId: "account-savings", envelopeId: null, categoryId: null });

    // when/then: selecting expense does not accidentally include refunds
    const expenseOnly = filters({ kinds: new Set(["expense"]) });
    expect([expense, refund, income, transfer].map((entry) => matchesTransactionFilters(entry, expenseOnly))).toEqual([true, false, false, false]);
    expect(matchesTransactionFilters(refund, filters({ kinds: new Set(["refund"]) }))).toBe(true);
  });

  test("amount filters support an exact value or an inclusive range", () => {
    const expense = transaction({ amount: 5_042 });

    // when/then: exact and boundary values match; values outside the range do not
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "exact", minor: 5_042 } }))).toBe(true);
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "exact", minor: 5_000 } }))).toBe(false);
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "range", minMinor: 5_000, maxMinor: 5_042 } }))).toBe(true);
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "range", minMinor: 5_043, maxMinor: null } }))).toBe(false);
  });

  test("filter choices retain archived accounts and envelopes referenced this month", () => {
    const entries = [
      transaction({ type: "transfer", toAccountId: "account-savings", envelopeId: null, categoryId: null }),
      transaction({ envelopeId: null, items: [{ id: "item-1", envelopeId: "envelope-archived", categoryId: null, amount: 1_000 }] }),
    ];

    const references = transactionFilterReferences(entries);

    expect(references.accountIds).toEqual(new Set(["account-checking", "account-savings"]));
    expect(references.envelopeIds).toEqual(new Set(["envelope-archived"]));
  });
});

describe("report day filter", () => {
  test("keeps only the selected calendar date and combines it with other filters", () => {
    const selected = filters({ date: "2026-08-15", placeIds: new Set(["place-linden"]) });
    expect(matchesTransactionFilters(transaction({ placeId: "place-linden" }), selected)).toBe(true);
    expect(matchesTransactionFilters(transaction({ date: "2026-08-16", placeId: "place-linden" }), selected)).toBe(false);
    expect(matchesTransactionFilters(transaction({ placeId: "place-zone-51" }), selected)).toBe(false);
    expect(matchesTransactionFilters(transaction({ date: "2026-08-16", placeId: "place-linden" }), { ...selected, date: null })).toBe(true);
  });
});
