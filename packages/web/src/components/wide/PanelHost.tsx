import type { Transaction, WideWidgetId, WidgetOpts } from "@enveo/shared";
import { lazy } from "react";
import type { StateResponse } from "../../lib/api";
import { useBudgetPreferences, useTheme } from "../../lib/contexts";
import { type Message, msg, useT } from "../../lib/i18n";
import { font, TEAL, tint } from "../../lib/theme";
import { resolveWidgetScroll, toggleEnabled } from "../../lib/wideBoard";
import { WIDGET_CATALOG } from "../../lib/widgetCatalog";
import { AddScreen, type Tab as AddTab } from "../../screens/Add";
import type { ReportView } from "../../screens/reports/types";
import { TITLES } from "../../screens/reports/types";
import { LazyChunk } from "../lazy";
import { AccountPanel } from "./AccountPanel";
import { EnvelopePanel } from "./EnvelopePanel";
import type { PanelView } from "./panel";
import { TxnPanel } from "./TxnPanel";

// Vite dedupes a dynamically-imported module by its resolved id: App.tsx already `lazy()`s
// `screens/Reports` for the phone full-screen stack, so this does NOT create a second chunk for
// Reports — it just adds another entry point into the SAME one. The panel's report variant
// renders a SECOND `ReportsScreen` instance beside the primary pane's — the primary always shows
// the hub there (App forces its `view` to "overview"), this one always shows a specific tab
// (`resolvePanel` only ever produces the `report` kind for a non-"overview" `reportsView`).
const ReportsScreen = lazy(() => import("../../screens/Reports").then((m) => ({ default: m.ReportsScreen })));

const EnvelopesOptions = lazy(() => import("../EditWidgetsSheet").then((m) => ({ default: m.EnvelopesOptions })));

const HINT_COPY: Record<"envelope" | "report" | "account" | "generic", Message> = {
  envelope: msg("Choose an envelope to see its summary."),
  report: msg("Choose a report to open it here."),

  account: msg("Choose an account to see its details."),
  generic: msg("Nothing is open in this panel yet."),
};

const EYEBROW_STYLE: React.CSSProperties = { fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase" };

function WidgetSettingsPanel({ widgetId, state, onClose }: { widgetId: WideWidgetId; state: StateResponse; onClose: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { preferences, update } = useBudgetPreferences();
  const widget = preferences.wideWidgets.find((w) => w.id === widgetId);
  // Defensive, not expected: `reconcileBudgetPreferences` always fills every WIDE_WIDGET_IDS
  // entry, so this only fires if `widgetId` somehow named an id outside that set.
  if (!widget) return null;
  const scrollOn = resolveWidgetScroll(widget);
  const setOpts = (opts: WidgetOpts) =>
    update({ wideWidgets: preferences.wideWidgets.map((w) => (w.id === widgetId ? { ...w, opts: { ...w.opts, ...opts } } : w)) });
  const toggleScroll = () => update({ wideWidgets: preferences.wideWidgets.map((w) => (w.id === widgetId ? { ...w, scroll: !scrollOn } : w)) });
  const remove = () => {
    update({ wideWidgets: preferences.wideWidgets.map((w) => (w.id === widgetId ? { ...w, enabled: false } : w)) });
    onClose();
  };
  return (
    <div className="gsh" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ ...EYEBROW_STYLE, color: C.mute }}>{t("Size on the grid")}</span>
        <span style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5 }}>
          {t("Size: {w} × {h} — drag the ◢ corner on the tile to resize", { w: String(widget.w), h: String(widget.h) })}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ ...EYEBROW_STYLE, color: C.mute }}>{t("Scrolling")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={scrollOn}
          onClick={toggleScroll}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minHeight: 30,
            padding: 0,
            border: "none",
            background: "none",
            cursor: "pointer",
            fontFamily: font,
          }}
        >
          <span
            style={{
              width: 38,
              height: 22,
              borderRadius: 999,
              background: scrollOn ? TEAL : C.line,
              position: "relative",
              flexShrink: 0,
              transition: "background .15s",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: scrollOn ? 18 : 2,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 1px 2px rgba(20,20,28,0.2)",
                transition: "left .15s",
              }}
            />
          </span>
          <span style={{ fontSize: 12.5, color: C.text }}>{t("Scroll inside the tile")}</span>
        </button>
        <span style={{ fontSize: 11, color: C.mute }}>
          {scrollOn ? t("Content scrolls when it does not fit the tile.") : t("Overflowing content is clipped at the tile edge.")}
        </span>
      </div>
      {widgetId === "envelopes" && (
        <LazyChunk variant="silent">
          <EnvelopesOptions w={widget} state={state} onChange={setOpts} />
        </LazyChunk>
      )}
      <button
        onClick={remove}
        style={{
          alignSelf: "flex-start",
          minHeight: 30,
          padding: "8px 13px",
          borderRadius: 9,
          border: `1px solid ${tint(C.neg, 0.32)}`,
          background: "transparent",
          color: C.neg,
          fontSize: 12,
          fontWeight: 650,
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        {t("Remove from the grid")}
      </button>
    </div>
  );
}

function WidgetPickerPanel({ onClose }: { onClose: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const { preferences, update } = useBudgetPreferences();
  const candidates = preferences.wideWidgets.filter((w) => !w.enabled);
  const place = (id: WideWidgetId) => {
    update({ wideWidgets: toggleEnabled(preferences.wideWidgets, id, true) });
    onClose();
  };
  return (
    <div className="gsh" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={{ ...EYEBROW_STYLE, color: C.mute }}>{t("Not on the board")}</span>
      {candidates.length === 0 ? (
        <span style={{ fontSize: 12, color: C.mute, lineHeight: 1.5 }}>{t("Every widget is already on the grid.")}</span>
      ) : (
        candidates.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => place(w.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 3,
              minHeight: 30,
              padding: "10px 12px",
              borderRadius: 11,
              border: `1px solid ${C.line}`,
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: font,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 650, color: C.text }}>
              {/* The plus is the design's own add-option copy ("＋ {name}", v3.dc.html:613); hidden
                  from assistive tech so the row announces the widget's name, not "plus". */}
              <span aria-hidden>{"＋ "}</span>
              {t(WIDGET_CATALOG[w.id].title)}
            </span>
            {/* Always present for a wide id — pinned by widgetCatalog.test.ts, so this is a type
                narrowing, not a real fallback. */}
            {WIDGET_CATALOG[w.id].description && <span style={{ fontSize: 11, color: C.mute, lineHeight: 1.45 }}>{t(WIDGET_CATALOG[w.id].description!)}</span>}
          </button>
        ))
      )}
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
  onEditAccountTxn,
  onEditEnvelopeTxn,
  onEditTxnPanel,
  onDuplicateTxnPanel,
  onPrev,
  onNext,
  editTxn,
  addPreset,
  onDoneEdit,
}: {
  view: PanelView;
  onClose: () => void;
  onOpenTxns: (f?: { envId?: string; accId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => void;

  state: StateResponse;
  month: string;
  monthDay: string | null;
  onSelectDay: (date: string | null) => void;
  onView: (v: ReportView) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onFillGoals: () => void;
  onEditTxn: (t: Transaction) => void;

  onEditAccountTxn: (t: Transaction) => void;

  onEditEnvelopeTxn: (t: Transaction) => void;

  onEditTxnPanel: (t: Transaction) => void;

  onDuplicateTxnPanel: (t: Transaction) => void;
  onPrev: () => void;
  onNext: () => void;

  editTxn: Transaction | null;
  addPreset: { tab?: AddTab; importSheet?: boolean; duplicateFrom?: Transaction };
  onDoneEdit: () => void;
}) {
  const C = useTheme();
  const { t } = useT();

  const label =
    view.kind === "report"
      ? t(TITLES[view.view])
      : view.kind === "widgets"
        ? t(WIDGET_CATALOG[view.widgetId].title)
        : view.kind === "widgetPicker"
          ? t("Add widget")
          : view.kind === "account"
            ? // Name only — this reads the VIEWED-month `state.accounts`, which is fine for a
              // field that never varies by month; the balance itself (AccountPanel's own concern)
              // must never come from here (the 3.6.2 rule).
              (state.accounts.find((a) => a.id === view.accountId)?.name ?? "")
            : view.kind === "envelope"
              ? (state.envelopes.find((e) => e.id === view.envelopeId)?.name ?? "")
              : view.kind === "txn"
                ? (() => {
                    const tx = state.transactions.find((x) => x.id === view.txnId);
                    if (!tx) return "";
                    const txEnv = tx.envelopeId ? state.envelopes.find((e) => e.id === tx.envelopeId) : null;
                    return tx.name || tx.note || txEnv?.name || (tx.items.length ? t("Split transaction") : t("Transaction"));
                  })()
                : "";

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
          <EnvelopePanel
            envelopeId={view.envelopeId}
            month={view.month}
            groups={state.groups}
            accounts={state.accounts}
            onOpenTxns={onOpenTxns}
            onEditTxn={onEditEnvelopeTxn}
          />
        );
      case "report":
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
      case "widgetPicker":
        return <WidgetPickerPanel onClose={onClose} />;
      case "account":
        return (
          <AccountPanel accountId={view.accountId} envelopes={state.envelopes} groups={state.groups} onOpenTxns={onOpenTxns} onEditTxn={onEditAccountTxn} />
        );
      case "add":
        return (
          <AddScreen
            state={state}
            editTxn={editTxn}
            onDone={onDoneEdit}
            initialTab={addPreset.tab}
            initialImport={addPreset.importSheet}
            duplicateFrom={addPreset.duplicateFrom}
          />
        );
      case "txn":
        return (
          <TxnPanel
            key={view.txnId}
            txnId={view.txnId}
            state={state}
            month={month}
            onOpenEnvelope={onOpenEnvelope}
            onEditTxn={onEditTxnPanel}
            onDuplicateTxn={onDuplicateTxnPanel}
          />
        );
      default:
        return assertNever(view);
    }
  })();

  return (
    <>
      {}
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
