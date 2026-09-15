import type { Account, Envelope, EnvelopeGroup, WideWidgetId } from "@enveo/shared";
import type { ReportTab, ReportView } from "../../screens/reports/types";
import type { ScreenId } from "../chrome";

export type PanelView =
  | { kind: "empty"; hint: "envelope" | "report" | "account" | "generic" }
  | { kind: "envelope"; envelopeId: string; month: string; source: "selection" | "fallback" }
  | { kind: "report"; view: ReportTab; source: "selection" | "fallback" }
  | { kind: "widgets"; widgetId: WideWidgetId }
  | { kind: "widgetPicker" }
  | { kind: "account"; accountId: string; source: "selection" | "fallback" }
  | { kind: "add" }
  | { kind: "txn"; txnId: string; source: "selection" | "fallback" };

export interface PanelFallbacks {
  firstEnvelopeId: string | null;
  firstAccountId: string | null;
  firstTxnId: string | null;
  month: string;
}

export function panelFallbacks(
  state: {
    envelopes: ReadonlyArray<Pick<Envelope, "id" | "groupId" | "sort" | "archived">>;
    groups: ReadonlyArray<Pick<EnvelopeGroup, "id" | "sort">>;
    accounts: ReadonlyArray<Pick<Account, "id" | "sort" | "archived">>;
  },
  month: string,
  filteredTxns: ReadonlyArray<{ id: string }>,
): PanelFallbacks {
  const groupSortById = new Map(state.groups.map((g) => [g.id, g.sort]));
  const firstEnvelope = state.envelopes
    .filter((e) => !e.archived)
    .sort(
      (a, b) => (groupSortById.get(a.groupId) ?? Number.MAX_SAFE_INTEGER) - (groupSortById.get(b.groupId) ?? Number.MAX_SAFE_INTEGER) || a.sort - b.sort,
    )[0];
  const firstAccount = state.accounts.filter((a) => !a.archived).sort((a, b) => a.sort - b.sort)[0];
  return {
    firstEnvelopeId: firstEnvelope?.id ?? null,
    firstAccountId: firstAccount?.id ?? null,
    firstTxnId: filteredTxns[0]?.id ?? null,
    month,
  };
}

export function resolvePanel(
  a: {
    screen: ScreenId;
    reportsView: ReportView;
    envView: { envelopeId: string; month: string } | null;
    widgetSettings?: WideWidgetId | null;

    widgetPicker?: boolean;
    acctView?: { accountId: string } | null;
    txnView?: { txnId: string } | null;
  },
  fb: PanelFallbacks,
): PanelView {
  if (a.screen === "addExpense") return { kind: "add" };
  if (a.envView) return { kind: "envelope", envelopeId: a.envView.envelopeId, month: a.envView.month, source: "selection" };

  if (a.acctView) return { kind: "account", accountId: a.acctView.accountId, source: "selection" };
  if (a.screen === "reports") {
    if (a.reportsView !== "overview") return { kind: "report", view: a.reportsView, source: "selection" };
    return { kind: "report", view: "spending", source: "fallback" };
  }
  if (a.screen === "start" && a.widgetPicker) return { kind: "widgetPicker" };
  if (a.screen === "start" && a.widgetSettings) return { kind: "widgets", widgetId: a.widgetSettings };
  if (a.screen === "accounts" || a.screen === "settings") {
    return fb.firstAccountId ? { kind: "account", accountId: fb.firstAccountId, source: "fallback" } : { kind: "empty", hint: "account" };
  }
  if (a.screen === "start" || a.screen === "budget") {
    return fb.firstEnvelopeId ? { kind: "envelope", envelopeId: fb.firstEnvelopeId, month: fb.month, source: "fallback" } : { kind: "empty", hint: "envelope" };
  }
  if (a.screen === "transactions") {
    if (a.txnView) return { kind: "txn", txnId: a.txnView.txnId, source: "selection" };
    return fb.firstTxnId ? { kind: "txn", txnId: fb.firstTxnId, source: "fallback" } : { kind: "empty", hint: "generic" };
  }
  return { kind: "empty", hint: "generic" };
}

/**
 * The wide shell's primary pane never shows the Add takeover (it lives in the panel instead, per
 * `resolvePanel` above) — it keeps rendering the screen Add returns to, so the primary pane never
 * flashes/unmounts to the Add screen and back. `editReturn` is App's own state (the screen an
 * edit-in-progress returns to); this is a pure lookup, not a second copy of that state.
 */
export function primaryScreenFor(screen: ScreenId, editReturn: ScreenId): ScreenId {
  return screen === "addExpense" ? editReturn : screen;
}
