import { computeBudgetState } from "../budget";
import type { Account, AccountType, Allocation, Budget, Category, ClientLedger, Envelope, EnvelopeGroup, Money, Place, Transaction, TxnItem } from "../types";

/** One line of money; an unsplit transaction has exactly one. `amount` is signed: negative leaves the account. */
export interface MigrationLine {
  key: string;
  amount: Money;
  /** null: the money is not in any envelope (income, an uncategorized row). */
  categoryKey: string | null;
  memo: string | null;
  transferAccountKey: string | null;
  transferPeerKey: string | null;
  /** The row's own title, when the source keeps one apart from the payee. Absent: the payee names it. */
  name?: string | null;
  /** A category alongside the envelope, created by name. */
  category?: string | null;
}

export interface MigrationTransaction {
  accountKey: string;
  date: string;
  payee: string | null;
  memo: string | null;
  lines: MigrationLine[];
}

export interface MigrationSource {
  name: string;
  /** null: the source does not say, so the budget keeps its own currency. */
  currency: string | null;
  /** `expectedBalance` null: the source does not state the balance, so the person compares it by eye. */
  accounts: Array<{ key: string; name: string; type: AccountType; onBudget: boolean; closed: boolean; expectedBalance: Money | null }>;
  groups: Array<{ key: string; name: string }>;
  categories: Array<{ key: string; groupKey: string; name: string; hidden: boolean; monthlyTarget: Money | null; note: string | null }>;
  /** Already expressed in Enveo's terms: see `carriedAllocation`. */
  allocations: Array<{ categoryKey: string; month: string; amount: Money }>;
  /** The source's own figures for `month`, compared with what the ledger computes. */
  month: string;
  /** null: the source does not state what each envelope holds. */
  expectedAvailable: Array<{ categoryKey: string; amount: Money }> | null;
  /** The source tracks spending without envelopes, so no assignment can be carried over. */
  trackingOnly: boolean;
  transactions: MigrationTransaction[];
}

export interface MigrationDifference {
  name: string;
  expected: Money;
  actual: Money;
}

export interface MigrationReceipt {
  budgetName: string;
  month: string;
  accounts: number;
  envelopes: number;
  transactions: number;
  allocations: number;
  places: number;
  accountDifferences: MigrationDifference[];
  envelopeDifferences: MigrationDifference[];
  /** False when the source states no balance for some account: nothing was compared for it. */
  balancesChecked: boolean;
  /** Accounts whose balance the source does not state, with the balance the move produces; closed ones only when not zero. */
  uncheckedBalances: Array<{ name: string; amount: Money }>;
  envelopesChecked: boolean;
  /** On-budget accounts owing money: Enveo has no card-payment envelopes, so debt lowers To be budgeted. */
  debtAccounts: number;
  trackingOnly: boolean;
}

export interface MigrationResult {
  ledger: ClientLedger;
  receipt: MigrationReceipt;
}

export interface MigrationOptions {
  budget: Budget;
  newId: () => string;
  envelopeStyle: (index: number) => { color: string; icon: string };
  accountStyle: (index: number) => { color: string; icon: string };
}

/**
 * YNAB and Actual reset an overspent category to zero at the start of the next month and charge
 * the overspending to the money still to assign; Enveo carries the negative balance forward. The
 * same money stays where it was when that reset is added to the next month's assignment, which
 * keeps both each envelope's available amount and To be budgeted equal to the source's.
 */
export function carriedAllocation(args: { assigned: Money; previousBalance: Money; openingBalance: Money }): Money {
  return args.assigned + args.openingBalance - args.previousBalance;
}

interface TransferSide {
  transaction: MigrationTransaction;
  line: MigrationLine;
}

export function buildMigrationLedger(source: MigrationSource, options: MigrationOptions): MigrationResult {
  const { newId } = options;
  const accountIds = new Map(source.accounts.map((account) => [account.key, newId()]));
  const groupIds = new Map(source.groups.map((group) => [group.key, newId()]));
  const envelopeIds = new Map(source.categories.map((category) => [category.key, newId()]));
  const onBudget = new Set(source.accounts.filter((account) => account.onBudget).map((account) => account.key));

  const accounts: Account[] = source.accounts.map((account, index) => ({
    id: accountIds.get(account.key)!,
    name: account.name,
    ...options.accountStyle(index),
    type: account.type,
    onBudget: account.onBudget,
    initialBalance: 0,
    archived: account.closed,
    sort: index,
    automaticEnvelopeId: null,
  }));
  const groups: EnvelopeGroup[] = source.groups.map((group, index) => ({ id: groupIds.get(group.key)!, name: group.name, sort: index }));
  const envelopes: Envelope[] = source.categories.map((category, index) => ({
    id: envelopeIds.get(category.key)!,
    groupId: groupIds.get(category.groupKey)!,
    name: category.name,
    ...options.envelopeStyle(index),
    note: category.note,
    monthlyTarget: category.monthlyTarget,
    isSavings: false,
    sort: index,
    archived: category.hidden,
  }));
  const allocations: Allocation[] = source.allocations.flatMap((allocation) => {
    const envelopeId = envelopeIds.get(allocation.categoryKey);
    return envelopeId && allocation.amount !== 0 ? [{ id: newId(), envelopeId, month: allocation.month, amount: allocation.amount }] : [];
  });

  const places = new Map<string, Place>();
  const placeId = (name: string | null): string | null => {
    const trimmed = name?.trim();
    if (!trimmed) return null;
    const key = trimmed.toLowerCase();
    const existing = places.get(key);
    if (existing) return existing.id;
    const created = { id: newId(), name: trimmed, archived: false };
    places.set(key, created);
    return created.id;
  };

  const categories = new Map<string, Category>();
  const categoryId = (name: string | null | undefined): string | null => {
    const trimmed = name?.trim();
    if (!trimmed) return null;
    const key = trimmed.toLowerCase();
    const existing = categories.get(key);
    if (existing) return existing.id;
    const created = { id: newId(), name: trimmed, archived: false };
    categories.set(key, created);
    return created.id;
  };
  const rowName = (line: MigrationLine, payee: string | null): string | null => (line.name === undefined ? payee?.trim() || null : line.name?.trim() || null);

  const sides = new Map<string, TransferSide>();
  const namedBy = new Map<string, string>();
  for (const transaction of source.transactions) {
    for (const line of transaction.lines) {
      sides.set(line.key, { transaction, line });
      if (line.transferPeerKey) namedBy.set(line.transferPeerKey, line.key);
    }
  }
  const transfersDone = new Set<string>();

  const blank = (transaction: MigrationTransaction, memo: string | null) => ({
    id: newId(),
    date: transaction.date,
    accountId: accountIds.get(transaction.accountKey)!,
    toAccountId: null,
    isRefund: false,
    envelopeId: null,
    placeId: null,
    categoryId: null,
    name: null,
    note: memo?.trim() || null,
    tag: null,
    sourceRef: null,
    allocationFromEnvelopeId: null,
    allocationToEnvelopeId: null,
    items: [],
    createdAt: `${transaction.date}T12:00:00.000Z`,
  });

  const transferRow = (transaction: MigrationTransaction, line: MigrationLine): Transaction | null => {
    const peerKey = line.transferPeerKey;
    // A split's transfer line and its counterpart may name each other by different ids.
    if ((peerKey && transfersDone.has(peerKey)) || transfersDone.has(namedBy.get(line.key) ?? "")) return null;
    transfersDone.add(line.key);
    const peer = sides.get(peerKey ?? "")?.line ?? sides.get(namedBy.get(line.key) ?? "")?.line;
    const fromKey = line.amount < 0 ? transaction.accountKey : line.transferAccountKey!;
    const toKey = line.amount < 0 ? line.transferAccountKey! : transaction.accountKey;
    const fromSide = line.amount < 0 ? line : peer;
    const toSide = line.amount < 0 ? peer : line;
    const leavesBudget = onBudget.has(fromKey) && !onBudget.has(toKey);
    const entersBudget = !onBudget.has(fromKey) && onBudget.has(toKey);
    return {
      ...blank({ ...transaction, accountKey: fromKey }, line.memo ?? transaction.memo),
      type: "transfer",
      name: line.name?.trim() || null,
      toAccountId: accountIds.get(toKey)!,
      amount: Math.abs(line.amount),
      allocationFromEnvelopeId: leavesBudget ? (envelopeIds.get(fromSide?.categoryKey ?? "") ?? null) : null,
      allocationToEnvelopeId: entersBudget ? (envelopeIds.get(toSide?.categoryKey ?? "") ?? null) : null,
    };
  };

  const moneyRow = (transaction: MigrationTransaction, line: MigrationLine): Transaction => {
    const envelopeId = onBudget.has(transaction.accountKey) ? (envelopeIds.get(line.categoryKey ?? "") ?? null) : null;
    return {
      ...blank(transaction, line.memo ?? transaction.memo),
      type: line.amount > 0 && !envelopeId ? "income" : "expense",
      amount: Math.abs(line.amount),
      isRefund: line.amount > 0 && !!envelopeId,
      envelopeId,
      placeId: placeId(transaction.payee),
      categoryId: categoryId(line.category),
      name: rowName(line, transaction.payee),
    };
  };

  /** Enveo's split holds unsigned envelope items, so anything else stays as separate rows. */
  const splitRow = (transaction: MigrationTransaction, lines: MigrationLine[]): Transaction | null => {
    const inward = lines[0]!.amount > 0;
    if (lines.length < 2 || !onBudget.has(transaction.accountKey)) return null;
    if (lines.some((line) => line.transferAccountKey || line.amount > 0 !== inward || !envelopeIds.has(line.categoryKey ?? ""))) return null;
    const items: TxnItem[] = lines.map((line) => ({
      id: newId(),
      envelopeId: envelopeIds.get(line.categoryKey!)!,
      categoryId: categoryId(line.category),
      amount: Math.abs(line.amount),
    }));
    return {
      ...blank(transaction, transaction.memo),
      type: "expense",
      amount: items.reduce((sum, item) => sum + item.amount, 0),
      isRefund: inward,
      placeId: placeId(transaction.payee),
      name: lines.some((line) => line.name !== undefined)
        ? [...new Set(lines.flatMap((line) => line.name?.trim() || []))].join(" · ") || null
        : transaction.payee?.trim() || null,
      items,
    };
  };

  const transactions: Transaction[] = source.transactions.flatMap((transaction) => {
    // A zero row moves nothing, and a row of a deleted account has nowhere to live.
    const lines = transaction.lines
      .filter((line) => line.amount !== 0)
      .map((line) => (line.transferAccountKey && !accountIds.has(line.transferAccountKey) ? { ...line, transferAccountKey: null } : line));
    if (lines.length === 0 || !accountIds.has(transaction.accountKey)) return [];
    const split = splitRow(transaction, lines);
    if (split) return [split];
    return lines.flatMap((line) => {
      if (!line.transferAccountKey) return [moneyRow(transaction, line)];
      const transfer = transferRow(transaction, line);
      return transfer ? [transfer] : [];
    });
  });

  const budget: Budget = { ...options.budget, currency: source.currency ?? options.budget.currency };
  const ledger: ClientLedger = {
    budgets: [budget],
    accounts,
    groups,
    envelopes,
    categories: [...categories.values()],
    places: [...places.values()],
    allocations,
    transactions,
  };

  // Every date counts for an account, so the balance is read past the end of any budget.
  const balances = new Map(computeBudgetState(ledger, "9999-12").accounts.map((state) => [state.account.id, state.balance]));
  const available = new Map(computeBudgetState(ledger, source.month).envelopes.map((state) => [state.envelope.id, state.available]));
  const balanceOf = (key: string) => balances.get(accountIds.get(key)!) ?? 0;
  const accountDifferences = source.accounts.flatMap((account) => {
    const actual = balanceOf(account.key);
    return account.expectedBalance === null || actual === account.expectedBalance ? [] : [{ name: account.name, expected: account.expectedBalance, actual }];
  });
  // A closed account still holding money is where a mismatched transfer would land, so it is shown too.
  const uncheckedBalances = source.accounts.flatMap((account) => {
    const amount = balanceOf(account.key);
    return account.expectedBalance === null && (!account.closed || amount !== 0) ? [{ name: account.name, amount }] : [];
  });
  const categoryNames = new Map(source.categories.map((category) => [category.key, category.name]));
  const envelopeDifferences = (source.expectedAvailable ?? []).flatMap(({ categoryKey, amount }) => {
    const id = envelopeIds.get(categoryKey);
    if (!id) return [];
    const actual = available.get(id) ?? 0;
    return actual === amount ? [] : [{ name: categoryNames.get(categoryKey)!, expected: amount, actual }];
  });

  return {
    ledger,
    receipt: {
      budgetName: source.name,
      month: source.month,
      accounts: accounts.length,
      envelopes: envelopes.length,
      transactions: transactions.length,
      allocations: allocations.length,
      places: places.size,
      accountDifferences,
      envelopeDifferences,
      balancesChecked: source.accounts.every((account) => account.expectedBalance !== null),
      uncheckedBalances,
      envelopesChecked: source.expectedAvailable !== null,
      debtAccounts: source.accounts.filter((account) => account.onBudget && !account.closed && (account.expectedBalance ?? balanceOf(account.key)) < 0).length,
      trackingOnly: source.trackingOnly,
    },
  };
}
