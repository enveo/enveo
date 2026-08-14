/** Deterministic screenshot-import duplicate classification shared by API and local E2EE. */
export type ImportDupStatus = "new" | "exists" | "probable";

export interface ExistingImportRow {
  date: string;
  amount: number;
  sourceRef: string | null;
}

export interface ImportCandidate {
  date: string;
  amount: number;
  rawPlace?: string | null;
}

const norm = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();
const strongKey = (date: string, amount: number, ref: string): string => `${date}|${amount}|${ref}`;
const weakKey = (date: string, amount: number): string => `${date}|${amount}`;

export interface ImportDupIndex {
  strong: Set<string>;
  weak: Set<string>;
  /** Register an item accepted in this batch. Only strong identity blocks another row. */
  markSeen(item: ImportCandidate): void;
}

export function buildImportDupIndex(rows: ExistingImportRow[]): ImportDupIndex {
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const row of rows) {
    const ref = norm(row.sourceRef);
    if (ref) strong.add(strongKey(row.date, row.amount, ref));
    weak.add(weakKey(row.date, row.amount));
  }
  return {
    strong,
    weak,
    markSeen(item) {
      const ref = norm(item.rawPlace);
      if (ref) strong.add(strongKey(item.date, item.amount, ref));
    },
  };
}

export function classifyImportDup(item: ImportCandidate, index: ImportDupIndex): ImportDupStatus {
  const ref = norm(item.rawPlace);
  if (ref && index.strong.has(strongKey(item.date, item.amount, ref))) return "exists";
  if (index.weak.has(weakKey(item.date, item.amount))) return "probable";
  return "new";
}
