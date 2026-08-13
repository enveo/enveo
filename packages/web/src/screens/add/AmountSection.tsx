import type { MutableRefObject } from "react";
import { useCurrency, useTheme } from "../../lib/contexts";
import { currencySymbol, localizePadExpression } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Glyph } from "../../lib/icons";
import { tint } from "../../lib/theme";
import type { Tab } from "./types";

/** Amount hero (expense sign toggle + tappable expression + cursor) and the
 *  quiet account/date line under it. Presentational: the pad state machine,
 *  the scroll-to-end effect and the date computation stay in the controller
 *  (`amtRef` is the controller's ref so its effect keeps working unchanged). */
export function AmountSection({
  tab,
  isRefund,
  plus,
  amount,
  numpadOpen,
  amtRef,
  accountName,
  dateLabel,
  dateColor,
  onOpenPad,
  onToggleRefund,
  onOpenAccountSheet,
  onOpenDateSheet,
}: {
  tab: Tab;
  isRefund: boolean;
  plus: boolean;
  /** The CANONICAL pad expression (comma-decimal) — rendered in the UI language below, never localized upstream. */
  amount: string;
  numpadOpen: boolean;
  amtRef: MutableRefObject<HTMLDivElement | null>;
  accountName: string | null;
  dateLabel: string;
  dateColor: string;
  onOpenPad: () => void;
  onToggleRefund: () => void;
  onOpenAccountSheet: () => void;
  onOpenDateSheet: () => void;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const currency = useCurrency();
  return (
    <>
      {/* Amount hero (board .amt-big): centered, 38px/800 tabular; tap anywhere → open the pad.
          The horizontally-scrolling inner div keeps a long expression's cursor end visible. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpenPad}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenPad();
          }
        }}
        style={{ padding: "8px 0 2px", cursor: "pointer", display: "flex", justifyContent: "center" }}
      >
        <div style={{ display: "inline-flex", alignItems: "baseline", maxWidth: "100%" }}>
          {/* Expense-only sign toggle: −/+ flips isRefund right next to the number (board spec) —
              income/transfer never show it (income is always +, transfer has no sign). */}
          {tab === "expense" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleRefund();
              }}
              aria-label={t("Toggle refund")}
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                alignSelf: "center",
                flexShrink: 0,
                marginRight: 7,
                border: `1.5px solid ${isRefund ? C.pos : C.line}`,
                background: isRefund ? tint(C.pos, 0.12) : "none",
                color: isRefund ? C.pos : C.text,
                fontSize: 17,
                fontWeight: 800,
                lineHeight: 1,
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              {isRefund ? "+" : "−"}
            </button>
          )}
          <div ref={amtRef} className="gs" style={{ overflowX: "auto", whiteSpace: "nowrap", maxWidth: "100%" }}>
            <span style={{ fontSize: 38, fontWeight: 800, color: plus ? C.pos : C.text, fontVariantNumeric: "tabular-nums" }}>
              {localizePadExpression(amount, lang) || "0"}
            </span>
            {numpadOpen && (
              <span
                style={{
                  display: "inline-block",
                  width: 2,
                  height: 28,
                  background: "var(--accent)",
                  borderRadius: 1,
                  marginLeft: 3,
                  verticalAlign: "text-bottom",
                  animation: "fi .6s ease-in-out infinite alternate",
                }}
              />
            )}
          </div>
          <span style={{ fontSize: 17, color: C.soft, fontWeight: 700, marginLeft: 5, flexShrink: 0 }}>{currencySymbol(currency, lang)}</span>
        </div>
      </div>

      {/* Account + date — one quiet line under the amount (board B6v2 spec): two independent tap
          targets (account → showAcc; date → the existing DateSheet), composed WITHOUT gluing a
          sentence — tiny icons carry the meaning instead ("from account X … date Y" reads in the
          wrong order in several languages). A non-today date warns amber. */}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, padding: "0 0 8px" }}>
        <button
          onClick={onOpenAccountSheet}
          style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 2, cursor: "pointer" }}
        >
          <Glyph name="wallet" size={11} color={C.mute} />
          <span style={{ fontSize: 11, fontWeight: 700, color: C.soft }}>{accountName ?? t("Account")}</span>
        </button>
        <span style={{ fontSize: 11, color: C.mute }}>·</span>
        <button
          onClick={onOpenDateSheet}
          style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 2, cursor: "pointer" }}
        >
          <Glyph name="calendar" size={11} color={dateColor} />
          <span style={{ fontSize: 11, fontWeight: 700, color: dateColor }}>{dateLabel}</span>
        </button>
      </div>
    </>
  );
}
