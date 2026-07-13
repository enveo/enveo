/**
 * Reports → "Subscriptions" tab (spec 2026-07-08-subscriptions-design §2–3):
 * 1. "To review (N)" — inbox of detection proposals (expandable history,
 *    ✓ acceptProposal / ✗ dismiss per device); empty → the section disappears,
 * 2. "Upcoming" — EXCLUSIVELY planned transactions (upcomingWindow from
 *    lib/reportSummary — same source as the Reports overview card);
 *    tap → actions sheet: shift date / pause 1-2-3 months / delete,
 * 3. "Your recurring payments" — rules with a template + ~X/month total.
 * Everything computed locally from the replica (pure shared selectors, zero I/O).
 */
import { useMemo, useState } from "react";
import {
  detectSubscriptions,
  type ClientLedger,
  type Recurrence,
  type UpcomingPayment,
} from "@enveo/shared";
import { useLedgerVersion } from "../lib/api";
import { useMask, useSubsDismissed, useTheme } from "../lib/contexts";
import { shortDate, todayISO } from "../lib/dates";
import { isLight } from "../lib/format";
import { haptic } from "../lib/haptics";
import { useT, type Message, msg } from "../lib/i18n";
import { Glyph } from "../lib/icons";
import { local } from "../lib/mutate";
import { upcomingWindow } from "../lib/reportSummary";
import { store } from "../lib/store";
import { acceptProposal, pauseRecurrence, recurringRows, removeRecurrence, txnToPayload } from "../lib/subs";
import { CORAL, TEAL } from "../lib/theme";
import { Sheet } from "./chrome";

type Mask = (n: number) => string;

/** "Pause" durations offered on a recurring payment. */
const PAUSE_LABEL: Record<1 | 2 | 3, Message> = { 1: msg("1 mo"), 2: msg("2 mo"), 3: msg("3 mo") };

const CYCLE_KEY: Record<Recurrence["rule"], Message> = {
  none: msg("monthly"), // a "none" rule is never created in the UI — key only for type completeness
  weekly: msg("weekly"),
  monthly: msg("monthly"),
  monthEnd: msg("month end"),
  quarterly: msg("quarterly"),
  yearly: msg("yearly"),
};

export function SubscriptionsTab() {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  const { dismissed, dismiss } = useSubsDismissed();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [sheet, setSheet] = useState<UpcomingPayment | null>(null);
  const today = todayISO();

  const ledger = store.getLedger();
  const proposals = useMemo(
    () => (ledger ? detectSubscriptions(ledger, today).filter((p) => !dismissed.includes(p.key)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, today, dismissed],
  );
  // ONE source of "upcoming" shared with the Reports overview card (lib/reportSummary).
  const upcoming = useMemo(
    () => (ledger ? upcomingWindow(ledger, today, 30).payments : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, today],
  );
  const recurring = useMemo(
    () => (ledger ? recurringRows(ledger, today) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, today],
  );
  if (!ledger) return null;
  const totalMonthly = recurring.reduce((s, r) => s + r.monthlyCost, 0);

  const sectionTitle = (label: string, right?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "18px 0 8px" }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{label}</span>
      {right && <span style={{ fontSize: 12.5, fontWeight: 600, color: C.soft, fontVariantNumeric: "tabular-nums" }}>{right}</span>}
    </div>
  );

  return (
    <>
      {proposals.length > 0 && (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "2px 0 8px" }}>{t("To review ({n})", { n: proposals.length })}</div>
          {proposals.map((p) => {
            const open = openKey === p.key;
            return (
              <div key={p.key} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 12px", marginBottom: 8 }}>
                <button onClick={() => setOpenKey(open ? null : p.key)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</div>
                    <div style={{ fontSize: 11.5, color: C.soft, marginTop: 2 }}>
                      {t(p.cycle === "monthly" ? msg("monthly") : msg("yearly"))} · {t("seen {n}× since {date}", { n: p.occurrences.length, date: shortDate(p.occurrences[0]!.date, lang, true) })}
                    </div>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(p.amount)}</span>
                  <span aria-hidden style={{ color: C.mute, fontSize: 11, flexShrink: 0, transform: open ? "rotate(180deg)" : "none" }}>▾</span>
                </button>
                {open && (
                  <div style={{ marginTop: 8, borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
                    {p.occurrences.map((o) => (
                      <div key={o.date} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.soft, padding: "2px 0" }}>
                        <span>{shortDate(o.date, lang, true)}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>{M(o.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    onClick={() => { acceptProposal(p); haptic([10, 30, 14]); }}
                    style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: "none", background: TEAL, color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                  >
                    ✓ {t("It's a subscription")}
                  </button>
                  <button
                    onClick={() => dismiss(p.key)}
                    style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: `1px solid ${C.line}`, background: "transparent", color: C.soft, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                  >
                    ✗ {t("Not a subscription")}
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {sectionTitle(t("Upcoming"))}
      {upcoming.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "4px 0" }}>{t("No planned payments in the next 30 days.")}</div>}
      {upcoming.map((u) => {
        const env = u.txn.envelopeId ? ledger.envelopes.find((e) => e.id === u.txn.envelopeId) : undefined;
        return (
          <button key={u.txn.id} onClick={() => setSheet(u)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: "none", border: "none", borderBottom: `1px solid ${C.line}`, padding: "9px 0", cursor: "pointer", textAlign: "left" }}>
            <span style={{ fontSize: 11.5, color: C.soft, width: 52, flexShrink: 0 }}>{shortDate(u.txn.date, lang)}</span>
            <span style={{ width: 30, height: 30, borderRadius: 8, background: env?.color ?? C.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {env && <Glyph name={env.icon} size={15} color={isLight(env.color) ? "#33312c" : "#fff"} />}
            </span>
            <span style={{ flex: 1, fontSize: 13.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.label}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(u.txn.amount)}</span>
          </button>
        );
      })}

      {sectionTitle(t("Your recurring payments"), recurring.length > 0 ? t("~{amount}/mo", { amount: M(totalMonthly) }) : undefined)}
      {recurring.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "4px 0" }}>{t("No recurring payments. Confirm a proposal above or add a transaction with repeat (Add → Repeat).")}</div>}
      {recurring.map((r) => (
        <div key={r.rec.id} style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.line}`, padding: "9px 0" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.label}
              {r.paused && <span style={{ fontSize: 11, color: "#d97706", marginLeft: 6 }}>{t("(paused until {date})", { date: shortDate(r.rec.pausedUntil!, lang, true) })}</span>}
            </div>
            <div style={{ fontSize: 11, color: C.soft, marginTop: 2 }}>
              {t(CYCLE_KEY[r.rec.rule])}
              {r.nextDate ? ` · ${t("next {date}", { date: shortDate(r.nextDate, lang) })}` : r.lastDate ? ` · ${t("last {date}", { date: shortDate(r.lastDate, lang) })}` : ""}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(r.amount)}</div>
            {r.rec.rule !== "monthly" && r.rec.rule !== "monthEnd" && (
              <div style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{t("~{amount}/mo", { amount: M(r.monthlyCost) })}</div>
            )}
          </div>
        </div>
      ))}

      <UpcomingActionsSheet payment={sheet} ledger={ledger} onClose={() => setSheet(null)} M={M} />
    </>
  );
}

/** Upcoming-payment actions sheet: shift date / pause (only with a rule) / delete. */
function UpcomingActionsSheet({ payment, ledger, onClose, M }: { payment: UpcomingPayment | null; ledger: ClientLedger; onClose: () => void; M: Mask }) {
  const { t, lang } = useT();
  const rec = payment?.txn.recurrenceId ? ledger.recurrences.find((r) => r.id === payment.txn.recurrenceId) : undefined;

  const shiftDate = (date: string) => {
    if (!payment || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date === payment.txn.date) return;
    local.updateTxn(payment.txn.id, { ...txnToPayload(payment.txn), date });
    haptic(8);
    onClose();
  };
  const pause = (months: number) => {
    if (!rec) return;
    pauseRecurrence(rec, months);
    haptic(8);
    onClose();
  };
  const remove = () => {
    if (!payment) return;
    if (rec) {
      if (!window.confirm(t("Delete this recurring payment? Future planned transactions will be removed; history stays."))) return;
      removeRecurrence(rec);
    } else {
      if (!window.confirm(t("Delete this transaction? This cannot be undone."))) return;
      local.deleteTxn(payment.txn.id);
    }
    onClose();
  };

  return (
    <Sheet show={!!payment} onClose={onClose}>
      {(C) => {
        if (!payment) return null;
        const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 0", borderTop: `1px solid ${C.line}` } as const;
        return (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
              <span style={{ flex: 1, fontSize: 17, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{payment.label}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(payment.txn.amount)}</span>
            </div>
            <div style={row}>
              <span style={{ fontSize: 13.5, color: C.text }}>{t("Move date")}</span>
              <input
                type="date"
                value={payment.txn.date}
                onChange={(e) => shiftDate(e.target.value)}
                aria-label={t("Move date")}
                style={{ border: `1px solid ${C.line}`, borderRadius: 9, padding: "6px 8px", background: C.bg, color: C.text, fontSize: 13, colorScheme: "inherit" }}
              />
            </div>
            {rec && (
              <div style={row}>
                <span style={{ fontSize: 13.5, color: C.text }}>{t("Pause")}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  {([1, 2, 3] as const).map((n) => (
                    <button key={n} onClick={() => pause(n)} style={{ padding: "6px 12px", borderRadius: 9, border: `1px solid ${C.line}`, background: "transparent", color: C.text, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                      {t(PAUSE_LABEL[n])}
                    </button>
                  ))}
                </span>
              </div>
            )}
            <div style={row}>
              <button onClick={remove} style={{ width: "100%", padding: "9px 0", borderRadius: 9, border: "none", background: "transparent", color: CORAL, fontSize: 13.5, fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
                {rec ? t("Delete recurring payment") : t("Delete")}
              </button>
            </div>
            {rec?.pausedUntil && rec.pausedUntil > new Date().toISOString().slice(0, 10) && (
              <div style={{ fontSize: 11.5, color: "#d97706", marginTop: 4 }}>{t("(paused until {date})", { date: shortDate(rec.pausedUntil, lang, true) })}</div>
            )}
          </>
        );
      }}
    </Sheet>
  );
}
