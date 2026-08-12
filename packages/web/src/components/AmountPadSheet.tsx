import { useEffect, useState } from "react";
import { fmtSignedTrim, type PadState, padKey, padPreview } from "../lib/amount";
import { useMask } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { CORAL } from "../lib/theme";
import { Sheet } from "./chrome";
import { Numpad } from "./pickers";

/**
 * Shared amount-numpad sheet (spec 2026-07-09-amount-pad-design): opened by
 * tapping a readOnly amount input. The line starts from the field's current
 * value (relative mode: an operator appends to it), a digit on a fresh line
 * replaces the value, an operator on `A⊕B` reduces (`50+24`+`+`→`74+`).
 * ✓ evaluates and validates (negatives only with allowNegative); tapping the backdrop cancels.
 *
 * The component does NOT know the domain — commit only via the caller's `onCommit(minor)`
 * (existing write paths: setAllocation/setItems/setEdited/…).
 */
/**
 * Target of the open pad — held ONCE per screen/sheet (`useState<AmountPadTarget | null>`).
 * `onCommit` is the EXISTING write path of the integration point; the pad doesn't know the domain.
 */
export type AmountPadTarget = {
  label: string;
  initial: number;
  allowNegative?: boolean;
  onCommit: (minor: number) => void;
};

/** Convenience host: one AmountPadSheet per screen, target in the caller's state. */
export function AmountPadHost({ target, onClose }: { target: AmountPadTarget | null; onClose: () => void }) {
  return (
    <AmountPadSheet
      show={!!target}
      label={target?.label ?? ""}
      initial={target?.initial ?? 0}
      allowNegative={target?.allowNegative}
      onCommit={(minor) => target?.onCommit(minor)}
      onClose={onClose}
    />
  );
}

export function AmountPadSheet({
  show,
  label,
  initial,
  allowNegative,
  onCommit,
  onClose,
}: {
  show: boolean;
  label: string;
  /** Current field value in minor units — starting point of the edit line. */
  initial: number;
  /** Account balances/onboarding may be negative; allocations/goal/split may not. */
  allowNegative?: boolean;
  onCommit: (minor: number) => void;
  onClose: () => void;
}) {
  const M = useMask();
  const { t } = useT();
  const [state, setState] = useState<PadState>({ expr: "", fresh: true });
  const [error, setError] = useState(false);

  // Every open starts a fresh line with the field's current value.
  useEffect(() => {
    if (show) {
      setState({ expr: fmtSignedTrim(initial), fresh: true });
      setError(false);
    }
  }, [show, initial]);

  const preview = padPreview(state.expr);
  // Operator beyond the number's sign (index 0) ⇒ the line holds an expression → show the "= result" preview.
  const hasOp = /[+−×-]/.test(state.expr.slice(1));

  const onKey = (k: string) => {
    setError(false);
    setState((s) => padKey(s, k === "DEL" ? "⌫" : k));
  };

  const onOk = () => {
    const minor = padPreview(state.expr);
    if (minor === null || (minor < 0 && !allowNegative)) {
      setError(true);
      return; // no save and no close — the line is highlighted red
    }
    onCommit(minor);
    onClose();
  };

  return (
    <Sheet show={show} onClose={onClose}>
      {(C) => (
        <div>
          <div style={{ fontSize: 13.5, color: C.mute, textAlign: "center", marginBottom: 10 }}>{label}</div>
          <div
            role="status"
            aria-label={label}
            style={{
              fontSize: 28,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              textAlign: "right",
              color: error ? CORAL : C.text,
              background: error ? "var(--danger-18)" : C.bg,
              border: `1.5px solid ${error ? CORAL : C.line}`,
              borderRadius: 12,
              padding: "8px 14px",
              overflowX: "auto",
              whiteSpace: "nowrap",
            }}
          >
            {state.expr || "0"}
          </div>
          <div style={{ minHeight: 20, textAlign: "right", fontSize: 14, color: C.mute, fontVariantNumeric: "tabular-nums", margin: "6px 2px 10px" }}>
            {hasOp && preview !== null ? t("= {amount}", { amount: M(preview) }) : ""}
          </div>
          {/* Keyboard bleeds to the sheet edge (like on the Add screen); the Numpad's own
              safe-area padding replaces the Sheet's bottom padding. */}
          <div style={{ margin: "0 -20px calc(-28px - env(safe-area-inset-bottom))" }}>
            <Numpad onKey={onKey} onOk={onOk} />
          </div>
        </div>
      )}
    </Sheet>
  );
}
