import { computeNetWorthSeries, computeStateResponse } from "@enveo/shared";
import { type LazyExoticComponent, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { fmtSignedTrim } from "../lib/amount";
import { type AccountView, type EnvelopeView, type StateResponse, useLedgerVersion } from "../lib/api";
import {
  automaticEnvelopePreview,
  currentReconciliationAccount,
  formatAutomaticEnvelopeEffect,
  type ReconciliationEnvelopeSelection,
  reconciliationActualValueAfterAccountRefresh,
  reconciliationEnvelopeAfterAccountRefresh,
  reconciliationTxnPayload,
} from "../lib/automaticEnvelopeUi";
import type { WidgetConfig, WidgetId, WidgetOpts } from "../lib/contexts";
import { useCurrency, useMask, useSettings, useTheme } from "../lib/contexts";
import { currentMonth } from "../lib/dates";
import { currencySymbol, localizePadExpression, parseAmount } from "../lib/format";
import { type Message, msg, useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { font, TEAL } from "../lib/theme";
import { sumBalances } from "../lib/uiState";
import { WIDGET_CATALOG } from "../lib/widgetCatalog";
import { AutomaticEnvelopeEffect } from "../screens/add/AutomaticEnvelopeEffect";
import { EnvelopePickerSheet } from "../screens/add/EnvelopePickerSheet";
import { collapsedRowStyle } from "../screens/add/styles";
import type { ReportTab } from "../screens/reports/types";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { type ScreenId, Sheet } from "./chrome";
import { CardBox, SectionEyebrow, useBand } from "./kit";
import { LazyChunk } from "./lazy";
import { Sparkline } from "./reportKit";
import { AccCell, accountIconColor, EnvRow } from "./tiles";

/** Props every Start-screen widget receives — a component picks the subset it needs. All six
 *  original (eager) widgets ignore the three PR5 additions below, so they stay untouched. */
export interface WidgetProps {
  state: StateResponse;
  month: string;
  onNav: (s: ScreenId) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  /** Deep link into a specific report subscreen (App.openReports). */
  onOpenReport?: (tab: ReportTab) => void;
  /** Heatmap day → Month report with that day's panel open (App.setMonthDay + openReports("month")). */
  onOpenMonthDay?: (date: string) => void;
  /** True when a wide board tile hosts the widget: the tile owns title+card chrome, so the body
   *  skips its own SectionEyebrow/CardBox. Default false — phone rendering is pixel-identical. */
  chromeless?: boolean;
  opts?: WidgetOpts;
}

/** Month-summary amount without the fractional part (strips e.g. ",00"/".00"), masked via the caller's M. */
const maskWhole = (M: (minor: number) => string, minor: number) => M(minor).replace(/[.,]\d\d(?!\d)/, "");

/** Quick-action pool (`opts.actions`) — checked in EditWidgets' QuickActionsOptions, rendered by QuickActions. */
export type QuickActionKey = "expense" | "transfer" | "import" | "suggest" | "discreet" | "darkMode" | "reports";

/** Canonical order (also the QuickActionsOptions checklist order) — a stale persisted key not in this
 *  list (a removed action) is silently dropped, never crashes the row. */
export const QUICK_ACTION_ORDER: QuickActionKey[] = ["expense", "transfer", "import", "suggest", "discreet", "darkMode", "reports"];

/** Mirrors the `actions` default in contexts.tsx defaultStartWidgets() — kept here too because an
 *  ALREADY-persisted device may have a quickActions widget with no `opts.actions` at all (pre-dates
 *  this feature), same fallback idiom as AccountsWidget's `opts?.count ?? 4`. */
export const DEFAULT_QUICK_ACTIONS: QuickActionKey[] = ["expense", "transfer", "import", "suggest"];

export const QUICK_ACTION_DEFS: Record<QuickActionKey, { label: Message; glyph?: string; d?: string }> = {
  expense: { label: msg("Expense"), d: "M12 5v14M5 12h14" },
  transfer: { label: msg("Transfer"), d: "M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" },
  import: { label: msg("From screenshot"), glyph: "camera" },
  suggest: { label: msg("Suggest"), d: "M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M5.8 5.8l2.4 2.4M15.8 15.8l2.4 2.4M18.2 5.8l-2.4 2.4M8.2 15.8l-2.4 2.4" },
  discreet: { label: msg("Discreet mode"), d: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z M12 14.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z" },
  darkMode: { label: msg("Light / Dark"), d: "M20.5 13.5A8.5 8.5 0 1110.5 3.5a7 7 0 0010 10z" },
  reports: { label: msg("Reports"), d: "M4 20V10M9 20V4M14 20v-6M19 20v-9" },
};

/** Actions from a persisted `opts.actions` — filters out a stale/removed key, falls back to the default set. */
function resolveActions(actions: string[] | undefined): QuickActionKey[] {
  const kept = (actions ?? []).filter((a): a is QuickActionKey => a in QUICK_ACTION_DEFS);
  return kept.length > 0 ? kept : DEFAULT_QUICK_ACTIONS;
}

/* ── Quick actions: configurable tiles → Add (expense/transfer), the import sheet, Budget+suggest,
 * or device-only toggles (discreet mode, light/dark) and a Reports shortcut ── */
export function QuickActions({ onNav, onQuickAdd, opts }: WidgetProps) {
  const C = useTheme();
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  const keys = resolveActions(opts?.actions);
  const handlers: Record<QuickActionKey, () => void> = {
    expense: () => onNav("addExpense"),
    transfer: () => onQuickAdd("transfer"),
    import: () => onQuickAdd("import"),
    suggest: () => onQuickAdd("suggest"),
    discreet: () => setSettings({ ...settings, discreet: !settings.discreet }),
    darkMode: () => setSettings({ ...settings, themeMode: settings.themeMode === "dark" ? "light" : "dark" }),
    reports: () => onNav("reports"),
  };
  return (
    <div>
      <SectionEyebrow label={t("Quick actions")} />
      <CardBox style={{ padding: "10px 8px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-around", rowGap: 10 }}>
          {keys.map((key) => {
            const def = QUICK_ACTION_DEFS[key];
            return (
              <button
                key={key}
                onClick={handlers[key]}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 2px",
                  minWidth: 56,
                  fontFamily: font,
                }}
              >
                {def.glyph ? <Glyph name={def.glyph} size={18} color={C.soft} sw={1.8} /> : <Ico d={def.d!} size={18} color={C.soft} sw={1.8} />}
                <span style={{ fontSize: 10.5, fontWeight: 600, color: C.text }}>{t(def.label)}</span>
              </button>
            );
          })}
        </div>
      </CardBox>
    </div>
  );
}

/* ── Accounts: the Start 2-col grid, foldable to `opts.count` (default 4) ── */
export function AccountsWidget({ state, onNav, onOpenTxns, opts }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t, tp } = useT();
  const { band } = useBand();
  const MW = (n: number) => maskWhole(M, n);
  // Accounts are CURRENT-balance always — never scoped to the viewed month (unlike envelopes).
  // Recomputed from the replica at `currentMonth()` regardless of which month is on screen, so
  // flipping to a past month never changes what's shown here (same pattern as chrome.tsx's Drawer).
  const version = useLedgerVersion();
  const accountsNow = useMemo(() => {
    const l = store.getLedger();
    return l ? computeStateResponse(l, currentMonth()).accounts : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const allAccounts = [...accountsNow].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  // opts.picked mirrors envelopes' `picked:` mode: defined AND non-empty → only those accounts;
  // undefined (or an empty selection, e.g. right after switching to "Selected") → show all.
  const picked = opts?.picked;
  const accounts = picked && picked.length > 0 ? allAccounts.filter((a) => picked.includes(a.id)) : allAccounts;
  const count = opts?.count ?? 4;
  const [expanded, setExpanded] = useState(!(opts?.collapsed ?? true));
  const shown = expanded ? accounts : accounts.slice(0, count);
  const accountsTotal = MW(sumBalances(accounts));
  const [selAcc, setSelAcc] = useState<AccountView | null>(null);
  const [reconcileAccountId, setReconcileAccountId] = useState<string | null>(null);
  const reconcileAccount = currentReconciliationAccount(accountsNow, reconcileAccountId);
  const activeEnvelopes = state.envelopes.filter((envelope) => !envelope.archived);
  const activeGroupIds = new Set(activeEnvelopes.map((envelope) => envelope.groupId));
  const activeGroups = state.groups.filter((group) => activeGroupIds.has(group.id));

  return (
    <div>
      {!band && <SectionEyebrow label={t("Accounts")} right={t("total {amount}", { amount: accountsTotal })} />}
      <CardBox style={band ? { marginTop: -26, paddingTop: 30, position: "relative", zIndex: 0, boxShadow: "0 8px 22px rgba(29,42,71,0.14)" } : undefined}>
        {band && (
          <div style={{ textAlign: "center", fontSize: 9.5, fontWeight: 750, letterSpacing: "0.14em", color: C.soft, paddingBottom: 4 }}>
            {tp("{n} account · total {amount} | {n} accounts · total {amount}", accounts.length, {
              n: String(accounts.length),
              amount: accountsTotal,
            }).toUpperCase()}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 16, rowGap: 0 }}>
          {shown.map((a, i) => {
            // last ROW of the 2-col grid, counting the ghost "+ new account" cell
            // (shown.length + 1 total cells) — same row → no separator underneath.
            const lastRow = Math.floor(i / 2) === Math.ceil((shown.length + 1) / 2) - 1;
            return <AccCell key={a.id} a={a} onClick={() => setSelAcc(a)} last={lastRow} />;
          })}
          {/* always the right column — its own row when shown.length is even, shares
              the last account's row when odd (gridColumnStart forces column 2 either way) */}
          <button
            onClick={() => onNav("accounts")}
            style={{
              gridColumnStart: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "7px 0",
              background: "none",
              border: "none",
              fontSize: 11,
              fontWeight: 600,
              color: C.mute,
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            {t("+ new account")}
          </button>
        </div>
      </CardBox>
      {accounts.length > count && (
        <div style={{ textAlign: "center", padding: "2px 0 0" }}>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{ background: "none", border: "none", fontSize: 11, fontWeight: 600, color: C.mute, cursor: "pointer", fontFamily: font }}
          >
            {expanded ? t("collapse ▴") : t("show all ({n}) ▾", { n: String(accounts.length) })}
          </button>
        </div>
      )}

      <Sheet show={!!selAcc} onClose={() => setSelAcc(null)}>
        {(C) =>
          selAcc && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 11,
                      background: selAcc.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Glyph name={selAcc.icon} size={20} color={accountIconColor(selAcc.color)} />
                  </div>
                  <span style={{ fontSize: 18, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selAcc.name}
                  </span>
                </div>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {M(selAcc.balance)}
                </span>
              </div>
              <div style={{ height: 1, background: C.line, margin: "0 0 12px" }} />
              <div style={{ display: "flex", justifyContent: "space-evenly", marginTop: 16 }}>
                {(
                  [
                    [
                      "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
                      t("Transactions"),
                      () => {
                        const a = selAcc;
                        setSelAcc(null);
                        onOpenTxns({ accId: a.id });
                      },
                    ],
                    [
                      "M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4",
                      t("Reconcile"),
                      () => {
                        const a = selAcc;
                        setSelAcc(null);
                        setReconcileAccountId(a.id);
                      },
                    ],
                  ] as const
                ).map(([d, label, onClick]) => (
                  <button
                    key={label}
                    onClick={onClick}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 7,
                      padding: 0,
                    }}
                  >
                    <span
                      style={{ width: 52, height: 52, borderRadius: "50%", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <Ico d={d} size={20} color={C.text} sw={1.5} />
                    </span>
                    <span style={{ fontSize: 12, color: C.text }}>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        }
      </Sheet>

      <ReconcileSheet account={reconcileAccount} envelopes={activeEnvelopes} groups={activeGroups} onClose={() => setReconcileAccountId(null)} />
    </div>
  );
}

/** Account balance reconciliation owned by AccountsWidget. */
function ReconcileSheet({
  account,
  envelopes,
  groups,
  onClose,
}: {
  account: AccountView | null;
  envelopes: StateResponse["envelopes"];
  groups: StateResponse["groups"];
  onClose: () => void;
}) {
  const M = useMask();
  const { t, lang } = useT();
  const currency = useCurrency();
  const [val, setVal] = useState("");
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  const [envelopeSelection, setEnvelopeSelection] = useState<ReconciliationEnvelopeSelection | null>(null);
  const [showEnvelopePicker, setShowEnvelopePicker] = useState(false);
  const actualBalanceSource = useRef<{ id: string; balance: number } | null>(null);
  const automaticEnvelopeId = account && envelopes.some((envelope) => envelope.id === account.automaticEnvelopeId) ? account.automaticEnvelopeId : null;
  useEffect(() => {
    if (!account) {
      actualBalanceSource.current = null;
      setEnvelopeSelection(null);
      return;
    }
    const previousBalanceSource = actualBalanceSource.current;
    actualBalanceSource.current = { id: account.id, balance: account.balance };
    setVal((current) => reconciliationActualValueAfterAccountRefresh(current, previousBalanceSource, account));
    setEnvelopeSelection((current) => reconciliationEnvelopeAfterAccountRefresh(current, account.id, automaticEnvelopeId));
    setShowEnvelopePicker(false);
  }, [account?.id, account?.balance, automaticEnvelopeId]);
  if (!account) return null;
  const currentEnvelopeSelection = reconciliationEnvelopeAfterAccountRefresh(envelopeSelection, account.id, automaticEnvelopeId);
  const envelopeId = currentEnvelopeSelection.envelopeId;
  const openPad = () =>
    setPad({
      label: t("Actual balance (from your bank)"),
      initial: parseAmount(val) ?? 0,
      allowNegative: true, // the real account balance may be negative (e.g. a credit card)
      onCommit: (minor) => setVal(fmtSignedTrim(minor)),
    });
  const real = parseAmount(val);
  const diff = real === null ? 0 : real - account.balance;
  const submit = () => {
    if (real === null || diff === 0) {
      onClose();
      return;
    }
    local.createTxn(
      reconciliationTxnPayload({
        accountId: account.id,
        difference: diff,
        date: new Date().toISOString().slice(0, 10),
        envelopeId,
        // the note is transaction DATA — saved in the language active at creation time
        note: t("Balance adjustment"),
      }),
    );
    onClose();
  };
  const selectedEnvelope = envelopes.find((envelope) => envelope.id === envelopeId);
  const positivePreview = diff > 0 ? automaticEnvelopePreview({ accounts: [account], envelopes }, { type: "income", accountId: account.id }, diff) : null;
  const positiveEffect =
    positivePreview && positivePreview.rows.length > 0
      ? formatAutomaticEnvelopeEffect(positivePreview, M, {
          heading: t("Automatic envelope effect"),
          readyToAssign: t("Ready to assign"),
          noEnvelopeChange: t("No envelope change"),
          noChange: t("No change"),
        })
      : null;
  return (
    <>
      <Sheet show={!!account} onClose={onClose}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{t("Reconcile account")}</div>
            <div style={{ fontSize: 12.5, color: C.soft, marginBottom: 16 }}>{account.name}</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: C.soft }}>{t("Balance in the app")}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(account.balance)}</span>
            </div>
            <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
              {t("Actual balance (from your bank)")}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
              <input
                // `val` stays CANONICAL (pad output in, parseAmount out) — display only is localized.
                value={localizePadExpression(val, lang)}
                readOnly
                onClick={openPad}
                onFocus={openPad}
                style={{
                  flex: 1,
                  padding: "9px 11px",
                  borderRadius: 9,
                  border: `1px solid ${C.line}`,
                  background: C.surface,
                  color: C.text,
                  fontSize: 16,
                  fontWeight: 600,
                  fontFamily: font,
                  fontVariantNumeric: "tabular-nums",
                  cursor: "pointer",
                }}
              />
              <span style={{ color: C.mute, fontSize: 13 }}>{currencySymbol(currency, lang)}</span>
            </div>
            {real !== null && diff !== 0 && (
              <div style={{ fontSize: 12.5, marginBottom: 12, color: diff > 0 ? C.pos : C.neg }}>
                {t("Difference: {sign}{amount} → this will create a correcting {kind}", {
                  sign: diff > 0 ? "+" : "−",
                  amount: M(Math.abs(diff)),
                  kind: t(diff > 0 ? msg("income") : msg("expense")),
                })}
              </div>
            )}
            {diff > 0 && positiveEffect && <AutomaticEnvelopeEffect data={positiveEffect} />}
            {diff < 0 && (
              <>
                <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
                  {t("Envelope for the adjustment")}
                </div>
                <button onClick={() => setShowEnvelopePicker(true)} style={{ ...collapsedRowStyle(C, !!selectedEnvelope), margin: "0 0 4px" }}>
                  {selectedEnvelope && <Glyph name={selectedEnvelope.icon} size={17} color={selectedEnvelope.color} sw={1.8} />}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      fontWeight: selectedEnvelope ? 650 : 500,
                      color: selectedEnvelope ? C.text : C.mute,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {selectedEnvelope?.name ?? t("Choose an envelope")}
                  </span>
                </button>
                {currentEnvelopeSelection.provenance === "automatic" && envelopeId !== null && (
                  <div style={{ color: C.mute, fontSize: 10.5, marginBottom: 12 }}>{t("Selected automatically from this account")}</div>
                )}
              </>
            )}
            <button
              onClick={submit}
              disabled={real === null || diff === 0}
              style={{
                width: "100%",
                padding: "12px 0",
                borderRadius: 12,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                opacity: real === null || diff === 0 ? 0.5 : 1,
              }}
            >
              {real !== null && diff === 0 ? t("Balance matches") : t("Reconcile")}
            </button>
          </>
        )}
      </Sheet>
      <EnvelopePickerSheet
        show={showEnvelopePicker}
        onClose={() => setShowEnvelopePicker(false)}
        envelopes={envelopes}
        groups={groups}
        onSelect={(id) => {
          setEnvelopeSelection({ ...currentEnvelopeSelection, envelopeId: id, provenance: "explicit" });
          setShowEnvelopePicker(false);
        }}
      />
      {/* Sibling of the Sheet (not a child) — the panel's transform would break the pad's position:fixed. */}
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </>
  );
}

/** Envelope groups to render for a given `opts.mode` — "all" | "savings" | `group:<id>` | `picked:<ids>`. */
function envelopeSections(
  state: StateResponse,
  mode: string,
  t: (m: Message, p?: Record<string, string | number>) => string,
): Array<{ label: string; list: EnvelopeView[] }> {
  const envelopes = [...state.envelopes].filter((e) => !e.archived).sort((a, b) => a.sort - b.sort);
  if (mode === "savings") return [{ label: t("Envelopes · Savings"), list: envelopes.filter((e) => e.isSavings) }];
  if (mode.startsWith("group:")) {
    const gid = mode.slice("group:".length);
    const g = state.groups.find((gr) => gr.id === gid);
    return [{ label: g ? t("Envelopes · {group}", { group: g.name }) : t("Envelopes"), list: envelopes.filter((e) => e.groupId === gid) }];
  }
  if (mode.startsWith("picked:")) {
    const ids = new Set(mode.slice("picked:".length).split(",").filter(Boolean));
    return [{ label: t("Envelopes · Selected"), list: envelopes.filter((e) => ids.has(e.id)) }];
  }
  // "all" (default/fallback for an unrecognized mode string)
  return (["daily", "savings"] as const).map((kind) => ({
    label: kind === "daily" ? t("Envelopes · Everyday") : t("Envelopes · Savings"),
    list: envelopes.filter((e) => e.isSavings === (kind === "savings")),
  }));
}

/* ── Envelopes: grouped EnvRow lists, scoped by opts.mode ── */
export function EnvelopesWidget({ state, month, onOpenEnvelope, opts, chromeless }: WidgetProps) {
  const M = useMask();
  const { t } = useT();
  const sections = envelopeSections(state, opts?.mode ?? "all", t);
  const MW = (n: number) => maskWhole(M, n);
  return (
    <>
      {sections.map(({ label, list }) => {
        if (list.length === 0) return null;
        const rows = list.map((e, idx) => <EnvRow key={e.id} e={e} onClick={() => onOpenEnvelope(e.id, month)} last={idx === list.length - 1} />);
        // On a wide-board tile the tile supplies the card chrome; the per-SECTION eyebrow stays
        // (it is content — a group label with its total — not duplicated widget chrome).
        return (
          <div key={label}>
            <SectionEyebrow label={label} right={t("total {amount}", { amount: MW(list.reduce((s, e) => s + e.available, 0)) })} />
            {chromeless ? rows : <CardBox>{rows}</CardBox>}
          </div>
        );
      })}
    </>
  );
}

/** Separate savings-only widget (`envelopesSavings`) — same rendering as EnvelopesWidget, mode forced
 *  regardless of `opts`, so a user can run "envelopes" as everyday-only elsewhere and still see savings. */
function EnvelopesSavingsWidget(props: WidgetProps) {
  return <EnvelopesWidget {...props} opts={{ mode: "savings" }} />;
}

/* ── Report widgets: current-month cashflow numbers, and a 12mo net-worth sparkline ── */
export function CashflowWidget({ state, onNav, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const net = state.monthIncome - state.monthExpense;
  const trio = (
    <div style={{ display: "flex", gap: 8, padding: chromeless ? 0 : "10px 0" }}>
      {(
        [
          [t("Income"), state.monthIncome, C.pos],
          [t("Expense"), state.monthExpense, C.neg],
          [t("Net"), net, net >= 0 ? C.pos : C.neg],
        ] as const
      ).map(([label, val, col]) => (
        <div key={label} style={{ flex: 1 }}>
          <div style={{ fontSize: 10.5, color: C.soft }}>{label}</div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: col, fontVariantNumeric: "tabular-nums" }}>{M(val)}</div>
        </div>
      ))}
    </div>
  );
  // Wide-board tiles supply their own eyebrow+card chrome; doubling it overflowed the default
  // w:3,h:1 tile (measured: clientHeight 53 vs scrollHeight 80 on first load).
  if (chromeless) return trio;
  return (
    <div>
      <SectionEyebrow
        label={t("Report · Cash flow")}
        right={
          <button
            onClick={() => onNav("reports")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--accent)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            {t("details")} ›
          </button>
        }
      />
      <CardBox>{trio}</CardBox>
    </div>
  );
}

export function NetWorthWidget({ month, onNav, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const version = useLedgerVersion();
  const netWorth = useMemo(() => {
    const l = store.getLedger();
    return l ? computeNetWorthSeries(l, month, 12) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const nwLast = netWorth.at(-1)?.total ?? 0;
  const nwDelta = nwLast - (netWorth.at(-2)?.total ?? nwLast);
  const body = (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(nwLast)}</span>
        {nwDelta !== 0 && (
          <span style={{ fontSize: 11.5, fontWeight: 600, color: nwDelta > 0 ? C.pos : C.neg, fontVariantNumeric: "tabular-nums" }}>
            {nwDelta > 0 ? "▲ +" : "▼ "}
            {M(Math.abs(nwDelta))}
          </span>
        )}
      </div>
      <Sparkline points={netWorth} />
    </>
  );
  // Same rule as CashflowWidget above: the wide tile brings its own chrome, and the doubled
  // stack overflowed the default w:1,h:1 tile ~4.5x on first load (measured).
  if (chromeless) return body;
  return (
    <div>
      <SectionEyebrow
        label={t("Report · Net worth")}
        right={
          <button
            onClick={() => onNav("reports")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--accent)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            {t("details")} ›
          </button>
        }
      />
      <CardBox style={{ padding: "10px 14px" }}>{body}</CardBox>
    </div>
  );
}

/** Registry: widget id → component, for the six ORIGINAL widgets whose bodies are cheap enough to
 *  stay eager (Start renders them at boot). PR5's six report-backed widgets (attention/recent/
 *  spending/goals/trends/heatmap) live in `./widgetsBoard` instead, behind `LAZY_WIDGETS` below —
 *  `renderWidget` is the ONE place that picks eager vs. lazy, so no caller needs to know which is
 *  which. `Partial` (rather than the full `Record<WidgetId, …>`) is what keeps this file eager-safe:
 *  a `Record` over all twelve ids would force importing the six lazy bodies at the top of this
 *  module, defeating the whole split. */
export const START_WIDGETS: Partial<Record<WidgetId, (p: WidgetProps) => ReactNode>> = {
  quickActions: QuickActions,
  accounts: AccountsWidget,
  envelopes: EnvelopesWidget,
  envelopesSavings: EnvelopesSavingsWidget,
  reportCashflow: CashflowWidget,
  reportNetWorth: NetWorthWidget,
};

/** The lazy half of the registry — one `import()` of `./widgetsBoard` per widget id, so Rollup
 *  emits ONE chunk shared by all six (plus whatever `reportKit`/`reports/charts` code the Reports
 *  screen's own chunk already carries — see that module's header comment). */
const AttentionWidget = lazy(() => import("./widgetsBoard").then((m) => ({ default: m.AttentionWidget })));
const RecentWidget = lazy(() => import("./widgetsBoard").then((m) => ({ default: m.RecentWidget })));
const SpendingWidget = lazy(() => import("./widgetsBoard").then((m) => ({ default: m.SpendingWidget })));
const GoalsWidget = lazy(() => import("./widgetsBoard").then((m) => ({ default: m.GoalsWidget })));
const TrendsWidget = lazy(() => import("./widgetsBoard").then((m) => ({ default: m.TrendsWidget })));
const HeatmapWidget = lazy(() => import("./widgetsBoard").then((m) => ({ default: m.HeatmapWidget })));

type LazyWidgetId = "attention" | "recent" | "spending" | "goals" | "trends" | "heatmap";

export const LAZY_WIDGETS: Record<LazyWidgetId, LazyExoticComponent<(p: WidgetProps) => ReactNode>> = {
  attention: AttentionWidget,
  recent: RecentWidget,
  spending: SpendingWidget,
  goals: GoalsWidget,
  trends: TrendsWidget,
  heatmap: HeatmapWidget,
};

/** Same silhouette as a rendered widget (eyebrow + an empty card) so the Start stack doesn't jump
 *  while the chunk fetches — 64px mirrors a typical single-row widget's height. */
function WidgetPending({ title }: { title: string }) {
  return (
    <div>
      <SectionEyebrow label={title} />
      <CardBox style={{ minHeight: 64 }}>{null}</CardBox>
    </div>
  );
}

/** The ONE place Start.tsx (and, later, the wide board) renders a widget by config: eager ids go
 *  straight through `START_WIDGETS`, everything else through `LAZY_WIDGETS` behind a `LazyChunk`
 *  (its error boundary keeps a failed fetch from blanking the rest of Start — variant "silent"
 *  because the inner `Suspense` below already supplies a themed pending state, so the boundary's
 *  OWN default fallback is never shown; only its failure path matters here). A corrupted/future
 *  persisted id (settings are untyped JSON at rest) falls through to `null` — never crash Start.
 *  `t` is passed in rather than called here: `renderWidget` is a plain function invoked during a
 *  component's render, not a component/hook itself, so the `useT()` call stays at the real call
 *  site (Start.tsx). */
export function renderWidget(cfg: WidgetConfig, props: WidgetProps, t: (m: Message, p?: Record<string, string | number>) => string): ReactNode {
  if (cfg.id in START_WIDGETS) {
    const W = START_WIDGETS[cfg.id]!;
    return <W {...props} opts={cfg.opts} />;
  }
  const L = LAZY_WIDGETS[cfg.id as LazyWidgetId];
  if (!L) return null;
  const title = t(WIDGET_CATALOG[cfg.id].title);
  return (
    <LazyChunk variant="silent">
      <Suspense fallback={<WidgetPending title={title} />}>
        <L {...props} opts={cfg.opts} />
      </Suspense>
    </LazyChunk>
  );
}
