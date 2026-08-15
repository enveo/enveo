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
  sourceRef: null,
  items: [],
  createdAt: "2026-08-15T10:00:00.000Z",
  ...overrides,
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
    { id: "place-lidl", name: "Lidl" },
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
    // given: an expense recorded at Lidl
    const expense = transaction({ placeId: "place-lidl" });

    // when: the user enters only a fragment of the place
    const matches = matchesTransactionQuery(expense, "li", index);

    // then: the transaction remains visible
    expect(matches).toBe(true);
  });

  test("every user-facing transaction description participates in search", () => {
    // given: transactions whose useful descriptions live in different fields
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

    // when: the user searches for a fragment from each field
    const results = cases.map(({ query, expense }) => matchesTransactionQuery(expense, query, index));

    // then: name, note, category, envelope, both accounts and split items are searchable
    expect(results).toEqual([true, true, true, true, true, true, true]);
  });

  test("text fragments and exact amounts can satisfy different query terms", () => {
    // given: expenses that separate a merchant fragment from the amount
    const lidlForExactAmount = transaction({ placeId: "place-lidl", amount: 5_042 });
    const lidlForAnotherAmount = transaction({ placeId: "place-lidl", amount: 6_000 });
    const anotherMerchantForExactAmount = transaction({ name: "Biedronka", amount: 5_042 });

    // when: the user combines the merchant fragment with a decimal amount
    const results = [
      matchesTransactionQuery(lidlForExactAmount, "li 50,42", index),
      matchesTransactionQuery(lidlForAnotherAmount, "li 50,42", index),
      matchesTransactionQuery(anotherMerchantForExactAmount, "li 50,42", index),
      matchesTransactionQuery(lidlForExactAmount, "li 50.42", index),
    ];

    // then: every term must match, and an amount never matches only by numeric substring
    expect(results).toEqual([true, false, false, true]);
  });

  test("a locale-formatted amount with grouping spaces remains one query term", () => {
    // given: a larger Lidl expense whose displayed Polish amount contains a grouping space
    const expense = transaction({ placeId: "place-lidl", amount: 194_400 });

    // when/then: a value copied from the UI still combines with a merchant fragment
    expect(matchesTransactionQuery(expense, "li 1 944,00", index)).toBe(true);
  });

  test("amounts copied from supported locales preserve grouping and decimal separators", () => {
    // given: common UI representations of the same 1944.00 amount
    const localeAmounts = ["1 944,00", "1\u00a0944,00", "1\u202f944,00", "1,944.00", "1.944,00", "1,944", "1.944"];

    // when: each value is parsed as a complete amount token
    const parsed = localeAmounts.map(parseSearchAmount);

    // then: grouping never changes the minor-unit value
    expect(parsed).toEqual(localeAmounts.map(() => 194_400));
  });

  test("amount parsing rejects malformed grouping instead of guessing", () => {
    // given: values that are neither valid decimals nor valid three-digit grouping
    const malformed = ["1,94,4.00", "1.944.00", "12 34,00", "1,234.567", "50abc", "-1.00"];

    // when/then: an invalid token never turns into a surprising amount match
    expect(malformed.map(parseSearchAmount)).toEqual(malformed.map(() => null));
  });

  test("locale-formatted grouped amounts work inside a multi-term query", () => {
    // given: a larger Lidl expense
    const expense = transaction({ placeId: "place-lidl", amount: 194_400 });

    // when/then: both English-style and continental-style copied amounts remain one exact term
    expect(matchesTransactionQuery(expense, "li 1,944.00", index)).toBe(true);
    expect(matchesTransactionQuery(expense, "li 1.944,00", index)).toBe(true);
  });

  test("search folds Polish letters that Unicode decomposition leaves intact", () => {
    // given: a merchant name containing Ł and ó
    const polishIndex = createTransactionSearchIndex({ ...indexSources(), places: [{ id: "place-lodz", name: "Łódź Fabryczna" }] });
    const expense = transaction({ placeId: "place-lodz" });

    // when/then: a keyboard-friendly query without Polish characters still matches
    expect(matchesTransactionQuery(expense, "lodz", polishIndex)).toBe(true);
  });

  test("a numeric term still matches text such as venue names", () => {
    // given: venues whose names contain numbers and an unrelated transaction for 151.00
    const zone = transaction({ placeId: "place-zone-51", amount: 1_000 });
    const year = transaction({ placeId: "place-1944", amount: 1_000 });
    const unrelatedAmount = transaction({ placeId: null, name: "Dinner", amount: 15_100 });

    // when/then: numbers search text too, while amount matching remains exact
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
  test("different dimensions combine with AND while selections inside one dimension use OR", () => {
    // given: a Lidl expense paid from the main account
    const expense = transaction({ placeId: "place-lidl", categoryId: "category-groceries" });
    const selected = filters({
      accountIds: new Set(["account-checking", "account-savings"]),
      placeIds: new Set(["place-lidl"]),
      categoryIds: new Set(["category-groceries"]),
    });

    // when/then: any selected account may match, but every active dimension must match
    expect(matchesTransactionFilters(expense, selected)).toBe(true);
    expect(matchesTransactionFilters(expense, { ...selected, placeIds: new Set(["place-1944"]) })).toBe(false);
  });

  test("transfer destinations and split item assignments participate in filters", () => {
    // given: a transfer and a split expense whose assignments live only on its items
    const transfer = transaction({ type: "transfer", toAccountId: "account-savings", envelopeId: null, categoryId: null });
    const split = transaction({
      envelopeId: null,
      categoryId: null,
      items: [{ id: "item-1", envelopeId: "envelope-groceries", categoryId: "category-chemicals", amount: 1_000 }],
    });

    // when/then: either side of a transfer and any split item may satisfy its dimension
    expect(matchesTransactionFilters(transfer, filters({ accountIds: new Set(["account-savings"]) }))).toBe(true);
    expect(matchesTransactionFilters(split, filters({ envelopeIds: new Set(["envelope-groceries"]) }))).toBe(true);
    expect(matchesTransactionFilters(split, filters({ categoryIds: new Set(["category-chemicals"]) }))).toBe(true);
  });

  test("expense, refund, income and transfer are distinct filter choices", () => {
    // given: one transaction of every user-visible kind
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
    // given: a transaction for 50.42
    const expense = transaction({ amount: 5_042 });

    // when/then: exact and boundary values match; values outside the range do not
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "exact", minor: 5_042 } }))).toBe(true);
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "exact", minor: 5_000 } }))).toBe(false);
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "range", minMinor: 5_000, maxMinor: 5_042 } }))).toBe(true);
    expect(matchesTransactionFilters(expense, filters({ amount: { mode: "range", minMinor: 5_043, maxMinor: null } }))).toBe(false);
  });

  test("filter choices retain archived accounts and envelopes referenced this month", () => {
    // given: a transfer and split expense referencing entities that may now be archived
    const entries = [
      transaction({ type: "transfer", toAccountId: "account-savings", envelopeId: null, categoryId: null }),
      transaction({ envelopeId: null, items: [{ id: "item-1", envelopeId: "envelope-archived", categoryId: null, amount: 1_000 }] }),
    ];

    // when: the screen derives the entities needed by its specific-filter pickers
    const references = transactionFilterReferences(entries);

    // then: both sides of a transfer and split assignments remain available as filter choices
    expect(references.accountIds).toEqual(new Set(["account-checking", "account-savings"]));
    expect(references.envelopeIds).toEqual(new Set(["envelope-archived"]));
  });
});
