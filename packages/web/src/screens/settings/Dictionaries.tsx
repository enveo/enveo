import { useMemo, useState } from "react";
import { useLedgerVersion } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import { store } from "../../lib/store";
import { font } from "../../lib/theme";
import { Eyebrow, Helper } from "./ui";

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

  const row = (entry: DictionaryEntry) => (
    <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: `1px solid ${C.line}` }}>
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
      {entry.uses === 0 && entry.archived && (
        <button
          onClick={() => {
            if (window.confirm(t("Delete “{name}” for good? It is not used by any transaction.", { name: entry.name }))) remove(entry.id);
          }}
          style={{ background: "none", border: "none", color: C.neg, fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: font, padding: "4px 6px" }}
        >
          {t("Delete")}
        </button>
      )}
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
    </div>
  );

  return (
    <div style={{ paddingBottom: 24 }}>
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

      <Eyebrow>{t("Suggested when adding")}</Eyebrow>
      {visible.length === 0 ? <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0 4px" }}>{t("Nothing here yet.")}</div> : visible.map(row)}
      <Helper>{t("Hiding an entry only removes it from suggestions. Transactions that use it keep it, here and in reports.")}</Helper>

      {hidden.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <Eyebrow>{t("Hidden")}</Eyebrow>
          {hidden.map(row)}
          <Helper>{t("An entry nothing uses can be deleted for good.")}</Helper>
        </div>
      )}
    </div>
  );
}
