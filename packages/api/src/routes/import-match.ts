/**
 * Pure matching logic of raw screenshot descriptions against history (no I/O) —
 * extracted so it can be tested without a database.
 *
 * The match key of a historical transaction is (in order):
 *   source_ref (raw bank description, e.g. "PRO*PLATNOSC") → place → tag → name.
 * source_ref is the STRONGEST signal: it is exactly the string the bank shows
 * on the statement, and it does NOT change when the transaction is corrected
 * (the user fixes the name/envelope, but source_ref stays). Thanks to that, a
 * single correction "PRO*PLATNOSC → Orlen/Fuel" teaches the assignment for the
 * future — something matching by place name (which the correction overwrites
 * to "Orlen") could not do.
 */

const normTxt = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]+/gi, " ").replace(/\s+/g, " ").trim();

function trigramsOf(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Text similarity: containment → 0.95, otherwise Dice on trigrams. */
export function textSim(a: string, b: string): number {
  const na = normTxt(a);
  const nb = normTxt(b);
  if (na.length < 3 || nb.length < 3) return 0; // single-letter keys break matching
  if (na.includes(nb) || nb.includes(na)) return 0.95;
  const ta = trigramsOf(na);
  const tb = trigramsOf(nb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

export interface HistPattern {
  place: string | null;
  name: string | null;
  envelope: string | null;
  category: string | null;
  count: number;
  /** the pattern comes from source_ref (raw bank description) — the OVERRIDING signal,
   *  independent of count, stable across corrections; propagated all the way to the assignment decision */
  fromSourceRef: boolean;
  /** TYPE learning (2026-07-12): history also carries the transaction type — a
   *  confident source_ref hit deterministically proposes a transfer/refund
   *  (cycle-1 vision only sees inflow/outflow; users confuse refund↔transfer). */
  type: "expense" | "income" | "transfer";
  isRefund: boolean;
  /** Target account of the historical transfer (null outside transfers). */
  toAccountId: string | null;
}

/** Grouped assignment pattern + similarity key. */
export interface HistGroup extends HistPattern {
  key: string;
}

const MIN_SIM = 0.3;
const TOP_N = 5;

/** Pattern ranking for one raw description (top 5). */
export function rankPatterns(raw: string, groups: HistGroup[]): HistPattern[] {
  const nraw = normTxt(raw);
  return groups
    .map((g) => {
      let sim = textSim(raw, g.key);
      // a learned exact hit on the raw description beats everything (1.0 > 0.95)
      if (g.fromSourceRef && nraw === normTxt(g.key)) sim = 1;
      // confidence bonus: source_ref > anchored in a place > the rest
      sim += g.fromSourceRef ? 0.02 : g.place ? 0.01 : 0;
      return { g, sim };
    })
    .filter((x) => x.sim >= MIN_SIM)
    .sort((a, b) => b.sim - a.sim || b.g.count - a.g.count)
    .slice(0, TOP_N)
    .map(({ g }) => ({ place: g.place, name: g.name, envelope: g.envelope, category: g.category, count: g.count, fromSourceRef: g.fromSourceRef, type: g.type, isRefund: g.isRefund, toAccountId: g.toAccountId }));
}

/** Model proposal (cycle 2) — raw names before conversion to ids. */
export interface ModelAssignment {
  name: string | null;
  place: string | null;
  envelope: string | null;
  category: string | null;
}

/**
 * Final assignment decision: combines the best history pattern (`top`, rank[0])
 * with the model's proposal. source_ref is OVERRIDING — when `top` comes from
 * source_ref (a learned correction matched to the raw bank description), we copy
 * all four fields from it VERBATIM and IGNORE the model (which is instructed to
 * pick by highest count, so on its own it would outvote a single correction with
 * a more numerous place-name pattern). Otherwise we trust the model, and `top`
 * fills the missing fields (name, place, envelope and category — symmetrically).
 * This is where the source_ref ranking actually dominates end-to-end;
 * rankPatterns itself merely places it at rank[0].
 */
export function decideAssignment(
  rawPlace: string,
  top: HistPattern | undefined,
  model: ModelAssignment | undefined,
  hardOverride = true,
): { name: string; place: string | null; envelope: string | null; category: string | null } {
  // hardOverride: only for a SURE source_ref hit (deterministic path, no AI).
  // On an uncertain hit the model decides, and `top` merely fills the gaps.
  if (hardOverride && top?.fromSourceRef) {
    return { name: top.name?.trim() || rawPlace, place: top.place, envelope: top.envelope, category: top.category };
  }
  return {
    name: model?.name?.trim() || top?.name || rawPlace,
    place: model?.place?.trim() || top?.place || null,
    envelope: model?.envelope?.trim() || top?.envelope || null,
    category: model?.category?.trim() || top?.category || null,
  };
}

const CONFIDENT_SIM = 0.95; // exact hit or containment; trigram fuzzy (<0.95) → uncertain

/**
 * A SURE source_ref hit — qualifies the item for a deterministic assignment
 * WITHOUT asking the AI. Conditions: a pattern with `fromSourceRef` exists whose
 * raw bank description exactly equals or contains/is contained by the current one
 * (sim ≥ 0.95), AND it carries a real assignment (envelope/category/place) —
 * otherwise there is nothing to copy deterministically, so better let the model
 * try. Returns the pattern or null (→ to the AI).
 */
export function confidentSourceRef(raw: string, groups: HistGroup[]): HistPattern | null {
  let best: { g: HistGroup; sim: number } | null = null;
  for (const g of groups) {
    if (!g.fromSourceRef) continue;
    const sim = textSim(raw, g.key);
    if (sim < CONFIDENT_SIM) continue;
    if (!best || sim > best.sim || (sim === best.sim && g.count > best.g.count)) best = { g, sim };
  }
  if (!best) return null;
  const g = best.g;
  // A "real assignment" = envelope/category/place OR a learned type other than
  // a plain expense (transfer/refund/income) — a pure transfer has no envelope,
  // and the type is exactly what we want to learn from it.
  const learnsType = g.type !== "expense" || g.isRefund;
  if (g.envelope === null && g.category === null && g.place === null && !learnsType) return null; // nothing to copy → to the AI
  return { place: g.place, name: g.name, envelope: g.envelope, category: g.category, count: g.count, fromSourceRef: true, type: g.type, isRefund: g.isRefund, toAccountId: g.toAccountId };
}
