import type { MutableRefObject } from "react";
import { useCurrency, useTheme } from "../../lib/contexts";
import { currencySymbol, localizePadExpression } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { tint } from "../../lib/theme";
import type { Tab } from "./types";

/** Amount hero: the expense sign toggle, the tappable expression and the pad cursor.
 *  Account, envelope and date moved into the flow card below it (design B2), so this
 *  is the number and nothing else. Presentational: the pad state machine and the
 *  scroll-to-end effect stay in the controller (`amtRef` is the controller's ref). */
export function AmountSection({
  tab,
  isRefund,
  plus,
  amount,
  numpadOpen,
  amtRef,
  onOpenPad,
  onToggleRefund,
}: {
  tab: Tab;
  isRefund: boolean;
  plus: boolean;
  /** The CANONICAL pad expression (comma-decimal) — rendered in the UI language below, never localized upstream. */
  amount: string;
  numpadOpen: boolean;
  amtRef: MutableRefObject<HTMLDivElement | null>;
  onOpenPad: () => void;
  onToggleRefund: () => void;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const currency = useCurrency();
  return (
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
      style={{ padding: "12px 0 4px", cursor: "pointer", display: "flex", justifyContent: "center" }}
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
          <span style={{ fontSize: 42, fontWeight: 800, color: plus ? C.pos : C.text, fontVariantNumeric: "tabular-nums" }}>
            {localizePadExpression(amount, lang) || "0"}
          </span>
          {numpadOpen && (
            <span
              style={{
                display: "inline-block",
                width: 2,
                height: 30,
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
  );
}
