import { nextMonth } from "../budget";
import { isSupportedCurrency } from "../currency";
import { isCalendarDate } from "../dates";
import type { AccountType, Money } from "../types";
import { carriedAllocation, type MigrationLine, type MigrationSource, type MigrationTransaction } from "./ledger";

type Flag = number | boolean | null;

/** The rows of an Actual export's db.sqlite, column names as Actual wrote them. */
export interface ActualTables {
  budgetName: string;
  accounts: Array<{ id: string; name: string | null; offbudget: Flag; closed: Flag; tombstone: Flag; type: string | null; sort_order: number | null }>;
  groups: Array<{ id: string; name: string | null; is_income: Flag; hidden: Flag; tombstone: Flag; sort_order: number | null }>;
  categories: Array<{ id: string; name: string | null; is_income: Flag; cat_group: string | null; hidden: Flag; tombstone: Flag; sort_order: number | null }>;
  categoryMapping: Array<{ id: string; transferId: string | null }>;
  payees: Array<{ id: string; name: string | null; transfer_acct: string | null }>;
  payeeMapping: Array<{ id: string; targetId: string | null }>;
  transactions: Array<{
    id: string;
    isParent: Flag;
    isChild: Flag;
    parent_id: string | null;
    acct: string | null;
    category: string | null;
    amount: number | null;
    description: string | null;
    notes: string | null;
    date: number | null;
    transferred_id: string | null;
    tombstone: Flag;
  }>;
  budgets: Array<{ month: number; category: string; amount: number | null; carryover: Flag }>;
  preferences: Array<{ id: string; value: string | null }>;
}

export class ActualExportError extends Error {
  constructor(readonly code: "not_an_actual_export" | "unsupported_currency") {
    super(code);
    this.name = "ActualExportError";
  }
}

const ACCOUNT_TYPES: Readonly<Record<string, AccountType>> = { checking: "checking", savings: "savings", cash: "cash", investment: "investment" };

/** A corrupt date must not turn into a walk over thousands of years of months. */
const FIRST_MONTH = "1970-01";
const LAST_MONTH = "2100-12";

const on = (flag: Flag): boolean => !!flag;
const bySortOrder = (a: { sort_order: number | null }, b: { sort_order: number | null }) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
const toDate = (value: number | null): string | null => {
  const digits = String(value ?? "");
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return isCalendarDate(date) ? date : null;
};
const toMonth = (value: number): string => `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}`;

export function actualTablesToMigrationSource(tables: ActualTables, currentMonth: string): MigrationSource {
  const preference = (id: string) => tables.preferences.find((row) => row.id === id)?.value ?? null;
  const currency = preference("defaultCurrencyCode")?.trim().toUpperCase() || null;
  if (currency && !isSupportedCurrency(currency)) throw new ActualExportError("unsupported_currency");
  // Actual renamed these modes: "report" and "tracking" are the same budget without envelopes.
  const trackingOnly = ["report", "tracking"].includes(preference("budgetType") ?? "");

  const accounts = tables.accounts.filter((row) => !on(row.tombstone)).sort(bySortOrder);
  const accountIds = new Set(accounts.map((row) => row.id));
  const onBudget = new Set(accounts.filter((row) => !on(row.offbudget)).map((row) => row.id));
  const groups = tables.groups.filter((row) => !on(row.tombstone) && !on(row.is_income)).sort(bySortOrder);
  const hiddenGroups = new Set(groups.filter((row) => on(row.hidden)).map((row) => row.id));
  const groupIds = new Set(groups.map((row) => row.id));
  const categories = tables.categories
    .filter((row) => !on(row.tombstone) && !on(row.is_income) && row.cat_group !== null && groupIds.has(row.cat_group))
    .sort(bySortOrder);
  const categoryIds = new Set(categories.map((row) => row.id));

  const categoryMap = new Map(tables.categoryMapping.map((row) => [row.id, row.transferId]));
  const payeeMap = new Map(tables.payeeMapping.map((row) => [row.id, row.targetId]));
  const payees = new Map(tables.payees.map((row) => [row.id, row]));
  const payeeOf = (id: string | null) => (id ? payees.get(payeeMap.get(id) ?? id) : undefined);

  const rows = tables.transactions.filter((row) => !on(row.tombstone) && row.acct !== null && accountIds.has(row.acct) && toDate(row.date) !== null);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, typeof rows>();
  for (const row of rows) {
    if (on(row.isChild) && row.parent_id) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]);
  }

  const line = (row: (typeof rows)[number]): MigrationLine => {
    const category = row.category ? (categoryMap.get(row.category) ?? row.category) : null;
    const peer = row.transferred_id ? rowById.get(row.transferred_id) : undefined;
    return {
      key: row.id,
      amount: row.amount ?? 0,
      categoryKey: category && categoryIds.has(category) ? category : null,
      memo: row.notes,
      transferAccountKey: peer?.acct ?? payeeOf(row.description)?.transfer_acct ?? null,
      transferPeerKey: row.transferred_id,
    };
  };

  const transactions: MigrationTransaction[] = rows
    .filter((row) => !on(row.isChild))
    .map((row) => {
      const payee = payeeOf(row.description);
      return {
        accountKey: row.acct!,
        date: toDate(row.date)!,
        payee: payee?.transfer_acct ? null : (payee?.name ?? null),
        memo: row.notes,
        lines: on(row.isParent) && children.has(row.id) ? children.get(row.id)!.map(line) : [line(row)],
      };
    });

  const balances = new Map<string, Money>();
  const activity = new Map<string, Map<string, Money>>();
  for (const transaction of transactions) {
    for (const entry of transaction.lines) {
      balances.set(transaction.accountKey, (balances.get(transaction.accountKey) ?? 0) + entry.amount);
      if (!entry.categoryKey || !onBudget.has(transaction.accountKey)) continue;
      const month = transaction.date.slice(0, 7);
      const months = activity.get(entry.categoryKey) ?? new Map<string, Money>();
      months.set(month, (months.get(month) ?? 0) + entry.amount);
      activity.set(entry.categoryKey, months);
    }
  }

  const allocations: MigrationSource["allocations"] = [];
  const expectedAvailable: MigrationSource["expectedAvailable"] = [];
  if (!trackingOnly) {
    const assigned = new Map(tables.budgets.map((row) => [`${row.category}|${toMonth(row.month)}`, row]));
    const months = [...tables.budgets.map((row) => toMonth(row.month)), ...[...activity.values()].flatMap((byMonth) => [...byMonth.keys()])]
      .filter((month) => month >= FIRST_MONTH && month <= LAST_MONTH)
      .sort();
    const lastMonth = [currentMonth, months.at(-1) ?? currentMonth].sort().at(-1)!;
    for (const category of categories) {
      let balance: Money = 0;
      let carries = false;
      let month = months[0] ?? currentMonth;
      while (month <= lastMonth) {
        const budget = assigned.get(`${category.id}|${month}`);
        const openingBalance = carries ? balance : Math.max(0, balance);
        const amount = budget?.amount ?? 0;
        allocations.push({ categoryKey: category.id, month, amount: carriedAllocation({ assigned: amount, previousBalance: balance, openingBalance }) });
        balance = openingBalance + amount + (activity.get(category.id)?.get(month) ?? 0);
        carries = on(budget?.carryover ?? null);
        if (month === currentMonth) expectedAvailable.push({ categoryKey: category.id, amount: balance });
        month = nextMonth(month);
      }
    }
  }

  return {
    name: tables.budgetName,
    currency,
    accounts: accounts.map((row) => ({
      key: row.id,
      name: row.name ?? "",
      type: ACCOUNT_TYPES[row.type ?? ""] ?? "other",
      onBudget: !on(row.offbudget),
      closed: on(row.closed),
      expectedBalance: balances.get(row.id) ?? 0,
    })),
    groups: groups.map((row) => ({ key: row.id, name: row.name ?? "" })),
    categories: categories.map((row) => ({
      key: row.id,
      groupKey: row.cat_group!,
      name: row.name ?? "",
      hidden: on(row.hidden) || hiddenGroups.has(row.cat_group!),
      monthlyTarget: null,
      note: null,
    })),
    allocations,
    month: currentMonth,
    expectedAvailable,
    trackingOnly,
    transactions,
  };
}
