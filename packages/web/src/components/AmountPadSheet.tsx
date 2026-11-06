import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { fmtSignedTrim, type PadState, padKey, padPreview } from "../lib/amount";
import { useMask, useTheme } from "../lib/contexts";
import { localizePadExpression } from "../lib/format";
import { useT } from "../lib/i18n";
import { useWideHost } from "../lib/shellContext";
import { CORAL, font, TEAL } from "../lib/theme";
import { Sheet } from "./chrome";
import { Numpad } from "./pickers";
import { useAccountPortalTarget } from "./SignOutShield";

/**
 * Shared amount-numpad sheet (spec 2026-07-09-amount-pad-design): opened by
 * tapping a readOnly amount input. The line starts from the field's current
 * value (relative mode: an operator appends to it), a digit on a fresh line
 * replaces the value, an operator on `A⊕B` reduces (`50+24`+`+`→`74+`).
 * ✓ evaluates and validates (negatives only with allowNegative); tapping the backdrop cancels.
 * Wide layouts dock the pad across the bottom of the side panel instead (no backdrop; Done/✓
 * commits, Escape cancels); desktop fields are typed in directly (`PadInput`) and rarely open it.
 *
 * The component does NOT know the domain — commit only via the caller's `onCommit(minor)`
 * (existing write paths: setDisplayedAllocation/setItems/setEdited/…).
 */

export type AmountPadTarget = {
  label: string;
  initial: number;
  allowNegative?: boolean;
  onCommit: (minor: number) => void;
  /** The field that opened the pad. A docked pad (no backdrop) belongs to it: it scrolls the field
   *  above the keys and closes once the field leaves the DOM. */
  field?: HTMLElement | null;
};

/** Heights of the open docked pads; PaneSurface reserves the tallest (plus a gap, so the edited
 *  field never sits flush on the keys) as bottom padding. */
const dockHeights = new Map<object, number>();
function syncDockHeight() {
  const root = document.documentElement;
  if (dockHeights.size === 0) root.style.removeProperty("--amount-dock-h");
  else root.style.setProperty("--amount-dock-h", `${Math.max(...dockHeights.values()) + 12}px`);
}

/** The line a docked pad is editing, so the field that opened it can show it in place. */
type DockedLine = { target: unknown; expr: string };
let dockedLine: DockedLine | null = null;
const dockedLineListeners = new Set<() => void>();
function publishDockedLine(next: DockedLine | null) {
  dockedLine = next;
  for (const listener of dockedLineListeners) listener();
}
function subscribeDockedLine(listener: () => void) {
  dockedLineListeners.add(listener);
  return () => dockedLineListeners.delete(listener);
}
/** The expression a docked pad is editing for `target` (the object the field handed to its pad
 *  host), or null when no docked pad edits it. */
export function useDockedPadLine(target: unknown): string | null {
  const line = useSyncExternalStore(
    subscribeDockedLine,
    () => dockedLine,
    () => null,
  );
  return target != null && line?.target === target ? line.expr : null;
}

export function AmountPadHost({ target, onClose }: { target: AmountPadTarget | null; onClose: () => void }) {
  return (
    <AmountPadSheet
      show={!!target}
      label={target?.label ?? ""}
      initial={target?.initial ?? 0}
      allowNegative={target?.allowNegative}
      onCommit={(minor) => target?.onCommit(minor)}
      onClose={onClose}
      resetKey={target}
      field={target?.field}
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
  resetKey,
  field = null,
}: {
  show: boolean;
  label: string;

  initial: number;
  /** Account balances/onboarding may be negative; allocations/goal/split may not. */
  allowNegative?: boolean;
  onCommit: (minor: number) => void;
  onClose: () => void;
  /** A new value restarts the line even when `initial` is unchanged: the docked pad has no
   *  backdrop, so a tap on another field retargets it while it stays open. */
  resetKey?: unknown;
  field?: HTMLElement | null;
}) {
  const M = useMask();
  const C = useTheme();
  const { t, lang } = useT();
  const [state, setState] = useState<PadState>({ expr: "", fresh: true });
  const [error, setError] = useState(false);
  const portalTarget = useAccountPortalTarget();
  const wide = useWideHost();
  const dockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (show) {
      setState({ expr: fmtSignedTrim(initial), fresh: true });
      setError(false);
    }
  }, [show, initial, resetKey]);

  const preview = padPreview(state.expr);

  const hasOp = /[+−×-]/.test(state.expr.slice(1));

  const onKey = (k: string) => {
    setError(false);
    setState((s) => padKey(s, k === "DEL" ? "⌫" : k));
  };

  const onOk = () => {
    const minor = padPreview(state.expr);
    if (minor === null || (minor < 0 && !allowNegative)) {
      setError(true);
      return;
    }
    onCommit(minor);
    onClose();
  };

  const desktop = wide?.mode === "desktop";
  const docked = !!wide && !desktop && show;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dockKey = useRef({}).current;
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  // A docked session whose host unmounts (its form returned null or went away) ends with it, so the
  // caller's retained target cannot bring the pad back when the form reopens. Deferred: StrictMode
  // replays this cleanup on mount, and the replayed setup marks the host alive again first.
  const aliveRef = useRef(false);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      queueMicrotask(() => {
        if (!aliveRef.current && dockedRef.current) closeRef.current();
      });
    };
  }, []);

  // Desktop amount fields are typed in (PadInput, AmountField): a pad session still open when the
  // layout turns desktop would later commit over what was typed, so it ends here.
  useEffect(() => {
    if (show && desktop) closeRef.current();
  }, [show, desktop]);

  // The docked pad sits over the bottom of the pane its field lives in. The pane's scroller gets
  // the dock's height as bottom padding and scroll padding (PaneSurface reads --amount-dock-h), so
  // the field being edited scrolls up above the keys; Escape closes the pad alone — captured
  // before WideShell's document handler, which would close the whole panel.
  useLayoutEffect(() => {
    if (!docked) return;
    dockHeights.set(dockKey, dockRef.current?.offsetHeight ?? 0);
    syncDockHeight();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    // With no backdrop, the form that opened the pad can go away under it (closed, replaced, moved
    // to its next stage). The pad belongs to its field: once that field leaves the DOM it closes,
    // and the caller's onClose clears the target it held.
    const observer = new MutationObserver(() => {
      if (fieldRef.current && !fieldRef.current.isConnected) closeRef.current();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      observer.disconnect();
      dockHeights.delete(dockKey);
      syncDockHeight();
    };
  }, [docked, dockKey]);

  useEffect(() => {
    if (!docked) return;
    publishDockedLine({ target: resetKey, expr: state.expr });
  }, [docked, resetKey, state.expr]);
  useEffect(() => {
    if (!docked) return;
    return () => {
      if (dockedLine?.target === resetKey) publishDockedLine(null);
    };
  }, [docked, resetKey]);

  useLayoutEffect(() => {
    if (!docked || !field) return;
    const raf = requestAnimationFrame(() => field.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(raf);
  }, [docked, field]);

  if (wide) {
    if (!docked) return null;
    // Wide layouts have no popups: the pad is part of the pane its field lives in (every pad
    // caller is a surface in the side panel), docked across its bottom with no backdrop — the
    // DockedNumpad idiom of the Budget screen. Portaled out of the panel's transformed layer
    // into the sign-out boundary's host, which carries no app font.
    const anchor = wide.rects.panel ?? wide.rects.primary;
    return createPortal(
      <div
        ref={dockRef}
        data-amount-pad-dock
        role="group"
        aria-label={label}
        style={{
          position: "fixed",
          bottom: 0,
          left: anchor.left,
          width: anchor.width,
          zIndex: 110,
          background: C.keybg,
          borderTop: `1px solid ${C.line}`,
          fontFamily: font,
          WebkitFontSmoothing: "antialiased",
          boxShadow: "0 -6px 18px rgba(0,0,0,0.06)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minHeight: 44,
            padding: "0 12px 0 16px",
            background: C.surface,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          <span
            style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {label}
          </span>
          <span
            role="status"
            aria-label={label}
            style={{
              fontSize: 13,
              color: error ? CORAL : C.soft,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "55%",
            }}
          >
            {localizePadExpression(state.expr, lang) || "0"}
            {hasOp && preview !== null && <span style={{ color: TEAL, fontWeight: 650 }}>{` ${t("= {amount}", { amount: M(preview) })}`}</span>}
          </span>
          <button
            type="button"
            onClick={onOk}
            style={{
              flexShrink: 0,
              border: "none",
              borderRadius: 8,
              padding: "6px 12px",
              background: "var(--accent-22)",
              color: TEAL,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: font,
              cursor: "pointer",
            }}
          >
            {t("Done")}
          </button>
        </div>
        <Numpad onKey={onKey} onOk={onOk} />
      </div>,
      portalTarget ?? document.body,
    );
  }

  // The pad usually opens over another sheet (cover, suggest, fill goals) whose body sits at z 100,
  // above this sheet's z-90 backdrop — taps on it then missed the backdrop and the pad stayed open.
  // Portaled out of the screen: iOS WebKit clipped the fixed pad inside this z-index wrapper to the
  // screen's overflow:hidden column, which ends above the bottom nav, hiding the bottom key rows.
  // The target sits outside the app container's font, so the wrapper sets it.
  return createPortal(
    <div style={{ position: "relative", zIndex: 110, fontFamily: font, WebkitFontSmoothing: "antialiased" }}>
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
              {localizePadExpression(state.expr, lang) || "0"}
            </div>
            <div style={{ minHeight: 20, textAlign: "right", fontSize: 14, color: C.mute, fontVariantNumeric: "tabular-nums", margin: "6px 2px 10px" }}>
              {hasOp && preview !== null ? t("= {amount}", { amount: M(preview) }) : ""}
            </div>
            {}
            <div style={{ margin: "0 -20px calc(-28px - env(safe-area-inset-bottom))" }}>
              <Numpad onKey={onKey} onOk={onOk} />
            </div>
          </div>
        )}
      </Sheet>
    </div>,
    portalTarget ?? document.body,
  );
}
