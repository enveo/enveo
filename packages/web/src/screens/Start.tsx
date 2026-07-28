import { useState } from "react";
import { Ico } from "../lib/icons";
import { useMask, useSettings, useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { P, TEAL, font, tint } from "../lib/theme";
import { CardBox, useBand } from "../components/kit";
import { EditWidgetsSheet, START_WIDGETS } from "../components/widgets";
import { Header, type ScreenId } from "../components/chrome";
import { type StateResponse } from "../lib/api";
import { LOCALE_OF } from "../lib/format";
import { todayISO } from "../lib/dates";
import { monthRuler, tbbState } from "../lib/uiState";

export function StartScreen({
  state,
  month,
  onOpenTxns,
  onOpenEnvelope,
  onMenu,
  onPrev,
  onNext,
  onNav,
  onQuickAdd,
}: {
  state: StateResponse;
  month: string;
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onNav: (s: ScreenId) => void;
  /** "transfer" opens Add pre-set to the Transfer tab; "import" opens Add with the screenshot-import sheet already showing; "suggest" opens Budget with the suggest sheet already showing. */
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const { settings } = useSettings();
  const [editWidgets, setEditWidgets] = useState(false);
  // month summary without the fractional part (strips e.g. ",00" / ".00" from the formatted amount), with the discreet mask
  const MW = (minor: number) => M(minor).replace(/[.,]\d\d(?!\d)/, "");
  const hs = tbbState(state.readyToAssign);
  const ruler = monthRuler(todayISO());
  const { band, hc } = useBand();
  const shortDay = new Intl.DateTimeFormat(LOCALE_OF[lang], { day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(`${todayISO()}T00:00:00Z`));
  const IncomeExpense = () => (
    <span style={{ fontSize: 11, color: hc(C.headerMute, C.soft), whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
      <span style={{ color: hc(C.headerPos, C.pos) }}>↑</span> <b style={{ color: hc(C.headerInk, C.text), fontWeight: 650 }}>{MW(state.monthIncome)}</b>
      {"  "}
      <span style={{ color: hc(C.headerNeg, C.neg) }}>↓</span> <b style={{ color: hc(C.headerInk, C.text), fontWeight: 650 }}>{MW(state.monthExpense)}</b>
    </span>
  );

  // Empty-state backstop only needs the counts — the widgets below compute their own filtered lists.
  const accountsCount = state.accounts.filter((a) => !a.archived).length;
  const envelopesCount = state.envelopes.filter((e) => !e.archived).length;

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <div
        style={
          band
            ? { background: C.headerBg, paddingBottom: 30, clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 22px), 50% 100%, 0 calc(100% - 22px))", position: "relative", zIndex: 1 }
            : undefined
        }
      >
        <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onRight={() => setEditWidgets(true)} rightIcon="pencil" onBand={band} />
        <div style={{ padding: `4px ${P + 4}px 0`, textAlign: band ? "center" : "left" }}>
          {hs === "zero" && (
            <div style={{ display: "flex", justifyContent: band ? "center" : "space-between", alignItems: "center", gap: 10 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: hc(C.headerPos, C.pos), whiteSpace: "nowrap" }}>
                <Ico d="M5 13l4 4L19 7" size={14} color={hc(C.headerPos, C.pos)} sw={2.4} />
                {t("All money assigned")}
              </span>
              {!band && <IncomeExpense />}
            </div>
          )}
          {hs !== "zero" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.18em", color: hc(C.headerMute, C.mute) }}>
                  {hs === "positive" ? t("To be budgeted").toUpperCase() : t("Over-assigned").toUpperCase()}
                </span>
                <IncomeExpense />
              </div>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onNav("budget")}
                onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNav("budget"); } }}
                style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: band ? "center" : "flex-start", cursor: "pointer" }}
              >
                <AmountHero value={state.readyToAssign} />
              </div>
            </div>
          )}
          {band && hs === "zero" && <div style={{ marginTop: 4, display: "flex", justifyContent: "center" }}><IncomeExpense /></div>}
          <div style={{ height: 3, borderRadius: 2, background: hc(tint(C.headerInk, 0.22), C.line), margin: "9px 0 5px", position: "relative" }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${ruler.pct}%`, background: hc(tint(C.headerInk, 0.55), C.mute), borderRadius: 2, display: "block" }} />
            <span style={{ position: "absolute", left: `${ruler.pct}%`, top: "50%", width: 7, height: 7, borderRadius: "50%", background: hc(C.headerInk, C.text), transform: "translate(-50%,-50%)", display: "block" }} />
          </div>
          <div style={{ fontSize: 10.5, color: hc(C.headerMute, C.soft), textAlign: "left" }}>
            {t("{date} · {pct}% of month", { date: shortDay, pct: String(ruler.pct) })}
          </div>
        </div>
      </div>

      {/* Empty states (backstop outside the wizard): missing accounts OR envelopes → CTA below the header */}
      {(accountsCount === 0 || envelopesCount === 0) && (
        <CardBox style={{ display: "flex", flexDirection: "column", gap: 8, margin: `0 ${P}px 10px`, padding: "12px 14px" }}>
          {accountsCount === 0 && (
            <button onClick={() => onNav("accounts")} style={{ padding: "10px 0", borderRadius: 10, border: "none", background: TEAL, color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: font }}>
              {t("Add your first account")}
            </button>
          )}
          {envelopesCount === 0 && (
            <button onClick={() => onNav("budget")} style={{ padding: "10px 0", borderRadius: 10, border: `1px solid ${TEAL}`, background: "transparent", color: TEAL, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: font }}>
              {t("Create envelopes")}
            </button>
          )}
        </CardBox>
      )}

      {/* Configurable widget stack (settings.startWidgets — device setting, "Edit widgets" sheet below).
          A corrupted/future persisted id (settings are untyped JSON at rest) must never crash Start. */}
      {settings.startWidgets
        .filter((w) => w.enabled && w.id in START_WIDGETS)
        .map((w) => {
          const Widget = START_WIDGETS[w.id];
          return (
            <Widget
              key={w.id}
              state={state}
              month={month}
              onNav={onNav}
              onOpenEnvelope={onOpenEnvelope}
              onOpenTxns={onOpenTxns}
              onQuickAdd={onQuickAdd}
              opts={w.opts}
            />
          );
        })}

      <EditWidgetsSheet show={editWidgets} state={state} onClose={() => setEditWidgets(false)} />
    </div>
  );
}

/* ── Hero "to be budgeted" amount: big integer part + smaller decimal+currency tail ── */
function AmountHero({ value }: { value: number }) {
  const C = useTheme();
  const M = useMask();
  const { band, hc } = useBand();
  const neg = value < 0;
  const big = neg ? hc(C.headerNeg, C.neg) : hc("var(--cta)", C.text);
  // A two-tone negative would read weird — keep the same red as the big part, just smaller.
  const small = neg ? big : hc(C.headerMute, C.soft);
  const s = M(value);
  const m = s.match(/^(.*?)([,.]\d{2})(\s?\D*)$/);
  return (
    <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", color: big }}>
      {m ? m[1] : s}
      {m && <span style={{ fontSize: 16, fontWeight: 700, color: small }}>{m[2]}{m[3]}</span>}
    </span>
  );
}
