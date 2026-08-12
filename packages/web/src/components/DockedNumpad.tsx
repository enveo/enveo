import { hasOpenOp, padKey, padPreview, type PadState } from "../lib/amount";
import { useMask, useTheme } from "../lib/contexts";
import { isLight } from "../lib/format";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { P } from "../lib/theme";
import { Numpad } from "./pickers";

/**
 * Docked numpad (spec 2026-07-10-docked-numpad-design): IN-PLACE allocation
 * editing on the Budget screen. ZERO backdrop — the list underneath stays
 * visible and scrollable; the pad visually replaces the BottomNav (fixed,
 * zIndex above the nav, opaque background + safe-area from the Numpad).
 *
 * The component does NOT know the domain — the line state (`PadState`) is held
 * by the caller (Budget: `editing`), writes only via `target.onCommit(minor)`.
 * The OK key is contextual: A⊕B state → `=` (explicit reduction, pad stays),
 * otherwise ✓ → validation (computable result, negative allowed — moving money
 * back OUT of an envelope is a valid allocation) and commit; errors reported
 * via `onInvalid` (red cell highlight in the row — a flag in the caller's state).
 */
export type DockedNumpadTarget = {
  /** Name of the edited envelope (bar above the keys). */
  label: string;
  icon?: string;
  /** Envelope color — the icon tile in the bar. */
  color?: string;
  onCommit: (minor: number) => void;
  onCancel: () => void;
  /** ✓ on an uncomputable/negative result — the caller sets the error flag. */
  onInvalid: () => void;
};

export function DockedNumpad({ target, state, onState }: { target: DockedNumpadTarget | null; state: PadState | null; onState: (s: PadState) => void }) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  if (!target || !state) return null;

  // A⊕B = a full expression: OK shows "=" and reduces instead of committing.
  const open = hasOpenOp(state.expr);
  const preview = open ? padPreview(state.expr) : null;

  // allowNegative: the ONLY caller of this pad is allocation editing on Budget — negative
  // allocations move money back OUT of an envelope (see amount.ts padKey docs).
  const onKey = (k: string) => onState(padKey(state, k === "DEL" ? "⌫" : k, { allowNegative: true }));
  const onOk = () => {
    if (open) {
      onState(padKey(state, "=", { allowNegative: true }));
      return;
    }
    const minor = padPreview(state.expr);
    if (minor === null) target.onInvalid();
    else target.onCommit(minor);
  };

  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, maxWidth: 420, margin: "0 auto", zIndex: 60, background: C.keybg }}>
      {/* Bar: [envelope icon+name · "= X" preview when an expression is open · ✕] */}
      <div style={{ height: 40, display: "flex", alignItems: "center", gap: 8, padding: `0 ${P}px`, borderBottom: `1px solid ${C.line}` }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
          {target.icon && target.color && (
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: target.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Glyph name={target.icon} size={12} color={isLight(target.color) ? "#33312c" : "#fff"} sw={1.6} />
            </div>
          )}
          <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {target.label}
          </span>
        </div>
        <span style={{ fontSize: 13, color: C.mute, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {open && preview !== null ? t("= {amount}", { amount: M(preview) }) : ""}
        </span>
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={target.onCancel}
            aria-label={t("Cancel editing")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 8, marginRight: -8, display: "flex" }}
          >
            <Ico d="M6 6l12 12M18 6L6 18" size={15} color={C.mute} sw={2} />
          </button>
        </div>
      </div>
      <Numpad onKey={onKey} onOk={onOk} okGlyph={open ? "equals" : "check"} />
    </div>
  );
}
