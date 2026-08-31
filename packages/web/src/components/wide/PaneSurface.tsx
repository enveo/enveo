import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { InWideShell, type PaneSurfaceHost, useWideHost } from "../../lib/shellContext";
import type { Theme } from "../../lib/theme";

/**
 * The pane-surface presentation for `Surface` (`chrome.tsx`) when a `PaneSurfaceHost` is present
 * — i.e. inside the wide shell (PR6b, D1). Wide-chunk only: `Surface` only imports this module
 * behind its own `lazy()`, so nothing here reaches the phone bundle.
 *
 * An opaque, absolutely-positioned overlay filling the panel column, with a slim header carrying
 * ONLY the ✕ (30×30, `aria-label t("Close")` — PanelHost's own header idiom, `PanelHost.tsx`'s ✕
 * button styles verbatim) — bodies render their own headings already, matching PanelHost's kinds
 * that pass an empty label (`envelope`, `add`).
 */
export function PaneSurface({ host, onClose, children }: { host: PaneSurfaceHost; onClose: () => void; children: ReactNode | ((C: Theme) => ReactNode) }) {
  const C = useTheme();
  const { t } = useT();
  const ctx = useWideHost(); // the CALLER's provider — host may be "primary"; re-provided below
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Register for exactly as long as this surface is mounted (Surface already gates on `show`).
  // WideShell's `register()` also reopens a collapsed panel — the surface analogue of the
  // selection-reopen effect (WideShell.tsx) — and the returned unregister is this effect's
  // cleanup, so a rail-navigate-away unmount of the OWNER removes the surface with no extra code.
  useEffect(() => host.register({ close: () => closeRef.current() }), [host]);

  // Focus hygiene on unmount: a Cancel/Save button inside the surface unmounts under the focused
  // element and would otherwise strand focus on `<body>` — hand it to the panel toggle, the same
  // resting place every other close path in the shell uses. Guarded so a rail-nav unmount (focus
  // legitimately already moved to the rail button that triggered it) never steals focus back:
  // only act when focus was actually lost to `<body>`/nothing.
  useEffect(
    () => () => {
      const a = document.activeElement;
      if (!a || a === document.body) document.querySelector<HTMLElement>("[data-panel-toggle]")?.focus();
    },
    [],
  );

  if (!host.node || !ctx) return null;

  return createPortal(
    <div data-wide-pane-surface style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: C.surface }}>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 14px", borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
        <button
          onClick={onClose}
          aria-label={t("Close")}
          style={{
            width: 30,
            height: 30,
            minWidth: 30,
            minHeight: 30,
            flexShrink: 0,
            borderRadius: 8,
            border: "none",
            background: "transparent",
            color: C.soft,
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✕
        </button>
      </div>
      {/* LOAD-BEARING re-provision: portals move DOM, not React context. Without `host: "panel"`
          here, a surface opened from the PRIMARY pane would keep `host: "primary"` from its
          caller's provider, and every nested `Sheet` it renders (acctForm's
          `EnvelopePickerSheet`, reconcile's amount pad) would take `Sheet`'s primary/phone
          branch — `position: fixed` INSIDE the panel's always-on transform, clipped to the
          column (the exact house pitfall PR6 Task 5's `Sheet` fix exists for). With this
          re-provision, a nested `Sheet` reads `host === "panel"` and takes `Sheet`'s existing
          panel branch instead: portal to `document.body` + `data-wide-panel-portal` marker,
          which `WideShell.panelContains` already honours. */}
      <InWideShell.Provider value={{ ...ctx, host: "panel" }}>
        <div className="gs" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px calc(20px + env(safe-area-inset-bottom))" }}>
          {typeof children === "function" ? children(C) : children}
        </div>
      </InWideShell.Provider>
    </div>,
    host.node,
  );
}
