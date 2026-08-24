import { computeStateResponse, type Transaction } from "@enveo/shared";
import { type CSSProperties, useMemo, useState } from "react";
import { type StateResponse, useLedgerVersion } from "../../lib/api";
import { visibleAutomaticEnvelopeName } from "../../lib/automaticEnvelopeAccountUi";
import { useMask, useTheme } from "../../lib/contexts";
import { currentMonth, shortDate } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { store } from "../../lib/store";
import { font, TEAL, TRANSFER } from "../../lib/theme";

/**
 * PR6b Task 4 — the account detail pane body (v3's `acct` pane): balance card → actions grid →
 * recent activity. Hosted exclusively by `PanelHost`'s `account` kind, which only ever renders on
 * wide (pr6b-context.md D2) — unlike `EnvelopeScreen` (also mounted full-screen on phone), this
 * component never forks on `useWideHost()`; it is a panel body by construction, always.
 *
 * The balance is GLOBAL, always: `computeStateResponse(store.getLedger(), currentMonth())` —
 * NEVER the viewed month's `state.accounts` — the exact Drawer/Rail/AccountsWidget rule (Rail.tsx
 * `TbbCard`, widgets.tsx `AccountsWidget`) this pane exists to make reachable on wide (the 3.6.2
 * incident's screen). Edit/Reconcile are STUBBED here on purpose: `AccountEdit` isn't extracted
 * yet (Task 5) and `ReconcileSheet` still lives in eager `widgets.tsx` (Task 6) — the buttons and
 * their local open-booleans are wired now so those tasks only add a render, not new plumbing.
 */
export function AccountPanel({
  accountId,
  envelopes,
  onOpenTxns,
  onEditTxn,
}: {
  accountId: string;
  envelopes: StateResponse["envelopes"];
  /** Unused until Task 5 (the automatic-envelope picker) — accepted now so `PanelHost`'s call
   *  site doesn't change shape again when that surface lands. */
  groups: StateResponse["groups"];
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
  onEditTxn: (t: Transaction) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();

  // GLOBAL balance, always (see file header) — recomputed at `currentMonth()` on every ledger
  // write, regardless of which month the shell is viewing.
  const accountsNow = useMemo(() => {
    const l = store.getLedger();
    return l ? computeStateResponse(l, currentMonth()).accounts : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const account = accountsNow.find((a) => a.id === accountId) ?? null;

  // Edit/Reconcile: Task 5/6 render a `Surface` off these; only the openers exist here.
  const [, setEdit] = useState(false);
  const [, setReconcile] = useState(false);

  // Recent activity: last 5 transactions touching this account, across every month — the LIVE
  // ledger, not the viewed month's `state.transactions` (that goes empty on day 1 for an older
  // account; the widgetsBoard `RecentWidget` pattern and its stated reason, reused verbatim below
  // rather than re-derived). "Touching" is two-sided, same as `transactionSearch.ts`'s account
  // filter and this pane's own "Transactions" button (`onOpenTxns` → the shared matcher): a
  // transfer's `accountId` is only the SOURCE, so a transfer landing here as the DESTINATION
  // (`toAccountId`) must still show up, or an account funded mainly by transfers-in renders an
  // incomplete list while its own "Transactions" button correctly shows the same rows.
  const accById = useMemo(() => {
    const ledger = store.getLedger();
    return new Map((ledger?.accounts ?? []).map((a) => [a.id, a]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const envById = useMemo(() => new Map(envelopes.map((e) => [e.id, e])), [envelopes]);
  const recent = useMemo(() => {
    const ledger = store.getLedger();
    if (!ledger) return [];
    return ledger.transactions
      .filter((tx) => tx.accountId === accountId || tx.toAccountId === accountId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, accountId]);

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
      {/* balance card */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 26, fontWeight: 800, color: account.balance < 0 ? C.neg : C.text, fontVariantNumeric: "tabular-nums" }}>
            {M(account.balance)}
          </span>
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
        {automaticName && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: TEAL }}>{t("Automatic: {envelope}", { envelope: automaticName })}</div>
        )}
      </div>

      {/* actions: 2-col grid, three buttons — the third spans the grid's natural flow */}
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

      {/* recent activity */}
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>{t("Recent activity")}</div>
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
    </div>
  );
}
