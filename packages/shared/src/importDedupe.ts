export const IMPORT_DUP_STATUSES = ["new", "exists", "probable"] as const;
export type ImportDupStatus = (typeof IMPORT_DUP_STATUSES)[number];

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
  /**
   * Classifies one candidate and, on an exact match, CLAIMS the existing row it matched: every
   * recorded transaction stands for exactly one imported entry, so a second identical entry of
   * the same day is not hidden behind the first one's booking.
   */
  claim(item: ImportCandidate): ImportDupStatus;
  /** Legacy batch callers without review identities: identical later items count as this one. */
  markSeen(item: ImportCandidate): void;
}

export function buildImportDupIndex(rows: ExistingImportRow[]): ImportDupIndex {
  const strong = new Map<string, number[]>();
  const transfers = new Map<string, number[]>();
  const weak = new Set<string>();
  const seen = new Set<string>();
  const claimed = new Set<number>();
  const add = (index: Map<string, number[]>, key: string, position: number) => index.set(key, [...(index.get(key) ?? []), position]);
  rows.forEach((row, position) => {
    if (row.transferDirection) {
      add(transfers, transferKey(row.date, row.amount, row.transferDirection), position);
      // The receiving side has no text of its own to match; it is identified by the transfer set
      // alone and must not turn every unrelated same-day amount into a "probable" duplicate.
      if (row.transferDirection === "in") return;
    }
    const ref = norm(row.sourceRef);
    if (ref) add(strong, strongKey(row.date, row.amount, ref), position);
    weak.add(weakKey(row.date, row.amount));
  });
  const claimFrom = (positions: readonly number[] | undefined): boolean => {
    const free = positions?.find((position) => !claimed.has(position));
    if (free === undefined) return false;
    claimed.add(free);
    return true;
  };
  return {
    claim(item) {
      const keys = candidateRefs(item.rawPlace).map((ref) => strongKey(item.date, item.amount, ref));
      if (keys.some((key) => seen.has(key))) return "exists";
      if (keys.some((key) => claimFrom(strong.get(key)))) return "exists";
      const transfer = item.direction ? transferKey(item.date, item.amount, item.direction) : null;
      if (transfer !== null && claimFrom(transfers.get(transfer))) return "exists";
      // Every exact counterpart is already taken by an earlier identical entry: this one may be
      // a genuine repeat, so it is shown for review instead of being hidden.
      if (keys.some((key) => strong.has(key)) || (transfer !== null && transfers.has(transfer))) return "probable";
      if (weak.has(weakKey(item.date, item.amount))) return "probable";
      return "new";
    },
    markSeen(item) {
      const ref = norm(item.rawPlace);
      if (ref) seen.add(strongKey(item.date, item.amount, ref));
    },
  };
}

export function classifyImportDup(item: ImportCandidate, index: ImportDupIndex): ImportDupStatus {
  return index.claim(item);
}

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

export function importCandidateDirection(
  item: { type: "expense" | "income" | "transfer"; isRefund?: boolean; accountId?: string | null; toAccountId?: string | null },
  accountId: string,
): ImportMoneyDirection {
  if (item.type === "income") return "in";
  if (item.type === "expense") return item.isRefund ? "in" : "out";
  return item.toAccountId === accountId && item.accountId !== accountId ? "in" : "out";
}
