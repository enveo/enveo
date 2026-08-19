import { useMemo, useState } from "react";
import { PickerSearch } from "../../components/kit";
import { useLedgerVersion } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import { matchesSearch } from "../../lib/search";
import { store } from "../../lib/store";
import { font } from "../../lib/theme";
import { Helper } from "./ui";

/** How many transactions still carry an entry — split items count too (`txn_items.category_id`). */
export interface DictionaryEntry {
  id: string;
  name: string;
  archived: boolean;
  uses: number;
}

/** Pure: both dictionaries with their usage counts, name-sorted. Exported for the unit test. */
export function dictionaryEntries(ledger: {
  categories: readonly { id: string; name: string; archived: boolean }[];
  places: readonly { id: string; name: string; archived: boolean }[];
  transactions: readonly { categoryId: string | null; placeId: string | null; items: readonly { categoryId: string | null }[] }[];
}): { categories: DictionaryEntry[]; places: DictionaryEntry[] } {
  const catUses = new Map<string, number>();
  const placeUses = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string | null) => {
    if (id) m.set(id, (m.get(id) ?? 0) + 1);
  };
  for (const t of ledger.transactions) {
    bump(catUses, t.categoryId);
    bump(placeUses, t.placeId);
    for (const item of t.items) bump(catUses, item.categoryId);
  }
  const rows = <T extends { id: string; name: string; archived: boolean }>(list: readonly T[], uses: Map<string, number>): DictionaryEntry[] =>
    [...list].map((e) => ({ id: e.id, name: e.name, archived: e.archived, uses: uses.get(e.id) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
  return { categories: rows(ledger.categories, catUses), places: rows(ledger.places, placeUses) };
}

export type DictionarySort = "name" | "uses";

/**
 * The screenshot import mints a place per merchant STRING, so the same shop arrives as "Żabka",
 * "ZABKA" and "zabka nr 3." Normalising case, diacritics, punctuation and spacing collapses those
 * onto one key — deliberately EXACT after normalisation, with no fuzzy distance: a false grouping
 * here would invite the human to merge two genuinely different places, and that cannot be undone.
 */
export function normalizeDictionaryName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

/** Entries whose normalised names collide, most-used first inside a group (that one survives). */
export function duplicateGroups(entries: DictionaryEntry[]): DictionaryEntry[][] {
  const byKey = new Map<string, DictionaryEntry[]>();
  for (const entry of entries) {
    const key = normalizeDictionaryName(entry.name);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return [...byKey.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort((a, b) => (a.uses !== b.uses ? b.uses - a.uses : a.name.localeCompare(b.name))))
    .sort((a, b) => b.length - a.length || a[0]!.name.localeCompare(b[0]!.name));
}

/**
 * Upkeep sorting. "uses" ascending FIRST is the default on purpose: this screen exists to prune,
 * and the rows worth acting on are the ones nothing uses. Name is the tie-break either way, so
 * the order never wobbles between renders.
 */
export function sortDictionary(entries: DictionaryEntry[], sort: DictionarySort, ascending: boolean): DictionaryEntry[] {
  if (sort === "name") return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return [...entries].sort((a, b) => (a.uses !== b.uses ? (ascending ? a.uses - b.uses : b.uses - a.uses) : a.name.localeCompare(b.name)));
}

/**
 * Dictionary upkeep. Hiding takes an entry out of ENTRY (suggestions, pickers) and nothing else —
 * every transaction that carries it keeps showing it here, in the list and in reports. Deleting is
 * offered only at zero usages, and even then the write degrades to a hide if a reference appeared
 * from another device in the meantime (the FK would otherwise null the value out of a transaction).
 */
export function DictionariesSection() {
  const C = useTheme();
  const { t, tp } = useT();
  const ledgerVersion = useLedgerVersion();
  const [tab, setTab] = useState<"categories" | "places">("categories");
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<DictionarySort>("name");
  const [usesAscending, setUsesAscending] = useState(true);
  const [mergeSource, setMergeSource] = useState<DictionaryEntry | null>(null);
  const { categories, places } = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? dictionaryEntries(ledger) : { categories: [], places: [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerVersion]);

  const entries = tab === "categories" ? categories : places;
  const visible = entries.filter((e) => !e.archived);
  const hidden = entries.filter((e) => e.archived);
  const setArchived = (id: string, archived: boolean) =>
    tab === "categories" ? local.setCategoryArchived(id, archived) : local.setPlaceArchived(id, archived);
  const remove = (id: string) => (tab === "categories" ? local.deleteCategory(id) : local.deletePlace(id));
  const merge = (fromId: string, intoId: string) => (tab === "categories" ? local.mergeCategories(fromId, intoId) : local.mergePlaces(fromId, intoId));

  // One op per absorbed entry, and the count in the prompt is what the human is actually agreeing
  // to: every transaction (and split item) carrying the losing name changes to the surviving one.
  const confirmMerge = (sources: DictionaryEntry[], into: DictionaryEntry) => {
    const moved = sources.reduce((n, e) => n + e.uses, 0);
    const names = sources.map((e) => e.name).join(", ");
    const ok = window.confirm(
      tp(
        "Merge “{names}” into “{into}”? {n} transaction moves over and only “{into}” stays. | Merge “{names}” into “{into}”? {n} transactions move over and only “{into}” stays.",
        moved,
        { names, into: into.name, n: moved },
      ),
    );
    if (!ok) return;
    for (const source of sources) merge(source.id, into.id);
    setMergeSource(null);
  };

  const row = (entry: DictionaryEntry) => {
    const picking = mergeSource !== null && mergeSource.id !== entry.id;
    return (
      <div
        key={entry.id}
        onClick={picking ? () => confirmMerge([mergeSource], entry) : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 0",
          borderBottom: `1px solid ${C.line}`,
          cursor: picking ? "pointer" : "default",
          opacity: mergeSource !== null && !picking ? 0.45 : 1,
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 13.5,
              fontWeight: 500,
              color: entry.archived ? C.mute : C.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.name}
          </span>
          <span style={{ display: "block", fontSize: 11, color: C.mute }}>
            {entry.uses === 0 ? t("not used yet") : tp("{n} transaction | {n} transactions", entry.uses, { n: entry.uses })}
          </span>
        </span>
        {picking && <span style={{ fontSize: 11.5, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>{t("Merge into this")}</span>}
        {mergeSource === null && (
          <button
            onClick={() => setMergeSource(entry)}
            style={{
              background: "none",
              border: "none",
              color: C.soft,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: font,
              padding: "4px 6px",
            }}
          >
            {t("Merge")}
          </button>
        )}
        {mergeSource === null && entry.uses === 0 && entry.archived && (
          <button
            onClick={() => {
              if (window.confirm(t("Delete “{name}” for good? It is not used by any transaction.", { name: entry.name }))) remove(entry.id);
            }}
            style={{
              background: "none",
              border: "none",
              color: C.neg,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: font,
              padding: "4px 6px",
            }}
          >
            {t("Delete")}
          </button>
        )}
        {mergeSource === null && (
          <button
            onClick={() => setArchived(entry.id, !entry.archived)}
            style={{
              background: entry.archived ? "var(--accent-1a)" : C.chip,
              border: `1px solid ${entry.archived ? "var(--accent)" : C.line}`,
              borderRadius: 999,
              padding: "5px 11px",
              fontSize: 11,
              fontWeight: 600,
              color: entry.archived ? "var(--accent)" : C.text,
              fontFamily: font,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {entry.archived ? t("Restore") : t("Hide")}
          </button>
        )}
      </div>
    );
  };

  // Hundreds of places (the screenshot import mints one per merchant name) make an unfiltered
  // list useless — search first, then narrow to the group the human is actually working on.
  const group = showHidden ? hidden : visible;
  // Suggestions only in the plain view: while merging, or inside a search, the human is already
  // steering, and a second list competing for the same tap is noise.
  const suggestions = mergeSource === null && !showHidden && !query ? duplicateGroups(visible) : [];
  const matched = sortDictionary(
    group.filter((e) => matchesSearch(e.name, query)),
    sort,
    usesAscending,
  );

  return (
    <div style={{ paddingTop: 12, paddingBottom: 24 }}>
      <div style={{ display: "flex", background: C.chip, borderRadius: 12, padding: 2, marginBottom: 14 }}>
        {(["categories", "places"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              flex: 1,
              padding: "8px 0",
              borderRadius: 10,
              border: "none",
              fontSize: 12.5,
              fontWeight: 650,
              fontFamily: font,
              cursor: "pointer",
              background: tab === id ? C.card : "transparent",
              color: tab === id ? C.text : C.soft,
            }}
          >
            {id === "categories" ? t("Categories") : t("Places")}
          </button>
        ))}
      </div>

      {mergeSource !== null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--accent-1a)",
            border: `1px solid var(--accent)`,
            borderRadius: 12,
            padding: "10px 12px",
            marginBottom: 12,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text }}>{t("Pick the entry “{name}” should become.", { name: mergeSource.name })}</span>
          <button
            onClick={() => setMergeSource(null)}
            style={{ background: "none", border: "none", color: C.soft, fontSize: 11.5, fontWeight: 650, fontFamily: font, cursor: "pointer", flexShrink: 0 }}
          >
            {t("Cancel")}
          </button>
        </div>
      )}

      {suggestions.length > 0 && (
        <div style={{ background: C.chip, borderRadius: 12, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.soft, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 6 }}>
            {t("Look like the same thing")}
          </div>
          {suggestions.map((entries) => {
            const keep = entries[0]!;
            const absorbed = entries.slice(1);
            return (
              <div key={keep.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                {/* Two lines, then clip: the variants ARE the evidence for the suggestion, and a
                    single ellipsised line hides the third spelling the human is deciding about. */}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    lineHeight: 1.35,
                    color: C.text,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 2,
                  }}
                >
                  {entries.map((e) => e.name).join(" · ")}
                </span>
                <button
                  onClick={() => confirmMerge(absorbed, keep)}
                  style={{
                    background: C.card,
                    border: `1px solid ${C.line}`,
                    borderRadius: 999,
                    padding: "5px 11px",
                    fontSize: 11,
                    fontWeight: 650,
                    color: "var(--accent)",
                    fontFamily: font,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {t("Keep “{name}”", { name: keep.name })}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PickerSearch value={query} onChange={setQuery} />
        </div>
        <div style={{ display: "flex", background: C.chip, borderRadius: 999, padding: 2, flexShrink: 0, marginBottom: 10 }}>
          {[false, true].map((wantHidden) => (
            <button
              key={String(wantHidden)}
              onClick={() => setShowHidden(wantHidden)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "none",
                fontSize: 11.5,
                fontWeight: 650,
                fontFamily: font,
                cursor: "pointer",
                background: showHidden === wantHidden ? C.card : "transparent",
                color: showHidden === wantHidden ? C.text : C.soft,
                whiteSpace: "nowrap",
              }}
            >
              {wantHidden ? t("Hidden") : t("Visible")} {wantHidden ? hidden.length : visible.length}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.mute }}>{t("Sort")}</span>
        {(["name", "uses"] as const).map((id) => (
          <button
            key={id}
            onClick={() => {
              if (id === "uses" && sort === "uses") setUsesAscending((v) => !v);
              setSort(id);
            }}
            style={{
              background: "none",
              border: "none",
              padding: "4px 0",
              fontSize: 11.5,
              fontWeight: sort === id ? 700 : 500,
              color: sort === id ? "var(--accent)" : C.soft,
              fontFamily: font,
              cursor: "pointer",
            }}
          >
            {id === "name" ? t("Name") : `${t("Uses")} ${usesAscending ? "↑" : "↓"}`}
          </button>
        ))}
      </div>

      {matched.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0 4px" }}>{query ? t("No matches") : t("Nothing here yet.")}</div>
      ) : (
        matched.map(row)
      )}
      <Helper>
        {mergeSource !== null
          ? t("Merging keeps every transaction — they just point at the entry you pick.")
          : showHidden
            ? t("An entry nothing uses can be deleted for good.")
            : t("Hiding an entry only removes it from suggestions. Transactions that use it keep it, here and in reports.")}
      </Helper>
    </div>
  );
}
