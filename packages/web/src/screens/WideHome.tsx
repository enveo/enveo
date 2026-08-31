/**
 * The wide Home board (pr5-task-6-brief.md) — a dense CSS grid of the same report-backed widgets
 * Start's phone stack offers, laid out and sized by the user rather than stacked in a fixed
 * order. Mounted by `WideShell` in place of the phone `StartScreen` once `mode !== "phone"` — this
 * module is statically imported BY `WideShell` (itself behind `LazyChunk` from `App.tsx`), so it
 * ships in the wide chunk at zero eager cost; nothing here is ever reachable from the phone
 * bundle's static-import graph.
 *
 * Persistence is `preferences.wideWidgets` (`@enveo/shared` schemaVersion 2) via
 * `useBudgetPreferences()` directly — NOT `useSettings()`, which only projects the phone stack
 * (`startWidgets`). The two lists are independent (spec §7's table row, PR5 reconciliation
 * decision 3): resizing/reordering/toggling here never touches the phone Start stack, and vice
 * versa.
 *
 * Edit mode (`edit`, App-owned — see `WideShell`'s band right-slot handoff) only changes the tile
 * CHROME: dashed border, jiggle, drag handle, size hint, gear (configurable widgets only), remove
 * ✕, and the corner resize handle. The widget BODY is unaffected either way — `renderWidget` is
 * called with `chromeless: true` so a body that supports it (the six PR5 report-backed widgets)
 * skips its own phone SectionEyebrow+CardBox; the four "original" wide-capable widgets
 * (envelopes/envelopesSavings/reportCashflow/reportNetWorth) do not read `chromeless` at all
 * (widgets.tsx's own doc comment: "stay untouched") and keep rendering their own inner eyebrow —
 * an accepted, pre-existing scoping decision from Task 4, not something this task revisits.
 *
 * Resize and reorder each commit exactly ONE `update({ wideWidgets })` op per gesture (pointerup /
 * drop), never one per pointermove — the outbox is not a scroll buffer. A resize's live feedback
 * lives in local `draft` state only; a reorder's live feedback is `useDragReorder`'s own direct
 * DOM transform (no React state during the drag at all, same as `EditWidgetsSheet`).
 */
import type { StateResponse, WideWidgetConfig, WideWidgetId } from "@enveo/shared";
import { useRef, useState } from "react";
import type { ScreenId } from "../components/chrome";
import { EnvelopePillGrid } from "../components/wide/homeBodies";
import { renderWidget, type WidgetProps } from "../components/widgets";
import { useBudgetPreferences, useTheme } from "../lib/contexts";
import { useDragReorder } from "../lib/dnd";
import { useT } from "../lib/i18n";
import { font } from "../lib/theme";
import { applyResize, clampRow, clampSpan, commitResetLayout, reorderEnabled, resolveWidgetScroll, toggleEnabled } from "../lib/wideBoard";
import { WIDGET_CATALOG } from "../lib/widgetCatalog";
import type { ReportTab } from "./reports/types";

export interface WideHomeProps {
  mode: "fold" | "desktop";
  state: StateResponse;
  month: string;
  onNav: (s: ScreenId) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onOpenReport: (tab: ReportTab) => void;
  onOpenMonthDay: (date: string) => void;
  

  edit: boolean;
   
  onWidgetSettings: (id: WideWidgetId) => void;
  /** Owner round 6 item 28: the edit-mode "+" tile → `WideShell`'s panel picker. The board itself
   *  never renders the candidate list any more (see `AddTile`); the PLACEMENT still happens through
   *  the same `toggleEnabled`/`update({ wideWidgets })` path every other edit gesture uses, just
   *  from the picker body (PanelHost) instead of from this cell. */
  onAddWidget: () => void;
  

  onFillGoals: () => void;
}






const WIDGET_REPORT_TAB: Partial<Record<WideWidgetId, ReportTab>> = {
  attention: "budgets",
  spending: "spending",
  reportCashflow: "cashflow",
  reportNetWorth: "assets",
  goals: "goals",
  trends: "trends",
  heatmap: "month",
};



const ROW_H = 104;










const HEADER_HIT_MARGIN = "-8.5px 0";

/** Round-glyph chrome buttons (gear/remove/drag handle): 30×30 hit box, small centered glyph —
 *  the house ≥30×30 rule, measured in Step 5, not just asserted here. Layout height is ~13px
 *  (`HEADER_HIT_MARGIN`) so edit-mode chrome doesn't re-inflate the header row it sits in. */
const chromeBtn = (color: string): React.CSSProperties => ({
  width: 30,
  height: 30,
  minWidth: 30,
  minHeight: 30,
  margin: HEADER_HIT_MARGIN,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "none",
  color,
  cursor: "pointer",
  borderRadius: 8,
  flexShrink: 0,
});

/**
 * The board's trailing EDIT-MODE cell: the design's own ghost tile (v3.dc.html:614-621 — `span 1`
 * column × `span 2` rows, 1.5px dashed `T.line`, radius 14, centered, muted, its label the design's
 * literal "＋ Add widget" copy at 13px/650).
 *
 * What this deliberately does NOT port is the design's own `homeAddOpen` behaviour, which expanded
 * that same tile into an internally-scrolling list of widget names INSIDE the cell (v3:3670-3676).
 * Owner round 6 item 28 rejects that outright ("tragiczne"): a picker squeezed into one 1×2 grid
 * cell can show ~2 rows of a ten-widget catalogue. The affordance stays exactly the design's; the
 * choosing moves to the right panel (`PanelView` kind `widgetPicker`), which is where every other
 * board-editing surface already lives (the gear's `widgets` kind) — ONE pane machine, one more kind.
 *
 * EXHAUSTED STATE (requirement (d), decided from the design): the design keeps the tile mounted and
 * answers with its own copy, "Every widget is already on the grid." — so this tile stays visible
 * with that text and simply stops being a button (no picker to open, nothing to place). Hiding it
 * would also drop the "Reset layout" rhythm's last grid cell and make the board silently change
 * shape at the exact moment the user is arranging it.
 */
function AddTile({ candidates, onOpenPicker }: { candidates: number; onOpenPicker: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const exhausted = candidates === 0;
  const shared: React.CSSProperties = {
    gridColumn: "span 1",
    gridRow: "span 2",
    border: `1.5px dashed ${C.line}`,
    borderRadius: 14,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    color: C.mute,
    overflow: "hidden",
    minHeight: 0,
    textAlign: "center",
    fontFamily: font,
  };
  if (exhausted) {
    return (
      <div data-wide-add-tile="exhausted" style={shared}>
        <span style={{ fontSize: 11.5, lineHeight: 1.45 }}>{t("Every widget is already on the grid.")}</span>
      </div>
    );
  }
  return (
    <button
      data-wide-add-tile="plus"
      type="button"
      onClick={onOpenPicker}
      aria-label={t("Add widget")}
      style={{ ...shared, background: "none", cursor: "pointer" }}
    >
      {


}
      <span aria-hidden style={{ fontSize: 26, lineHeight: 1, fontWeight: 400 }}>
        ＋
      </span>
      <span style={{ fontSize: 13, fontWeight: 650 }}>{t("Add widget")}</span>
    </button>
  );
}

export function WideHome({
  mode,
  state,
  month,
  onNav,
  onOpenEnvelope,
  onOpenTxns,
  onQuickAdd,
  onOpenReport,
  onOpenMonthDay,
  edit,
  onWidgetSettings,
  onAddWidget,
  onFillGoals,
}: WideHomeProps) {
  const C = useTheme();
  const { t } = useT();
  const cols = mode === "fold" ? 2 : 4;
  const { preferences, update } = useBudgetPreferences();
  const board = preferences.wideWidgets;
  // Gesture-local only: a resize's live feedback, never committed until pointerup. `null` outside
  // an in-flight resize, so `rows` below reads straight from the reconciled replica the rest of
  // the time.
  const [draft, setDraft] = useState<WideWidgetConfig[] | null>(null);
  const rows = draft ?? board;
  const gridRef = useRef<HTMLDivElement | null>(null);

  const enabledRows = rows.filter((w) => w.enabled);
  const disabledRows = rows.filter((w) => !w.enabled);

  const commitMove = (from: number, to: number) => update({ wideWidgets: reorderEnabled(board, from, to) });
  const dnd = useDragReorder(commitMove);

  const onToggle = (id: WideWidgetId, enabled: boolean) => update({ wideWidgets: toggleEnabled(board, id, enabled) });

  const openWidget = (id: WideWidgetId) => {
    if (id === "recent") {
      onOpenTxns();
      return;
    }
    if (id === "envelopes" || id === "envelopesSavings") {
      onNav("budget");
      return;
    }
    const tab = WIDGET_REPORT_TAB[id];
    if (tab) onOpenReport(tab);
  };

  /** Pointer-based corner resize (mock :3627-3641 ported to pointer events, commit-on-up). `w0`
   *  is the CURRENTLY RENDERED (clamped) span, not the raw stored one — the mock's own `wOf`
   *  already clamps before the gesture starts, so dragging a desktop-authored wide tile on the
   *  fold begins from what's actually on screen; a release with no movement can therefore commit
   *  the clamped width, same as the approved mock. */
  const beginResize = (id: WideWidgetId, w0: number, h0: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    const cellW = (grid.clientWidth - 12 * (cols - 1)) / cols + 12;
    const base = rows;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => {
      const nw = clampSpan(w0 + Math.round((ev.clientX - sx) / cellW), cols);
      const nh = clampRow(h0 + Math.round((ev.clientY - sy) / ROW_H));
      setDraft(applyResize(base, id, nw, nh));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      

      setDraft((current) => {
        if (current) update({ wideWidgets: current });
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const widgetProps: Omit<WidgetProps, "opts" | "chromeless"> = {
    state,
    month,
    onNav,
    onOpenEnvelope,
    onOpenTxns,
    onQuickAdd,
    onOpenReport,
    onOpenMonthDay,
    onFillGoals,
  };

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", padding: 14 }}>
      {/* Zero eager bytes: this lives inside the wide chunk only (WideHome's own header comment),
       *  not `StyleInjector` (the phone-eager global stylesheet). */}
      <style>{"@keyframes wideHomeJiggle { 0%, 100% { transform: rotate(-0.6deg); } 50% { transform: rotate(0.6deg); } }"}</style>
      <div
        ref={gridRef}
        data-wide-board
        style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: 92, gridAutoFlow: "dense", gap: 12 }}
      >
        {enabledRows.map((w, idx) => {
          const b = dnd.bind(idx);
          const title = t(WIDGET_CATALOG[w.id].title);
          const spanW = clampSpan(w.w, cols);
          return (
            <div
              key={w.id}
              ref={dnd.itemRef(idx)}
              style={{
                position: "relative",
                gridColumn: `span ${spanW}`,
                gridRow: `span ${w.h}`,
                background: C.card,
                border: edit ? "1.5px dashed var(--accent)" : `1px solid ${C.line}`,
                borderRadius: 14,
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                

                gap: 9,
                overflow: "hidden",
                minHeight: 0,
                outline: dnd.over === idx && dnd.dragging !== idx ? "2px dashed var(--accent)" : "none",
                outlineOffset: -2,
                animation: edit ? `wideHomeJiggle ${(0.32 + (idx % 3) * 0.03).toFixed(2)}s ease-in-out infinite` : "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                {edit && (
                  <span
                    {...b}
                    aria-label={t("Drag {name}", { name: title })}
                    style={{
                      ...b.style,
                      width: 30,
                      height: 30,
                      margin: HEADER_HIT_MARGIN,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: C.mute,
                      fontSize: 14,
                      flexShrink: 0,
                    }}
                  >
                    ≡
                  </span>
                )}
                <button
                  type="button"
                  

                  onClick={edit ? undefined : () => openWidget(w.id)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 30,
                    display: "flex",
                    alignItems: "center",
                    textAlign: "left",
                    padding: 0,
                    margin: HEADER_HIT_MARGIN,
                    border: "none",
                    background: "none",
                    fontFamily: font,
                    fontSize: 10,
                    fontWeight: 750,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color: C.mute,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    cursor: edit ? "default" : "pointer",
                  }}
                >
                  {title} ›
                </button>
                {edit && (
                  <div style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: C.mute, fontVariantNumeric: "tabular-nums", marginRight: 2 }}>
                      {spanW}×{w.h}
                    </span>
                    {/* The gear panel offers Size + Scrolling for every wide widget now (owner round
                        3 item 14) — the design's own `HAS_SETTINGS` map is `true` for every id
                        (v3.dc.html:3606), so unlike the phone catalogue's `configurable` flag
                        (quickActions/accounts/envelopes only, a DIFFERENT "has an options body"
                        concept) this is never gated per widget. */}
                    <button onClick={() => onWidgetSettings(w.id)} aria-label={t("Widget settings")} style={chromeBtn(C.soft)}>
                      ⚙
                    </button>
                    <button onClick={() => onToggle(w.id, false)} aria-label={t("Remove from the grid")} style={chromeBtn(C.neg)}>
                      ✕
                    </button>
                  </div>
                )}
              </div>
              <div
                // gsh (chrome.tsx): tile-body scrollbars stay invisible until hovered — owner
                // ruling, parity owner round 1 item 2. `resolveWidgetScroll` is the gear panel's
                // "Scroll inside the tile" toggle (owner round 3 item 14) resolved to an effective
                // boolean — false clips (a stat/chart block never legitimately scrolls, so a
                // native scrollbar there is always a layout bug showing through).
                className="gsh"
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: resolveWidgetScroll(w) ? "auto" : "hidden",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {w.id === "envelopes" || w.id === "envelopesSavings" ? (
                  // Wide-only design grammar (B3): a compact pill grid, not the phone `EnvRow` list
                  // `renderWidget` would otherwise reach for — `envelopesSavings` always forces
                  // "savings", same as the phone `EnvelopesSavingsWidget` wrapper (widgets.tsx).
                  <EnvelopePillGrid
                    state={state}
                    month={month}
                    mode={w.id === "envelopesSavings" ? "savings" : (w.opts?.mode ?? "all")}
                    onOpenEnvelope={onOpenEnvelope}
                  />
                ) : (
                  renderWidget({ id: w.id, enabled: true, opts: w.opts }, { ...widgetProps, chromeless: true, tile: { w: spanW, h: w.h } }, t)
                )}
              </div>
              {edit && (
                <button
                  onPointerDown={beginResize(w.id, spanW, w.h)}
                  aria-label={t("Size: {w} × {h} — drag the ◢ corner on the tile to resize", { w: String(spanW), h: String(w.h) })}
                  style={{
                    position: "absolute",
                    right: 0,
                    bottom: 0,
                    width: 30,
                    height: 30,
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "flex-end",
                    padding: 4,
                    border: "none",
                    background: "none",
                    color: "var(--accent)",
                    cursor: "nwse-resize",
                    touchAction: "none",
                    zIndex: 2,
                  }}
                >
                  ◢
                </button>
              )}
            </div>
          );
        })}
        {edit && <AddTile candidates={disabledRows.length} onOpenPicker={onAddWidget} />}
      </div>
      {edit && (
        // The only way an EXISTING board (whose stored layout reconciliation deliberately keeps)
        // can adopt the shipped default row map — see `commitResetLayout`. Edit-mode only, under
        // the grid next to the Add tile it complements; ≥30×30 hit target (house rule, measured).
        <div style={{ display: "flex", justifyContent: "center", padding: "14px 0 2px" }}>
          <button
            onClick={() => commitResetLayout(update)}
            style={{
              minWidth: 30,
              minHeight: 30,
              padding: "6px 16px",
              borderRadius: 10,
              border: `1.5px dashed ${C.line}`,
              background: "none",
              color: C.mute,
              fontSize: 12,
              fontWeight: 650,
              fontFamily: font,
              cursor: "pointer",
            }}
          >
            {t("Reset layout")}
          </button>
        </div>
      )}
    </div>
  );
}
