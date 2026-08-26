import { computeEnvelopeSummary, computeStateResponse, type Transaction } from "@enveo/shared";
import { useMemo, useState } from "react";
import { type EnvelopeView, type StateResponse, useLedgerVersion } from "../../lib/api";
import { useMask, useTheme } from "../../lib/contexts";
import { monthLabel, shortDate } from "../../lib/dates";
import { isLight } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Glyph } from "../../lib/icons";
import { useWideHost } from "../../lib/shellContext";
import { store } from "../../lib/store";
import { font, TEAL, TRANSFER } from "../../lib/theme";
import { emptyTransactionFilters, matchesTransactionFilters } from "../../lib/transactionSearch";
import { EnvEdit } from "../../screens/Budget";
import { PERIOD_KEY, PERIODS, type Period } from "../../screens/Envelope";

/**
 * Design parity wave C task 2 (waveC-t2-brief.md, model: `AccountPanel.tsx`) — the wide panel's
 * envelope-summary body, replacing the phone `EnvelopeScreen` (which carried its own back-chevron
 * header, a duplicate month-nav row and a full-width "Transactions/Edit" footer bar into the
 * panel — owner rule 2's exact "phone chrome in a panel" violation, gaps-budget.md #2). Month is
 * the resolved `PanelView`'s own month (App's viewed month) — this component only ever RENDERS
 * it, it never navigates it (no local month state, unlike `EnvelopeScreen`); the shared top band
 * is the only month-nav in the wide shell.
 *
 * Everything computed EXCLUSIVELY locally from the IndexedDB replica, same as `EnvelopeScreen`/
 * `AccountPanel`: `computeEnvelopeSummary` (category window + 6-month series + carry-in) +
 * `computeStateResponse` (this month's allocated/spent/available + this month's transactions).
 * The category-window period buttons and their labels are IMPORTED from `screens/Envelope.tsx`
 * (now exported) rather than duplicated — the brief's "extract the trio/breakdown data helpers"
 * direction, applied to the one piece of that screen's own logic another consumer needs verbatim.
 */
export function EnvelopePanel({
  envelopeId,
  month,
  groups,
  accounts,
  onOpenTxns,
  onEditTxn,
}: {
  envelopeId: string;
  month: string;
  groups: StateResponse["groups"];
  accounts: StateResponse["accounts"];
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onEditTxn: (t: Transaction) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  // Fold's 552px panel lays the monthly + category breakdowns side by side (v3 `L.detailCols`:
  // "1fr 1fr" at 1104px vs "1fr" — single column, i.e. stacked — at 1440px); the desktop 400px
  // panel stays stacked, exactly `EnvelopeScreen`'s own `foldTwoCol` gate.
  const wideHost = useWideHost();
  const foldTwoCol = wideHost?.mode === "fold";
  const [period, setPeriod] = useState<Period>(1);
  const [edit, setEdit] = useState<EnvelopeView | null>(null);

  const data = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeEnvelopeSummary(ledger, envelopeId, month, { categoryMonths: period }) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, envelopeId, month, period]);
  const stateM = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeStateResponse(ledger, month) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const env = stateM?.envelopes.find((e) => e.id === envelopeId);

  const categoryNameById = useMemo(() => new Map((stateM?.categories ?? []).map((c) => [c.id, c.name])), [stateM]);

  // "Transactions in {name}" (gaps-budget.md #3): up to 5 of THIS MONTH's transactions matching
  // the envelope (top-level `envelopeId` OR a split item's), reusing the exact matcher
  // `Transactions.tsx`'s own envelope filter and this pane's "Open in list ›" both rely on
  // (`matchesTransactionFilters`) rather than a third, independently-written predicate.
  const recentTxns = useMemo(() => {
    if (!stateM) return [];
    const filters = { ...emptyTransactionFilters(), envelopeIds: new Set([envelopeId]) };
    return stateM.transactions.filter((tx) => matchesTransactionFilters(tx, filters)).slice(0, 5);
  }, [stateM, envelopeId]);

  // Vanished envelope (deleted on another device / stale selection): the `AccountPanel` no-data
  // rule, verbatim — render the hint, never crash. `PanelHost`'s own ✕ is the only way out here
  // (owner rule 2 — no inner close of its own).
  if (!data || !stateM || !env) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.5 }}>{t("Choose an envelope to see its summary.")}</span>
      </div>
    );
  }

  const txt = isLight(env.color) ? "#33312c" : "#fff";
  const neg = env.available < 0;
  const carryIn = data.carryIn;
  const progress = Math.min(1, Math.max(0, env.spent / Math.max(1, env.allocated + carryIn)));
  const series = data.series;
  const maxSpent = Math.max(...series.map((s) => s.spent), 1);
  const total = data.categoriesTotal;

  // Single hero-card stat (uppercase eyebrow + value) — EnvelopeScreen's own helper, verbatim.
  const stat = (label: string, value: string, color: string) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.mute, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );

  // Sign-correct rows — the `AccountPanel` rule, verbatim (a split/refund/transfer must not
  // collapse to a flat "−"): expense → "−amount" in the ordinary text colour (an expense row
  // reads as ordinary spending, not a deficit — only the AVAILABLE figure above is sign-coloured);
  // income/refund → "+amount" in the positive colour; transfer → unsigned, the transfer colour.
  const signed = (tx: Transaction): { text: string; color: string } => {
    if (tx.type === "transfer") return { text: M(tx.amount), color: TRANSFER };
    if (tx.type === "income" || tx.isRefund) return { text: `+${M(tx.amount)}`, color: C.pos };
    return { text: `-${M(tx.amount)}`, color: C.text };
  };
  // "day · category" sub-line (v3:2646's `dayLabel(t.day, t) + " · " + t.cat`, translated into
  // this app's own day formatter and category lookup): a split transaction's category comes from
  // the ITEM referencing this envelope, since its other items may carry a different one.
  const subOf = (tx: Transaction): string => {
    const catId = tx.items.length > 0 ? (tx.items.find((i) => i.envelopeId === envelopeId)?.categoryId ?? null) : tx.categoryId;
    const catName = catId ? categoryNameById.get(catId) : null;
    return catName ? `${shortDate(tx.date, lang)} · ${catName}` : shortDate(tx.date, lang);
  };
  // Same payee fallback chain as `widgetsBoard.tsx`'s `RecentWidget` / `MonthReport.tsx` (reused
  // rather than re-derived): explicit name → note → this envelope's own name → "Split
  // transaction"/"Transaction".
  const payeeOf = (tx: Transaction): string => tx.name || tx.note || env.name || (tx.items.length ? t("Split transaction") : t("Transaction"));

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 13 }}>
      {/* name row: icon + name + inline Edit pill, ONE row (v3:1012-1017) — no back chevron, no
          month nav, no bottom action bar (owner rule 2 / gaps-budget.md #2). */}
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: env.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Glyph name={env.icon} size={16} color={txt} />
        </div>
        <span
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            fontSize: 16.5,
            fontWeight: 700,
            color: C.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {env.name}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setEdit(env)}
          style={{
            flexShrink: 0,
            cursor: "pointer",
            fontSize: 11.5,
            color: C.soft,
            background: "transparent",
            border: `1px solid ${C.line}`,
            borderRadius: 8,
            padding: "6px 11px",
            fontFamily: font,
            // House >=30x30 touch-target floor (measured, not asserted): the design's own box
            // (padding 6px 11px around 11.5px text, v3:1016) renders ~28px tall — under 30px.
            // box-sizing border-box + minHeight makes 30 the TOTAL box height without touching
            // the design's visible padding/font-size/border.
            boxSizing: "border-box",
            minHeight: 30,
          }}
        >
          {t("Edit")}
        </button>
      </div>

      {/* trio card: available/spent/allocated + progress bar, carry caption ALWAYS muted
          (gaps-budget.md #7 — was sign-coloured red on a negative carry-in). */}
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px 12px" }}>
        <div style={{ display: "flex", textAlign: "center", gap: 8 }}>
          {stat(t("BUDGET"), M(env.allocated), C.text)}
          {stat(t("SPENT"), M(Math.max(0, env.spent)), C.text)}
          {stat(t("AVAILABLE"), `${neg ? "-" : ""}${M(Math.abs(env.available))}`, neg ? C.neg : C.pos)}
        </div>
        <div style={{ marginTop: 12, height: 7, background: C.inset, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progress * 100}%`, background: neg ? C.neg : env.color, borderRadius: 4, transition: "width .4s" }} />
        </div>
        <div style={{ marginTop: 8, textAlign: "center", fontSize: 10, color: C.mute, fontVariantNumeric: "tabular-nums" }}>
          {t("{amount} from the previous month", { amount: `${carryIn < 0 ? "-" : "+"}${M(Math.abs(carryIn))}` })}
        </div>
      </div>

      {/* monthly breakdown + category breakdown */}
      <div
        style={
          foldTwoCol
            ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }
            : { display: "flex", flexDirection: "column", gap: 18 }
        }
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 10 }}>{t("Monthly breakdown")}</div>
          {series.map((s) => (
            <div key={s.month} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: C.soft, width: 70, textAlign: "right" }}>{monthLabel(s.month, lang).split(" ")[0]}</span>
              <div style={{ flex: 1, height: 8, background: C.inset, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(Math.max(0, s.spent) / maxSpent) * 100}%`, background: env.color, borderRadius: 4 }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.text, width: 76, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {M(Math.max(0, s.spent))}
              </span>
            </div>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>{t("Breakdown by category")}</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                style={{
                  flex: 1,
                  padding: "6px 0",
                  borderRadius: 9,
                  border: `1px solid ${period === p ? TEAL : C.line}`,
                  background: period === p ? "var(--accent-1a)" : "transparent",
                  color: period === p ? TEAL : C.soft,
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: font,
                }}
              >
                {t(PERIOD_KEY[p])}
              </button>
            ))}
          </div>
          {data.categories.map((c) => {
            const share = total > 0 ? (c.amount / total) * 100 : 0;
            return (
              <div key={c.categoryId ?? "none"} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.name}
                  </span>
                  <span style={{ fontSize: 11.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{share.toFixed(1)}%</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(c.amount)}</span>
                </div>
                <div style={{ height: 4, background: C.inset, borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
                  <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, share))}%`, background: env.color, borderRadius: 2 }} />
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 8, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
            <span style={{ fontSize: 12.5, color: C.soft }}>{t("Total")}</span>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(total)}</span>
          </div>
        </div>
      </div>

      {/* "Transactions in {name}" + "Open in list ›" (gaps-budget.md #3 — entirely missing
          before this task) above a bordered ≤5-row list, empty state when none this month. */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t("Transactions in {name}", { name: env.name })}</span>
        <button
          onClick={() => onOpenTxns({ envId: envelopeId })}
          // minHeight 30 — the padding-less text button (v3:1076, 11.5px) measures well under
          // the 30px tap floor every other affordance on this panel clears; flex + alignItems
          // centers the text in the taller box without touching the design's visible size/weight.
          // alignSelf "center" opts THIS item out of the row's `alignItems: "baseline"` (measured:
          // without it, growing this button to 30px drags the shared line-box baseline down with
          // it and shifts the "Transactions in {name}" heading ~7px lower) — the heading keeps its
          // original position; only the row's own height grows to fit the taller tap target.
          style={{
            alignSelf: "center",
            display: "flex",
            alignItems: "center",
            minHeight: 30,
            cursor: "pointer",
            fontSize: 11.5,
            // 650 per the wave-C re-review (the weight every sibling accent link in the design
            // carries — "All transactions ›" v3:449, "Check for updates" v3:166).
            fontWeight: 650,
            color: TEAL,
            background: "transparent",
            border: "none",
            padding: 0,
            fontFamily: font,
          }}
        >
          {t("Open in list ›")}
        </button>
      </div>
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "2px 12px" }}>
        {recentTxns.length === 0 ? (
          <div style={{ fontSize: 12, color: C.mute, padding: "14px 0", textAlign: "center" }}>{t("Nothing here yet this month.")}</div>
        ) : (
          recentTxns.map((tx, i) => {
            const s = signed(tx);
            return (
              <div
                key={tx.id}
                role="button"
                onClick={() => onEditTxn(tx)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 0",
                  borderBottom: i === recentTxns.length - 1 ? "none" : `1px solid ${C.line}`,
                  cursor: "pointer",
                }}
              >
                <span style={{ width: 24, height: 24, borderRadius: 7, background: env.color, display: "block", flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 13, fontWeight: 550, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {payeeOf(tx)}
                  </span>
                  <span style={{ fontSize: 10, color: C.mute }}>{subOf(tx)}</span>
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: s.color, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{s.text}</span>
              </div>
            );
          })
        )}
      </div>

      <EnvEdit env={edit} groups={groups} accounts={accounts} onClose={() => setEdit(null)} />
    </div>
  );
}
