





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

 
export function categoryCountsFor(ledger: ClientLedger, version: number, envelopeId: string | null): Map<string, number> {
  if (!cache || cache.version !== version) cache = { version, byEnv: build(ledger) };
  return (envelopeId && cache.byEnv.get(envelopeId)) || new Map();
}

 
export function rankCategories<T extends { id: string; name: string }>(cats: T[], counts: Map<string, number>): T[] {
  return [...cats].sort((a, b) => {
    const ca = counts.get(a.id) ?? 0;
    const cb = counts.get(b.id) ?? 0;
    if (ca !== cb) return cb - ca;
    return a.name.localeCompare(b.name);
  });
}
