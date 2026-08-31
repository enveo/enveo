import type { Transaction } from "@enveo/shared";
import { useEffect, useMemo, useState } from "react";
import { Sheet } from "../../components/chrome";
import { HighlightedText, PickerSearch } from "../../components/kit";
import { useTheme as useThemeForFilterHelpers } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { matchesSearch, SEARCH_THRESHOLD } from "../../lib/search";
import { font, TEAL } from "../../lib/theme";
import {
  emptyTransactionFilters,
  matchesTransactionFilters,
  matchesTransactionQuery,
  parseSearchAmount,
  type TransactionFilters,
  type TransactionKind,
  type TransactionSearchIndex,
} from "../../lib/transactionSearch";

type Named = { id: string; name: string };
type FilterView = "main" | "accounts" | "envelopes" | "places" | "categories" | "amount";

interface TransactionFilterSheetProps {
  show: boolean;
  onClose: () => void;
  filters: TransactionFilters;
  onApply: (filters: TransactionFilters) => void;
  transactions: readonly Transaction[];
  query: string;
  searchIndex: TransactionSearchIndex;
  accounts: readonly Named[];
  envelopes: readonly Named[];
  categories: readonly Named[];
  places: readonly Named[];
  formatMoney: (minor: number) => string;
}

const cloneFilters = (filters: TransactionFilters): TransactionFilters => ({
  accountIds: new Set(filters.accountIds),
  envelopeIds: new Set(filters.envelopeIds),
  placeIds: new Set(filters.placeIds),
  categoryIds: new Set(filters.categoryIds),
  kinds: new Set(filters.kinds),
  amount: filters.amount ? { ...filters.amount } : null,
});

export function activeFilterCount(filters: TransactionFilters): number {
  return (
    [filters.accountIds, filters.envelopeIds, filters.placeIds, filters.categoryIds, filters.kinds].filter((selection) => selection.size > 0).length +
    (filters.amount ? 1 : 0)
  );
}

// Exported for `WideFilterPanel.tsx` (design parity wave C task 5): the wide inline panel shows
// the SAME "Not filtered" / "{first} +{n-1}" summary per column and per chip as this sheet's
// "main" list — one summary function, not a re-derived copy that could drift from the sheet's.
export function selectionSummary(selected: ReadonlySet<string>, options: readonly Named[], anyLabel: string): string {
  if (selected.size === 0) return anyLabel;
  const picked = options.filter((option) => selected.has(option.id));
  const first = picked[0]?.name ?? anyLabel;
  return picked.length > 1 ? `${first} +${picked.length - 1}` : first;
}

export function amountSummary(filters: TransactionFilters, formatMoney: (minor: number) => string, anyLabel: string): string {
  if (!filters.amount) return anyLabel;
  if (filters.amount.mode === "exact") return formatMoney(filters.amount.minor);
  const from = filters.amount.minMinor === null ? "…" : formatMoney(filters.amount.minMinor);
  const to = filters.amount.maxMinor === null ? "…" : formatMoney(filters.amount.maxMinor);
  return `${from} – ${to}`;
}

export function TransactionFilterSheet({
  show,
  onClose,
  filters,
  onApply,
  transactions,
  query,
  searchIndex,
  accounts,
  envelopes,
  categories,
  places,
  formatMoney,
}: TransactionFilterSheetProps) {
  const { t, tp } = useT();
  const [view, setView] = useState<FilterView>("main");
  const [draft, setDraft] = useState<TransactionFilters>(() => cloneFilters(filters));
  const [pickerQuery, setPickerQuery] = useState("");
  const [amountMode, setAmountMode] = useState<"exact" | "range">("exact");
  const [exactAmount, setExactAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

  useEffect(() => {
    if (!show) return;
    const next = cloneFilters(filters);
    setDraft(next);
    setView("main");
    setPickerQuery("");
    setAmountMode(next.amount?.mode ?? "exact");
    setExactAmount(next.amount?.mode === "exact" ? String(next.amount.minor / 100).replace(".", ",") : "");
    setMinAmount(next.amount?.mode === "range" && next.amount.minMinor !== null ? String(next.amount.minMinor / 100).replace(".", ",") : "");
    setMaxAmount(next.amount?.mode === "range" && next.amount.maxMinor !== null ? String(next.amount.maxMinor / 100).replace(".", ",") : "");
  }, [filters, show]);

  const openView = (next: FilterView) => {
    setPickerQuery("");
    setView(next);
  };

  const toggleSet = (key: "accountIds" | "envelopeIds" | "placeIds" | "categoryIds", id: string) => {
    setDraft((current) => {
      const selected = new Set(current[key]);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...current, [key]: selected };
    });
  };

  const toggleKind = (kind: TransactionKind) => {
    setDraft((current) => {
      const kinds = new Set(current.kinds);
      if (kinds.has(kind)) kinds.delete(kind);
      else kinds.add(kind);
      return { ...current, kinds };
    });
  };

  const parsedExact = exactAmount.trim() ? parseSearchAmount(exactAmount.trim()) : null;
  const parsedMin = minAmount.trim() ? parseSearchAmount(minAmount.trim()) : null;
  const parsedMax = maxAmount.trim() ? parseSearchAmount(maxAmount.trim()) : null;
  const amountInvalid =
    amountMode === "exact"
      ? !!exactAmount.trim() && parsedExact === null
      : (!!minAmount.trim() && parsedMin === null) ||
        (!!maxAmount.trim() && parsedMax === null) ||
        (parsedMin !== null && parsedMax !== null && parsedMin > parsedMax);

  const saveAmount = () => {
    if (amountInvalid) return;
    if (amountMode === "exact") {
      setDraft((current) => ({ ...current, amount: parsedExact === null ? null : { mode: "exact", minor: parsedExact } }));
    } else {
      setDraft((current) => ({
        ...current,
        amount: parsedMin === null && parsedMax === null ? null : { mode: "range", minMinor: parsedMin, maxMinor: parsedMax },
      }));
    }
    setView("main");
  };

  const matchingCount = useMemo(
    () =>
      transactions.filter((transaction) => matchesTransactionQuery(transaction, query, searchIndex) && matchesTransactionFilters(transaction, draft)).length,
    [draft, query, searchIndex, transactions],
  );

  const kinds: Array<{ id: TransactionKind; label: string }> = [
    { id: "expense", label: t("Expense") },
    { id: "income", label: t("Income") },
    { id: "refund", label: t("Refund") },
    { id: "transfer", label: t("Transfer") },
  ];

  const pickerConfig =
    view === "accounts"
      ? { title: t("Accounts"), options: accounts, key: "accountIds" as const }
      : view === "envelopes"
        ? { title: t("Envelopes"), options: envelopes, key: "envelopeIds" as const }
        : view === "places"
          ? { title: t("Places"), options: places, key: "placeIds" as const }
          : view === "categories"
            ? { title: t("Categories"), options: categories, key: "categoryIds" as const }
            : null;

  return (
    <Sheet show={show} onClose={onClose} tall>
      {(C) => (
        <>
          {view === "main" && (
            <>
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 4 }}>{t("Filter")}</div>
                <div style={{ fontSize: 12, color: C.soft, textAlign: "center", marginBottom: 16 }}>{t("Narrow transactions by specific fields")}</div>
              </div>

              <div className="gs" style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: C.soft, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                  {t("Type")}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 16 }}>
                  {kinds.map((kind) => {
                    const selected = draft.kinds.has(kind.id);
                    return (
                      <button
                        key={kind.id}
                        onClick={() => toggleKind(kind.id)}
                        aria-pressed={selected}
                        style={{
                          padding: "7px 11px",
                          borderRadius: 18,
                          border: `1.5px solid ${selected ? TEAL : C.line}`,
                          background: selected ? "var(--accent-14)" : C.surface,
                          color: selected ? TEAL : C.text,
                          fontSize: 12.5,
                          fontWeight: selected ? 700 : 500,
                          cursor: "pointer",
                        }}
                      >
                        {kind.label}
                      </button>
                    );
                  })}
                </div>

                <div style={{ background: C.surface, borderRadius: 13, border: `1px solid ${C.line}`, overflow: "hidden" }}>
                  <FilterRow label={t("Place")} value={selectionSummary(draft.placeIds, places, t("Not filtered"))} onClick={() => openView("places")} />
                  <FilterRow
                    label={t("Category")}
                    value={selectionSummary(draft.categoryIds, categories, t("Not filtered"))}
                    onClick={() => openView("categories")}
                  />
                  <FilterRow
                    label={t("Envelope")}
                    value={selectionSummary(draft.envelopeIds, envelopes, t("Not filtered"))}
                    onClick={() => openView("envelopes")}
                  />
                  <FilterRow
                    label={t("Account")}
                    value={selectionSummary(draft.accountIds, accounts, t("Not filtered"))}
                    onClick={() => openView("accounts")}
                  />
                  <FilterRow label={t("Amount")} value={amountSummary(draft, formatMoney, t("Not filtered"))} onClick={() => openView("amount")} last />
                </div>
              </div>

              <div style={{ display: "flex", gap: 9, flexShrink: 0, marginTop: 16 }}>
                <button
                  onClick={() => {
                    setDraft(emptyTransactionFilters());
                    setExactAmount("");
                    setMinAmount("");
                    setMaxAmount("");
                  }}
                  disabled={activeFilterCount(draft) === 0}
                  style={{
                    flex: "0 0 34%",
                    padding: "11px 8px",
                    borderRadius: 11,
                    border: `1px solid ${C.line}`,
                    background: C.bg,
                    color: C.neg,
                    fontSize: 13,
                    fontWeight: 650,
                    cursor: "pointer",
                    opacity: activeFilterCount(draft) === 0 ? 0.45 : 1,
                  }}
                >
                  {t("Clear")}
                </button>
                <button
                  onClick={() => {
                    onApply(cloneFilters(draft));
                    onClose();
                  }}
                  style={{
                    flex: 1,
                    padding: "11px 8px",
                    borderRadius: 11,
                    border: "none",
                    background: "var(--cta)",
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {tp("Show {n} transaction | Show {n} transactions", matchingCount)}
                </button>
              </div>
            </>
          )}

          {pickerConfig && (
            <>
              <SheetHeader title={pickerConfig.title} backLabel={t("Back")} onBack={() => setView("main")} />
              {pickerConfig.options.length > SEARCH_THRESHOLD && <PickerSearch value={pickerQuery} onChange={setPickerQuery} />}
              <div className="gs" style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
                {pickerConfig.options.filter((option) => matchesSearch(option.name, pickerQuery)).length === 0 ? (
                  <div style={{ textAlign: "center", color: C.mute, fontSize: 13, padding: "24px 0" }}>{t("No matches")}</div>
                ) : (
                  pickerConfig.options
                    .filter((option) => matchesSearch(option.name, pickerQuery))
                    .map((option) => {
                      const selected = draft[pickerConfig.key].has(option.id);
                      return (
                        <button
                          key={option.id}
                          onClick={() => toggleSet(pickerConfig.key, option.id)}
                          aria-pressed={selected}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            width: "100%",
                            padding: "11px 4px",
                            border: "none",
                            borderBottom: `1px solid ${C.line}`,
                            background: "none",
                            color: C.text,
                            fontFamily: font,
                            fontSize: 13.5,
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <span
                            style={{
                              width: 21,
                              height: 21,
                              borderRadius: 6,
                              border: `1.5px solid ${selected ? TEAL : C.line}`,
                              background: selected ? TEAL : C.surface,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            {selected && <Ico d="M5 13l4 4L19 7" size={13} color="#fff" sw={2.5} />}
                          </span>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <HighlightedText text={option.name} query={pickerQuery} />
                          </span>
                        </button>
                      );
                    })
                )}
              </div>
              <button
                onClick={() => setView("main")}
                style={{
                  flexShrink: 0,
                  marginTop: 16,
                  width: "100%",
                  padding: "11px 0",
                  borderRadius: 11,
                  border: "none",
                  background: "var(--cta)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {t("Done")}
              </button>
            </>
          )}

          {view === "amount" && (
            <>
              <SheetHeader title={t("Amount")} backLabel={t("Back")} onBack={() => setView("main")} />
              <div className="gs" style={{ flex: 1, overflowY: "auto" }}>
                <div style={{ display: "flex", padding: 3, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 11, marginBottom: 18 }}>
                  {(["exact", "range"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setAmountMode(mode)}
                      style={{
                        flex: 1,
                        padding: "8px 6px",
                        borderRadius: 8,
                        border: "none",
                        background: amountMode === mode ? TEAL : "transparent",
                        color: amountMode === mode ? "#fff" : C.soft,
                        fontSize: 12.5,
                        fontWeight: 650,
                        cursor: "pointer",
                      }}
                    >
                      {mode === "exact" ? t("Exactly") : t("Range")}
                    </button>
                  ))}
                </div>

                {amountMode === "exact" ? (
                  <AmountInput label={t("Amount")} value={exactAmount} onChange={setExactAmount} />
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <AmountInput label={t("From")} value={minAmount} onChange={setMinAmount} />
                    <AmountInput label={t("To")} value={maxAmount} onChange={setMaxAmount} />
                  </div>
                )}
                {amountInvalid && <div style={{ color: C.neg, fontSize: 11.5, marginTop: 9 }}>{t("Enter a valid amount")}</div>}
              </div>
              <button
                onClick={saveAmount}
                disabled={amountInvalid}
                style={{
                  flexShrink: 0,
                  marginTop: 16,
                  width: "100%",
                  padding: "11px 0",
                  borderRadius: 11,
                  border: "none",
                  background: "var(--cta)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: amountInvalid ? "default" : "pointer",
                  opacity: amountInvalid ? 0.45 : 1,
                }}
              >
                {t("Done")}
              </button>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

function FilterRow({ label, value, onClick, last = false }: { label: string; value: string; onClick: () => void; last?: boolean }) {
  const C = useThemeForFilterHelpers();
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "12px 13px",
        border: "none",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        background: "none",
        fontFamily: font,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: C.text }}>{label}</span>
      <span style={{ maxWidth: "48%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: C.soft }}>{value}</span>
      <Ico d="M9 5l7 7-7 7" size={13} color={C.mute} sw={2} />
    </button>
  );
}

function SheetHeader({ title, backLabel, onBack }: { title: string; backLabel: string; onBack: () => void }) {
  const C = useThemeForFilterHelpers();
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginBottom: 14 }}>
      <button
        onClick={onBack}
        aria-label={backLabel}
        style={{ position: "absolute", left: 0, display: "flex", padding: 4, border: "none", background: "none", cursor: "pointer" }}
      >
        <Ico d="M15 19l-7-7 7-7" size={17} color={C.mute} sw={2} />
      </button>
      <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{title}</div>
    </div>
  );
}

function AmountInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const C = useThemeForFilterHelpers();
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", color: C.soft, fontSize: 11.5, marginBottom: 6 }}>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        placeholder="0,00"
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "11px 12px",
          borderRadius: 10,
          border: `1px solid ${C.line}`,
          background: C.bg,
          color: C.text,
          fontFamily: font,
          fontSize: 15,
        }}
      />
    </label>
  );
}
