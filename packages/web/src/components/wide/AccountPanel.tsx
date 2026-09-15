import { computeStateResponse, type Transaction } from "@enveo/shared";
import { type CSSProperties, useMemo, useState } from "react";
import { type StateResponse, useLedgerVersion } from "../../lib/api";
import { visibleAutomaticEnvelopeName } from "../../lib/automaticEnvelopeAccountUi";
import { useMask, useTheme } from "../../lib/contexts";
import { currentMonth, shortDate } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { Glyph } from "../../lib/icons";
import { store } from "../../lib/store";
import { font, TEAL, TRANSFER } from "../../lib/theme";
import { AccountEditSheet } from "../AccountEditSheet";
import { ReconcileSheet } from "../ReconcileSheet";
import { accountIconColor } from "../tiles";

export function AccountPanel({
  accountId,
  envelopes,
  groups,
  onOpenTxns,
  onEditTxn,
}: {
  accountId: string;
  envelopes: StateResponse["envelopes"];
  groups: StateResponse["groups"];
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onEditTxn: (t: Transaction) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp, lang } = useT();
  const version = useLedgerVersion();

  const accountsNow = useMemo(() => {
    const l = store.getLedger();
    return l ? computeStateResponse(l, currentMonth()).accounts : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const account = accountsNow.find((a) => a.id === accountId) ?? null;

  const [edit, setEdit] = useState(false);
  const [reconcile, setReconcile] = useState(false);

  // Reconcile gets ACTIVE envelopes/groups only — exactly `AccountsWidget`'s filter (widgets.tsx),
  // the sheet's other caller: with raw lists, an ARCHIVED linked envelope would still validate as
  // the automatic adjustment target and the picker would offer archived envelopes. `AccountEditSheet`
  // keeps the raw lists on purpose — same as `Accounts.tsx`'s phone call sites — because it filters
  // through `selectableAutomaticEnvelopes` itself.
  const activeEnvelopes = useMemo(() => envelopes.filter((envelope) => !envelope.archived), [envelopes]);
  const activeGroups = useMemo(() => {
    const activeGroupIds = new Set(activeEnvelopes.map((envelope) => envelope.groupId));
    return groups.filter((group) => activeGroupIds.has(group.id));
  }, [activeEnvelopes, groups]);

  // Transactions touching this account, across every month — the LIVE ledger, not the viewed
  // month's `state.transactions` (that goes empty on day 1 for an older account; the widgetsBoard
  // `RecentWidget` pattern and its stated reason, reused verbatim below rather than re-derived).
  // "Touching" is two-sided, same as `transactionSearch.ts`'s account filter and this pane's own
  // "Transactions" button (`onOpenTxns` → the shared matcher): a transfer's `accountId` is only
  // the SOURCE, so a transfer landing here as the DESTINATION (`toAccountId`) must still show up,
  // or an account funded mainly by transfers-in renders an incomplete list while its own
  // "Transactions" button correctly shows the same rows. `recent` (the last 5, for the list below)
  // and `txnCountThisMonth` (the balance box's caption) both derive from this ONE sorted array.
  const accById = useMemo(() => {
    const ledger = store.getLedger();
    return new Map((ledger?.accounts ?? []).map((a) => [a.id, a]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const envById = useMemo(() => new Map(envelopes.map((e) => [e.id, e])), [envelopes]);
  const touching = useMemo(() => {
    const ledger = store.getLedger();
    if (!ledger) return [];
    return ledger.transactions
      .filter((tx) => tx.accountId === accountId || tx.toAccountId === accountId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, accountId]);
  const recent = useMemo(() => touching.slice(0, 5), [touching]);
  // Balance-box caption (waveE-t2-brief.md, v3:2832): transactions touching this account in the
  // REAL current calendar month (`currentMonth()`) — matching the box's own GLOBAL balance above
  // it (the 3.6.2 law), NEVER the app's viewed `state.month` (unlike the Accounts card grid's own
  // "{n} transactions · {month}" sub-line, which self-documents its viewed-month scope in its own
  // text — this caption's bare "this month" instead reads as "right now", the same tense as the
  // balance figure it sits directly under).
  const txnCountThisMonth = useMemo(() => touching.filter((tx) => tx.date.slice(0, 7) === currentMonth()).length, [touching]);

  // Vanished account (deleted in another tab / by sync): render the hint body, never crash — the
  // `EnvelopeScreen` no-data rule, verbatim. `closePanel`/✕ still work; a fresh `nav()` clears the
  // stale selection (App.tsx). No new i18n key: the panel's own no-selection hint reads naturally
  // here too.
  if (!account) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.5 }}>{t("Choose an account to see its details.")}</span>
      </div>
    );
  }

  // Automatic line THROUGH THE BOUNDARY — never `account.automaticEnvelopeId` raw (a pre-3.8
  // replica row has no key at all; `visibleAutomaticEnvelopeName`'s falsy check is the pinned
  // behaviour, `automaticEnvelopeAccountUi.ts`).
  const automaticName = visibleAutomaticEnvelopeName(account, envelopes);

  // Same sign/description rules as widgetsBoard.tsx's `RecentWidget` (itself matching
  // Transactions.tsx's row) — reused rather than re-derived, INCLUDING the expense colour
  // (`C.text`, not `C.neg` — only the balance figure above is sign-coloured; a single expense row
  // reads as ordinary spending, not a deficit).
  const signed = (tx: Transaction): { text: string; color: string } => {
    if (tx.type === "transfer") return { text: M(tx.amount), color: TRANSFER };
    if (tx.type === "income" || tx.isRefund) return { text: `+${M(tx.amount)}`, color: C.pos };
    return { text: `-${M(tx.amount)}`, color: C.text };
  };
  const descOf = (tx: Transaction): string => {
    if (tx.type === "transfer") {
      const from = accById.get(tx.accountId)?.name ?? "?";
      const to = tx.toAccountId ? (accById.get(tx.toAccountId)?.name ?? "?") : "?";
      return `${from} → ${to}`;
    }
    const env = tx.envelopeId ? envById.get(tx.envelopeId) : null;
    return tx.name || tx.note || env?.name || (tx.items.length ? t("Split transaction") : t("Transaction"));
  };

  const actionBtnStyle: CSSProperties = {
    minHeight: 36,
    padding: "9px 0",
    borderRadius: 11,
    border: `1px solid var(--accent-55)`,
    background: "var(--accent-1a)",
    color: TEAL,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: font,
  };

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", padding: 14 }}>
      {/* icon + name row (waveE-t2-brief.md, v3:2003-2005) — plain body content, NOT a second
          name/✕ band: PanelHost's slim header above this pane is the only chrome (owner rule 2). */}
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 13, flexWrap: "wrap" }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: account.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.92)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Glyph name={account.icon} size={12} color={accountIconColor(account.color)} />
          </span>
        </span>
        <span style={{ fontSize: 16.5, fontWeight: 700, color: C.text }}>{account.name}</span>
        {account.archived && (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 650,
              color: C.mute,
              background: C.inset,
              borderRadius: 999,
              padding: "3px 9px",
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            {t("Closed")}
          </span>
        )}
      </div>

      {}
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px", marginBottom: 22 }}>
        <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.mute, marginBottom: 4 }}>{t("Balance")}</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: account.balance < 0 ? C.neg : C.text, fontVariantNumeric: "tabular-nums" }}>
          {M(account.balance)}
        </div>
        <div style={{ fontSize: 11.5, color: C.soft, marginTop: 4 }}>{tp("{n} transaction this month | {n} transactions this month", txnCountThisMonth)}</div>
        {automaticName && (
          <div style={{ fontSize: 11.5, fontWeight: 650, color: TEAL, marginTop: 4 }}>{t("Automatic envelope: {name}", { name: automaticName })}</div>
        )}
      </div>

      {}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 22 }}>
        <button onClick={() => onOpenTxns({ accId: account.id })} style={actionBtnStyle}>
          {t("Transactions")}
        </button>
        <button onClick={() => setEdit(true)} style={actionBtnStyle}>
          {t("Edit")}
        </button>
        <button onClick={() => setReconcile(true)} style={actionBtnStyle}>
          {t("Reconcile")}
        </button>
      </div>

      {}
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>{t("Recent in {name}", { name: account.name })}</div>
      {recent.length === 0 ? (
        <div style={{ fontSize: 12, color: C.mute }}>{t("No transactions.")}</div>
      ) : (
        recent.map((tx, i) => {
          const s = signed(tx);
          return (
            <div
              key={tx.id}
              role="button"
              onClick={() => onEditTxn(tx)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                minHeight: 30,
                padding: "8px 0",
                borderBottom: i === recent.length - 1 ? "none" : `1px solid ${C.line}`,
                cursor: "pointer",
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontSize: 12.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{descOf(tx)}</span>
                <span style={{ fontSize: 10.5, color: C.mute }}>{shortDate(tx.date, lang)}</span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: s.color, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{s.text}</span>
            </div>
          );
        })
      )}
      <AccountEditSheet account={edit ? account : null} envelopes={envelopes} groups={groups} onClose={() => setEdit(false)} />
      <ReconcileSheet account={reconcile ? account : null} envelopes={activeEnvelopes} groups={activeGroups} onClose={() => setReconcile(false)} />
    </div>
  );
}
