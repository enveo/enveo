import { useEffect, useMemo, useState } from "react";
import type { Transaction } from "@enveo/shared";
import type { StateResponse } from "../lib/api";
import { Header, Sheet } from "../components/chrome";
import type { ScreenId } from "../components/chrome";
import { SectionEyebrow, CardBox, HighlightedText, PickerSearch, useBand } from "../components/kit";
import { useMask, useTheme } from "../lib/contexts";
import { dayHeading } from "../lib/dates";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { matchesSearch, SEARCH_THRESHOLD } from "../lib/search";
import { P, TRANSFER, TEAL, tint, font } from "../lib/theme";

export function TransactionsScreen({
  state,
  month,
  onMenu,
  onPrev,
  onNext,
  onEditTxn,
  query,
  setQuery,
  envFilter,
  setEnvFilter,
  accFilter,
  setAccFilter,
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
  envFilter: ReadonlySet<string>;
  setEnvFilter: (s: ReadonlySet<string>) => void;
  accFilter: ReadonlySet<string>;
  setAccFilter: (s: ReadonlySet<string>) => void;
}) {
  const C = useTheme();
  const { band, hc } = useBand();
  const M = useMask();
  const { t, tp, lang } = useT();
  const [pickFilter, setPickFilter] = useState(false);
  // One search box filters both the envelope AND account grids below — a single "koperty/konta"
  // sheet reads more naturally with one search than a duplicated box per section.
  const [pickQ, setPickQ] = useState("");
  useEffect(() => {
    if (pickFilter) setPickQ("");
  }, [pickFilter]);

  const envById = useMemo(() => new Map(state.envelopes.map((e) => [e.id, e])), [state.envelopes]);
  const accById = useMemo(() => new Map(state.accounts.map((a) => [a.id, a])), [state.accounts]);
  const catById = useMemo(() => new Map(state.categories.map((c) => [c.id, c])), [state.categories]);
  const envelopes = state.envelopes.filter((e) => !e.archived).sort((a, b) => a.sort - b.sort);
  // accounts for the picker: active + any archived ones already in the filter
  const accounts = state.accounts.filter((a) => !a.archived || accFilter.has(a.id)).sort((a, b) => a.sort - b.sort);

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
    if (tx.categoryId && catById.get(tx.categoryId)) parts.push(catById.get(tx.categoryId)!.name);
    const env = tx.envelopeId ? envById.get(tx.envelopeId) : null;
    if (env) parts.push(env.name);
    if (tx.items.length) parts.push(tp("{n} item | {n} items", tx.items.length));
    return parts.join(" · ");
  };

  const q = query.trim().toLowerCase();
  const matchesEnv = (t: Transaction) =>
    envFilter.size === 0 || (!!t.envelopeId && envFilter.has(t.envelopeId)) || t.items.some((it) => envFilter.has(it.envelopeId));
  // source OR destination account (transfers visible from both sides)
  const matchesAcc = (t: Transaction) =>
    accFilter.size === 0 || accFilter.has(t.accountId) || (t.type === "transfer" && !!t.toAccountId && accFilter.has(t.toAccountId));
  const matchesQuery = (t: Transaction) => !q || `${descOf(t)} ${subOf(t)} ${accById.get(t.accountId)?.name ?? ""}`.toLowerCase().includes(q);
  const txns = state.transactions.filter((t) => matchesEnv(t) && matchesAcc(t) && matchesQuery(t));

  // grouping by date (descending order preserved)
  const groups: Array<{ date: string; items: Transaction[] }> = [];
  for (const t of txns) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }

  // balance of the visible (filtered) transactions — like the bar in the original
  const balance = txns.reduce((s, t) => (t.type === "transfer" ? s : s + (t.type === "income" || t.isRefund ? t.amount : -t.amount)), 0);
  const activeEnvs = envelopes.filter((e) => envFilter.has(e.id));
  const activeAccs = accounts.filter((a) => accFilter.has(a.id));
  const toggleEnv = (id: string) => {
    const next = new Set(envFilter);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEnvFilter(next);
  };
  const toggleAcc = (id: string) => {
    const next = new Set(accFilter);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setAccFilter(next);
  };
  const clearFilters = () => {
    setEnvFilter(new Set());
    setAccFilter(new Set());
  };

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
              style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
            >
              <Ico
                d="M4 4h16l-6.3 7.4V19l-3.4-2v-5.6L4 4zM17.5 14.5v6M14.5 17.5h6"
                size={18}
                color={envFilter.size || accFilter.size ? hc("var(--cta)", TEAL) : hc(C.headerMute, C.mute)}
                sw={1.8}
              />
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

        {(activeEnvs.length > 0 || activeAccs.length > 0) && (
          <div className="gs" style={{ display: "flex", alignItems: "center", gap: 7, padding: `0 ${P}px 8px`, overflowX: "auto" }}>
            <span style={{ fontSize: 13.5, color: C.text, flexShrink: 0 }}>{t("Filter:")}</span>
            {activeEnvs.map((e) => (
              <button
                key={e.id}
                onClick={() => toggleEnv(e.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 11px 5px 6px",
                  borderRadius: 18,
                  border: "none",
                  background: C.surface,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 7,
                    background: tint(e.color, 0.16),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Glyph name={e.icon} size={13} color={e.color} sw={1.7} />
                </span>
                <span style={{ fontSize: 13.5, color: C.text }}>{e.name}</span>
                <Ico d="M6 6l12 12M18 6L6 18" size={13} color={C.soft} sw={2} />
              </button>
            ))}
            {activeAccs.map((a) => (
              <button
                key={a.id}
                onClick={() => toggleAcc(a.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 11px 5px 6px",
                  borderRadius: 18,
                  border: "none",
                  background: C.surface,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: tint(a.color, 0.16),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Glyph name={a.icon} size={12} color={a.color} sw={1.7} />
                </span>
                <span style={{ fontSize: 13.5, color: C.text }}>{a.name}</span>
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

      <Sheet show={pickFilter} onClose={() => setPickFilter(false)} tall={envelopes.length + accounts.length > SEARCH_THRESHOLD}>
        {(C) => {
          const filteredEnvs = envelopes.filter((e) => matchesSearch(e.name, pickQ));
          const filteredAccs = accounts.filter((a) => matchesSearch(a.name, pickQ));
          return (
            <>
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 4 }}>{t("Filter")}</div>
                <div style={{ fontSize: 12, color: C.mute, textAlign: "center", marginBottom: 14 }}>{t("Show only selected envelopes and accounts")}</div>

                {envelopes.length + accounts.length > SEARCH_THRESHOLD && <PickerSearch value={pickQ} onChange={setPickQ} />}
              </div>

              <div className="gs" style={{ flex: 1, overflowY: "auto", overscrollBehavior: "contain" }}>
                {filteredEnvs.length === 0 && filteredAccs.length === 0 ? (
                  <div style={{ textAlign: "center", color: C.mute, fontSize: 13, padding: "24px 0" }}>{t("No matches")}</div>
                ) : (
                  <>
                    {filteredEnvs.length > 0 && (
                      <>
                        <div style={{ fontSize: 10.5, fontWeight: 600, color: C.soft, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                          {t("Envelopes")}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          {filteredEnvs.map((e) => {
                            const on = envFilter.has(e.id);
                            return (
                              <button
                                key={e.id}
                                onClick={() => toggleEnv(e.id)}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  padding: "8px 10px",
                                  borderRadius: 11,
                                  border: `1.5px solid ${on ? TEAL : C.line}`,
                                  background: on ? "var(--accent-14)" : C.surface,
                                  cursor: "pointer",
                                }}
                              >
                                <span
                                  style={{
                                    width: 26,
                                    height: 26,
                                    borderRadius: 7,
                                    background: tint(e.color, 0.16),
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                  }}
                                >
                                  <Glyph name={e.icon} size={13} color={e.color} sw={1.7} />
                                </span>
                                <span
                                  style={{
                                    fontSize: 13,
                                    color: C.text,
                                    flex: 1,
                                    textAlign: "left",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  <HighlightedText text={e.name} query={pickQ} />
                                </span>
                                {on && <Ico d="M5 13l4 4L19 7" size={14} color={TEAL} sw={2.4} />}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {filteredAccs.length > 0 && (
                      <>
                        <div style={{ fontSize: 10.5, fontWeight: 600, color: C.soft, textTransform: "uppercase", letterSpacing: 0.6, margin: "16px 0 8px" }}>
                          {t("Accounts")}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          {filteredAccs.map((a) => {
                            const on = accFilter.has(a.id);
                            return (
                              <button
                                key={a.id}
                                onClick={() => toggleAcc(a.id)}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  padding: "8px 10px",
                                  borderRadius: 11,
                                  border: `1.5px solid ${on ? TEAL : C.line}`,
                                  background: on ? "var(--accent-14)" : C.surface,
                                  cursor: "pointer",
                                }}
                              >
                                <span
                                  style={{
                                    width: 26,
                                    height: 26,
                                    borderRadius: "50%",
                                    background: tint(a.color, 0.16),
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                  }}
                                >
                                  <Glyph name={a.icon} size={13} color={a.color} sw={1.7} />
                                </span>
                                <span
                                  style={{
                                    fontSize: 13,
                                    color: C.text,
                                    flex: 1,
                                    textAlign: "left",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  <HighlightedText text={a.name} query={pickQ} />
                                </span>
                                {on && <Ico d="M5 13l4 4L19 7" size={14} color={TEAL} sw={2.4} />}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              {(envFilter.size > 0 || accFilter.size > 0) && (
                <button
                  onClick={clearFilters}
                  style={{
                    flexShrink: 0,
                    marginTop: 16,
                    width: "100%",
                    padding: "11px 0",
                    borderRadius: 11,
                    border: `1px solid ${C.line}`,
                    background: C.bg,
                    color: C.neg,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {t("Clear filters")}
                </button>
              )}
            </>
          );
        }}
      </Sheet>
    </div>
  );
}
