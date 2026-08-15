import type { Transaction } from "@enveo/shared";
import { useMemo, useState } from "react";
import { Header } from "../components/chrome";
import { CardBox, SectionEyebrow, useBand } from "../components/kit";
import type { StateResponse } from "../lib/api";
import { useMask, useTheme } from "../lib/contexts";
import { dayHeading } from "../lib/dates";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { font, P, TEAL, TRANSFER, tint } from "../lib/theme";
import {
  createTransactionSearchIndex,
  matchesTransactionFilters,
  matchesTransactionQuery,
  type TransactionFilters,
  transactionFilterReferences,
} from "../lib/transactionSearch";
import { activeFilterCount, TransactionFilterSheet } from "./transactions/TransactionFilterSheet";

export function TransactionsScreen({
  state,
  month,
  onMenu,
  onPrev,
  onNext,
  onEditTxn,
  query,
  setQuery,
  filters,
  setFilters,
}: {
  state: StateResponse;
  month: string;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onEditTxn: (t: Transaction) => void;
  // filters kept in App — they survive entering an edit and returning
  query: string;
  setQuery: (q: string) => void;
  filters: TransactionFilters;
  setFilters: (filters: TransactionFilters) => void;
}) {
  const C = useTheme();
  const { band, hc } = useBand();
  const M = useMask();
  const { t, tp, lang } = useT();
  const [pickFilter, setPickFilter] = useState(false);

  const envById = useMemo(() => new Map(state.envelopes.map((e) => [e.id, e])), [state.envelopes]);
  const accById = useMemo(() => new Map(state.accounts.map((a) => [a.id, a])), [state.accounts]);
  const catById = useMemo(() => new Map(state.categories.map((c) => [c.id, c])), [state.categories]);
  const placeById = useMemo(() => new Map(state.places.map((p) => [p.id, p])), [state.places]);
  const filterReferences = useMemo(() => transactionFilterReferences(state.transactions), [state.transactions]);
  const envelopes = state.envelopes
    .filter((e) => !e.archived || filters.envelopeIds.has(e.id) || filterReferences.envelopeIds.has(e.id))
    .sort((a, b) => a.sort - b.sort);
  // Historical entities referenced by this month remain available for an explicit filter.
  const accounts = state.accounts
    .filter((a) => !a.archived || filters.accountIds.has(a.id) || filterReferences.accountIds.has(a.id))
    .sort((a, b) => a.sort - b.sort);
  const categories = [...state.categories].sort((a, b) => a.name.localeCompare(b.name));
  const places = [...state.places].sort((a, b) => a.name.localeCompare(b.name));
  const searchIndex = useMemo(
    () => createTransactionSearchIndex({ accounts: state.accounts, envelopes: state.envelopes, categories: state.categories, places: state.places }),
    [state.accounts, state.categories, state.envelopes, state.places],
  );

  const colorOf = (t: Transaction): string => {
    if (t.type === "transfer") return TRANSFER;
    if (t.type === "income") return C.pos;
    const env = t.envelopeId ? envById.get(t.envelopeId) : t.items[0] ? envById.get(t.items[0].envelopeId) : null;
    return env?.color ?? C.mute;
  };
  const signed = (tx: Transaction): { text: string; color: string } => {
    if (tx.type === "transfer") return { text: M(tx.amount), color: TRANSFER };
    if (tx.type === "income" || tx.isRefund) return { text: `+${M(tx.amount)}`, color: C.pos };
    return { text: `-${M(tx.amount)}`, color: C.text };
  };
  const descOf = (tx: Transaction): string => {
    if (tx.type === "transfer") {
      const from = accById.get(tx.accountId)?.name ?? "?";
      const to = tx.toAccountId ? (accById.get(tx.toAccountId)?.name ?? "?") : "?";
      return `${from} → ${to}`;
    }
    const env = tx.envelopeId ? envById.get(tx.envelopeId) : null;
    return tx.name || tx.note || env?.name || (tx.items.length ? t("Split transaction") : t("Transaction"));
  };
  const subOf = (tx: Transaction): string => {
    if (tx.type === "transfer") return t("Transfer");
    const parts: string[] = [];
    if (tx.placeId && placeById.get(tx.placeId)) parts.push(placeById.get(tx.placeId)!.name);
    if (tx.categoryId && catById.get(tx.categoryId)) parts.push(catById.get(tx.categoryId)!.name);
    const env = tx.envelopeId ? envById.get(tx.envelopeId) : null;
    if (env) parts.push(env.name);
    if (tx.items.length) parts.push(tp("{n} item | {n} items", tx.items.length));
    return parts.join(" · ");
  };

  const txns = state.transactions.filter(
    (transaction) => matchesTransactionQuery(transaction, query, searchIndex) && matchesTransactionFilters(transaction, filters),
  );

  // grouping by date (descending order preserved)
  const groups: Array<{ date: string; items: Transaction[] }> = [];
  for (const t of txns) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }

  // balance of the visible (filtered) transactions — like the bar in the original
  const balance = txns.reduce((s, t) => (t.type === "transfer" ? s : s + (t.type === "income" || t.isRefund ? t.amount : -t.amount)), 0);
  const selectedSummary = (selected: ReadonlySet<string>, options: ReadonlyArray<{ id: string; name: string }>): string => {
    const picked = options.filter((option) => selected.has(option.id));
    return picked.length > 1 ? `${picked[0]?.name ?? ""} +${picked.length - 1}` : (picked[0]?.name ?? "");
  };
  const clearDimension = (key: "accountIds" | "envelopeIds" | "placeIds" | "categoryIds" | "kinds" | "amount") => {
    setFilters({ ...filters, [key]: key === "amount" ? null : new Set() });
  };
  const filterChips: Array<{ key: string; label: string; value: string; onRemove: () => void }> = [];
  if (filters.placeIds.size)
    filterChips.push({ key: "places", label: t("Place"), value: selectedSummary(filters.placeIds, places), onRemove: () => clearDimension("placeIds") });
  if (filters.categoryIds.size)
    filterChips.push({
      key: "categories",
      label: t("Category"),
      value: selectedSummary(filters.categoryIds, categories),
      onRemove: () => clearDimension("categoryIds"),
    });
  if (filters.envelopeIds.size)
    filterChips.push({
      key: "envelopes",
      label: t("Envelope"),
      value: selectedSummary(filters.envelopeIds, envelopes),
      onRemove: () => clearDimension("envelopeIds"),
    });
  if (filters.accountIds.size)
    filterChips.push({
      key: "accounts",
      label: t("Account"),
      value: selectedSummary(filters.accountIds, accounts),
      onRemove: () => clearDimension("accountIds"),
    });
  if (filters.kinds.size) {
    const kindLabels = new Map([
      ["expense", t("Expense")],
      ["income", t("Income")],
      ["refund", t("Refund")],
      ["transfer", t("Transfer")],
    ]);
    const values = [...filters.kinds].map((kind) => kindLabels.get(kind) ?? kind);
    filterChips.push({
      key: "kinds",
      label: t("Type"),
      value: values.length > 1 ? `${values[0]} +${values.length - 1}` : (values[0] ?? ""),
      onRemove: () => clearDimension("kinds"),
    });
  }
  if (filters.amount) {
    const value =
      filters.amount.mode === "exact"
        ? M(filters.amount.minor)
        : `${filters.amount.minMinor === null ? "…" : M(filters.amount.minMinor)} – ${filters.amount.maxMinor === null ? "…" : M(filters.amount.maxMinor)}`;
    filterChips.push({ key: "amount", label: t("Amount"), value, onRemove: () => clearDimension("amount") });
  }
  const filterCount = activeFilterCount(filters);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
        <div data-band={band || undefined} style={band ? { background: C.headerBg, paddingBottom: 4 } : undefined}>
          <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onBand={band} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: `2px ${P}px 6px`,
              padding: "8px 12px",
              background: hc(tint(C.headerInk, 0.13), C.card),
              borderRadius: 12,
              boxShadow: band ? "none" : "0 1px 2px rgba(20,20,28,0.05)",
            }}
          >
            <Ico d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" size={17} color={hc(C.headerMute, C.mute)} sw={1.8} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search...")}
              style={{ flex: 1, minWidth: 0, background: "none", border: "none", fontSize: 14.5, color: hc(C.headerInk, C.text), fontFamily: font }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label={t("Clear search")}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
              >
                <Ico d="M6 6l12 12M18 6L6 18" size={14} color={hc(C.headerMute, C.mute)} sw={2} />
              </button>
            )}
            <button
              onClick={() => setPickFilter(true)}
              aria-label={t("Filter")}
              style={{ position: "relative", background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
            >
              <Ico
                d="M4 4h16l-6.3 7.4V19l-3.4-2v-5.6L4 4zM17.5 14.5v6M14.5 17.5h6"
                size={18}
                color={filterCount ? hc("var(--cta)", TEAL) : hc(C.headerMute, C.mute)}
                sw={1.8}
              />
              {filterCount > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -7,
                    minWidth: 15,
                    height: 15,
                    padding: "0 3px",
                    borderRadius: 8,
                    boxSizing: "border-box",
                    background: "var(--cta)",
                    color: "#fff",
                    fontSize: 9,
                    fontWeight: 800,
                    lineHeight: "15px",
                    textAlign: "center",
                  }}
                >
                  {filterCount}
                </span>
              )}
            </button>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "baseline",
              gap: 6,
              padding: `0 ${P + 4}px 8px`,
              fontSize: 11,
              color: hc(C.headerMute, C.soft),
            }}
          >
            {t("Balance:")}
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: balance < 0 ? hc(C.headerNeg, C.neg) : balance > 0 ? hc(C.headerPos, C.pos) : hc(C.headerInk, C.text),
              }}
            >
              {balance < 0 ? "-" : balance > 0 ? "+" : ""}
              {M(Math.abs(balance))}
            </span>
          </div>
        </div>

        {filterChips.length > 0 && (
          <div className="gs" style={{ display: "flex", alignItems: "center", gap: 7, padding: `0 ${P}px 8px`, overflowX: "auto" }}>
            <span style={{ fontSize: 13.5, color: C.text, flexShrink: 0 }}>{t("Filter:")}</span>
            {filterChips.map((chip) => (
              <button
                key={chip.key}
                onClick={chip.onRemove}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "6px 9px",
                  borderRadius: 18,
                  border: "none",
                  background: C.surface,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 12, color: C.soft }}>{chip.label}:</span>
                <span style={{ fontSize: 12.5, color: C.text, fontWeight: 650 }}>{chip.value}</span>
                <Ico d="M6 6l12 12M18 6L6 18" size={13} color={C.soft} sw={2} />
              </button>
            ))}
          </div>
        )}

        {groups.length === 0 && <div style={{ textAlign: "center", color: C.mute, fontSize: 13.5, padding: "56px 0" }}>{t("No transactions.")}</div>}

        {groups.map((group) => (
          <div key={group.date}>
            <SectionEyebrow label={dayHeading(group.date, lang, t)} />
            <CardBox style={{ marginBottom: 8, padding: "2px 12px" }}>
              {group.items.map((tx, i) => {
                const col = colorOf(tx);
                const s = signed(tx);
                const acc = accById.get(tx.accountId);
                return (
                  <div
                    key={tx.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onEditTxn(tx)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onEditTxn(tx);
                      }
                    }}
                    className="fu"
                    style={{
                      animationDelay: `${i * 20}ms`,
                      display: "flex",
                      alignItems: "center",
                      padding: "6px 0",
                      gap: 10,
                      cursor: "pointer",
                      width: "100%",
                      background: "none",
                      border: "none",
                      borderBottom: i === group.items.length - 1 ? "none" : `1px solid ${C.line}`,
                      textAlign: "left",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        flexShrink: 0,
                        background: tint(col, 0.16),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {tx.type === "transfer" ? (
                        <Ico d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" size={14} color={col} sw={2} />
                      ) : (
                        <Glyph
                          name={tx.type === "income" ? "moneybag" : tx.envelopeId ? (envById.get(tx.envelopeId)?.icon ?? "tag") : "tag"}
                          size={14}
                          color={col}
                          sw={1.7}
                        />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          color: C.text,
                          fontSize: 13.5,
                          fontWeight: 550,
                          lineHeight: 1.25,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {descOf(tx)}
                      </div>
                      <div
                        style={{
                          color: C.soft,
                          fontSize: 10.5,
                          lineHeight: 1.25,
                          marginTop: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {subOf(tx)}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25, fontVariantNumeric: "tabular-nums", color: s.color }}>{s.text}</span>
                      </div>
                      {tx.type !== "transfer" && acc && <div style={{ color: C.mute, fontSize: 9.5, lineHeight: 1.25, marginTop: 1 }}>{acc.name}</div>}
                    </div>
                  </div>
                );
              })}
            </CardBox>
          </div>
        ))}
      </div>

      <TransactionFilterSheet
        show={pickFilter}
        onClose={() => setPickFilter(false)}
        filters={filters}
        onApply={setFilters}
        transactions={state.transactions}
        query={query}
        searchIndex={searchIndex}
        accounts={accounts}
        envelopes={envelopes}
        categories={categories}
        places={places}
        formatMoney={M}
      />
    </div>
  );
}
