import { computeStateResponse } from "@enveo/shared";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLedgerVersion } from "../lib/api";
import { useSettings, useTheme } from "../lib/contexts";
import { currentMonth, monthLabel } from "../lib/dates";
import { CHECKBOX_CSS, INPUT_FOCUS_CSS, NAME_UNDERLINE_FOCUS_CSS } from "../lib/focusPresentation";
import { LOCALE_OF } from "../lib/format";
import { useT } from "../lib/i18n";
import { D_INSTALL, Ico } from "../lib/icons";
import { isInstallable, useInstall } from "../lib/installPrompt";
import { useWideHost } from "../lib/shellContext";
import { store } from "../lib/store";
import { CORAL, CTA, font, P, type Theme } from "../lib/theme";
import { APP_VERSION, buildLabel } from "../lib/version";
import { PHONE_COL } from "../lib/viewMode";

// Lazy — the pane-surface presentation lives in the wide chunk; phone (and any un-hosted mount)
// never requests it, since `Surface` below only reaches this branch when `useWideHost()?.surfaces`
// is set (WideShell-only).
const PaneSurface = lazy(() => import("./wide/PaneSurface").then((m) => ({ default: m.PaneSurface })));

/**
 * Hover-reveal scrollbars for WIDE scroll surfaces (owner ruling, parity owner round 1 item 2;
 * design v3.dc.html:21-28): no visible scrollbar at rest, a slim hairline thumb while the pointer
 * hovers the scroll container. One shared mechanism, two entry points:
 * - `.gsh` — the opt-in class for wide-only containers (rail accounts, board tile bodies, the
 *   envelope pill grid, panel bodies, WideSettings' two panes);
 * - the `[data-wide-primary] .gs` / `[data-wide-panel] .gs` scopes — they sweep up every `.gs`
 *   list a PHONE screen brings along when it is hosted in a wide pane (Transactions, Budget,
 *   report subscreens…), so phone markup stays untouched and phone behavior (`.gs` = scrollbar
 *   fully hidden) is byte-identical: those data attributes exist only under `WideShell`.
 * Chrome/Firefox take the standard `scrollbar-width`/`scrollbar-color` path (per spec, a non-auto
 * value there disables `::-webkit-scrollbar` styling); Safari takes the webkit rules. Content is
 * never `display:none` — scrolling (wheel/drag/touch) keeps working, only the indicator hides.
 * The thumb is a fixed neutral gray readable on every theme surface (the design's own literal,
 * rgba(43,42,39,…), is light-Cisza ink and would vanish on the dark themes).
 */
const GSH = (suffix: string) => [".gsh", "[data-wide-primary] .gs", "[data-wide-panel] .gs"].map((s) => s + suffix).join(",");
const HOVER_SCROLLBAR_CSS =
  `${GSH("")}{scrollbar-width:thin;scrollbar-color:transparent transparent}` +
  `${GSH(":hover")}{scrollbar-color:rgba(128,127,122,.45) transparent}` +
  `${GSH("::-webkit-scrollbar")}{width:4px;height:4px}` +
  `${GSH("::-webkit-scrollbar-track")}{background:transparent}` +
  `${GSH("::-webkit-scrollbar-thumb")}{background:transparent;border-radius:999px}` +
  `${GSH(":hover::-webkit-scrollbar-thumb")}{background:rgba(128,127,122,.45)}` +
  `${GSH("::-webkit-scrollbar-thumb:hover")}{background:rgba(128,127,122,.7)}` +
  `${GSH("::-webkit-scrollbar-corner")}{background:transparent}`;

/** Injects animation keyframes (system font — no webfonts). */
export function StyleInjector() {
  useEffect(() => {
    if (document.getElementById("g4")) return;
    const s = document.createElement("style");
    s.id = "g4";
    // :focus-visible (C3 a11y sweep): the browser default focus ring is a near-black 1px
    // outline (measured ~2.2:1 on dark surfaces, under the 3:1 UI floor) — invisible on dark
    // backgrounds. This is desktop/keyboard-only in effect (mobile taps never trigger
    // :focus-visible), so it costs nothing on the primary mobile-first surface.
    // Search shells on the header band and content sheets share one --focus-ring token, so
    // keyboard focus has the same color wherever the search field is opened.
    // .rpt-body>:first-child (ReportShell's body div, reportKit.tsx): the body itself carries a
    // consistent paddingTop for the band→content gap, but each subscreen's first element also
    // brings its OWN top margin (a section eyebrow, a stat row, a bare goal row — whatever
    // happens to render first, which for Budgets even varies by data: Overspent/Near/Within
    // budget each has a different margin-top). Rather than hunt down and hand-tune every
    // subscreen's first-child style (fragile — the "first" element for Budgets depends on which
    // section has rows), one !important rule zeroes whichever element lands there, so the
    // shell's own paddingTop is the ONE source of that gap everywhere. `!important` is required:
    // an author stylesheet !important rule is the only thing that outranks an inline `style`
    // (itself normal-priority, cascade-wise, despite the specificity myth) — see MDN cascade order.
    // `.fi` deliberately has NO `both`/`forwards` fill mode (unlike `.fu`, whose ancestors never
    // host a Sheet): a CSS *animation* keeps affecting its target property — and per the CSS
    // Animations spec, generating a stacking context for it — for as long as the animation stays
    // associated with the element, which `forwards`/`both` extends forever (the animation-name is
    // never removed). Settings.tsx wraps its active sub-screen in `.fi` (its own comment: "fi, not
    // fu — transform on an ancestor breaks position:fixed sheets"), which correctly avoided the
    // TRANSFORM/containing-block pitfall but missed this one: with `both`, that wrapper stayed a
    // stacking context forever after mounting, trapping the E2EE-enable Sheet's z-index inside it
    // — so the wide side panel's OWN always-on `transform` (`WideShell`'s `data-wide-panel`, a
    // stacking context by construction) painted OVER it regardless of the Sheet's own z-index,
    // and `elementFromPoint` inside the overlap resolved to the panel, not the Sheet (unclickable
    // at 1104/1440; verified live, and verified fixed by dropping `both` here). With the default
    // fill mode (`none`), the animation stops affecting opacity the moment it completes, so the
    // element stops being a stacking context — every current use (`.fi`'s own callers) already
    // rests at opacity:1 by then (Sheet's backdrop keeps its own dynamic drag-fade `style.opacity`
    // authored value, which is what takes over once the animation lets go), so this changes no
    // visible frame, only what happens after the fade finishes.
    s.textContent = `*{-webkit-tap-highlight-color:transparent}@keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes su{from{transform:translateY(100%)}to{transform:translateY(0)}}@keyframes sl{from{transform:translateX(-100%)}to{transform:translateX(0)}}@keyframes fi{from{opacity:0}to{opacity:1}}@keyframes sp{to{transform:rotate(360deg)}}@keyframes wg{from{transform:rotate(-.5deg)}to{transform:rotate(.5deg)}}@keyframes sk{0%,100%{opacity:.5}50%{opacity:.9}}.fu{animation:fu .4s ease-out both}.fi{animation:fi .25s ease-out}.sk{animation:sk 1.2s ease-in-out infinite}.gs::-webkit-scrollbar{width:0;height:0}${HOVER_SCROLLBAR_CSS}body{margin:0}@media(hover:hover){button:not(:disabled):hover{filter:brightness(.96)}}:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}${INPUT_FOCUS_CSS}${NAME_UNDERLINE_FOCUS_CSS}${CHECKBOX_CSS}.rpt-body>:first-child{margin-top:0 !important}`;
    document.head.appendChild(s);
  }, []);
  return null;
}

export function Header({
  month,
  onMenu,
  onPrev,
  onNext,
  onRight,
  rightIcon = "kebab",
  onBand = false,
}: {
  month: string;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRight?: () => void;
  rightIcon?: "kebab" | "pencil";
  onBand?: boolean;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const ink = onBand ? C.headerInk : C.text;
  const inkSoft = onBand ? C.headerInk : C.soft;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `12px ${P}px 6px` }}>
      <button onClick={onMenu} aria-label={t("Menu")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
        <Ico d="M4 6h16M4 12h16M4 18h16" size={21} color={ink} sw={2} />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={onPrev}
          aria-label={t("Previous month")}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
        >
          <Ico d="M15 19l-7-7 7-7" size={17} color={onBand ? C.headerInk : undefined} />
        </button>
        <span style={{ color: ink, fontSize: 18.5, fontWeight: 600, minWidth: 128, textAlign: "center", letterSpacing: 0.2 }}>{monthLabel(month, lang)}</span>
        <button onClick={onNext} aria-label={t("Next month")} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}>
          <Ico d="M9 5l7 7-7 7" size={17} color={onBand ? C.headerInk : undefined} />
        </button>
      </div>
      <button onClick={onRight} aria-label={t("More")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
        {rightIcon === "pencil" ? (
          <Ico
            d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
            size={18}
            color={onBand ? C.headerInk : undefined}
          />
        ) : (
          <svg width="20" height="20" fill={inkSoft} viewBox="0 0 24 24" style={{ opacity: onBand ? 0.75 : 1 }}>
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        )}
      </button>
    </div>
  );
}

/** `Sheet`'s (and `Surface`'s — below) exact contract, extracted so both share one type instead
 *  of two copies that could drift. No behaviour change. */
export type SheetProps = {
  show: boolean;
  onClose: () => void;
  lockSwipe?: boolean;
  tall?: boolean;
  children: ReactNode | ((C: Theme) => ReactNode);
};

/** Bottom sheet — follows the theme (dark in dark mode). Content may be a render prop `(C) => …`.
 *  `tall`: opt-in FIXED height (instead of content-driven) for sheets whose content can shrink
 *  drastically (a filtered search list) — without it, a filtered-down list collapses the sheet's
 *  height and, anchored at `bottom:0`, the whole thing can sink behind an open mobile keyboard. */
export function Sheet({ show, onClose, lockSwipe = false, tall = false, children }: SheetProps) {
  const C = useTheme();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ y0: number; scroll0: number; dy: number; active: boolean } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  // PR6 Task 5 fix: a Sheet rendered from panel-hosted content (Add's date/account/envelope
  // pickers, ImportSheet's own Sheet, its AiConsentSheet — the only PanelHost kind with Sheet
  // descendants) sits inside WideShell's panel `<div>`, which carries an always-on CSS
  // `transform` (open/closed slide, `chrome.tsx`'s sibling `WideShell.tsx`) — a non-`none`
  // transform is a containing block for `position:fixed` (house pitfall, CLAUDE.md), so without
  // this the backdrop+sheet below would be clipped to the panel's own ~400-550px column instead
  // of the real viewport. Portal to `document.body`, the SAME mechanism already used for the
  // ImportSheet full-screen editor and IconColorPicker for the identical reason. Scoped to the
  // panel host only — primary-pane and phone Sheets have no transformed ancestor and must keep
  // rendering in place: WideShell's Escape/focus-restore containment checks recognize a portaled
  // sheet via `data-wide-panel-portal` (see `panelContains` there), which only ever marks this
  // branch's output.
  const hostedInPanel = useWideHost()?.host === "panel";

  // Reset drag state on every sheet open.
  useEffect(() => {
    if (show) {
      setDragY(0);
      setDragging(false);
    }
  }, [show]);

  // WebKit hit-test kick (same flaw and same fix as ImportSheet.tsx's full-screen editor over
  // its own Sheet, and WideShell.tsx's own mount-time kick): portaling this sheet ABOVE the
  // panel's transformed (composited) layer means closing it can leave WebKit's hit-test region
  // stale on that layer until a repaint. Only the panel-hosted, portaled case introduces this —
  // primary/phone Sheets never sit above a transformed ancestor.
  const wasShown = useRef(show);
  useEffect(() => {
    const justClosed = hostedInPanel && wasShown.current && !show;
    wasShown.current = show;
    if (!justClosed) return;
    const root = document.getElementById("root");
    if (!root) return;
    root.style.opacity = "0.9999";
    const raf = requestAnimationFrame(() => {
      root.style.opacity = "";
    });
    return () => cancelAnimationFrame(raf);
  }, [show, hostedInPanel]);

  if (!show) return null;

  // tall sheets don't scroll themselves (overflowY hidden) — their inner `.gs` list does instead.
  // Drag-to-dismiss must still key off the LIST's scroll offset, not the outer container's (always 0).
  const currentScrollTop = () => {
    const el = scrollRef.current;
    if (!el) return 0;
    return tall ? (el.querySelector<HTMLElement>(".gs")?.scrollTop ?? 0) : el.scrollTop;
  };

  // lockSwipe: sheets whose body owns vertical drag (ScrollPicker wheels in DateSheet) opt out of
  // swipe-to-dismiss, otherwise spinning a wheel closes the sheet. They still close via backdrop/buttons.
  const onTouchStart = (e: React.TouchEvent) => {
    if (lockSwipe) return;
    drag.current = { y0: e.touches[0]!.clientY, scroll0: currentScrollTop(), dy: 0, active: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.touches[0]!.clientY - d.y0;
    // Engage the gesture only when content is at the top and movement is downward — don't steal regular scroll.
    if (!d.active && d.scroll0 <= 0 && dy > 4) {
      d.active = true;
      setDragging(true);
    }
    if (d.active) {
      d.dy = Math.max(0, dy);
      setDragY(d.dy);
    }
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d?.active && d.dy > 90) onClose();
    else setDragY(0);
  };

  const body = (
    <>
      <div
        className="fi"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 90,
          backdropFilter: "blur(3px)",
          opacity: 1 - Math.min(dragY / 320, 0.6),
          transition: dragging ? "none" : "opacity .25s",
        }}
      />
      <div
        ref={scrollRef}
        className="gs"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={endDrag}
        onTouchCancel={endDrag}
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          maxWidth: PHONE_COL,
          margin: "0 auto",
          zIndex: 100,
          background: C.sheet,
          borderRadius: "22px 22px 0 0",
          padding: "18px 20px calc(28px + env(safe-area-inset-bottom))",
          animation: "su .3s cubic-bezier(.4,0,.2,1)",
          boxShadow: "0 -8px 30px rgba(0,0,0,0.35)",
          ...(tall
            ? { height: "82vh", display: "flex", flexDirection: "column" as const, overflowY: "hidden" as const }
            : { maxHeight: "82vh", overflowY: "auto" as const }),
          overscrollBehavior: "contain",
          touchAction: "pan-y",
          transform: `translateY(${dragY}px)`,
          transition: dragging ? "none" : "transform .25s cubic-bezier(.4,0,.2,1)",
        }}
      >
        <div style={{ width: 40, height: 5, borderRadius: 3, background: C.line, margin: "0 auto 14px", cursor: "grab" }} />
        {typeof children === "function" ? children(C) : children}
      </div>
    </>
  );

  // `display:contents` keeps this wrapper out of layout entirely (both children are already
  // `position:fixed`) — it exists ONLY to carry `data-wide-panel-portal`, the marker WideShell's
  // containment checks look for.
  return hostedInPanel
    ? createPortal(
        <div data-wide-panel-portal style={{ display: "contents" }}>
          {body}
        </div>,
        document.body,
      )
    : body;
}

/** `Sheet`'s exact contract (`SheetProps`, above), pane-hosted on wide (spec §2's `<Surface>`,
 *  landed against PR6's pane model — PR6b): no surface host in context → this IS `Sheet`, byte-
 *  identical, so phone (and any un-hosted mount) pays nothing new. With a host present (inside the
 *  wide shell), the same children render as an overlay stacked over the right panel's derived
 *  content instead — lazy, so the presentation code lives in the wide chunk.
 *
 *  `tall`/`lockSwipe` are phone-`Sheet`-only concerns (content-driven vs. fixed height, swipe-to-
 *  dismiss) — a pane surface is a fixed column with its own scrollbar and no swipe gesture, so
 *  they are accepted (callers keep one prop shape for both branches) and silently ignored on the
 *  pane branch rather than threaded through as dead props. */
export function Surface(props: SheetProps) {
  const surfaces = useWideHost()?.surfaces ?? null;
  if (!surfaces) return <Sheet {...props} />;
  if (!props.show) return null;
  return (
    <Suspense fallback={null}>
      <PaneSurface host={surfaces} onClose={props.onClose}>
        {props.children}
      </PaneSurface>
    </Suspense>
  );
}

export type ScreenId = "start" | "budget" | "transactions" | "accounts" | "reports" | "activity" | "addExpense" | "settings";

/**
 * Enveo mark ("e" monogram) — BRAND COLORS hardcoded, independent of theme;
 * geometry 1:1 with public/favicon.svg. The only inline-logo source in the app.
 */
export function LogoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="116" fill="#1d2a47" />
      <circle cx="256" cy="256" r="118" fill="none" stroke="#ff7e6b" strokeWidth="58" />
      <line x1="152" y1="256" x2="352" y2="256" stroke="#ff7e6b" strokeWidth="52" />
      <line x1="278" y1="272" x2="424" y2="354" stroke="#1d2a47" strokeWidth="72" />
    </svg>
  );
}

export function BottomNav({ active, onNav }: { active: ScreenId; onNav: (s: ScreenId) => void }) {
  const C = useTheme();
  const { t } = useT();
  const tabs: Array<{ id: ScreenId | "add"; label?: string; d?: string }> = [
    { id: "start", label: t("Home"), d: NAV_ICONS.start },
    { id: "budget", label: t("Budget"), d: NAV_ICONS.budget },
    { id: "add" },
    { id: "transactions", label: t("Transactions"), d: NAV_ICONS.transactions },
    { id: "reports", label: t("Reports"), d: NAV_ICONS.reports },
  ];
  // data-band: the nav always paints "var(--nav-bg)" as its own background (on Duet that's the
  // navy band, `--accent` itself).
  return (
    <nav
      data-band={C.headerStyle === "band" || undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-around",
        background: "var(--nav-bg)",
        padding: "6px 0 calc(12px + env(safe-area-inset-bottom))",
        flexShrink: 0,
      }}
    >
      {/* every slot flex:1 — slot center = 1/5 of the width regardless of label lengths (otherwise "Transactions" pushes the FAB off the screen axis) */}
      {tabs.map((tab) =>
        tab.id === "add" ? (
          <div key="add" style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            <button
              onClick={() => onNav("addExpense")}
              aria-label={t("Add")}
              style={{
                width: 54,
                height: 54,
                borderRadius: "50%",
                border: "none",
                background: CTA,
                cursor: "pointer",
                marginTop: -8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 3px 10px var(--cta-40)",
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
                <line x1="12" y1="4" x2="12" y2="20" />
                <line x1="4" y1="12" x2="20" y2="12" />
              </svg>
            </button>
          </div>
        ) : (
          <button
            key={tab.id}
            onClick={() => onNav(tab.id as ScreenId)}
            style={{
              flex: 1,
              position: "relative",
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "5px 0 7px",
            }}
          >
            <Ico d={tab.d!} size={21} color={active === tab.id ? "var(--nav-on)" : "var(--nav-mute)"} sw={1.6} />
            <span style={{ fontSize: 11, fontWeight: 500, color: active === tab.id ? "var(--nav-on)" : "var(--nav-mute)", whiteSpace: "nowrap" }}>
              {tab.label}
            </span>
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: "50%",
                transform: "translateX(-50%)",
                width: 44,
                height: 3,
                borderRadius: 2,
                background: active === tab.id ? "var(--nav-ind)" : "transparent",
              }}
            />
          </button>
        ),
      )}
    </nav>
  );
}

/* Drawer glyphs (patterns from the menu-settings-hifi mock) — 1.7 stroke, zero emoji. */
const D_BANK = "M3 21h18M4 18h16M6 18V9m4 9V9m4 9V9m4 9V9M2 9l10-5 10 5z";
const D_BARS = "M4 20V10m6 10V4m6 16v-7M2 20h20";
export const D_EYE = "M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12zM12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z";
export const D_MOON = "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z";
export const D_GEAR =
  "M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33 1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82 1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z";
const D_CHEV = "M9 5l7 7-7 7";

/** Screen-nav icon paths — ONE copy shared by `BottomNav` above (phone) and the wide shell's
 *  `Rail` (`components/wide/Rail.tsx`), so the two icon languages can never drift apart (PR4
 *  task 5). A lookup rather than the plan's literal "array": every caller already knows which
 *  screen it wants and indexes by id, so a `Record` skips a `.find()` at every call site for
 *  free. chrome.tsx is already eager (BottomNav needs it on the very first paint), so Rail.tsx
 *  importing this from the lazy wide chunk adds no bytes to the phone bundle — only the wide
 *  chunk gains a reference to a string that already shipped. */
export const NAV_ICONS: Readonly<Record<"start" | "budget" | "transactions" | "reports" | "accounts", string>> = {
  start: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4",
  budget: "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z",
  transactions: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  reports: "M4 19h16M7 16v-5M12 16V8M17 16v-9",
  accounts: D_BANK,
};

/** Stroked drawer SVG icon — stroke via style (var(--cta) etc. work). */
function DrawIco({ d, size = 18, color, w = 1.7 }: { d: string; size?: number; color: string; w?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ stroke: color }}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export function Drawer({
  open,
  onClose,
  onNav,
  onOpenReports,
  onInstall,
}: {
  open: boolean;
  onClose: () => void;
  onNav: (s: ScreenId) => void;
  onOpenReports: (tab: "budgets") => void;
  onInstall: () => void;
}) {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t, tp, lang } = useT();
  const version = useLedgerVersion();
  const { state: installState } = useInstall();
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // live shortcut data from the replica — CURRENT month (not the viewed one), only while open
  const live = useMemo(() => {
    if (!open) return null;
    const ledger = store.getLedger();
    if (!ledger) return null;
    const state = computeStateResponse(ledger, currentMonth());
    return {
      budgetName: ledger.budgets[0]?.name,
      txCount: ledger.transactions.length,
      overspent: state.envelopes.some((e) => e.available < 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version]);
  if (!open) return null;

  const darkOn = settings.themeMode === "dark";
  const txCount = live?.txCount ?? 0;
  const canInstall = isInstallable(installState);
  const chevron = <DrawIco d={D_CHEV} size={14} color={C.mute} w={2} />;
  // `ariaLabel` overrides the accessible name when `right` carries meaning beyond the visible
  // `label` (the overspent dot below is `aria-hidden` — a decoration with no text alternative
  // otherwise, since the button's accessible name would just be `label` on its own).
  const shortcut = (d: string, label: string, onClick: () => void, right: ReactNode, last = false, ariaLabel?: string) => (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "12px 2px",
        background: "none",
        border: "none",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        style={{ width: 34, height: 34, borderRadius: 10, background: C.inset, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
      >
        <DrawIco d={d} color={C.soft} />
      </span>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: C.text }}>{label}</span>
      {right}
    </button>
  );
  // quick toggles: discreet / dark (light↔dark; auto → explicitly dark) / settings
  const quicks: Array<{ key: string; active: boolean; toggle: boolean; label: string; d: string; onClick: () => void }> = [
    {
      key: "discreet",
      active: settings.discreet,
      toggle: true,
      label: t("discreet"),
      d: D_EYE,
      onClick: () => setSettings({ ...settings, discreet: !settings.discreet }),
    },
    {
      key: "dark",
      active: darkOn,
      toggle: true,
      label: t("dark"),
      d: D_MOON,
      onClick: () => setSettings({ ...settings, themeMode: darkOn ? "light" : "dark" }),
    },
    {
      key: "settings",
      active: false,
      toggle: false,
      label: t("settings"),
      d: D_GEAR,
      onClick: () => {
        onClose();
        onNav("settings");
      },
    },
  ];

  return (
    <>
      <div className="fi" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 110 }} />
      <div
        onTouchStart={(e) => {
          const p = e.touches[0]!;
          swipe.current = { x: p.clientX, y: p.clientY };
        }}
        onTouchEnd={(e) => {
          const st = swipe.current;
          swipe.current = null;
          if (!st) return;
          const p = e.changedTouches[0]!;
          // left swipe on the panel closes the menu; stopPropagation — App's global gestures must not react in parallel
          if (p.clientX - st.x < -50) {
            e.stopPropagation();
            onClose();
          }
        }}
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          left: 0,
          width: 264,
          maxWidth: "82%",
          zIndex: 120,
          background: C.surface,
          borderRadius: "0 22px 22px 0",
          animation: "sl .28s cubic-bezier(.4,0,.2,1)",
          display: "flex",
          flexDirection: "column",
          padding: "20px 18px calc(16px + env(safe-area-inset-bottom))",
          boxShadow: "8px 0 32px rgba(0,0,0,0.18)",
          fontFamily: font,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, paddingTop: "env(safe-area-inset-top)" }}>
          <LogoMark size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.text, letterSpacing: 0.2 }}>Enveo</div>
            <div
              style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {live?.budgetName ?? t("Budget")} ·{" "}
              {tp("{n} transaction | {n} transactions", txCount, { n: new Intl.NumberFormat(LOCALE_OF[lang]).format(txCount) })}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18, display: "flex", flexDirection: "column" }}>
          {shortcut(
            D_BANK,
            t("Accounts"),
            () => {
              onClose();
              onNav("accounts");
            },
            chevron,
          )}
          {shortcut(
            D_BARS,
            t("Activity"),
            () => {
              onClose();
              onNav("activity");
            },
            chevron,
          )}
          {shortcut(
            D_BARS,
            t("Envelope budgets"),
            () => {
              onClose();
              onOpenReports("budgets");
            },
            live?.overspent ? <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: CORAL, flexShrink: 0 }} /> : chevron,
            !canInstall,
            live?.overspent ? t("Envelope budgets — some envelopes are over budget") : undefined,
          )}
          {canInstall &&
            shortcut(
              D_INSTALL,
              t("Install app"),
              () => {
                onClose();
                onInstall();
              },
              chevron,
              true,
            )}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: 8 }}>
          {quicks.map((q) => (
            <button
              key={q.key}
              onClick={q.onClick}
              aria-label={q.label}
              aria-pressed={q.toggle ? q.active : undefined}
              style={{
                flex: 1,
                height: 44,
                borderRadius: 12,
                border: "none",
                cursor: "pointer",
                background: q.active ? "var(--cta-18)" : C.inset,
                outline: q.active ? "1.5px solid var(--cta)" : "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <DrawIco d={q.d} size={19} color={q.active ? "var(--cta)" : C.soft} w={q.active ? 1.8 : 1.7} />
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
          {quicks.map((q) => (
            <span
              key={q.key}
              aria-hidden
              style={{ flex: 1, textAlign: "center", fontSize: 9, color: q.active ? "var(--cta)" : C.mute, fontWeight: q.active ? 700 : 500 }}
            >
              {q.label}
            </span>
          ))}
        </div>

        <div
          style={{
            marginTop: 14,
            paddingTop: 10,
            borderTop: `1px solid ${C.line}`,
            fontSize: 10,
            color: C.mute,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1.5,
          }}
        >
          {`v${APP_VERSION} · enveo.app`}
          {buildLabel() ? (
            <>
              <br />
              <span style={{ opacity: 0.85 }}>{buildLabel()}</span>
            </>
          ) : null}
        </div>
        {/* handle hinting at the swipe gesture */}
        <span
          aria-hidden
          style={{ position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)", width: 4, height: 38, borderRadius: 2, background: C.line }}
        />
      </div>
    </>
  );
}
