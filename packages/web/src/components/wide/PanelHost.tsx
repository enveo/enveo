import type { Transaction, WideWidgetId, WidgetOpts } from "@enveo/shared";
import { lazy } from "react";
import type { StateResponse } from "../../lib/api";
import { useBudgetPreferences, useTheme } from "../../lib/contexts";
import { type Message, msg, useT } from "../../lib/i18n";
import { font } from "../../lib/theme";
import { WIDGET_CATALOG } from "../../lib/widgetCatalog";
import { AddScreen, type Tab as AddTab } from "../../screens/Add";
import type { ReportView } from "../../screens/reports/types";
import { TITLES } from "../../screens/reports/types";
import { LazyChunk } from "../lazy";
import type { PanelView } from "./panel";

// Same resolved module App.tsx already `lazy()`s for the full-screen phone summary — Vite
// dedupes a dynamically-imported module by its resolved id, so this does NOT create a second
// chunk for Envelope; it just adds another entry point into the SAME one.
const EnvelopeScreen = lazy(() => import("../../screens/Envelope").then((m) => ({ default: m.EnvelopeScreen })));
// Same dedupe as above, this time for Reports (Task 6): the panel's report variant renders a
// SECOND `ReportsScreen` instance beside the primary pane's — the primary always shows the hub
// there (App forces its `view` to "overview"), this one always shows a specific tab
// (`resolvePanel` only ever produces the `report` kind for a non-"overview" `reportsView`).
const ReportsScreen = lazy(() => import("../../screens/Reports").then((m) => ({ default: m.ReportsScreen })));
// The wide board's gear target (PR5 Task 6) reuses the phone edit sheet's envelope-mode options
// body verbatim (one options UI, not a second implementation) — dynamically imported, exactly
// like the two screens above, so the ~500-line `EditWidgetsSheet` module stays out of the wide
// chunk's static graph; Vite dedupes it with Start.tsx's own `lazy()` import of the same module.
const EnvelopesOptions = lazy(() => import("../EditWidgetsSheet").then((m) => ({ default: m.EnvelopesOptions })));

const HINT_COPY: Record<"envelope" | "report" | "generic", Message> = {
  envelope: msg("Choose an envelope to see its summary."),
  report: msg("Choose a report to open it here."),
  generic: msg("Nothing is open in this panel yet."),
};

/**
 * The `widgets` panel body (pr5-task-6-brief.md §3): the wide board's gear target. Reads/writes
 * `wideWidgets` directly via `useBudgetPreferences()` — no new props on `PanelHost` itself, the
 * same way `EnvelopesWidget`/`AccountsWidget` already read the replica straight from context
 * rather than threading it through every intermediate component. Per F4 there is no scroll
 * toggle and no options body beyond envelopes' selection mode (the only WIDE_WIDGET_ID the
 * catalogue marks `configurable`), so `envelopes` is the only id below with an options section.
 */
function WidgetSettingsPanel({ widgetId, state, onClose }: { widgetId: WideWidgetId; state: StateResponse; onClose: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { preferences, update } = useBudgetPreferences();
  const widget = preferences.wideWidgets.find((w) => w.id === widgetId);
  // Defensive, not expected: `reconcileBudgetPreferences` always fills every WIDE_WIDGET_IDS
  // entry, so this only fires if `widgetId` somehow named an id outside that set.
  if (!widget) return null;
  const setOpts = (opts: WidgetOpts) =>
    update({ wideWidgets: preferences.wideWidgets.map((w) => (w.id === widgetId ? { ...w, opts: { ...w.opts, ...opts } } : w)) });
  const remove = () => {
    update({ wideWidgets: preferences.wideWidgets.map((w) => (w.id === widgetId ? { ...w, enabled: false } : w)) });
    onClose();
  };
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t(WIDGET_CATALOG[widgetId].title)}</div>
      <div style={{ fontSize: 11.5, color: C.mute, marginBottom: 14 }}>
        {t("Size: {w} × {h} — drag the corner of the tile to resize", { w: String(widget.w), h: String(widget.h) })}
      </div>
      {widgetId === "envelopes" && (
        <LazyChunk variant="silent">
          <EnvelopesOptions w={widget} state={state} onChange={setOpts} />
        </LazyChunk>
      )}
      <button
        onClick={remove}
        style={{
          width: "100%",
          marginTop: 16,
          padding: "10px 0",
          minHeight: 36,
          borderRadius: 10,
          border: `1px solid ${C.neg}`,
          background: "transparent",
          color: C.neg,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        {t("Remove from the board")}
      </button>
    </div>
  );
}

/** This panel instance of `ReportsScreen` never renders the hub variant — its `view` is always a
 *  specific tab, never "overview" (see the `ReportsScreen` import comment above) — so `onMenu`
 *  (wired only to the phone-only hamburger inside `ReportShell`'s hub variant) is provably
 *  unreachable here. A real no-op, not a stand-in for `onClose` (a wrong callback would be worse
 *  than an honest one that never fires). */
function noop() {}

function assertNever(x: never): never {
  throw new Error(`PanelHost: unhandled panel kind ${JSON.stringify(x)}`);
}

/**
 * The panel's body for the CURRENT `PanelView`, behind a slim header (context label + ✕ close,
 * both ≥30px). This header is real, load-bearing chrome for every kind — including `empty`,
 * whose ✕ is the only way left to close the panel (pr4-task-4-brief.md §4d) — not a
 * transcription of the demo's dead `contextTab`/`ctx.back` machinery. PR6 extends it unmodified
 * for the `add` kind it introduces.
 *
 * `onClose` already encodes the CURRENT kind's close semantics (WideShell computes it from the
 * same `view` this component renders) — the ✕ button and WideShell's Escape handler both call
 * the identical function, so the two paths can never disagree about what "close" means here.
 */
export function PanelHost({
  view,
  onClose,
  onOpenTxns,
  state,
  month,
  monthDay,
  onSelectDay,
  onView,
  onOpenEnvelope,
  onFillGoals,
  onEditTxn,
  onPrev,
  onNext,
  editTxn,
  addPreset,
  onDoneEdit,
}: {
  view: PanelView;
  onClose: () => void;
  onOpenTxns: (f?: { envId?: string; accId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => void;
  /** Task 6 additions below — only consumed by the `report` kind's `ReportsScreen` instance, but
   *  kept as flat required props (matching `view`/`onClose`/`onOpenTxns` above) rather than an
   *  optional bag: this component is lazy-chunk-only, so the §3f eager-byte pressure that drove
   *  WideShell's own prop-bag grouping (pr4-context.md §11) does not apply here. */
  state: StateResponse;
  month: string;
  monthDay: string | null;
  onSelectDay: (date: string | null) => void;
  onView: (v: ReportView) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onFillGoals: () => void;
  onEditTxn: (t: Transaction) => void;
  onPrev: () => void;
  onNext: () => void;
  /** PR6 Task 2: the `add` kind's own props — App's edit/preset state, same as the phone
   *  column's `AddScreen` already reads (App.tsx's `screenEl`). */
  editTxn: Transaction | null;
  addPreset: { tab?: AddTab; importSheet?: boolean };
  onDoneEdit: () => void;
}) {
  const C = useTheme();
  const { t } = useT();

  const label = view.kind === "report" ? t(TITLES[view.view]) : view.kind === "widgets" ? t("Widget settings") : "";

  const body = (() => {
    switch (view.kind) {
      case "empty":
        return (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
            <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.5 }}>{t(HINT_COPY[view.hint])}</span>
          </div>
        );
      case "envelope":
        return (
          <LazyChunk>
            <EnvelopeScreen envelopeId={view.envelopeId} initialMonth={view.month} onBack={onClose} onOpenTxns={onOpenTxns} />
          </LazyChunk>
        );
      case "report":
        // The subscreen's own back chevron calls `onView("overview")` — same as the ✕ below, it
        // resolves the panel back to the empty "report" hint rather than fully collapsing the
        // panel (pr4-task-6-brief.md §6). Both `ReportsScreen` instances share App's `month`/
        // `onPrev`/`onNext`, so this subscreen's own mini month-nav drives the SAME axis the band
        // header and rail card read from — never a second, independently-paged month.
        return (
          <LazyChunk>
            <ReportsScreen
              state={state}
              month={month}
              view={view.view}
              onView={onView}
              monthDay={monthDay}
              onSelectDay={onSelectDay}
              onOpenEnvelope={onOpenEnvelope}
              onFillGoals={onFillGoals}
              onEditTxn={onEditTxn}
              onMenu={noop}
              onPrev={onPrev}
              onNext={onNext}
              onOpenTxns={onOpenTxns}
            />
          </LazyChunk>
        );
      case "widgets":
        return <WidgetSettingsPanel widgetId={view.widgetId} state={state} onClose={onClose} />;
      case "add":
        // AddScreen already ships in the EAGER bundle (App.tsx: "AddScreen with the whole
        // transaction-entry subtree" — the app's most-repeated action), so unlike EnvelopeScreen/
        // ReportsScreen/EnvelopesOptions above there is no separate chunk to `lazy()`/dedupe here:
        // a plain static import just references the already-loaded module. `AddHeader`'s own back
        // arrow (rendered inside `AddScreen`) IS this pane's close per D5/D4's mockup-inconsistency
        // note — it calls the SAME `onDoneEdit` the header ✕ above calls (see `WideShell`'s
        // `closePanel`), so the two paths can't disagree here either. Still unreached in practice
        // today: `App.tsx`'s wide branch keeps the phone-column takeover for Add until a later
        // task removes that gate (same "wired, unreached" precedent as Task 1's `add` kind itself).
        return <AddScreen state={state} editTxn={editTxn} onDone={onDoneEdit} initialTab={addPreset.tab} initialImport={addPreset.importSheet} />;
      default:
        return assertNever(view);
    }
  })();

  return (
    <>
      {/* data-wide-panel-header: stable test hook (data-wide-rail/-band idiom) — the
          verification playbook's touch-target sweep selects `[data-wide-panel-header] button`. */}
      <div
        data-wide-panel-header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          minHeight: 30,
          padding: "10px 14px",
          borderBottom: `1px solid ${C.line}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {label}
        </span>
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
      {body}
    </>
  );
}
