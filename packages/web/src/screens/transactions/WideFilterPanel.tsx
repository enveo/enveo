import { useEffect, useState } from "react";
import { useMask, useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { font, TEAL } from "../../lib/theme";
import {
  emptyTransactionFilters,
  parseSearchAmount,
  type TransactionAmountFilter,
  type TransactionFilters,
  type TransactionKind,
} from "../../lib/transactionSearch";
import { amountSummary, selectionSummary } from "./TransactionFilterSheet";

type Named = { id: string; name: string; color?: string };

/**
 * Design parity wave C task 5 (waveC-t5-brief.md, v3:310-364) — the inline filter body that
 * appears directly under the search bar on wide, welding the two into one bordered card
 * (`Transactions.tsx` owns the corner/border welding — this component is only the body). Lazy
 * from `Transactions.tsx` (§0.8): that screen module is shared by phone and wide alike (one
 * chunk, `App.tsx`'s own `lazy()`), so the 6-column grid + amount UI lives in its OWN chunk,
 * fetched only the first time a wide user opens Filters — a phone user never requests it.
 *
 * Reuses `TransactionFilters`/`activeFilterCount`'s model and the option lists `Transactions.tsx`
 * already builds (archived-but-referenced envelopes/accounts included) — NOT
 * `TransactionFilterSheet`'s drill-down UI. Every toggle/edit here writes `filters` directly
 * (live apply, v3:2606-2620's `amountRule` recomputed from the raw text on every change) instead
 * of the sheet's draft+Apply flow: there is no "Show N" step on wide, the list below reacts
 * immediately (owner rule 2 territory — no phone-sheet chrome bleeding into this surface).
 */
export interface WideFilterPanelProps {
  filters: TransactionFilters;
  setFilters: (filters: TransactionFilters) => void;
  /** The SAME filtered (query + filters) count `Transactions.tsx` renders the list from — v3's
   *  `matchLine` and `txnCount` both read `visible.length`; this is that one number. */
  matchCount: number;
  envelopes: ReadonlyArray<Named>;
  accounts: ReadonlyArray<Named>;
  categories: ReadonlyArray<Named>;
  places: ReadonlyArray<Named>;
  /** Escape or the search bar's caret — plain state in `Transactions.tsx`, not the pane machine:
   *  this panel is primary-pane furniture, never panel content. */
  onClose: () => void;
}

type AmountDraft = { invalid: boolean; amount: TransactionAmountFilter | null };

function computeAmountDraft(mode: "exact" | "range", exactText: string, minText: string, maxText: string): AmountDraft {
  if (mode === "exact") {
    const parsed = exactText.trim() ? parseSearchAmount(exactText.trim()) : null;
    const invalid = !!exactText.trim() && parsed === null;
    return { invalid, amount: parsed === null ? null : { mode: "exact", minor: parsed } };
  }
  const parsedMin = minText.trim() ? parseSearchAmount(minText.trim()) : null;
  const parsedMax = maxText.trim() ? parseSearchAmount(maxText.trim()) : null;
  const invalid =
    (!!minText.trim() && parsedMin === null) || (!!maxText.trim() && parsedMax === null) || (parsedMin !== null && parsedMax !== null && parsedMin > parsedMax);
  return {
    invalid,
    amount: invalid || (parsedMin === null && parsedMax === null) ? null : { mode: "range", minMinor: parsedMin, maxMinor: parsedMax },
  };
}

type FilterOption = { id: string; label: string; selected: boolean; color?: string; onToggle: () => void };

export function WideFilterPanel({ filters, setFilters, matchCount, envelopes, accounts, categories, places, onClose }: WideFilterPanelProps) {
  const C = useTheme();
  const M = useMask();
  const { t, tp } = useT();

  const [amtMode, setAmtMode] = useState<"exact" | "range">(filters.amount?.mode ?? "exact");
  const [exactText, setExactText] = useState(() => (filters.amount?.mode === "exact" ? String(filters.amount.minor / 100).replace(".", ",") : ""));
  const [minText, setMinText] = useState(() =>
    filters.amount?.mode === "range" && filters.amount.minMinor !== null ? String(filters.amount.minMinor / 100).replace(".", ",") : "",
  );
  const [maxText, setMaxText] = useState(() =>
    filters.amount?.mode === "range" && filters.amount.maxMinor !== null ? String(filters.amount.maxMinor / 100).replace(".", ",") : "",
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const notFiltered = t("Not filtered");
  const { invalid: amountInvalid } = computeAmountDraft(amtMode, exactText, minText, maxText);

  const applyAmount = (mode: "exact" | "range", exact: string, min: string, max: string) => {
    setFilters({ ...filters, amount: computeAmountDraft(mode, exact, min, max).amount });
  };
  const onModeChange = (mode: "exact" | "range") => {
    setAmtMode(mode);
    applyAmount(mode, exactText, minText, maxText);
  };
  const onExactChange = (value: string) => {
    setExactText(value);
    applyAmount("exact", value, minText, maxText);
  };
  const onMinChange = (value: string) => {
    setMinText(value);
    applyAmount(amtMode, exactText, value, maxText);
  };
  const onMaxChange = (value: string) => {
    setMaxText(value);
    applyAmount(amtMode, exactText, minText, value);
  };
  const clearAmount = () => {
    setAmtMode("exact");
    setExactText("");
    setMinText("");
    setMaxText("");
    setFilters({ ...filters, amount: null });
  };
  const clearAll = () => {
    setAmtMode("exact");
    setExactText("");
    setMinText("");
    setMaxText("");
    setFilters(emptyTransactionFilters());
  };
  const clearDimension = (key: "accountIds" | "envelopeIds" | "placeIds" | "categoryIds" | "kinds") => {
    setFilters({ ...filters, [key]: new Set() });
  };
  const toggleSet = (key: "accountIds" | "envelopeIds" | "placeIds" | "categoryIds", id: string) => {
    const next = new Set(filters[key]);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFilters({ ...filters, [key]: next });
  };
  const toggleKind = (kind: TransactionKind) => {
    const next = new Set(filters.kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setFilters({ ...filters, kinds: next });
  };

  const kindOptions: Named[] = [
    { id: "expense", name: t("Expense") },
    { id: "income", name: t("Income") },
    { id: "refund", name: t("Refund") },
    { id: "transfer", name: t("Transfer") },
  ];

  const columns: Array<{ key: string; title: string; summary: string; options: FilterOption[] }> = [
    {
      key: "kinds",
      title: t("Type"),
      summary: selectionSummary(filters.kinds, kindOptions, notFiltered),
      options: kindOptions.map((k) => ({
        id: k.id,
        label: k.name,
        selected: filters.kinds.has(k.id as TransactionKind),
        onToggle: () => toggleKind(k.id as TransactionKind),
      })),
    },
    {
      key: "places",
      title: t("Place"),
      summary: selectionSummary(filters.placeIds, places, notFiltered),
      options: places.map((p) => ({ id: p.id, label: p.name, selected: filters.placeIds.has(p.id), onToggle: () => toggleSet("placeIds", p.id) })),
    },
    {
      key: "categories",
      title: t("Category"),
      summary: selectionSummary(filters.categoryIds, categories, notFiltered),
      options: categories.map((c) => ({
        id: c.id,
        label: c.name,
        selected: filters.categoryIds.has(c.id),
        onToggle: () => toggleSet("categoryIds", c.id),
      })),
    },
    {
      key: "envelopes",
      title: t("Envelope"),
      summary: selectionSummary(filters.envelopeIds, envelopes, notFiltered),
      options: envelopes.map((e) => ({
        id: e.id,
        label: e.name,
        color: e.color,
        selected: filters.envelopeIds.has(e.id),
        onToggle: () => toggleSet("envelopeIds", e.id),
      })),
    },
    {
      key: "accounts",
      title: t("Account"),
      summary: selectionSummary(filters.accountIds, accounts, notFiltered),
      options: accounts.map((a) => ({
        id: a.id,
        label: a.name,
        color: a.color,
        selected: filters.accountIds.has(a.id),
        onToggle: () => toggleSet("accountIds", a.id),
      })),
    },
  ];

  const chips: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
  if (filters.kinds.size)
    chips.push({ key: "kinds", label: t("Type"), value: selectionSummary(filters.kinds, kindOptions, notFiltered), onRemove: () => clearDimension("kinds") });
  if (filters.placeIds.size)
    chips.push({
      key: "places",
      label: t("Place"),
      value: selectionSummary(filters.placeIds, places, notFiltered),
      onRemove: () => clearDimension("placeIds"),
    });
  if (filters.categoryIds.size)
    chips.push({
      key: "categories",
      label: t("Category"),
      value: selectionSummary(filters.categoryIds, categories, notFiltered),
      onRemove: () => clearDimension("categoryIds"),
    });
  if (filters.envelopeIds.size)
    chips.push({
      key: "envelopes",
      label: t("Envelope"),
      value: selectionSummary(filters.envelopeIds, envelopes, notFiltered),
      onRemove: () => clearDimension("envelopeIds"),
    });
  if (filters.accountIds.size)
    chips.push({
      key: "accounts",
      label: t("Account"),
      value: selectionSummary(filters.accountIds, accounts, notFiltered),
      onRemove: () => clearDimension("accountIds"),
    });
  if (filters.amount) chips.push({ key: "amount", label: t("Amount"), value: amountSummary(filters, M, notFiltered), onRemove: clearAmount });

  const filterCount =
    [filters.kinds, filters.placeIds, filters.categoryIds, filters.envelopeIds, filters.accountIds].filter((s) => s.size > 0).length + (filters.amount ? 1 : 0);

  const eyebrowStyle = { fontSize: 9.5, fontWeight: 750, letterSpacing: "0.14em", textTransform: "uppercase" as const, color: C.mute };
  const summaryLineStyle = { fontSize: 10.5, color: C.soft, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const };
  const amountInputStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "7px 9px",
    borderRadius: 8,
    border: `1px solid ${C.line}`,
    background: C.bg,
    color: C.text,
    fontFamily: font,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums" as const,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: C.card,
        border: `1px solid ${C.line}`,
        borderTop: "none",
        borderBottomLeftRadius: 14,
        borderBottomRightRadius: 14,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={eyebrowStyle}>{t("Filter")}</span>
        {chips.length === 0 && <span style={{ fontSize: 11.5, color: C.mute }}>{t("Narrow transactions by specific fields")}</span>}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
          {tp("{n} transaction matches | {n} transactions match", matchCount)}
        </span>
        {filterCount > 0 && (
          <button
            onClick={clearAll}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: C.neg, fontFamily: font }}
          >
            {t("Clear")}
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {chips.map((chip) => (
            <span
              key={chip.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 11.5,
                color: C.text,
                background: C.accentSoft,
                border: `1px solid ${TEAL}`,
                borderRadius: 999,
                padding: "4px 10px",
              }}
            >
              <span style={{ color: C.soft }}>{chip.label}:</span>
              <span style={{ fontWeight: 650 }}>{chip.value}</span>
              <button
                onClick={chip.onRemove}
                aria-label={t("Remove this filter")}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: C.mute, fontSize: 11, fontFamily: font }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10, borderTop: `1px solid ${C.line}`, paddingTop: 9 }}>
        {columns.map((col) => (
          <div key={col.key} style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={eyebrowStyle}>{col.title}</span>
            <span style={summaryLineStyle}>{col.summary}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 148, overflowY: "auto" }}>
              {col.options.map((option) => (
                <button
                  key={option.id}
                  onClick={option.onToggle}
                  aria-pressed={option.selected}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    minWidth: 0,
                    minHeight: 30,
                    boxSizing: "border-box",
                    padding: "4px 5px",
                    borderRadius: 7,
                    border: "none",
                    background: "none",
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: font,
                  }}
                >
                  <span
                    style={{
                      width: 15,
                      height: 15,
                      flexShrink: 0,
                      borderRadius: 5,
                      border: `1.5px solid ${option.selected ? TEAL : C.line}`,
                      background: option.selected ? TEAL : C.card,
                      color: "#fff",
                      fontSize: 9,
                      fontWeight: 800,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {option.selected ? "✓" : ""}
                  </span>
                  {option.color && <span style={{ width: 8, height: 8, flexShrink: 0, borderRadius: 3, background: option.color }} />}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11.5,
                      fontWeight: option.selected ? 650 : 500,
                      color: option.selected ? C.text : C.soft,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {option.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}

        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={eyebrowStyle}>{t("Amount")}</span>
          <span style={summaryLineStyle}>{amountSummary(filters, M, notFiltered)}</span>
          <div style={{ display: "flex", gap: 3, padding: 3, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 9 }}>
            {(["exact", "range"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => onModeChange(mode)}
                style={{
                  flex: 1,
                  textAlign: "center",
                  padding: "5px 0",
                  minHeight: 30,
                  boxSizing: "border-box",
                  borderRadius: 6,
                  border: "none",
                  fontSize: 11,
                  fontWeight: 650,
                  cursor: "pointer",
                  fontFamily: font,
                  background: amtMode === mode ? TEAL : "transparent",
                  color: amtMode === mode ? "#fff" : C.soft,
                }}
              >
                {mode === "exact" ? t("Exactly") : t("Range")}
              </button>
            ))}
          </div>
          {amtMode === "exact" ? (
            <input value={exactText} onChange={(e) => onExactChange(e.target.value)} placeholder="0.00" inputMode="decimal" style={amountInputStyle} />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
              <input value={minText} onChange={(e) => onMinChange(e.target.value)} placeholder={t("From")} inputMode="decimal" style={amountInputStyle} />
              <input value={maxText} onChange={(e) => onMaxChange(e.target.value)} placeholder={t("To")} inputMode="decimal" style={amountInputStyle} />
            </div>
          )}
          {amountInvalid && <span style={{ fontSize: 10.5, color: C.neg }}>{t("Enter a valid amount")}</span>}
        </div>
      </div>
    </div>
  );
}
