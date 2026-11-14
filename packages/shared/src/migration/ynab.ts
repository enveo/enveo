import { z } from "zod";
import { isSupportedCurrency } from "../currency";
import { isCalendarDate } from "../dates";
import type { AccountType, Money } from "../types";
import { carriedAllocation, type MigrationLine, type MigrationSource } from "./ledger";

const id = z.string().min(1);
const text = z.string().nullish();
const milliunits = z.number().int();
const deleted = z.boolean().optional();

const account = z.object({ id, name: z.string(), type: z.string(), on_budget: z.boolean(), closed: z.boolean(), balance: milliunits, deleted });
const payee = z.object({ id, name: z.string(), deleted });
const group = z.object({ id, name: z.string(), internal: z.boolean().optional(), deleted });
const monthCategory = z.object({ id, budgeted: milliunits, activity: milliunits, balance: milliunits, deleted });
const month = z.object({ month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), categories: z.array(monthCategory), deleted });
const category = z.object({
  id,
  category_group_id: id,
  original_category_group_id: text,
  category_group_name: text,
  name: z.string(),
  hidden: z.boolean(),
  internal: z.boolean().optional(),
  note: text,
  goal_cadence: z.number().nullish(),
  goal_cadence_frequency: z.number().nullish(),
  goal_target: z.number().nullish(),
  deleted,
});
const movement = {
  id,
  amount: milliunits,
  memo: text,
  payee_id: text,
  category_id: text,
  transfer_account_id: text,
  transfer_transaction_id: text,
  deleted,
};
const transaction = z.object({ ...movement, date: z.string().refine(isCalendarDate), account_id: id });
const subtransaction = z.object({ ...movement, transaction_id: id });

const plan = z.object({
  name: z.string(),
  currency_format: z.object({ iso_code: z.string(), decimal_digits: z.number() }).nullish(),
  accounts: z.array(account),
  payees: z.array(payee),
  category_groups: z.array(group),
  categories: z.array(category),
  months: z.array(month),
  transactions: z.array(transaction),
  subtransactions: z.array(subtransaction).default([]),
});
export type YnabPlan = z.infer<typeof plan>;

export class YnabPlanError extends Error {
  constructor(readonly code: "not_a_ynab_export" | "unsupported_currency") {
    super(code);
    this.name = "YnabPlanError";
  }
}

/** The API answers `{data:{plan}}`, and exports made before its 2026 rename carry `{data:{budget}}`. */
export function parseYnabPlan(raw: unknown): YnabPlan {
  const data = (raw as { data?: { plan?: unknown; budget?: unknown } } | null)?.data;
  const parsed = plan.safeParse(data?.plan ?? data?.budget ?? raw);
  if (!parsed.success) throw new YnabPlanError("not_a_ynab_export");
  return parsed.data;
}

const toMinor = (value: number): Money => Math.round(value / 10);

const ACCOUNT_TYPES: Readonly<Record<string, AccountType>> = { checking: "checking", savings: "savings", cash: "cash", otherAsset: "investment" };

/** YNAB moves money between a spending category and these on every card purchase. Enveo keeps the
 *  money in the spending envelope and shows the debt on the account, so the group has no equivalent. */
const CARD_PAYMENT_GROUP = "Credit Card Payments";

export function ynabPlanToMigrationSource(input: YnabPlan, currentMonth: string): MigrationSource {
  const format = input.currency_format;
  if (format && (format.decimal_digits !== 2 || !isSupportedCurrency(format.iso_code))) throw new YnabPlanError("unsupported_currency");

  const payees = new Map(input.payees.map((row) => [row.id, row.name]));
  const months = input.months
    .filter((row) => !row.deleted)
    .map((row) => ({ month: row.month.slice(0, 7), categories: row.categories }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const subtransactions = input.subtransactions.filter((row) => !row.deleted);
  const transactions = input.transactions.filter((row) => !row.deleted);

  const groupById = new Map(input.category_groups.map((row) => [row.id, row]));
  const groupOf = (row: YnabPlan["categories"][number]) => row.original_category_group_id ?? row.category_group_id;
  const used = new Set([...transactions, ...subtransactions].flatMap((row) => (row.category_id ? [row.category_id] : [])));
  const categories = input.categories.filter((row) => {
    if (row.internal || groupById.get(row.category_group_id)?.internal) return false;
    if (row.category_group_name === CARD_PAYMENT_GROUP || groupById.get(groupOf(row))?.name === CARD_PAYMENT_GROUP) return false;
    return !row.deleted || used.has(row.id);
  });
  const kept = new Set(categories.map((row) => row.id));
  const keptGroups = new Set(categories.map(groupOf));

  const allocations: MigrationSource["allocations"] = [];
  const available = new Map<string, Money>();
  const previous = new Map<string, Money>();
  for (const { month: key, categories: rows } of months) {
    for (const row of rows) {
      if (!kept.has(row.id) || row.deleted) continue;
      const balance = toMinor(row.balance);
      const activity = toMinor(row.activity);
      const previousBalance = previous.get(row.id) ?? 0;
      // YNAB's opening balance is what is left once this month's assignment and activity are removed.
      const assigned = toMinor(row.budgeted);
      const openingBalance = balance - assigned - activity;
      allocations.push({ categoryKey: row.id, month: key, amount: carriedAllocation({ assigned, previousBalance, openingBalance }) });
      previous.set(row.id, balance);
      if (key <= currentMonth) available.set(row.id, balance);
    }
  }

  const line = (row: z.infer<typeof transaction> | z.infer<typeof subtransaction>): MigrationLine => ({
    key: row.id,
    amount: toMinor(row.amount),
    categoryKey: row.category_id && kept.has(row.category_id) ? row.category_id : null,
    memo: row.memo ?? null,
    transferAccountKey: row.transfer_account_id ?? null,
    transferPeerKey: row.transfer_transaction_id ?? null,
  });

  const splits = new Map<string, MigrationLine[]>();
  for (const row of subtransactions) splits.set(row.transaction_id, [...(splits.get(row.transaction_id) ?? []), line(row)]);

  return {
    name: input.name,
    currency: format?.iso_code ?? null,
    accounts: input.accounts
      .filter((row) => !row.deleted)
      .map((row) => ({
        key: row.id,
        name: row.name,
        type: ACCOUNT_TYPES[row.type] ?? "other",
        onBudget: row.on_budget,
        closed: row.closed,
        expectedBalance: toMinor(row.balance),
      })),
    groups: input.category_groups.filter((row) => keptGroups.has(row.id)).map((row) => ({ key: row.id, name: row.name })),
    categories: categories.map((row) => ({
      key: row.id,
      groupKey: groupOf(row),
      name: row.name,
      hidden: row.hidden || !!row.deleted,
      monthlyTarget: row.goal_cadence === 1 && row.goal_cadence_frequency === 1 && row.goal_target ? toMinor(row.goal_target) : null,
      note: row.note ?? null,
    })),
    allocations,
    month: currentMonth,
    expectedAvailable: [...available].map(([categoryKey, amount]) => ({ categoryKey, amount })),
    trackingOnly: false,
    transactions: transactions.map((row) => ({
      accountKey: row.account_id,
      date: row.date,
      payee: (row.payee_id && !row.transfer_account_id && payees.get(row.payee_id)) || null,
      memo: row.memo ?? null,
      lines: splits.get(row.id) ?? [line(row)],
    })),
  };
}
