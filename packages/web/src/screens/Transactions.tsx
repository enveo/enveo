import type { Transaction } from "@enveo/shared";
import { useMemo, useState } from "react";
import { Header } from "../components/chrome";
import { CardBox, SectionEyebrow, useBand } from "../components/kit";
import type { StateResponse } from "../lib/api";
import { useMask, useTheme } from "../lib/contexts";
import { dayHeading } from "../lib/dates";
import { INPUT_FOCUS_CLASS } from "../lib/focusPresentation";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { useWideHost } from "../lib/shellContext";
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
  selectedTxnId,
  onSelectTxn,
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
  /** Design parity wave C task 3 (owner rule 2): on wide, a row click SELECTS the txn panel's
   *  content instead of opening the editor — `null`/absent on phone (`inWide` below gates the
   *  actual fork), matching the `AccountsScreen`/`BudgetScreen` `selected*Id` precedent. An
   *  explicit pick from App's `txnView`; `undefined`/`null` here means "nothing explicitly
   *  selected" and this component falls back to its OWN first FILTERED row (`txns[0]` below) —
   *  the one place that can, since App's own fallback table is deliberately unfiltered
   *  (panel.ts's own comment). */
  selectedTxnId?: string | null;
  onSelectTxn?: (id: string) => void;
}) {
  const C = useTheme();
  const { band, hc } = useBand();
  const M = useMask();
  const { t, tp, lang } = useT();
  const inWide = useWideHost() !== null;
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

  // Design parity wave C task 3 (txn gap 9): the row the panel is showing — an explicit pick, else
  // THIS list's own first entry (the never-empty fallback, computed here rather than trusted from
  // App since only this component owns the filtered/ordered `txns` the panel must agree with).
  // `null` off wide (`selectedTxnId`/`onSelectTxn` are never wired there) so phone never highlights
  // a row it has no panel to show it in.
  const effectiveSelectedId = inWide ? (selectedTxnId ?? txns[0]?.id ?? null) : null;

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
          {!inWide && <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onBand={band} />}
          {!inWide && (
            <div
              className={INPUT_FOCUS_CLASS}
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
          )}
          {!inWide && (
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
          )}
        </div>

        {/* Design parity wave C task 4 (txn gaps 4-7, v3:296-308): search + Filters merge into ONE
            bordered card — a SIBLING of the `data-band` wrapper above, not a child of it. Duet's
            `band` is a per-SCREEN theme flag, not a per-viewport one — it stays true on wide too —
            so nesting this inside that wrapper let its `C.headerBg` navy show through underneath
            the (transparent) count/Balance row below the card, with plain `C.soft`/`C.pos`/`C.neg`
            text sized for the CREAM Duet surface sitting on that navy instead (caught live on a
            Duet-light throwaway probe, not eyeballed from the design, which has no band concept at
            all). Plain `C.card`/`C.line` tokens throughout — not the phone `hc()` on-band variants
            above — matching the `TxnPanel`/`EnvelopePanel` (C2/C3) precedent that wide content
            ignores `hc()` entirely. `alignItems: "stretch"` (v3:296) is load-bearing, not
            decorative: it is what gives the borderless Filters button the search half's own ~32px
            height for free, clearing the house's 30px touch floor without a manual override (see
            7a73272's minHeight fix for the alternative). */}
        {inWide && (
          <>
            <div
              className={INPUT_FOCUS_CLASS}
              style={{
                display: "flex",
                alignItems: "stretch",
                margin: `2px ${P}px 0`,
                background: C.card,
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                boxShadow: "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 9, flex: 1, minWidth: 0, padding: "8px 12px" }}>
                <Ico d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" size={13} color={C.mute} sw={1.8} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  // Wide gets its OWN placeholder key (v3:299) rather than reusing phone's
                  // "Search..." — the two texts differ, and sharing the key would orphan
                  // whichever wording lost, since editing a message's English text is what
                  // changes its i18n key.
                  placeholder={t("Search transactions…")}
                  style={{ flex: 1, minWidth: 0, background: "none", border: "none", fontSize: 14, color: C.text, fontFamily: font }}
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label={t("Clear search")}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
                  >
                    <Ico d="M6 6l12 12M18 6L6 18" size={13} color={C.mute} sw={2} />
                  </button>
                )}
              </div>
              <div style={{ width: 1, background: C.line, flexShrink: 0 }} />
              {/* The caret flips with the sheet's own open state until C5 replaces the modal sheet
                  with an inline panel (v3:4310's `filtersOpen`-driven caret) — same `pickFilter`
                  boolean the sheet below already reads. */}
              <button
                onClick={() => setPickFilter((v) => !v)}
                aria-expanded={pickFilter}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  flexShrink: 0,
                  padding: "6px 13px 8px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: font,
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 650, color: pickFilter || filterCount > 0 ? TEAL : C.soft }}>{t("Filters")}</span>
                {filterCount > 0 && (
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxSizing: "border-box",
                      minWidth: 17,
                      height: 17,
                      padding: "0 5px",
                      borderRadius: 999,
                      background: TEAL,
                      color: "#fff",
                      fontSize: 10.5,
                      fontWeight: 750,
                    }}
                  >
                    {filterCount}
                  </span>
                )}
                <span style={{ fontSize: 10, color: pickFilter || filterCount > 0 ? TEAL : C.soft }}>{pickFilter ? "▴" : "▾"}</span>
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: `8px ${P}px 6px`, fontSize: 11, color: C.soft }}>
              <span>
                {tp("{shown} of {total} transactions | {shown} of {total} transactions", txns.length, {
                  shown: txns.length,
                  total: state.transactions.length,
                })}
              </span>
              <span>
                {t("Balance:")}{" "}
                <b style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: balance < 0 ? C.neg : balance > 0 ? C.pos : C.text }}>
                  {balance < 0 ? "-" : balance > 0 ? "+" : ""}
                  {M(Math.abs(balance))}
                </b>
              </span>
            </div>
          </>
        )}

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

        {groups.map((group) => {
          // Design parity wave C task 4 (txn gap 10, v3:2556-2563): per-day ↑in/↓out, wide only —
          // computed from `group.items` with the SAME income-or-refund/expense split as the
          // `balance` reduce above (not the design's own simplified `t.type === "income"`/`!t.type`,
          // which has no `isRefund` concept in its synthetic data model — real code wins on
          // mechanics). Left at 0/0 on phone (never read there), which also makes `right` below
          // `undefined` for free.
          let inSum = 0;
          let outSum = 0;
          if (inWide) {
            for (const tx of group.items) {
              if (tx.type === "transfer") continue;
              if (tx.type === "income" || tx.isRefund) inSum += tx.amount;
              else outSum += tx.amount;
            }
          }
          return (
            <div key={group.date}>
              <SectionEyebrow
                label={dayHeading(group.date, lang, t)}
                right={
                  inSum > 0 || outSum > 0 ? (
                    // Overrides SectionEyebrow's own 11px/600 default (v3:373-379 has neither on
                    // this wrapper) — the design's own `T.pos`/`T.neg` split only colors the two
                    // inner spans, so the container's weight/size need an explicit reset here.
                    <span style={{ fontSize: 10.5, fontWeight: 400 }}>
                      {inSum > 0 && <span style={{ color: C.pos }}>{`↑ ${M(inSum)}`}</span>}
                      {inSum > 0 && outSum > 0 && "  "}
                      {outSum > 0 && <span style={{ color: C.neg }}>{`↓ ${M(outSum)}`}</span>}
                    </span>
                  ) : undefined
                }
              />
              {/* Design parity wave C task 3 (gap 9): `overflow:hidden` clips a selected edge row's
                edge-to-edge `selBg` bleed to the card's own 14px radius — the exact Budget.tsx
                fix (design parity wave C task 1) applied to this list too. */}
              <CardBox style={{ marginBottom: 8, padding: "2px 12px", overflow: "hidden" }}>
                {group.items.map((tx, i) => {
                  const col = colorOf(tx);
                  const s = signed(tx);
                  const acc = accById.get(tx.accountId);
                  // Design parity wave C task 3 (owner rule 1's list/panel sync, txn gap 9): the
                  // SAME id `effectiveSelectedId` above resolves to — never a second "what's open"
                  // check (owner rule 3), and always `false` off wide (`effectiveSelectedId` is
                  // `null` there).
                  const selected = effectiveSelectedId === tx.id;
                  return (
                    <div
                      key={tx.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => (inWide ? onSelectTxn?.(tx.id) : onEditTxn(tx))}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (inWide) onSelectTxn?.(tx.id);
                          else onEditTxn(tx);
                        }
                      }}
                      className="fu"
                      style={{
                        animationDelay: `${i * 20}ms`,
                        display: "flex",
                        alignItems: "center",
                        // Edge-to-edge selection bleed (Budget.tsx's identical technique, design
                        // parity wave C task 1): row padding matches the CardBox's own 12px
                        // horizontal padding, and the equal-and-opposite negative margin lets the
                        // row's background reach the card's edges while leaving the CONTENT at the
                        // same horizontal position as before — applied to every row, not just the
                        // selected one, so nothing shifts on select (and nothing moves on phone,
                        // where `selected` is always false).
                        padding: "6px 12px",
                        margin: "0 -12px",
                        boxSizing: "border-box",
                        gap: 10,
                        cursor: "pointer",
                        width: "100%",
                        background: selected ? C.selBg : "transparent",
                        border: "none",
                        borderBottom: i === group.items.length - 1 || selected ? "none" : `1px solid ${C.line}`,
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
                            color: selected ? "var(--accent)" : C.text,
                            fontSize: 13.5,
                            fontWeight: selected ? 650 : 550,
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
                      {/* Wide-only (v3:389's `openMark`, computed only when `paneOpen` — design's
                        wide-table context): gated on `inWide` like every other wide-only fork in
                        this file, so phone's flex `gap` never grows a 3rd gap it never had, which
                        would otherwise narrow the description column's ellipsis budget. */}
                      {inWide && (
                        <span style={{ fontSize: 12, color: "var(--accent)", flexShrink: 0 }} aria-hidden="true">
                          {selected ? "▸" : ""}
                        </span>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25, fontVariantNumeric: "tabular-nums", color: s.color }}>
                            {s.text}
                          </span>
                        </div>
                        {tx.type !== "transfer" && acc && <div style={{ color: C.mute, fontSize: 9.5, lineHeight: 1.25, marginTop: 1 }}>{acc.name}</div>}
                      </div>
                    </div>
                  );
                })}
              </CardBox>
            </div>
          );
        })}
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
