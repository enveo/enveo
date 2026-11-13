import { z } from "zod";
import { isCalendarDate } from "../dates";
import type { Money } from "../types";
import type { MigrationLine, MigrationSource, MigrationTransaction } from "./ledger";

/** 4grosze.pl keeps the money still to assign in an envelope of this name; Enveo derives it instead. */
const TO_BE_BUDGETED = "Do rozdysponowania";

const text = z.string().nullish();
const row = z.object({
  id: z.string().min(1),
  pos: z.number().int().optional(),
  date: z.string().refine(isCalendarDate),
  payee: text,
  amount: z.string(),
  account: z.string().min(1),
  transferAccount: text,
  envelope: text,
  category: text,
  description: text,
  type: z.enum(["inflow", "outflow", "transfer"]),
});

const exportFile = z.object({
  envelopes: z.array(z.object({ name: z.string().min(1), group: z.string().min(1), archived: z.boolean().optional() })),
  accounts: z.array(z.object({ name: z.string().min(1), closed: z.boolean().optional() })),
  categories: z.array(z.object({ name: z.string().min(1) })).optional(),
  budgetEntries: z.array(z.object({ monthId: z.number().int(), envelope: z.string().min(1), budgeted: z.string() })),
  transactions: z.array(row),
});

export type FourGroszeExport = z.infer<typeof exportFile>;

export class FourGroszeExportError extends Error {
  constructor(readonly code: "not_a_4grosze_export" | "inconsistent_export") {
    super(code);
    this.name = "FourGroszeExportError";
  }
}

export function parseFourGroszeExport(raw: unknown): FourGroszeExport {
  const parsed = exportFile.safeParse(raw);
  if (!parsed.success) throw new FourGroszeExportError("not_a_4grosze_export");
  return parsed.data;
}

/** "-1 234.56" in minor units, without passing through a float. */
export function fourGroszeAmount(raw: string): Money {
  const match = /^([-−]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(raw.replace(/[\s  ]/g, ""));
  if (!match) throw new FourGroszeExportError("not_a_4grosze_export");
  const value = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -value : value;
}

function monthOf(monthId: number): string {
  const digits = String(monthId);
  const month = Number(digits.slice(4));
  if (digits.length !== 6 || month < 1 || month > 12) throw new FourGroszeExportError("not_a_4grosze_export");
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

const trimmed = (value: string | null | undefined): string | null => value?.trim() || null;

/** Names are the export's only identity, so a blank or repeated one cannot be resolved and refuses the file. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || seen.has(name)) throw new FourGroszeExportError("inconsistent_export");
    seen.add(name);
  }
  return names;
}

type Row = z.infer<typeof row> & { account: string; transferAccount: string | null; amountMinor: Money };

/**
 * Both sides of a transfer must state the same movement on the same day. A lone side is kept, since the export may
 * have lost the other account's rows, but a pair that disagrees has no right answer to pick.
 */
function pairTransfers(rows: Row[]): Array<number | null> {
  if (rows.some((transaction) => !transaction.transferAccount || transaction.transferAccount === transaction.account)) {
    throw new FourGroszeExportError("inconsistent_export");
  }
  if (rows.length === 1) return [null];
  const open = new Map<string, number[]>();
  const sideKey = (from: string, to: string, amount: Money, date: string) => `${from}\u0000${to}\u0000${amount}\u0000${date}`;
  const peers: Array<number | null> = rows.map(() => null);
  rows.forEach((transaction, index) => {
    const waiting = open.get(sideKey(transaction.transferAccount!, transaction.account, -transaction.amountMinor, transaction.date));
    const peer = waiting?.pop();
    if (peer === undefined) {
      const own = sideKey(transaction.account, transaction.transferAccount!, transaction.amountMinor, transaction.date);
      const list = open.get(own);
      if (list) list.push(index);
      else open.set(own, [index]);
      return;
    }
    peers[index] = peer;
    peers[peer] = index;
  });
  if (peers.some((peer) => peer === null)) throw new FourGroszeExportError("inconsistent_export");
  return peers;
}

/**
 * The export names everything by its name and states no balances, so the receipt lists the balances
 * the move produces for the person to compare. Each month's assignment comes over as it is, without
 * the overspending reset YNAB and Actual need: the export has no envelope figures to prove either way.
 */
export function fourGroszeExportToMigrationSource(input: FourGroszeExport, currentMonth: string, labels: { name: string; archive: string }): MigrationSource {
  const envelopeOf = (name: string | null | undefined): string | null => {
    const value = trimmed(name);
    return value && value !== TO_BE_BUDGETED ? value : null;
  };

  const envelopes = input.envelopes
    .map((envelope) => ({ name: envelope.name.trim(), group: envelope.group.trim(), archived: !!envelope.archived }))
    .filter((envelope) => envelope.name !== TO_BE_BUDGETED);
  if (envelopes.some((envelope) => !envelope.group)) throw new FourGroszeExportError("inconsistent_export");
  const known = new Set(uniqueNames(envelopes.map((envelope) => envelope.name)));
  const accounts = input.accounts.map((account) => ({ name: account.name.trim(), closed: !!account.closed }));
  const accountNames = new Set(uniqueNames(accounts.map((account) => account.name)));

  const rows: Row[] = input.transactions.map((transaction) => {
    const account = trimmed(transaction.account);
    if (!account) throw new FourGroszeExportError("inconsistent_export");
    return { ...transaction, account, transferAccount: trimmed(transaction.transferAccount), amountMinor: fourGroszeAmount(transaction.amount) };
  });

  const orphans = [
    ...new Set([...input.budgetEntries.map((entry) => envelopeOf(entry.envelope)), ...rows.map((transaction) => envelopeOf(transaction.envelope))]),
  ].filter((name): name is string => !!name && !known.has(name));
  const groups = [...new Set(envelopes.map((envelope) => envelope.group))];
  const archive = orphans.length > 0 ? `\u0000${labels.archive}` : null;

  // A transaction may name an account the export no longer lists; its history still counts.
  const missingAccounts = [
    ...new Set(rows.flatMap((transaction) => [transaction.account, transaction.transferAccount ?? ""]).filter((name) => name && !accountNames.has(name))),
  ];

  const allocations = new Map<string, { categoryKey: string; month: string; amount: Money }>();
  for (const entry of input.budgetEntries) {
    const categoryKey = envelopeOf(entry.envelope);
    if (!categoryKey) continue;
    const month = monthOf(entry.monthId);
    const key = `${categoryKey}\u0000${month}`;
    const amount = fourGroszeAmount(entry.budgeted);
    allocations.set(key, { categoryKey, month, amount: (allocations.get(key)?.amount ?? 0) + amount });
  }

  const byId = new Map<string, Row[]>();
  for (const transaction of rows) {
    const group = byId.get(transaction.id);
    if (group) group.push(transaction);
    else byId.set(transaction.id, [transaction]);
  }

  const lineOf = (transaction: Row, key: string, peerKey: string | null): MigrationLine => ({
    key,
    amount: transaction.amountMinor,
    categoryKey: peerKey === null ? envelopeOf(transaction.envelope) : null,
    memo: null,
    transferAccountKey: peerKey === null ? null : transaction.transferAccount,
    transferPeerKey: peerKey,
    name: trimmed(transaction.description),
    category: trimmed(transaction.category),
  });

  const transactions: MigrationTransaction[] = [...byId].flatMap(([id, group]) => {
    const sorted = [...group].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    const transfers = sorted.filter((transaction) => transaction.type === "transfer").length;
    if (transfers > 0) {
      if (transfers !== sorted.length) throw new FourGroszeExportError("inconsistent_export");
      const keys = sorted.map((_, index) => `${id}#${index}`);
      const peers = pairTransfers(sorted);
      return sorted.map((transaction, index) => {
        const peer = peers[index];
        return {
          accountKey: transaction.account,
          date: transaction.date,
          payee: null,
          memo: null,
          lines: [lineOf(transaction, keys[index]!, peer === null || peer === undefined ? `${id}#peer` : keys[peer]!)],
        };
      });
    }
    // A split shares one id; rows that differ in account or date are separate transactions.
    const parts = new Map<string, Row[]>();
    for (const transaction of sorted) {
      const key = `${transaction.account}\u0000${transaction.date}`;
      const part = parts.get(key);
      if (part) part.push(transaction);
      else parts.set(key, [transaction]);
    }
    return [...parts.values()].map((part, partIndex) => ({
      accountKey: part[0]!.account,
      date: part[0]!.date,
      payee: trimmed(part[0]!.payee),
      memo: null,
      lines: part.map((transaction, index) => lineOf(transaction, `${id}#${partIndex}.${index}`, null)),
    }));
  });

  return {
    name: labels.name,
    currency: null,
    accounts: [
      ...accounts.map((account) => ({ key: account.name, name: account.name, closed: account.closed })),
      ...missingAccounts.map((name) => ({ key: name, name, closed: true })),
    ].map((account) => ({ ...account, type: "checking" as const, onBudget: true, expectedBalance: null })),
    groups: [...groups.map((name) => ({ key: name, name })), ...(archive ? [{ key: archive, name: labels.archive }] : [])],
    categories: [
      ...envelopes.map((envelope) => ({
        key: envelope.name,
        groupKey: envelope.group,
        name: envelope.name,
        hidden: envelope.archived,
        monthlyTarget: null,
        note: null,
      })),
      ...orphans.map((name) => ({ key: name, groupKey: archive!, name, hidden: true, monthlyTarget: null, note: null })),
    ],
    allocations: [...allocations.values()],
    month: currentMonth,
    expectedAvailable: null,
    trackingOnly: false,
    transactions,
  };
}
