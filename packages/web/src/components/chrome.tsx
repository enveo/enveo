import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { computeStateResponse } from "@enveo/shared";
import { useLedgerVersion } from "../lib/api";
import { useSettings, useTheme } from "../lib/contexts";
import { currentMonth, monthLabel } from "../lib/dates";
import { LOCALE_OF } from "../lib/format";
import { useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { store } from "../lib/store";
import { CORAL, CTA, font, P, type Theme } from "../lib/theme";
import { APP_VERSION, buildLabel } from "../lib/version";

/** Injects animation keyframes (system font — no webfonts). */
export function StyleInjector() {
  useEffect(() => {
    if (document.getElementById("g4")) return;
    const s = document.createElement("style");
    s.id = "g4";
    s.textContent = `*{-webkit-tap-highlight-color:transparent}@keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes su{from{transform:translateY(100%)}to{transform:translateY(0)}}@keyframes sl{from{transform:translateX(-100%)}to{transform:translateX(0)}}@keyframes fi{from{opacity:0}to{opacity:1}}@keyframes sp{to{transform:rotate(360deg)}}@keyframes wg{from{transform:rotate(-.5deg)}to{transform:rotate(.5deg)}}@keyframes sk{0%,100%{opacity:.5}50%{opacity:.9}}.fu{animation:fu .4s ease-out both}.fi{animation:fi .25s ease-out both}.sk{animation:sk 1.2s ease-in-out infinite}.gs::-webkit-scrollbar{width:0;height:0}body{margin:0}@media(hover:hover){button:not(:disabled):hover{filter:brightness(.96)}}`;
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
        <button onClick={onPrev} aria-label={t("Previous month")} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}>
          <Ico d="M15 19l-7-7 7-7" size={17} color={onBand ? C.headerInk : undefined} />
        </button>
        <span style={{ color: ink, fontSize: 18.5, fontWeight: 600, minWidth: 128, textAlign: "center", letterSpacing: 0.2 }}>{monthLabel(month, lang)}</span>
        <button onClick={onNext} aria-label={t("Next month")} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}>
          <Ico d="M9 5l7 7-7 7" size={17} color={onBand ? C.headerInk : undefined} />
        </button>
      </div>
      <button onClick={onRight} aria-label={t("More")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
        {rightIcon === "pencil" ? (
          <Ico d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z" size={18} color={onBand ? C.headerInk : undefined} />
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

/** Bottom sheet — follows the theme (dark in dark mode). Content may be a render prop `(C) => …`.
 *  `tall`: opt-in FIXED height (instead of content-driven) for sheets whose content can shrink
 *  drastically (a filtered search list) — without it, a filtered-down list collapses the sheet's
 *  height and, anchored at `bottom:0`, the whole thing can sink behind an open mobile keyboard. */
export function Sheet({ show, onClose, lockSwipe = false, tall = false, children }: { show: boolean; onClose: () => void; lockSwipe?: boolean; tall?: boolean; children: ReactNode | ((C: Theme) => ReactNode) }) {
  const C = useTheme();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ y0: number; scroll0: number; dy: number; active: boolean } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Reset drag state on every sheet open.
  useEffect(() => { if (show) { setDragY(0); setDragging(false); } }, [show]);

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
    if (!d.active && d.scroll0 <= 0 && dy > 4) { d.active = true; setDragging(true); }
    if (d.active) { d.dy = Math.max(0, dy); setDragY(d.dy); }
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d?.active && d.dy > 90) onClose();
    else setDragY(0);
  };

  return (
    <>
      <div className="fi" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 90, backdropFilter: "blur(3px)", opacity: 1 - Math.min(dragY / 320, 0.6), transition: dragging ? "none" : "opacity .25s" }} />
      <div
        ref={scrollRef}
        className="gs"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={endDrag}
        onTouchCancel={endDrag}
        style={{
          position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 420, margin: "0 auto", zIndex: 100,
          background: C.sheet, borderRadius: "22px 22px 0 0", padding: "18px 20px calc(28px + env(safe-area-inset-bottom))",
          animation: "su .3s cubic-bezier(.4,0,.2,1)", boxShadow: "0 -8px 30px rgba(0,0,0,0.35)",
          ...(tall
            ? { height: "82vh", display: "flex", flexDirection: "column" as const, overflowY: "hidden" as const }
            : { maxHeight: "82vh", overflowY: "auto" as const }),
          overscrollBehavior: "contain", touchAction: "pan-y",
          transform: `translateY(${dragY}px)`,
          transition: dragging ? "none" : "transform .25s cubic-bezier(.4,0,.2,1)",
        }}
      >
        <div style={{ width: 40, height: 5, borderRadius: 3, background: C.line, margin: "0 auto 14px", cursor: "grab" }} />
        {typeof children === "function" ? children(C) : children}
      </div>
    </>
  );
}

export type ScreenId = "start" | "budget" | "transactions" | "accounts" | "reports" | "addExpense" | "settings";

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
    { id: "start", label: t("Home"), d: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" },
    { id: "budget", label: t("Budget"), d: "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" },
    { id: "add" },
    { id: "transactions", label: t("Transactions"), d: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
    { id: "reports", label: t("Reports"), d: "M4 19h16M7 16v-5M12 16V8M17 16v-9" },
  ];
  return (
    <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-around", background: "var(--nav-bg)", padding: "6px 0 calc(12px + env(safe-area-inset-bottom))", flexShrink: 0 }}>
      {/* every slot flex:1 — slot center = 1/5 of the width regardless of label lengths (otherwise "Transactions" pushes the FAB off the screen axis) */}
      {tabs.map((tab) =>
        tab.id === "add" ? (
          <div key="add" style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            <button onClick={() => onNav("addExpense")} aria-label={t("Add")} style={{ width: 54, height: 54, borderRadius: "50%", border: "none", background: CTA, cursor: "pointer", marginTop: -8, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 3px 10px var(--cta-40)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
                <line x1="12" y1="4" x2="12" y2="20" />
                <line x1="4" y1="12" x2="20" y2="12" />
              </svg>
            </button>
          </div>
        ) : (
          <button key={tab.id} onClick={() => onNav(tab.id as ScreenId)} style={{ flex: 1, position: "relative", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "5px 0 7px" }}>
            <Ico d={tab.d!} size={21} color={active === tab.id ? "var(--nav-on)" : "var(--nav-mute)"} sw={1.6} />
            <span style={{ fontSize: 11, fontWeight: 500, color: active === tab.id ? "var(--nav-on)" : "var(--nav-mute)", whiteSpace: "nowrap" }}>{tab.label}</span>
            <div style={{ position: "absolute", bottom: 0, left: "50%", transform: "translateX(-50%)", width: 44, height: 3, borderRadius: 2, background: active === tab.id ? "var(--nav-ind)" : "transparent" }} />
          </button>
        ),
      )}
    </nav>
  );
}

/* Drawer glyphs (patterns from the menu-settings-hifi mock) — 1.7 stroke, zero emoji. */
const D_BANK = "M3 21h18M4 18h16M6 18V9m4 9V9m4 9V9m4 9V9M2 9l10-5 10 5z";
const D_BARS = "M4 20V10m6 10V4m6 16v-7M2 20h20";
const D_EYE = "M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12zM12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z";
const D_MOON = "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z";
const D_GEAR =
  "M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33 1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82 1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z";
const D_CHEV = "M9 5l7 7-7 7";

/** Stroked drawer SVG icon — stroke via style (var(--cta) etc. work). */
function DrawIco({ d, size = 18, color, w = 1.7 }: { d: string; size?: number; color: string; w?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ stroke: color }} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Drawer({ open, onClose, onNav, onOpenReports }: { open: boolean; onClose: () => void; onNav: (s: ScreenId) => void; onOpenReports: (tab: "budgets") => void }) {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t, tp, lang } = useT();
  const version = useLedgerVersion();
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
  const chevron = <DrawIco d={D_CHEV} size={14} color={C.mute} w={2} />;
  const shortcut = (d: string, label: string, onClick: () => void, right: ReactNode, last = false) => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 2px", background: "none", border: "none", borderBottom: last ? "none" : `1px solid ${C.line}`, cursor: "pointer", textAlign: "left" }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: C.inset, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <DrawIco d={d} color={C.soft} />
      </span>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: C.text }}>{label}</span>
      {right}
    </button>
  );
  // quick toggles: discreet / dark (light↔dark; auto → explicitly dark) / settings
  const quicks: Array<{ key: string; active: boolean; toggle: boolean; label: string; d: string; onClick: () => void }> = [
    { key: "discreet", active: settings.discreet, toggle: true, label: t("discreet"), d: D_EYE, onClick: () => setSettings({ ...settings, discreet: !settings.discreet }) },
    { key: "dark", active: darkOn, toggle: true, label: t("dark"), d: D_MOON, onClick: () => setSettings({ ...settings, themeMode: darkOn ? "light" : "dark" }) },
    { key: "settings", active: false, toggle: false, label: t("settings"), d: D_GEAR, onClick: () => { onClose(); onNav("settings"); } },
  ];

  return (
    <>
      <div className="fi" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 110 }} />
      <div
        onTouchStart={(e) => { const p = e.touches[0]!; swipe.current = { x: p.clientX, y: p.clientY }; }}
        onTouchEnd={(e) => {
          const st = swipe.current;
          swipe.current = null;
          if (!st) return;
          const p = e.changedTouches[0]!;
          // left swipe on the panel closes the menu; stopPropagation — App's global gestures must not react in parallel
          if (p.clientX - st.x < -50) { e.stopPropagation(); onClose(); }
        }}
        style={{ position: "fixed", top: 0, bottom: 0, left: 0, width: 264, maxWidth: "82%", zIndex: 120, background: C.surface, borderRadius: "0 22px 22px 0", animation: "sl .28s cubic-bezier(.4,0,.2,1)", display: "flex", flexDirection: "column", padding: "20px 18px calc(16px + env(safe-area-inset-bottom))", boxShadow: "8px 0 32px rgba(0,0,0,0.18)", fontFamily: font }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, paddingTop: "env(safe-area-inset-top)" }}>
          <LogoMark size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.text, letterSpacing: 0.2 }}>Enveo</div>
            <div style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {live?.budgetName ?? t("Budget")} · {tp("{n} transaction | {n} transactions", txCount, { n: new Intl.NumberFormat(LOCALE_OF[lang]).format(txCount) })}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18, display: "flex", flexDirection: "column" }}>
          {shortcut(D_BANK, t("Accounts"), () => { onClose(); onNav("accounts"); }, chevron)}
          {shortcut(
            D_BARS,
            t("Envelope budgets"),
            () => { onClose(); onOpenReports("budgets"); },
            live?.overspent ? <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: CORAL, flexShrink: 0 }} /> : chevron,
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
              style={{ flex: 1, height: 44, borderRadius: 12, border: "none", cursor: "pointer", background: q.active ? "var(--cta-18)" : C.inset, outline: q.active ? "1.5px solid var(--cta)" : "none", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <DrawIco d={q.d} size={19} color={q.active ? "var(--cta)" : C.soft} w={q.active ? 1.8 : 1.7} />
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
          {quicks.map((q) => (
            <span key={q.key} aria-hidden style={{ flex: 1, textAlign: "center", fontSize: 9, color: q.active ? "var(--cta)" : C.mute, fontWeight: q.active ? 700 : 500 }}>{q.label}</span>
          ))}
        </div>

        <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${C.line}`, fontSize: 10, color: C.mute, fontVariantNumeric: "tabular-nums", lineHeight: 1.5 }}>
          {`v${APP_VERSION} · enveo.app`}
          {buildLabel() ? (
            <>
              <br />
              <span style={{ opacity: 0.85 }}>{buildLabel()}</span>
            </>
          ) : null}
        </div>
        {/* handle hinting at the swipe gesture */}
        <span aria-hidden style={{ position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)", width: 4, height: 38, borderRadius: 2, background: C.line }} />
      </div>
    </>
  );
}
