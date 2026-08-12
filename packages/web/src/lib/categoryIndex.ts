/**
 * Envelope→categories index (co-occurrence frequency in the ledger) for
 * category suggestions on the Add screen. PERFORMANCE: built ONCE per replica
 * version (memoized by ledgerVersion — invalidated after a sync/mutation), a read is
 * a Map lookup. Counts envelopes both from transactions and from split items.
 */
import type { ClientLedger } from "@enveo/shared";

let cache: { version: number; byEnv: Map<string, Map<string, number>> } | null = null;

function build(ledger: ClientLedger): Map<string, Map<string, number>> {
  const byEnv = new Map<string, Map<string, number>>();
  const bump = (envId: string | null | undefined, catId: string | null | undefined) => {
    if (!envId || !catId) return;
    let m = byEnv.get(envId);
    if (!m) byEnv.set(envId, (m = new Map()));
    m.set(catId, (m.get(catId) ?? 0) + 1);
  };
  for (const t of ledger.transactions) {
    bump(t.envelopeId, t.categoryId);
    for (const it of t.items ?? []) bump(it.envelopeId, t.categoryId);
  }
  return byEnv;
}

/** Category counters for an envelope (an empty Map when there is no history). */
export function categoryCountsFor(ledger: ClientLedger, version: number, envelopeId: string | null): Map<string, number> {
  if (!cache || cache.version !== version) cache = { version, byEnv: build(ledger) };
  return (envelopeId && cache.byEnv.get(envelopeId)) || new Map();
}

/** Category list sorting: frequent with THIS envelope first (descending), the rest alphabetically. */
export function rankCategories<T extends { id: string; name: string }>(cats: T[], counts: Map<string, number>): T[] {
  return [...cats].sort((a, b) => {
    const ca = counts.get(a.id) ?? 0;
    const cb = counts.get(b.id) ?? 0;
    if (ca !== cb) return cb - ca;
    return a.name.localeCompare(b.name);
  });
}
