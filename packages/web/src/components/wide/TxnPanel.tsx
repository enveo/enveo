import { computeStateResponse, type Transaction } from "@enveo/shared";
import { useMemo, useState } from "react";
import { type StateResponse, useLedgerVersion } from "../../lib/api";
import { useMask, useTheme } from "../../lib/contexts";
import { currentMonth, shortDate } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import { store } from "../../lib/store";
import { font, TRANSFER, tint } from "../../lib/theme";

/**
 * Design parity wave C task 3 — the transaction detail pane body (v3's `txn` pane, `txnDetail`
 * v3:2846-2876, markup v3:1316-1364): a read-only card, exactly like `AccountPanel`/`EnvelopePanel`
 * before it — hosted exclusively by `PanelHost`'s `txn` kind, which only ever renders on wide.
 * Owner rule 2 is the whole point of this file: a row click must land HERE, never on the phone's
 * numpad editor (`AddScreen`) — that only opens after an explicit Edit tap.
 *
 * `state.transactions`/`state.envelopes` are the VIEWED-month replica `PanelHost` already threads
 * everywhere else — correct for a transaction (transactions and envelope `available`/`spent` are
 * both month-scoped by construction) but wrong for a GLOBAL account balance, so the no-envelope
 * stat row recomputes accounts at `currentMonth()` off the live ledger — the exact `AccountPanel`
 * rule (Rail.tsx `TbbCard`, the 3.6.2 incident) applied here too.
 */
export function TxnPanel({
  txnId,
  state,
  month,
  onOpenEnvelope,
  onEditTxn,
  onDuplicateTxn,
}: {
  txnId: string;
  state: StateResponse;
  month: string;
  onOpenEnvelope: (envId: string, month: string) => void;
  onEditTxn: (t: Transaction) => void;
  onDuplicateTxn: (t: Transaction) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  // Local to THIS transaction — `PanelHost` keys this component by `txnId` (its own comment has
  // why): deleting the open transaction falls the panel back to a different one derivationally,
  // and a stale "are you sure?" card must not survive that switch onto an unrelated row.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tx = state.transactions.find((x) => x.id === txnId) ?? null;

  // GLOBAL account balances (house rule — Rail.tsx `TbbCard`/`AccountPanel`'s own rule), computed
  // regardless of whether this transaction even has one: cheap, and keeps the hook order stable
  // across the early "vanished" return below.
  const accountsNow = useMemo(() => {
    const l = store.getLedger();
    return l ? computeStateResponse(l, currentMonth()).accounts : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Vanished transaction (deleted elsewhere between panel-open and this render — a delete from
  // another device, a sync pull): render the hint body, never crash — the `AccountPanel`/
  // `EnvelopeScreen` no-data rule, verbatim. `WideShell`'s own vanish effect (design parity wave C
  // task 3) is the NORMAL path back to a real fallback; this is the defensive backstop for the one
  // frame in between, reusing the panel's own generic "nothing open" copy (`HINT_COPY.generic`,
  // PanelHost.tsx) rather than inventing a transaction-specific string for a case that should be
  // instantly superseded.
  if (!tx) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.5 }}>{t("Nothing is open in this panel yet.")}</span>
      </div>
    );
  }

  // Same sign/description rules as `AccountPanel`/`Transactions.tsx` (reused rather than
  // re-derived — the established per-screen idiom, each already a THIRD instance of the other
  // two's identical logic): expense stays `C.text`, not `C.neg` — a single row reads as ordinary
  // spending, not a deficit.
  const signed = (x: Transaction): { text: string; color: string } => {
    if (x.type === "transfer") return { text: M(x.amount), color: TRANSFER };
    if (x.type === "income" || x.isRefund) return { text: `+${M(x.amount)}`, color: C.pos };
    return { text: `-${M(x.amount)}`, color: C.text };
  };
  const descOf = (x: Transaction): string => {
    if (x.type === "transfer") {
      const from = state.accounts.find((a) => a.id === x.accountId)?.name ?? "?";
      const to = x.toAccountId ? (state.accounts.find((a) => a.id === x.toAccountId)?.name ?? "?") : "?";
      return `${from} → ${to}`;
    }
    const txEnv = x.envelopeId ? state.envelopes.find((e) => e.id === x.envelopeId) : null;
    return x.name || x.note || txEnv?.name || (x.items.length ? t("Split transaction") : t("Transaction"));
  };

  const kindLabel = tx.isRefund ? t("Refund") : tx.type === "income" ? t("Income") : tx.type === "transfer" ? t("Transfer") : t("Expense");
  const amount = signed(tx);
  const payee = descOf(tx);
  const catName = tx.categoryId ? (state.categories.find((c) => c.id === tx.categoryId)?.name ?? null) : null;
  const dateCat = [shortDate(tx.date, lang), catName].filter((part): part is string => !!part).join(" · ");

  const env = tx.envelopeId ? (state.envelopes.find((e) => e.id === tx.envelopeId) ?? null) : null;
  const envName = env ? env.name : tx.items.length ? t("Split transaction") : "—";
  const acctName = state.accounts.find((a) => a.id === tx.accountId)?.name ?? "?";

  const rows: Array<{ label: string; value: string }> = env
    ? [
        { label: t("Envelope available after this"), value: M(env.available) },
        { label: t("Spent in {envelope} this month", { envelope: env.name }), value: M(Math.max(0, env.spent)) },
      ]
    : [{ label: t("Account balance"), value: M(accountsNow.find((a) => a.id === tx.accountId)?.balance ?? 0) }];
  const deleteEffect = env
    ? t("The amount goes back to {envelope} and the account balance is restored. This cannot be undone.", { envelope: env.name })
    : t("The account balance is restored. This cannot be undone.");

  const pillStyle = {
    flex: 1,
    textAlign: "center" as const,
    padding: "11px 0",
    minHeight: 36,
    boxSizing: "border-box" as const,
    borderRadius: 11,
    border: `1px solid ${C.line}`,
    background: "transparent",
    color: C.soft,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: font,
  };
  const fieldRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 13px", fontSize: 13 };

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 13 }}>
      {/* kind → amount hero → payee → date · category */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.17em", textTransform: "uppercase", color: C.mute }}>{kindLabel}</span>
        <span style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.025em", color: amount.color, fontVariantNumeric: "tabular-nums" }}>{amount.text}</span>
        <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{payee}</span>
        {dateCat && <span style={{ fontSize: 12.5, color: C.soft }}>{dateCat}</span>}
      </div>

      {/* Envelope / Account / Note field group */}
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
        <div
          role={env ? "button" : undefined}
          tabIndex={env ? 0 : undefined}
          onClick={env ? () => onOpenEnvelope(env.id, month) : undefined}
          onKeyDown={
            env
              ? (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  onOpenEnvelope(env.id, month);
                }
              : undefined
          }
          style={{ ...fieldRowStyle, borderBottom: `1px solid ${C.line}`, cursor: env ? "pointer" : "default" }}
        >
          <span style={{ color: C.soft }}>{t("Envelope")}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 650, color: C.text }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: env ? env.color : C.mute, display: "block" }} />
            {envName}
            {env && " ›"}
          </span>
        </div>
        <div style={{ ...fieldRowStyle, borderBottom: `1px solid ${C.line}` }}>
          <span style={{ color: C.soft }}>{t("Account")}</span>
          <span style={{ fontWeight: 650, color: C.text }}>{acctName}</span>
        </div>
        <div style={fieldRowStyle}>
          <span style={{ color: C.soft }}>{t("Note")}</span>
          <span style={{ color: C.mute }}>{tx.note || t("No note")}</span>
        </div>
      </div>

      {/* stat lines */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: 12.5, color: C.soft }}>
            <span>{r.label}</span>
            <span style={{ fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums" }}>{r.value}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {!confirmDelete ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onEditTxn(tx)} style={pillStyle}>
            {t("Edit")}
          </button>
          <button onClick={() => onDuplicateTxn(tx)} style={pillStyle}>
            {t("Duplicate")}
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            style={{ ...pillStyle, flex: "none", padding: "11px 16px", border: `1px solid ${C.neg}`, color: C.neg, fontWeight: 600 }}
          >
            {t("Delete")}
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
            border: `1px solid ${C.neg}`,
            borderRadius: 12,
            padding: "12px 13px",
            background: tint(C.neg, 0.06),
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 650, color: C.text }}>{t("Delete “{name}”?", { name: payee })}</span>
          <span style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.45 }}>{deleteEffect}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setConfirmDelete(false)} style={{ ...pillStyle, padding: "10px 0", minHeight: 36, borderRadius: 10, background: C.card }}>
              {t("Cancel")}
            </button>
            <button
              onClick={() => local.deleteTxn(tx.id)}
              style={{
                flex: 1,
                textAlign: "center",
                padding: "10px 0",
                minHeight: 36,
                boxSizing: "border-box",
                borderRadius: 10,
                border: "none",
                background: C.neg,
                color: "#fff",
                fontSize: 13,
                fontWeight: 650,
                cursor: "pointer",
                fontFamily: font,
              }}
            >
              {t("Delete")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
