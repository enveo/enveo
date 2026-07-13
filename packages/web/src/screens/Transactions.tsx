import { useMemo, useState } from "react";
import type { Transaction } from "@enveo/shared";
import type { StateResponse } from "../lib/api";
import { Header, Sheet } from "../components/chrome";
import type { ScreenId } from "../components/chrome";
import { useMask, useTheme } from "../lib/contexts";
import { isLight } from "../lib/format";
import { dayHeading } from "../lib/dates";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { CORAL, INCOME, P, SAGE_BG, TRANSFER, TEAL, font } from "../lib/theme";

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
  const M = useMask();
  const { t, tp, lang } = useT();
  const [pickFilter, setPickFilter] = useState(false);

  const envById = useMemo(() => new Map(state.envelopes.map((e) => [e.id, e])), [state.envelopes]);
  const accById = useMemo(() => new Map(state.accounts.map((a) => [a.id, a])), [state.accounts]);
  const catById = useMemo(() => new Map(state.categories.map((c) => [c.id, c])), [state.categories]);
  const envelopes = state.envelopes.filter((e) => !e.archived).sort((a, b) => a.sort - b.sort);
  // accounts for the picker: active + any archived ones already in the filter
  const accounts = state.accounts.filter((a) => !a.archived || accFilter.has(a.id)).sort((a, b) => a.sort - b.sort);

  const colorOf = (t: Transaction): string => {
    if (t.type === "transfer") return TRANSFER;
    if (t.type === "income") return SAGE_BG;
    const env = t.envelopeId ? envById.get(t.envelopeId) : t.items[0] ? envById.get(t.items[0].envelopeId) : null;
    return env?.color ?? CORAL;
  };
  const signed = (tx: Transaction): { text: string; color: string } => {
    if (tx.type === "transfer") return { text: M(tx.amount), color: TRANSFER };
    if (tx.type === "income" || tx.isRefund) return { text: `+${M(tx.amount)}`, color: INCOME };
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
  const matchesQuery = (t: Transaction) =>
    !q || `${descOf(t)} ${subOf(t)} ${accById.get(t.accountId)?.name ?? ""}`.toLowerCase().includes(q);
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
  const clearFilters = () => { setEnvFilter(new Set()); setAccFilter(new Set()); };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
        <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} />

        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: `2px ${P}px 8px`, padding: "8px 12px", background: C.inset, borderRadius: 20 }}>
          <Ico d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" size={17} color={C.mute} sw={1.8} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search...")}
            style={{ flex: 1, minWidth: 0, background: "none", border: "none", outline: "none", fontSize: 14.5, color: C.text, fontFamily: font }}
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label={t("Clear search")} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}>
              <Ico d="M6 6l12 12M18 6L6 18" size={14} color={C.mute} sw={2} />
            </button>
          )}
          <button onClick={() => setPickFilter(true)} aria-label={t("Filter")} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}>
            <Ico d="M4 4h16l-6.3 7.4V19l-3.4-2v-5.6L4 4zM17.5 14.5v6M14.5 17.5h6" size={18} color={envFilter.size || accFilter.size ? TEAL : C.mute} sw={1.8} />
          </button>
        </div>

        {(activeEnvs.length > 0 || activeAccs.length > 0) && (
          <div className="gs" style={{ display: "flex", alignItems: "center", gap: 7, padding: `0 ${P}px 8px`, overflowX: "auto" }}>
            <span style={{ fontSize: 13.5, color: C.text, flexShrink: 0 }}>{t("Filter:")}</span>
            {activeEnvs.map((e) => (
              <button key={e.id} onClick={() => toggleEnv(e.id)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 11px 5px 6px", borderRadius: 18, border: "none", background: C.surface, cursor: "pointer", whiteSpace: "nowrap", boxShadow: "0 1px 2px rgba(0,0,0,0.1)", flexShrink: 0 }}>
                <span style={{ width: 24, height: 24, borderRadius: 7, background: e.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Glyph name={e.icon} size={13} color={isLight(e.color) ? "#33312c" : "#fff"} sw={1.7} />
                </span>
                <span style={{ fontSize: 13.5, color: C.text }}>{e.name}</span>
                <Ico d="M6 6l12 12M18 6L6 18" size={13} color={C.soft} sw={2} />
              </button>
            ))}
            {activeAccs.map((a) => (
              <button key={a.id} onClick={() => toggleAcc(a.id)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 11px 5px 6px", borderRadius: 18, border: "none", background: C.surface, cursor: "pointer", whiteSpace: "nowrap", boxShadow: "0 1px 2px rgba(0,0,0,0.1)", flexShrink: 0 }}>
                <span style={{ width: 24, height: 24, borderRadius: "50%", background: a.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Glyph name={a.icon} size={12} color={isLight(a.color) ? "#33312c" : "#fff"} sw={1.7} />
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
            <div style={{ padding: `6px ${P}px 2px`, fontSize: 13, fontWeight: 500, color: C.soft }}>{dayHeading(group.date, lang, t)}</div>
            {group.items.map((t, i) => {
              const col = colorOf(t);
              const s = signed(t);
              const acc = accById.get(t.accountId);
              return (
                <button key={t.id} onClick={() => onEditTxn(t)} className="fu" style={{ animationDelay: `${i * 20}ms`, display: "flex", alignItems: "center", padding: `5px ${P}px`, gap: 10, cursor: "pointer", width: "100%", background: "none", border: "none", textAlign: "left" }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0, background: col, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {t.type === "transfer" ? (
                      <Ico d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" size={15} color="#fff" sw={2} />
                    ) : (
                      <Glyph name={t.type === "income" ? "moneybag" : t.envelopeId ? (envById.get(t.envelopeId)?.icon ?? "tag") : "tag"} size={15} color={isLight(col) ? "#5a5852" : "#fff"} sw={1.7} />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: C.text, fontSize: 14, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{descOf(t)}</div>
                    <div style={{ color: C.mute, fontSize: 11, lineHeight: 1.25, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subOf(t)}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25, fontVariantNumeric: "tabular-nums", color: s.color }}>{s.text}</span>
                      {t.confirmed ? <Ico d="M5 13l4 4L19 7" size={13} color={INCOME} sw={2.5} /> : <Ico d="M12 8v4l3 2M12 22a10 10 0 100-20 10 10 0 000 20z" size={13} color="#e0a020" sw={2} />}
                    </div>
                    {t.type !== "transfer" && acc && <div style={{ color: C.mute, fontSize: 10, lineHeight: 1.25, marginTop: 1 }}>{acc.name}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7, borderTop: `1px solid ${C.line}`, padding: `10px ${P}px`, background: C.bg, flexShrink: 0 }}>
        <span style={{ fontSize: 13.5, color: C.soft }}>{t("Balance:")}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: balance < 0 ? CORAL : balance > 0 ? INCOME : C.text, fontVariantNumeric: "tabular-nums" }}>
          {balance < 0 ? "-" : balance > 0 ? "+" : ""}{M(Math.abs(balance))}
        </span>
      </div>

      <Sheet show={pickFilter} onClose={() => setPickFilter(false)}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 4 }}>{t("Filter")}</div>
            <div style={{ fontSize: 12, color: C.mute, textAlign: "center", marginBottom: 14 }}>{t("Show only selected envelopes and accounts")}</div>

            <div style={{ fontSize: 10.5, fontWeight: 600, color: C.soft, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>{t("Envelopes")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {envelopes.map((e) => {
                const on = envFilter.has(e.id);
                return (
                  <button key={e.id} onClick={() => toggleEnv(e.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 11, border: `1.5px solid ${on ? TEAL : C.line}`, background: on ? "var(--accent-14)" : C.surface, cursor: "pointer" }}>
                    <span style={{ width: 26, height: 26, borderRadius: 7, background: e.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Glyph name={e.icon} size={13} color={isLight(e.color) ? "#33312c" : "#fff"} sw={1.7} />
                    </span>
                    <span style={{ fontSize: 13, color: C.text, flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                    {on && <Ico d="M5 13l4 4L19 7" size={14} color={TEAL} sw={2.4} />}
                  </button>
                );
              })}
            </div>

            <div style={{ fontSize: 10.5, fontWeight: 600, color: C.soft, textTransform: "uppercase", letterSpacing: 0.6, margin: "16px 0 8px" }}>{t("Accounts")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {accounts.map((a) => {
                const on = accFilter.has(a.id);
                return (
                  <button key={a.id} onClick={() => toggleAcc(a.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 11, border: `1.5px solid ${on ? TEAL : C.line}`, background: on ? "var(--accent-14)" : C.surface, cursor: "pointer" }}>
                    <span style={{ width: 26, height: 26, borderRadius: "50%", background: a.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Glyph name={a.icon} size={13} color={isLight(a.color) ? "#33312c" : "#fff"} sw={1.7} />
                    </span>
                    <span style={{ fontSize: 13, color: C.text, flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                    {on && <Ico d="M5 13l4 4L19 7" size={14} color={TEAL} sw={2.4} />}
                  </button>
                );
              })}
            </div>

            {(envFilter.size > 0 || accFilter.size > 0) && (
              <button onClick={clearFilters} style={{ marginTop: 16, width: "100%", padding: "11px 0", borderRadius: 11, border: `1px solid ${C.line}`, background: C.bg, color: CORAL, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {t("Clear filters")}
              </button>
            )}
          </>
        )}
      </Sheet>

    </div>
  );
}
