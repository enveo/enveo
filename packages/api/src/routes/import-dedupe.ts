/**
 * Duplicate classification for screenshot imports.
 *
 * The key does NOT include nondeterministic fields (tag and envelope come from
 * the LLM and differ between uploads; manual transactions have tag=null) — that
 * was the cause of missed duplicates:
 * - "exists"  = date|amount|source_ref (raw bank description READ from the
 *   screenshot; apply stores it on the transaction) — deterministic, sure duplicate,
 * - "probable" = date|amount alone matches ANYTHING (including manual entries
 *   without source_ref) — the UI shows it unchecked, but selectable,
 * - "new"     = nothing similar.
 */
export type DupStatus = "new" | "exists" | "probable";

export interface ExistingRow {
  date: string;
  amount: number;
  sourceRef: string | null;
}

export interface DupItem {
  date: string;
  amount: number;
  rawPlace?: string | null;
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
const strongKey = (date: string, amount: number, ref: string): string => `${date}|${amount}|${ref}`;
const weakKey = (date: string, amount: number): string => `${date}|${amount}`;

export interface DupIndex {
  strong: Set<string>;
  weak: Set<string>;
  /** Registers a freshly written item (dedup within one batch) — strong key only. */
  markSeen: (item: DupItem) => void;
}

export function buildDupIndex(rows: ExistingRow[]): DupIndex {
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const r of rows) {
    const ref = norm(r.sourceRef);
    if (ref) strong.add(strongKey(r.date, r.amount, ref));
    weak.add(weakKey(r.date, r.amount));
  }
  return {
    strong,
    weak,
    markSeen(item: DupItem) {
      const ref = norm(item.rawPlace);
      if (ref) strong.add(strongKey(item.date, item.amount, ref));
      // deliberately WITHOUT weak — two different items with the same date+amount
      // in one batch (both visible on the screenshot) should both be added
    },
  };
}

export function classifyDup(item: DupItem, idx: DupIndex): DupStatus {
  const ref = norm(item.rawPlace);
  if (ref && idx.strong.has(strongKey(item.date, item.amount, ref))) return "exists";
  if (idx.weak.has(weakKey(item.date, item.amount))) return "probable";
  return "new";
}
