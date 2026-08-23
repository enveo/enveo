import type { Transaction } from "@enveo/shared";
import { lazy } from "react";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { type Message, msg, useT } from "../../lib/i18n";
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

const HINT_COPY: Record<"envelope" | "report" | "generic", Message> = {
  envelope: msg("Choose an envelope to see its summary."),
  report: msg("Choose a report to open it here."),
  generic: msg("Nothing is open in this panel yet."),
};

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
}) {
  const C = useTheme();
  const { t } = useT();

  const label = view.kind === "report" ? t(TITLES[view.view]) : "";

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
      default:
        return assertNever(view);
    }
  })();

  return (
    <>
      <div
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
