import type { Transaction, WideWidgetId, WidgetOpts } from "@enveo/shared";
import { lazy } from "react";
import type { StateResponse } from "../../lib/api";
import { useBudgetPreferences, useTheme } from "../../lib/contexts";
import { type Message, msg, useT } from "../../lib/i18n";
import { font, TEAL, tint } from "../../lib/theme";
import { resolveWidgetScroll } from "../../lib/wideBoard";
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
// The wide board's gear target (PR5 Task 6) reuses the phone edit sheet's envelope-mode options
// body verbatim (one options UI, not a second implementation) — dynamically imported, exactly
// like `ReportsScreen` above, so the ~500-line `EditWidgetsSheet` module stays out of the wide
// chunk's static graph; Vite dedupes it with Start.tsx's own `lazy()` import of the same module.
const EnvelopesOptions = lazy(() => import("../EditWidgetsSheet").then((m) => ({ default: m.EnvelopesOptions })));

const HINT_COPY: Record<"envelope" | "report" | "account" | "generic", Message> = {
  envelope: msg("Choose an envelope to see its summary."),
  report: msg("Choose a report to open it here."),
  // PR6b Task 3 — the account hint (panel.ts's `empty` variant gains this arm the moment the
  // `account` PanelView kind exists, since `HINT_COPY[view.hint]` below must stay total over the
  // whole hint union). The real account pane body (`AccountPanel`) is Task 4's scope.
  account: msg("Choose an account to see its details."),
  generic: msg("Nothing is open in this panel yet."),
};

/** Uppercase eyebrow caption above a settings section ("Size on the grid" / "Scrolling") — the
 *  design's own literal style (v3.dc.html:1697: 10px/750/0.16em uppercase, muted). A plain style
 *  object (the `color` token comes from the caller's `useTheme()`) rather than `kit.tsx`'s
 *  `SectionEyebrow`, which bakes in the phone stack's own side-padding/spacing rhythm this
 *  compact panel doesn't share. */
const EYEBROW_STYLE: React.CSSProperties = { fontSize: 10, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase" };

/**
 * The `widgets` panel body (pr5-task-6-brief.md §3, restyled to the design's crop per owner round
 * 3 item 14): the wide board's gear target. Reads/writes `wideWidgets` directly via
 * `useBudgetPreferences()` — no new props on `PanelHost` itself, the same way
 * `EnvelopesWidget`/`AccountsWidget` already read the replica straight from context rather than
 * threading it through every intermediate component. The widget's own name is the shared
 * `PanelHost` header above (`label`, this file) — the design's per-view header row IS that same
 * text, so it is not repeated a second time in the body. The size caption and the "Scroll inside
 * the tile" toggle are universal (every wide widget — the design's `HAS_SETTINGS` map, and now
 * `WideHome`'s gear button, is `true` for all of them); the envelope selection-mode body below
 * stays the one widget-specific extra, unchanged from the F4 cut.
 */
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
  /** PR6b Task 4: the `account` kind's OWN edit entry point — deliberately not `onEditTxn` above
   *  (see the bag's own comment, WideShell.tsx). */
  onEditAccountTxn: (t: Transaction) => void;
  /** Design parity wave C task 2: the `envelope` kind's OWN edit entry point — same reason
   *  `onEditAccountTxn` above exists separately from `onEditTxn` (that one's `editReturn` is
   *  hardcoded "reports" for the panel's report-subview instance). Unlike the account pane this
   *  needs no restore-stash: `envView` already round-trips through the URL (`routeToUrl`'s
   *  `?env=`), so `doneEdit`'s `history.back()` naturally restores both the originating screen
   *  and the envelope pane via `onPop` (App.tsx's `editEnvelopeTxn` comment has the full case). */
  onEditEnvelopeTxn: (t: Transaction) => void;
  /** Design parity wave C task 3: the `txn` kind's OWN Edit entry point — the SAME
   *  `editTxnFrom(t, "transactions")` binding `TransactionsScreen`'s own primary-pane row click
   *  already uses (App.tsx's `editTxnFromList`), not the shared `onEditTxn` above (hardcoded
   *  "reports" for the panel's report-subview instance). */
  onEditTxnPanel: (t: Transaction) => void;
  /** Design parity wave C task 3, owner rule 2: opens the Add pane prefilled as a NEW transaction
   *  cloned from this one — no direct ledger write (App.tsx's `duplicateTxnFromPanel`). */
  onDuplicateTxnPanel: (t: Transaction) => void;
  onPrev: () => void;
  onNext: () => void;
  /** PR6 Task 2: the `add` kind's own props — App's edit/preset state, same as the phone
   *  column's `AddScreen` already reads (App.tsx's `screenEl`). */
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
        ? // The design's own panel header IS the widget's name (owner round 3 item 14's crop:
          // "Cash flow · 12 months", not a generic "Widget settings" caption) — the catalogue's
          // card-title grammar, same string the tile's own header row already shows. "Widget
          // settings" stays alive as the gear button's aria-label (WideHome.tsx) — a DIFFERENT
          // surface, so that key is not orphaned by this change.
          t(WIDGET_CATALOG[view.widgetId].title)
        : view.kind === "account"
          ? // Name only — this reads the VIEWED-month `state.accounts`, which is fine for a
            // field that never varies by month; the balance itself (AccountPanel's own concern)
            // must never come from here (the 3.6.2 rule).
            (state.accounts.find((a) => a.id === view.accountId)?.name ?? "")
          : view.kind === "envelope"
            ? (state.envelopes.find((e) => e.id === view.envelopeId)?.name ?? "")
            : view.kind === "txn"
              ? // The SAME fallback chain `TxnPanel`'s own `descOf` uses for its "payee" line
                // (name → note → envelope name → split/plain fallback) — a nameless, noteless
                // manual entry (common in real data) should still show something better than a
                // blank/generic header. Verified live: measured `headerLabel` read the unhelpful
                // generic "Transaction" here before this matched the body's own richer chain. A
                // vanished transaction (deleted elsewhere between panel-open and this render)
                // degrades to an empty label, same as every other branch above.
                (() => {
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
        // Design parity wave C task 2: the real panel body (trio card, breakdowns, "Transactions
        // in X" list — EnvelopePanel.tsx), not the phone `EnvelopeScreen` full-screen takeover.
        // `EnvelopePanel` is a wide-only component (never mounted on phone, unlike
        // `EnvelopeScreen`), so — like `AccountPanel` above — it is a plain static import: it
        // already lives inside this lazy-chunk-only module, there is nothing to dedupe it with.
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
      case "account":
        // PR6b Task 4: the real `acct` pane body — balance card, actions, recent activity
        // (AccountPanel.tsx). `HINT_COPY.account` above stays the NO-selection copy; AccountPanel
        // reuses the same string for the separate "account vanished" case (its own file header).
        return (
          <AccountPanel accountId={view.accountId} envelopes={state.envelopes} groups={state.groups} onOpenTxns={onOpenTxns} onEditTxn={onEditAccountTxn} />
        );
      case "add":
        // AddScreen already ships in the EAGER bundle (App.tsx: "AddScreen with the whole
        // transaction-entry subtree" — the app's most-repeated action), so unlike EnvelopeScreen/
        // ReportsScreen/EnvelopesOptions above there is no separate chunk to `lazy()`/dedupe here:
        // a plain static import just references the already-loaded module. `AddHeader`'s own back
        // arrow (rendered inside `AddScreen`) IS this pane's close per D5/D4's mockup-inconsistency
        // note — it calls the SAME `onDoneEdit` the header ✕ above calls (see `WideShell`'s
        // `closePanel`), so the two paths can't disagree here either. Live since PR6 Task 5
        // (which removed `App.tsx`'s interim phone-column takeover for `screen === "addExpense"`
        // on wide): this now renders on every "+ Add" press and every row-edit entry. `duplicateFrom`
        // (design parity wave C task 3) rides the SAME preset bag `initialTab`/`initialImport`
        // already do — one more one-shot mount-time seed, not a new state channel.
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
        // Design parity wave C task 3: the real read-only detail card (TxnPanel.tsx) — kind label
        // → amount hero → payee → date · category → bordered Envelope/Account/Note field group →
        // two stat lines → Edit/Duplicate/Delete pills + inline delete-confirm. `HINT_COPY.generic`
        // above stays the no-selection copy for a genuinely empty transaction list; TxnPanel's own
        // file header covers the separate "vanished" case defensively. `key`: TxnPanel's own local
        // delete-confirm state must NOT survive a switch to a DIFFERENT transaction — deleting the
        // open one falls the panel back to another `id` in the same render position, and without a
        // key React would keep the same instance (and its `confirmDelete=true`) alive underneath it.
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
