import { useEffect, useRef, useState } from "react";
import type { AccountView, StateResponse } from "../lib/api";
import {
  automaticEnvelopePreview,
  formatAutomaticEnvelopeEffect,
  type ReconciliationEnvelopeSelection,
  reconciliationActualValueAfterAccountRefresh,
  reconciliationEnvelopeAfterAccountRefresh,
  reconciliationTxnPayload,
} from "../lib/automaticEnvelopeUi";
import { useMask } from "../lib/contexts";
import { parseAmount } from "../lib/format";
import { msg, useT } from "../lib/i18n";
import { Glyph } from "../lib/icons";
import { local } from "../lib/mutate";
import { TEAL } from "../lib/theme";
import { AutomaticEnvelopeEffect } from "../screens/add/AutomaticEnvelopeEffect";
import { EnvelopePickerSheet } from "../screens/add/EnvelopePickerSheet";
import { collapsedRowStyle } from "../screens/add/styles";
import { AmountField } from "./AmountField";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { Surface } from "./chrome";

/**
 * PR6b Task 6 — account balance reconciliation, extracted verbatim out of eager `widgets.tsx`
 * (where it was owned by the phone Start `AccountsWidget`'s per-account action sheet) into its
 * own lazily-imported module: the whole body (~180 dense lines) leaves the eager closure — the
 * bundle buy this task exists for (pr6b-context.md ground truth #10 / D3). `widgets.tsx` now
 * `lazy()`s this module behind `useOpenedOnce`, the exact `EnvActionsSheet` idiom; `AccountPanel`
 * (wide) reaches it too, so both callers share one implementation instead of two.
 *
 * `Sheet` → `Surface` is the only hosting change: on phone (and any un-hosted mount) `Surface` IS
 * `Sheet`, byte-identical. The "Actual balance (from your bank)" field is Task 5's `AmountField`
 * (the CONTROLLER RULING scopes the desktop-input fork to exactly this field and acctForm's
 * starting balance) — it owns the pad-vs-real-input fork, but NOT the pad's hosting here: this
 * module keeps its own local `pad` state (via `AmountField`'s `externalPad` escape hatch, review
 * fix) and renders `AmountPadHost` itself as a SIBLING of `<Surface>`, per the brief. Nesting the
 * pad inside the Surface's own body — as the field's self-contained default would — puts the
 * pad's `Sheet` inside the (phone) outer Sheet's always-transformed content div, breaking its
 * `position:fixed` backdrop+numpad against that small sheet instead of the viewport (the
 * ancestor-transform pitfall, CLAUDE.md; Accounts.tsx's "Starting balance" hoists the same way,
 * and `AmountField.test.ts`'s source scan fails the suite on any regression); the
 * currency-symbol span next to the old raw `<input>` is still gone with the move to `AmountField`
 * (no currency glyph on Accounts.tsx's field either). `real`/`diff` and everything downstream (the
 * difference line, the automatic-envelope preview, the envelope row) still derive from the SAME
 * canonical `fmtSignedTrim` string via `parseAmount` — no new math, integer minor units end to
 * end; only the widget rendering the string changed, so the padKey scars (⌫ deletes exactly one
 * char, `−` starts a negative only on an empty/"0" line) stay exactly as pinned in `amount.test.ts`
 * on fold/phone, and desktop gets a real `<input>` instead.
 *
 * Callers pass a GLOBAL `AccountView` (from `computeStateResponse(ledger, currentMonth())`) —
 * `AccountsWidget` already does; `AccountPanel`'s Reconcile action does too — so "Balance in the
 * app" is current by construction regardless of which month the shell is viewing (the 3.6.2 rule
 * this cluster exists to make reachable on wide).
 */
export function ReconcileSheet({
  account,
  envelopes,
  groups,
  onClose,
  initialValue = "",
}: {
  account: AccountView | null;
  envelopes: StateResponse["envelopes"];
  groups: StateResponse["groups"];
  onClose: () => void;
  /** Canonical `fmtSignedTrim` text to start from (the screenshot import hands over the bank balance). */
  initialValue?: string;
}) {
  const M = useMask();
  const { t } = useT();
  const [val, setVal] = useState(initialValue);
  const [envelopeSelection, setEnvelopeSelection] = useState<ReconciliationEnvelopeSelection | null>(null);
  const [showEnvelopePicker, setShowEnvelopePicker] = useState(false);
  // Hoisted so `AmountPadHost` (below) can render as a SIBLING of `<Surface>` — see this module's
  // and `AmountField`'s docblocks (`externalPad`).
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
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
    // A handed-over starting value (the bank balance from a screenshot import) wins on first mount only.
    setVal((current) =>
      previousBalanceSource === null && initialValue ? initialValue : reconciliationActualValueAfterAccountRefresh(current, previousBalanceSource, account),
    );
    setEnvelopeSelection((current) => reconciliationEnvelopeAfterAccountRefresh(current, account.id, automaticEnvelopeId));
    setShowEnvelopePicker(false);
  }, [account?.id, account?.balance, automaticEnvelopeId]);
  if (!account) return null;
  const currentEnvelopeSelection = reconciliationEnvelopeAfterAccountRefresh(envelopeSelection, account.id, automaticEnvelopeId);
  const envelopeId = currentEnvelopeSelection.envelopeId;
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
      <Surface show={!!account} onClose={onClose}>
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
            <div style={{ marginBottom: 12 }}>
              <AmountField value={val} onCommit={setVal} label={t("Actual balance (from your bank)")} allowNegative externalPad={[pad, setPad]} />
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
      </Surface>
      {/* Sibling of the Surface (not a child) — the panel's transform would break the pad's
          position:fixed on wide, and on phone the outer Sheet's own always-on transform would do
          the same to a pad nested inside it (see `AmountField`'s `externalPad` docblock). */}
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
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
    </>
  );
}
