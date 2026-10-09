import type { ExploreDim, ExploreGrouping, ExploreStep } from "@enveo/shared";

// The part of the Spending report's state that App and the router need at boot; the rest of the
// report (period presets, labels) loads with the report chunk.

/**
 * Everything the Spending report shows. The drill path lives in the URL (each level is a history
 * entry, so system back goes up one level); period, account and grouping do not, so going back
 * keeps the period and account the user set on the deeper level.
 */
export interface SpendingView {
  from: string;
  to: string;
  /** The user typed the range; keeps the date fields open even when it happens to match a preset. */
  custom: boolean;
  account: string | null;
  path: readonly ExploreStep[];
  /** A grouping the user picked, valid only on the level it was picked on. */
  grouping: { pathKey: string; g: ExploreGrouping } | null;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const i = y * 12 + m - 1 + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** Twelve calendar months ending this month, all accounts. */
export function defaultSpendingView(thisMonth: string, path: readonly ExploreStep[] = []): SpendingView {
  return { from: monthStart(shiftMonth(thisMonth, -11)), to: monthEnd(thisMonth), custom: false, account: null, path, grouping: null };
}

const CODE: Record<ExploreDim, string> = { group: "g", envelope: "e", category: "c", place: "p" };
const DIM_OF: Record<string, ExploreDim> = { g: "group", e: "envelope", c: "category", p: "place" };
const NULL_KEY = "-";

/** `e.<id>~c.<id>`; the "no category" bucket is `c.-`. */
export function encodePath(path: readonly ExploreStep[]): string {
  return path.map((s) => `${CODE[s.dim]}.${s.key ?? NULL_KEY}`).join("~");
}

/** Anything malformed (hand-edited URL, unknown dimension, repeated dimension) yields no path. */
export function decodePath(raw: string | null): ExploreStep[] {
  if (!raw) return [];
  const steps: ExploreStep[] = [];
  for (const part of raw.split("~")) {
    const m = /^([gecp])\.([A-Za-z0-9_-]{1,64})$/.exec(part);
    const dim = m ? DIM_OF[m[1]!] : undefined;
    if (!m || !dim || steps.some((s) => s.dim === dim)) return [];
    steps.push({ dim, key: m[2] === NULL_KEY ? null : m[2]! });
  }
  return steps;
}
