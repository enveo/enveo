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
import { renderWidget, type WidgetProps } from "../components/widgets";
import { useBudgetPreferences, useTheme } from "../lib/contexts";
import { useDragReorder } from "../lib/dnd";
import { useT } from "../lib/i18n";
import { font } from "../lib/theme";
import { applyResize, clampRow, clampSpan, reorderEnabled, toggleEnabled } from "../lib/wideBoard";
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
  /** Board edit-mode toggle — lifted to `App` (same shape as Start's/Budget's PR4 Task 3 pair) so
   *  the wide band's right-slot pencil can drive it; read-only here, toggled only from that slot. */
  edit: boolean;
  /** Gear target on a `configurable` tile → `WideShell`'s panel (its own local selection). */
  onWidgetSettings: (id: WideWidgetId) => void;
}

/** ROW height (px) the resize gesture assumes — the grid's own `gridAutoRows` (92) plus the gap
 *  (12), matching the approved mock's `rowH = 92 + 12` verbatim (mock :3632). */
const ROW_H = 104;

/** Round-glyph chrome buttons (gear/remove/drag handle): 30×30 hit box, small centered glyph —
 *  the house ≥30×30 rule, measured in Step 5, not just asserted here. */
const chromeBtn = (color: string): React.CSSProperties => ({
  width: 30,
  height: 30,
  minWidth: 30,
  minHeight: 30,
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

function AddTile({ candidates, onAdd, cols }: { candidates: WideWidgetConfig[]; onAdd: (id: WideWidgetId) => void; cols: number }) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div
      style={{
        gridColumn: `span ${Math.min(cols, 2)}`,
        gridRow: "span 1",
        border: `1.5px dashed ${C.line}`,
        borderRadius: 14,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        overflow: "hidden",
        minHeight: 0,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.14em", textTransform: "uppercase", color: C.mute, flexShrink: 0 }}>{t("Add widget")}</div>
      {candidates.length === 0 ? (
        <div style={{ fontSize: 11.5, color: C.mute }}>{t("Every widget is already on the grid.")}</div>
      ) : (
        <div className="gs" style={{ display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", minHeight: 0 }}>
          {candidates.map((w) => (
            <button
              key={w.id}
              onClick={() => onAdd(w.id)}
              style={{
                minHeight: 30,
                textAlign: "left",
                padding: "4px 8px",
                borderRadius: 8,
                border: "none",
                background: "none",
                cursor: "pointer",
                fontSize: 12.5,
                color: C.text,
                fontFamily: font,
              }}
            >
              {t(WIDGET_CATALOG[w.id].title)}
            </button>
          ))}
        </div>
      )}
    </div>
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
      // ONE committed op per gesture — read back whatever the last move produced, then clear the
      // gesture-local draft so the next render reads the reconciled replica again.
      setDraft((current) => {
        if (current) update({ wideWidgets: current });
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const widgetProps: Omit<WidgetProps, "opts" | "chromeless"> = { state, month, onNav, onOpenEnvelope, onOpenTxns, onQuickAdd, onOpenReport, onOpenMonthDay };

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
          const configurable = WIDGET_CATALOG[w.id].configurable;
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
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
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
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 10,
                    fontWeight: 750,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: C.mute,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {title}
                </span>
                {edit && (
                  <div style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: C.mute, fontVariantNumeric: "tabular-nums", marginRight: 2 }}>
                      {spanW}×{w.h}
                    </span>
                    {configurable && (
                      <button onClick={() => onWidgetSettings(w.id)} aria-label={t("Widget settings")} style={chromeBtn(C.soft)}>
                        ⚙
                      </button>
                    )}
                    <button onClick={() => onToggle(w.id, false)} aria-label={t("Remove from the board")} style={chromeBtn(C.neg)}>
                      ✕
                    </button>
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                {renderWidget({ id: w.id, enabled: true, opts: w.opts }, { ...widgetProps, chromeless: true }, t)}
              </div>
              {edit && (
                <button
                  onPointerDown={beginResize(w.id, spanW, w.h)}
                  aria-label={t("Size: {w} × {h} — drag the corner of the tile to resize", { w: String(spanW), h: String(w.h) })}
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
        {edit && <AddTile candidates={disabledRows} onAdd={(id) => onToggle(id, true)} cols={cols} />}
      </div>
    </div>
  );
}
