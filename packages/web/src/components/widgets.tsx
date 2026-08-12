import { computeNetWorthSeries, computeStateResponse } from "@enveo/shared";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { fmtSignedTrim } from "../lib/amount";
import { type AccountView, type EnvelopeView, type StateResponse, useLedgerVersion } from "../lib/api";
import type { WidgetConfig, WidgetId, WidgetOpts } from "../lib/contexts";
import { useCurrency, useMask, useSettings, useTheme } from "../lib/contexts";
import { currentMonth } from "../lib/dates";
import { useDragReorder } from "../lib/dnd";
import { currencySymbol, parseAmount } from "../lib/format";
import { type Message, msg, useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { matchesSearch, SEARCH_THRESHOLD } from "../lib/search";
import { store } from "../lib/store";
import { font, TEAL, type Theme, tint } from "../lib/theme";
import { sumBalances } from "../lib/uiState";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { type ScreenId, Sheet } from "./chrome";
import { CardBox, HighlightedText, PickerSearch, SectionEyebrow, useBand } from "./kit";
import { Sparkline } from "./reportKit";
import { AccCell, accountIconColor, EnvRow } from "./tiles";

/** Props every Start-screen widget receives — a component picks the subset it needs. */
export interface WidgetProps {
  state: StateResponse;
  month: string;
  onNav: (s: ScreenId) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
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

const QUICK_ACTION_DEFS: Record<QuickActionKey, { label: Message; glyph?: string; d?: string }> = {
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
export function AccountsWidget({ onNav, onOpenTxns, opts }: WidgetProps) {
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
  const [reconcile, setReconcile] = useState<AccountView | null>(null);

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
                        setReconcile(a);
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

      <ReconcileSheet account={reconcile} onClose={() => setReconcile(null)} />
    </div>
  );
}

/** Account balance reconciliation (moved verbatim from Start.tsx — now owned by AccountsWidget). */
function ReconcileSheet({ account, onClose }: { account: AccountView | null; onClose: () => void }) {
  const M = useMask();
  const { t, lang } = useT();
  const currency = useCurrency();
  const [val, setVal] = useState("");
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  useEffect(() => {
    if (account) setVal((account.balance / 100).toFixed(2).replace(".", ","));
  }, [account]);
  if (!account) return null;
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
    local.createTxn({
      type: diff > 0 ? "income" : "expense",
      accountId: account.id,
      amount: Math.abs(diff),
      date: new Date().toISOString().slice(0, 10),
      envelopeId: null,
      // the note is transaction DATA — saved in the language active at creation time
      note: t("Balance adjustment"),
    });
    onClose();
  };
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
                value={val}
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
export function EnvelopesWidget({ state, month, onOpenEnvelope, opts }: WidgetProps) {
  const M = useMask();
  const { t } = useT();
  const sections = envelopeSections(state, opts?.mode ?? "all", t);
  const MW = (n: number) => maskWhole(M, n);
  return (
    <>
      {sections.map(({ label, list }) =>
        list.length === 0 ? null : (
          <div key={label}>
            <SectionEyebrow label={label} right={t("total {amount}", { amount: MW(list.reduce((s, e) => s + e.available, 0)) })} />
            <CardBox>
              {list.map((e, idx) => (
                <EnvRow key={e.id} e={e} onClick={() => onOpenEnvelope(e.id, month)} last={idx === list.length - 1} />
              ))}
            </CardBox>
          </div>
        ),
      )}
    </>
  );
}

/** Separate savings-only widget (`envelopesSavings`) — same rendering as EnvelopesWidget, mode forced
 *  regardless of `opts`, so a user can run "envelopes" as everyday-only elsewhere and still see savings. */
function EnvelopesSavingsWidget(props: WidgetProps) {
  return <EnvelopesWidget {...props} opts={{ mode: "savings" }} />;
}

/* ── Report widgets: current-month cashflow numbers, and a 12mo net-worth sparkline ── */
export function CashflowWidget({ state, onNav }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const net = state.monthIncome - state.monthExpense;
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
      <CardBox>
        <div style={{ display: "flex", gap: 8, padding: "10px 0" }}>
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
      </CardBox>
    </div>
  );
}

export function NetWorthWidget({ month, onNav }: WidgetProps) {
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
      <CardBox style={{ padding: "10px 14px" }}>
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
      </CardBox>
    </div>
  );
}

/** Registry: widget id → component, in Start.tsx's render loop (`settings.startWidgets.filter(enabled)`).
 *  The `w.id in START_WIDGETS` guards below and in Start.tsx stay as defense against a corrupted/
 *  future persisted id (settings are untyped JSON at rest) even though this is now a full
 *  `Record<WidgetId, …>` — loadSettings() already drops any id unknown to the CURRENT WidgetId
 *  union on load (see contexts.tsx). */
export const START_WIDGETS: Record<WidgetId, (p: WidgetProps) => ReactNode> = {
  quickActions: QuickActions,
  accounts: AccountsWidget,
  envelopes: EnvelopesWidget,
  envelopesSavings: EnvelopesSavingsWidget,
  reportCashflow: CashflowWidget,
  reportNetWorth: NetWorthWidget,
};

/* ── "Edit widgets" sheet: reorder (drag handle), enable toggles, per-widget options ── */
const WIDGET_TITLE: Record<WidgetId, Message> = {
  quickActions: msg("Quick actions"),
  accounts: msg("Accounts"),
  envelopes: msg("Envelopes"),
  envelopesSavings: msg("Envelopes · Savings"),
  reportCashflow: msg("Report · Cash flow"),
  reportNetWorth: msg("Report · Net worth"),
};

function envModeLabel(mode: string, groups: StateResponse["groups"], t: (m: Message, p?: Record<string, string | number>) => string): string {
  if (mode === "savings") return t("Savings only");
  if (mode.startsWith("group:")) {
    const g = groups.find((gr) => gr.id === mode.slice("group:".length));
    return t("Group: {name}", { name: g?.name ?? "?" });
  }
  if (mode.startsWith("picked:")) {
    const n = mode.slice("picked:".length).split(",").filter(Boolean).length;
    return t("Selected ({n})", { n: String(n) });
  }
  return t("All (Everyday + Savings)");
}

function widgetSubtitle(w: WidgetConfig, state: StateResponse, t: (m: Message, p?: Record<string, string | number>) => string): string {
  switch (w.id) {
    // reuses the same "Selected (n)" key envModeLabel uses for envelopes' picked mode. RAW count
    // (not resolveActions' default-on-empty) — an intentional "all unchecked" must read as 0.
    case "quickActions":
      return t("Selected ({n})", { n: String((w.opts?.actions ?? []).length) });
    case "accounts": {
      const collapsed = w.opts?.collapsed ?? true;
      return collapsed ? t("collapsed · {n} shown ›", { n: String(w.opts?.count ?? 4) }) : t("all shown ›");
    }
    case "envelopes":
      return envModeLabel(w.opts?.mode ?? "all", state.groups, t);
    case "envelopesSavings":
      return t("Savings only");
    case "reportCashflow":
      return t("current month");
    case "reportNetWorth":
      return t("12-month sparkline");
  }
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      style={{
        width: 40,
        height: 22,
        borderRadius: 12,
        background: on ? "var(--accent)" : C.line,
        position: "relative",
        border: "none",
        cursor: "pointer",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left .2s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

/** Shared chip/tab look for the mode switchers below (Accounts' All/Selected, Envelopes' All/Savings/Group/Selected). */
function chipStyle(C: Theme, active: boolean): CSSProperties {
  return {
    padding: "5px 10px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    background: active ? "var(--accent-1a)" : C.chip,
    color: active ? "var(--accent)" : C.text,
    border: `1px solid ${active ? "var(--accent)" : C.line}`,
  };
}

/** Small checkbox-style indicator — same checkmark path used elsewhere for a satisfied state (see
 *  the "All money assigned" tick on Start). */
function CheckBox({ checked }: { checked: boolean }) {
  const C = useTheme();
  return (
    <span
      aria-hidden
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        border: `1.5px solid ${checked ? "var(--accent)" : C.line}`,
        background: checked ? "var(--accent)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {checked && <Ico d="M5 13l4 4L19 7" size={12} color="#fff" sw={3} />}
    </span>
  );
}

/** A tinted-icon + name + checkbox row — the "picked" checklist idiom shared by AccountsOptions and
 *  EnvelopesOptions (accounts/envelopes both carry their own {color, icon}). `query` (when the list
 *  is under search) highlights the matched span instead of just rendering the plain name. */
function PickRow({
  icon,
  color,
  name,
  checked,
  onToggle,
  query = "",
}: {
  icon: string;
  color: string;
  name: string;
  checked: boolean;
  onToggle: () => void;
  query?: string;
}) {
  const C = useTheme();
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 0",
        background: "none",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: font,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          background: tint(color, 0.15),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Glyph name={icon} size={12} color={color} sw={1.8} />
      </span>
      <span style={{ flex: 1, fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <HighlightedText text={name} query={query} />
      </span>
      <CheckBox checked={checked} />
    </button>
  );
}

function AccountsOptions({ w, state, onChange }: { w: WidgetConfig; state: StateResponse; onChange: (o: WidgetOpts) => void }) {
  const C = useTheme();
  const { t } = useT();
  const collapsed = w.opts?.collapsed ?? true;
  const count = w.opts?.count ?? 4;
  const picked = w.opts?.picked; // defined (even empty) → "Selected" tab active — see AccountsWidget
  const accounts = state.accounts.filter((a) => !a.archived);
  const [q, setQ] = useState("");
  // reset only on the "all"→"picked" transition (undefined→array) — NOT on every checkbox toggle,
  // which also produces a new `picked` array reference and would otherwise clear what was typed.
  useEffect(() => {
    if (picked !== undefined) setQ("");
  }, [picked !== undefined]);
  const filteredAccounts = accounts.filter((a) => matchesSearch(a.name, q));
  const stepBtn = {
    width: 26,
    height: 26,
    borderRadius: 8,
    border: `1px solid ${C.line}`,
    background: C.chip,
    color: C.text,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    lineHeight: 1,
  } as const;
  const tabs: Array<{ key: "all" | "picked"; label: Message; onClick: () => void }> = [
    { key: "all", label: msg("All"), onClick: () => onChange({ picked: undefined }) },
    { key: "picked", label: msg("Selected"), onClick: () => onChange({ picked: picked ?? [] }) },
  ];
  return (
    <div style={{ padding: "0 0 10px 26px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: C.text }}>{t("Collapsed by default")}</span>
        <Toggle on={collapsed} onClick={() => onChange({ collapsed: !collapsed })} label={t("Collapsed by default")} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: C.text }}>{t("Accounts shown when collapsed")}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => onChange({ count: Math.max(2, count - 1) })} style={stepBtn}>
            −
          </button>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text, width: 16, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{count}</span>
          <button onClick={() => onChange({ count: Math.min(8, count + 1) })} style={stepBtn}>
            +
          </button>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {tabs.map((tb) => (
          <button key={tb.key} onClick={tb.onClick} style={chipStyle(C, picked !== undefined ? tb.key === "picked" : tb.key === "all")}>
            {t(tb.label)}
          </button>
        ))}
      </div>
      {picked !== undefined && (
        <>
          {accounts.length > SEARCH_THRESHOLD && <PickerSearch value={q} onChange={setQ} />}
          {/* fixed (not max-) height once the search box is showing — filtering down to 1-2 rows must
              not shrink the checklist and reflow the whole widget-editor sheet under it (same shrink-
              behind-keyboard bug as the picker sheets in chrome.tsx, contained here since this list
              isn't the whole sheet). */}
          <div
            className="gs"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              ...(accounts.length > SEARCH_THRESHOLD ? { height: 200 } : { maxHeight: 200 }),
              overflowY: "auto",
            }}
          >
            {filteredAccounts.length === 0 ? (
              <div style={{ textAlign: "center", color: C.mute, fontSize: 12, padding: "10px 0" }}>{t("No matches")}</div>
            ) : (
              filteredAccounts.map((a) => {
                const ids = new Set(picked);
                const checked = ids.has(a.id);
                return (
                  <PickRow
                    key={a.id}
                    icon={a.icon}
                    color={a.color}
                    name={a.name}
                    query={q}
                    checked={checked}
                    onToggle={() => {
                      const next = new Set(ids);
                      if (checked) next.delete(a.id);
                      else next.add(a.id);
                      onChange({ picked: [...next] });
                    }}
                  />
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EnvelopesOptions({ w, state, onChange }: { w: WidgetConfig; state: StateResponse; onChange: (o: WidgetOpts) => void }) {
  const C = useTheme();
  const { t } = useT();
  const mode = w.opts?.mode ?? "all";
  const base = mode.split(":")[0]!; // "all" | "savings" | "group" | "picked"
  const groups = state.groups;
  const envelopes = state.envelopes.filter((e) => !e.archived);
  const [q, setQ] = useState("");
  // reset only on the transition INTO "picked" — not on every checkbox toggle, which also changes
  // `mode` (the picked-ids suffix) and would otherwise clear what was typed.
  useEffect(() => {
    if (base === "picked") setQ("");
  }, [base === "picked"]);
  const filteredEnvelopes = envelopes.filter((e) => matchesSearch(e.name, q));
  const tabs: Array<{ key: string; label: Message; onClick: () => void }> = [
    { key: "all", label: msg("All"), onClick: () => onChange({ mode: "all" }) },
    { key: "savings", label: msg("Savings only"), onClick: () => onChange({ mode: "savings" }) },
    { key: "group", label: msg("Group…"), onClick: () => onChange({ mode: `group:${groups[0]?.id ?? ""}` }) },
    { key: "picked", label: msg("Selected"), onClick: () => onChange({ mode: "picked:" }) },
  ];
  return (
    <div style={{ padding: "0 0 10px 26px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {tabs.map((tb) => (
          <button key={tb.key} onClick={tb.onClick} style={chipStyle(C, base === tb.key)}>
            {t(tb.label)}
          </button>
        ))}
      </div>
      {base === "group" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {groups.map((g) => (
            <button key={g.id} onClick={() => onChange({ mode: `group:${g.id}` })} style={chipStyle(C, mode === `group:${g.id}`)}>
              {g.name}
            </button>
          ))}
        </div>
      )}
      {base === "picked" && (
        <>
          {envelopes.length > SEARCH_THRESHOLD && <PickerSearch value={q} onChange={setQ} />}
          {/* fixed (not max-) height once the search box is showing — see AccountsOptions' comment. */}
          <div
            className="gs"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              ...(envelopes.length > SEARCH_THRESHOLD ? { height: 200 } : { maxHeight: 200 }),
              overflowY: "auto",
            }}
          >
            {filteredEnvelopes.length === 0 ? (
              <div style={{ textAlign: "center", color: C.mute, fontSize: 12, padding: "10px 0" }}>{t("No matches")}</div>
            ) : (
              filteredEnvelopes.map((e) => {
                const ids = new Set(mode.slice("picked:".length).split(",").filter(Boolean));
                const checked = ids.has(e.id);
                return (
                  <PickRow
                    key={e.id}
                    icon={e.icon}
                    color={e.color}
                    name={e.name}
                    query={q}
                    checked={checked}
                    onToggle={() => {
                      const next = new Set(ids);
                      if (checked) next.delete(e.id);
                      else next.add(e.id);
                      onChange({ mode: `picked:${[...next].join(",")}` });
                    }}
                  />
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function QuickActionsOptions({ w, onChange }: { w: WidgetConfig; onChange: (o: WidgetOpts) => void }) {
  const C = useTheme();
  const { t } = useT();
  // RAW opts (like AccountsOptions' `picked`) — resolveActions falls back to the default set on
  // empty, which would make "uncheck everything" snap right back to the defaults in this checklist.
  const selected = w.opts?.actions ?? [];
  return (
    <div style={{ padding: "0 0 10px 26px", display: "flex", flexDirection: "column", gap: 2 }}>
      {QUICK_ACTION_ORDER.map((key) => {
        const def = QUICK_ACTION_DEFS[key];
        const checked = selected.includes(key);
        return (
          <button
            key={key}
            onClick={() => {
              const set = new Set(selected);
              if (checked) set.delete(key);
              else set.add(key);
              // canonical order regardless of tap order — keeps QuickActions' row stable
              onChange({ actions: QUICK_ACTION_ORDER.filter((k) => set.has(k)) });
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 0",
              background: "none",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: font,
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                background: C.chip,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {def.glyph ? <Glyph name={def.glyph} size={12} color={C.soft} sw={1.8} /> : <Ico d={def.d!} size={12} color={C.soft} sw={1.8} />}
            </span>
            <span style={{ flex: 1, fontSize: 12, color: C.text }}>{t(def.label)}</span>
            <CheckBox checked={checked} />
          </button>
        );
      })}
    </div>
  );
}

export function EditWidgetsSheet({ show, state, onClose }: { show: boolean; state: StateResponse; onClose: () => void }) {
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  const [openOptions, setOpenOptions] = useState<WidgetId | null>(null);
  const list = settings.startWidgets;

  const commitMove = (from: number, to: number) => {
    const order = [...list];
    const [m] = order.splice(from, 1);
    order.splice(to, 0, m!);
    setSettings({ ...settings, startWidgets: order });
  };
  const dnd = useDragReorder(commitMove);

  const toggle = (id: WidgetId) => setSettings({ ...settings, startWidgets: list.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)) });
  const setOpts = (id: WidgetId, opts: WidgetOpts) =>
    setSettings({ ...settings, startWidgets: list.map((w) => (w.id === id ? { ...w, opts: { ...w.opts, ...opts } } : w)) });
  const configurable = (id: WidgetId) => id === "accounts" || id === "envelopes" || id === "quickActions";

  return (
    <Sheet show={show} onClose={onClose}>
      {(C) => (
        <>
          <div style={{ fontSize: 16, fontWeight: 750, color: C.text, textAlign: "center", marginBottom: 2 }}>{t("Edit widgets")}</div>
          <div style={{ fontSize: 11, color: C.mute, textAlign: "center", marginBottom: 12 }}>{t("Drag to reorder")}</div>
          {list.map((w, idx) => {
            if (!(w.id in START_WIDGETS)) return null; // corrupted/future persisted id — never crash the sheet
            const b = dnd.bind(idx);
            const title = t(WIDGET_TITLE[w.id]);
            return (
              <div
                key={w.id}
                ref={dnd.itemRef(idx)}
                style={{
                  borderBottom: `1px solid ${C.line}`,
                  background: dnd.dragging === idx ? C.bg : "transparent",
                  outline: dnd.over === idx && dnd.dragging !== idx ? `2px dashed ${TEAL}` : "none",
                  outlineOffset: -2,
                  borderRadius: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
                  <span
                    {...b}
                    aria-label={t("Drag {name}", { name: title })}
                    style={{ ...b.style, color: C.mute, fontSize: 15, padding: "4px 2px", display: "flex" }}
                  >
                    ≡
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{title}</div>
                    {configurable(w.id) ? (
                      <button
                        onClick={() => setOpenOptions(openOptions === w.id ? null : w.id)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          fontSize: 11,
                          color: C.mute,
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: font,
                        }}
                      >
                        {widgetSubtitle(w, state, t)}
                      </button>
                    ) : (
                      <div style={{ fontSize: 11, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {widgetSubtitle(w, state, t)}
                      </div>
                    )}
                  </div>
                  <Toggle on={w.enabled} onClick={() => toggle(w.id)} label={title} />
                </div>
                {openOptions === w.id && w.id === "accounts" && <AccountsOptions w={w} state={state} onChange={(o) => setOpts("accounts", o)} />}
                {openOptions === w.id && w.id === "envelopes" && <EnvelopesOptions w={w} state={state} onChange={(o) => setOpts("envelopes", o)} />}
                {openOptions === w.id && w.id === "quickActions" && <QuickActionsOptions w={w} onChange={(o) => setOpts("quickActions", o)} />}
              </div>
            );
          })}
          <button
            onClick={onClose}
            style={{
              width: "100%",
              marginTop: 14,
              padding: "12px 0",
              borderRadius: 12,
              border: "none",
              background: TEAL,
              color: "#fff",
              fontSize: 13.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Done")}
          </button>
        </>
      )}
    </Sheet>
  );
}
