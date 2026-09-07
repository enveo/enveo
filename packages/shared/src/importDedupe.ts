/** Deterministic screenshot-import duplicate classification shared by API and local E2EE. */
export type ImportDupStatus = "new" | "exists" | "probable";

/** Which way money moved for the account being imported into. */
export type ImportMoneyDirection = "in" | "out";

export interface ExistingImportRow {
  date: string;
  amount: number;
  sourceRef: string | null;
  /**
   * Set for a TRANSFER touching the imported account: "in" when the account received the money,
   * "out" when it sent it. A transfer is recorded once, from the sending account's side, so the
   * receiving account's import sees the same money as a top-up or incoming transfer whose text
   * never matches the transfer's source reference — direction plus date plus amount is the only
   * identity it has.
   */
  transferDirection?: ImportMoneyDirection;
}

export interface ImportCandidate {
  date: string;
  amount: number;
  rawPlace?: string | null;
  /** The candidate's own direction; lets an existing transfer of the same money block it. */
  direction?: ImportMoneyDirection;
}

// A status clock before an amount is not payment identity. Keep signs and merchant text intact.
const norm = (value: string | null | undefined): string =>
  (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[\t ]*[◷🕐-🕧]\uFE0F?\s*(?=[+-]?\d)/gmu, "");
const candidateRefs = (value: string | null | undefined): string[] => {
  const whole = norm(value);
  if (!whole) return [];
  return [...new Set([whole, ...whole.split(/\r?\n/).map(norm).filter(Boolean)])];
};
const strongKey = (date: string, amount: number, ref: string): string => `${date}|${amount}|${ref}`;
const weakKey = (date: string, amount: number): string => `${date}|${amount}`;
const transferKey = (date: string, amount: number, direction: ImportMoneyDirection): string => `${date}|${amount}|${direction}`;

export interface ImportDupIndex {
  strong: Set<string>;
  weak: Set<string>;
  /** Transfers touching the account, keyed with the direction the account saw. */
  transfers: Set<string>;
  /** Register an item accepted in this batch. Only strong identity blocks another row. */
  markSeen(item: ImportCandidate): void;
}

export function buildImportDupIndex(rows: ExistingImportRow[]): ImportDupIndex {
  const strong = new Set<string>();
  const weak = new Set<string>();
  const transfers = new Set<string>();
  for (const row of rows) {
    if (row.transferDirection) {
      transfers.add(transferKey(row.date, row.amount, row.transferDirection));
      // The receiving side has no text of its own to match; it is identified by the transfer set
      // alone and must not turn every unrelated same-day amount into a "probable" duplicate.
      if (row.transferDirection === "in") continue;
    }
    const ref = norm(row.sourceRef);
    if (ref) strong.add(strongKey(row.date, row.amount, ref));
    weak.add(weakKey(row.date, row.amount));
  }
  return {
    strong,
    weak,
    transfers,
    markSeen(item) {
      const ref = norm(item.rawPlace);
      if (ref) strong.add(strongKey(item.date, item.amount, ref));
    },
  };
}

export function classifyImportDup(item: ImportCandidate, index: ImportDupIndex): ImportDupStatus {
  if (candidateRefs(item.rawPlace).some((ref) => index.strong.has(strongKey(item.date, item.amount, ref)))) return "exists";
  if (item.direction && index.transfers.has(transferKey(item.date, item.amount, item.direction))) return "exists";
  if (index.weak.has(weakKey(item.date, item.amount))) return "probable";
  return "new";
}

/** The ledger rows that can prove an import candidate already exists on `accountId`: the
 *  account's own transactions plus every transfer INTO it, which lives on the sending account. */
export function existingImportRowsForAccount(
  transactions: ReadonlyArray<{ accountId: string; toAccountId: string | null; type: string; date: string; amount: number; sourceRef: string | null }>,
  accountId: string,
): ExistingImportRow[] {
  const rows: ExistingImportRow[] = [];
  for (const transaction of transactions) {
    if (transaction.accountId === accountId) {
      rows.push({
        date: transaction.date,
        amount: transaction.amount,
        sourceRef: transaction.sourceRef,
        ...(transaction.type === "transfer" ? { transferDirection: "out" as const } : {}),
      });
    } else if (transaction.type === "transfer" && transaction.toAccountId === accountId) {
      rows.push({ date: transaction.date, amount: transaction.amount, sourceRef: transaction.sourceRef, transferDirection: "in" });
    }
  }
  return rows;
}

/** Which way an import candidate moves money on `accountId` (the account it is judged against). */
export function importCandidateDirection(
  item: { type: "expense" | "income" | "transfer"; isRefund?: boolean; accountId?: string | null; toAccountId?: string | null },
  accountId: string,
): ImportMoneyDirection {
  if (item.type === "income") return "in";
  if (item.type === "expense") return item.isRefund ? "in" : "out";
  return item.toAccountId === accountId && item.accountId !== accountId ? "in" : "out";
}
