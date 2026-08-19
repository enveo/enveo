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

export interface MergePlan {
  /** The row that survives — it keeps its id, so nothing it is referenced by has to change. */
  survivorId: string;
  sourceIds: string[];
  /** Set when the surviving row has to be renamed to the name the human typed. */
  rename: string | null;
}

/**
 * Who survives, who is absorbed, and does the survivor need renaming. The typed name is the
 * intent, so if it ALREADY names another (visible) entry, that entry becomes the survivor and
 * nothing is renamed — otherwise the merge would mint a second row with an identical name and
 * hand the human the same duplicate back. Fewer than two selections is not a merge.
 */
export function planMerge(selectedIds: readonly string[], entries: readonly DictionaryEntry[], typedName: string): MergePlan | null {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const selected = selectedIds.filter((id) => byId.has(id));
  if (selected.length < 2) return null;
  const name = typedName.trim();
  const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const adopted = name ? entries.find((e) => !e.archived && !selected.includes(e.id) && sameName(e.name, name)) : undefined;
  if (adopted) return { survivorId: adopted.id, sourceIds: [...selected], rename: null };
  const survivorId = selected[0]!;
  const survivor = byId.get(survivorId)!;
  return { survivorId, sourceIds: selected.slice(1), rename: name && !sameName(survivor.name, name) ? name : null };
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
  // Selection ORDER matters: the first entry ticked seeds the name field and, unless the human
  // types something else, is the row that survives.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mergeName, setMergeName] = useState("");
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

  const rename = (id: string, name: string) => (tab === "categories" ? local.renameCategory(id, name) : local.renamePlace(id, name));

  const clearSelection = () => {
    setSelectedIds([]);
    setMergeName("");
  };

  const toggle = (entry: DictionaryEntry) =>
    setSelectedIds((ids) => {
      if (ids.includes(entry.id)) return ids.filter((id) => id !== entry.id);
      if (ids.length === 0) setMergeName(entry.name);
      return [...ids, entry.id];
    });

  const selectGroup = (group: DictionaryEntry[]) => {
    setSelectedIds(group.map((e) => e.id));
    setMergeName(group[0]!.name);
  };

  // One op per absorbed entry, and the count in the prompt is what the human is agreeing to: every
  // transaction (and split item) carrying an absorbed name changes to the surviving entry.
  const runMerge = () => {
    const plan = planMerge(selectedIds, entries, mergeName);
    if (!plan) return;
    const name = mergeName.trim() || entries.find((e) => e.id === plan.survivorId)?.name || "";
    const n = plan.sourceIds.length + 1;
    const ok = window.confirm(
      tp(
        "Merge {n} entry into one named “{name}”? Every transaction it carries moves over. | Merge {n} entries into one named “{name}”? Every transaction they carry moves over.",
        n,
        { n, name },
      ),
    );
    if (!ok) return;
    for (const sourceId of plan.sourceIds) merge(sourceId, plan.survivorId);
    if (plan.rename) rename(plan.survivorId, plan.rename);
    clearSelection();
  };

  const selecting = selectedIds.length > 0;
  const row = (entry: DictionaryEntry) => {
    const checked = selectedIds.includes(entry.id);
    return (
      <div
        key={entry.id}
        onClick={() => toggle(entry)}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: `1px solid ${C.line}`, cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(entry)}
          onClick={(e) => e.stopPropagation()}
          aria-label={entry.name}
          style={{ width: 18, height: 18, flexShrink: 0, accentColor: "var(--accent)", cursor: "pointer" }}
        />
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
        {/* While a selection is open the row is a checkbox and nothing else — three tap targets in
            one narrow row is how a "hide" lands on the entry above the one the human meant. */}
        {!selecting && entry.uses === 0 && entry.archived && (
          <button
            onClick={(e) => {
              e.stopPropagation();
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
        {!selecting && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setArchived(entry.id, !entry.archived);
            }}
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
  // Suggestions only in the plain view: mid-selection, or inside a search, the human is already
  // steering, and a second list competing for the same tap is noise.
  const suggestions = !selecting && !showHidden && !query ? duplicateGroups(visible) : [];
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

      {selecting && (
        <div style={{ background: "var(--accent-1a)", border: "1px solid var(--accent)", borderRadius: 12, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 650, color: C.text }}>
              {tp("{n} selected | {n} selected", selectedIds.length, { n: selectedIds.length })}
            </span>
            <button
              onClick={clearSelection}
              style={{ background: "none", border: "none", color: C.soft, fontSize: 11.5, fontWeight: 650, fontFamily: font, cursor: "pointer", flexShrink: 0 }}
            >
              {t("Clear")}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Seeded from the first entry ticked, then it is the human's to edit — the typed name
                is what the surviving entry ends up called, whichever row that turns out to be. */}
            <input
              value={mergeName}
              onChange={(e) => setMergeName(e.target.value)}
              placeholder={t("Name after merging")}
              aria-label={t("Name after merging")}
              style={{
                flex: 1,
                minWidth: 0,
                background: C.card,
                border: `1px solid ${C.line}`,
                borderRadius: 10,
                padding: "8px 10px",
                fontSize: 13,
                color: C.text,
                fontFamily: font,
              }}
            />
            <button
              onClick={runMerge}
              disabled={selectedIds.length < 2 || !mergeName.trim()}
              style={{
                background: selectedIds.length < 2 || !mergeName.trim() ? C.chip : "var(--cta)",
                border: "none",
                borderRadius: 10,
                padding: "9px 14px",
                fontSize: 12.5,
                fontWeight: 700,
                color: selectedIds.length < 2 || !mergeName.trim() ? C.mute : "#fff",
                fontFamily: font,
                cursor: selectedIds.length < 2 || !mergeName.trim() ? "default" : "pointer",
                flexShrink: 0,
              }}
            >
              {t("Merge")}
            </button>
          </div>
          {selectedIds.length < 2 && <div style={{ fontSize: 11, color: C.soft, marginTop: 6 }}>{t("Pick at least two entries to merge.")}</div>}
        </div>
      )}

      {suggestions.length > 0 && (
        <div style={{ background: C.chip, borderRadius: 12, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.soft, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 6 }}>
            {t("Look like the same thing")}
          </div>
          {suggestions.map((entries) => {
            const keep = entries[0]!;
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
                  onClick={() => selectGroup(entries)}
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
                  {t("Select these")}
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
        {selecting
          ? t("Merging keeps every transaction — they just move to the entry that stays.")
          : showHidden
            ? t("An entry nothing uses can be deleted for good.")
            : t("Hiding an entry only removes it from suggestions. Transactions that use it keep it, here and in reports.")}
      </Helper>
    </div>
  );
}
