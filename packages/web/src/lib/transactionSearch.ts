import type { Transaction } from "@enveo/shared";
import { normalizeForSearch } from "./search";

export interface TransactionSearchSources {
  accounts: ReadonlyArray<{ id: string; name: string }>;
  envelopes: ReadonlyArray<{ id: string; name: string }>;
  categories: ReadonlyArray<{ id: string; name: string }>;
  places: ReadonlyArray<{ id: string; name: string }>;
}

export interface TransactionSearchIndex {
  readonly accountNames: ReadonlyMap<string, string>;
  readonly envelopeNames: ReadonlyMap<string, string>;
  readonly categoryNames: ReadonlyMap<string, string>;
  readonly placeNames: ReadonlyMap<string, string>;
}

export type TransactionKind = "expense" | "income" | "refund" | "transfer";

export type TransactionAmountFilter = { mode: "exact"; minor: number } | { mode: "range"; minMinor: number | null; maxMinor: number | null };

export interface TransactionFilters {
  accountIds: ReadonlySet<string>;
  envelopeIds: ReadonlySet<string>;
  placeIds: ReadonlySet<string>;
  categoryIds: ReadonlySet<string>;
  kinds: ReadonlySet<TransactionKind>;
  amount: TransactionAmountFilter | null;
}

export function emptyTransactionFilters(): TransactionFilters {
  return {
    accountIds: new Set(),
    envelopeIds: new Set(),
    placeIds: new Set(),
    categoryIds: new Set(),
    kinds: new Set(),
    amount: null,
  };
}

export function createTransactionSearchIndex(sources: TransactionSearchSources): TransactionSearchIndex {
  return {
    accountNames: new Map(sources.accounts.map((account) => [account.id, account.name])),
    envelopeNames: new Map(sources.envelopes.map((envelope) => [envelope.id, envelope.name])),
    categoryNames: new Map(sources.categories.map((category) => [category.id, category.name])),
    placeNames: new Map(sources.places.map((place) => [place.id, place.name])),
  };
}

export function transactionFilterReferences(transactions: ReadonlyArray<Transaction>): {
  accountIds: ReadonlySet<string>;
  envelopeIds: ReadonlySet<string>;
} {
  const accountIds = new Set<string>();
  const envelopeIds = new Set<string>();
  for (const transaction of transactions) {
    accountIds.add(transaction.accountId);
    if (transaction.toAccountId) accountIds.add(transaction.toAccountId);
    if (transaction.envelopeId) envelopeIds.add(transaction.envelopeId);
    for (const item of transaction.items) envelopeIds.add(item.envelopeId);
  }
  return { accountIds, envelopeIds };
}

export function matchesTransactionQuery(transaction: Transaction, query: string, index: TransactionSearchIndex): boolean {
  const terms = normalizeForSearch(query.trim()).match(/\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?|[^\s]+/g) ?? [];
  if (terms.length === 0) return true;
  const text = [
    transaction.name,
    transaction.note,
    index.accountNames.get(transaction.accountId),
    transaction.toAccountId ? index.accountNames.get(transaction.toAccountId) : null,
    transaction.envelopeId ? index.envelopeNames.get(transaction.envelopeId) : null,
    transaction.categoryId ? index.categoryNames.get(transaction.categoryId) : null,
    transaction.placeId ? index.placeNames.get(transaction.placeId) : null,
    ...transaction.items.flatMap((item) => [index.envelopeNames.get(item.envelopeId), item.categoryId ? index.categoryNames.get(item.categoryId) : null]),
  ]
    .filter((value): value is string => !!value)
    .join(" ");
  const normalizedText = normalizeForSearch(text);
  return terms.every((term) => normalizedText.includes(term) || parseSearchAmount(term) === transaction.amount);
}

/** A query term is an amount only when the WHOLE term is a non-negative number with valid locale
 * grouping and at most two decimal digits. `parseFloat` is intentionally forbidden here: it would
 * turn `50abc` into 50.00 and make an ordinary text fragment silently behave like money. */
export function parseSearchAmount(term: string): number | null {
  const value = term.trim().replace(/[\u00a0\u202f]/g, " ");
  if (!/^\d[\d .,]*$/.test(value)) return null;

  let wholeDigits: string | null = null;
  let fractionDigits = "";

  if (value.includes(" ")) {
    const decimal = /([.,])(\d{1,2})$/.exec(value);
    const whole = decimal ? value.slice(0, decimal.index) : value;
    if (/[.,]/.test(whole) || (!decimal && /[.,]/.test(value))) return null;
    wholeDigits = groupedWholeDigits(whole, " ");
    fractionDigits = decimal?.[2] ?? "";
  } else {
    const commaCount = value.split(",").length - 1;
    const dotCount = value.split(".").length - 1;

    if (commaCount > 0 && dotCount > 0) {
      const commaAt = value.lastIndexOf(",");
      const dotAt = value.lastIndexOf(".");
      const decimalSeparator = commaAt > dotAt ? "," : ".";
      const groupingSeparator = decimalSeparator === "," ? "." : ",";
      const decimalAt = Math.max(commaAt, dotAt);
      const whole = value.slice(0, decimalAt);
      fractionDigits = value.slice(decimalAt + 1);
      if (!/^\d{1,2}$/.test(fractionDigits) || whole.includes(decimalSeparator)) return null;
      wholeDigits = groupedWholeDigits(whole, groupingSeparator);
    } else if (commaCount > 0 || dotCount > 0) {
      const separator = commaCount > 0 ? "," : ".";
      const parts = value.split(separator);
      if (parts.length === 2 && /^\d+$/.test(parts[0] ?? "") && /^\d{1,2}$/.test(parts[1] ?? "")) {
        wholeDigits = parts[0] ?? null;
        fractionDigits = parts[1] ?? "";
      } else {
        wholeDigits = groupedWholeDigits(value, separator);
      }
    } else if (/^\d+$/.test(value)) {
      wholeDigits = value;
    }
  }

  if (wholeDigits === null) return null;
  const minor = BigInt(wholeDigits) * 100n + BigInt(fractionDigits.padEnd(2, "0") || "0");
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function groupedWholeDigits(value: string, separator: " " | "," | "."): string | null {
  const escapedSeparator = separator === "." ? "\\." : separator;
  if (!new RegExp(`^\\d{1,3}(?:${escapedSeparator}\\d{3})+$`).test(value)) return null;
  return value.split(separator).join("");
}

export function matchesTransactionFilters(transaction: Transaction, filters: TransactionFilters): boolean {
  const matchesAccount =
    filters.accountIds.size === 0 ||
    filters.accountIds.has(transaction.accountId) ||
    (!!transaction.toAccountId && filters.accountIds.has(transaction.toAccountId));
  const matchesEnvelope =
    filters.envelopeIds.size === 0 ||
    (!!transaction.envelopeId && filters.envelopeIds.has(transaction.envelopeId)) ||
    transaction.items.some((item) => filters.envelopeIds.has(item.envelopeId));
  const matchesPlace = filters.placeIds.size === 0 || (!!transaction.placeId && filters.placeIds.has(transaction.placeId));
  const matchesCategory =
    filters.categoryIds.size === 0 ||
    (!!transaction.categoryId && filters.categoryIds.has(transaction.categoryId)) ||
    transaction.items.some((item) => !!item.categoryId && filters.categoryIds.has(item.categoryId));
  const kind: TransactionKind = transaction.type === "expense" && transaction.isRefund ? "refund" : transaction.type;
  const matchesKind = filters.kinds.size === 0 || filters.kinds.has(kind);
  const matchesAmount =
    filters.amount === null ||
    (filters.amount.mode === "exact"
      ? transaction.amount === filters.amount.minor
      : (filters.amount.minMinor === null || transaction.amount >= filters.amount.minMinor) &&
        (filters.amount.maxMinor === null || transaction.amount <= filters.amount.maxMinor));
  return matchesAccount && matchesEnvelope && matchesPlace && matchesCategory && matchesKind && matchesAmount;
}
