import type { BalanceMatchChange, BalanceMatchNearest } from "@enveo/shared";
import type { ReactNode } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import type { ImportBalanceDiagnosis, ImportBalanceEffect } from "../lib/importReview";
import { CORAL, TEAL } from "../lib/theme";
import { AmountField } from "./AmountField";
import type { AmountPadTarget } from "./AmountPadSheet";

/**
 * The reconciliation statement at the foot of the screenshot-import review.
 *
 * Shaped like the thing it reconciles against — a bank statement: one right-aligned column of
 * figures, a summation rule above the result, the bank's own figure typed into the same column.
 * The arithmetic is the information; nothing here is a card, a badge or an arrow. Every state
 * (matches / differs / suggestion / no explanation) reads as one more line of the statement.
 */
export type ImportBalanceMatchState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "proposal"; changes: BalanceMatchChange[]; rationale: string | null; alternatives: number }
  | { kind: "none"; nearest: BalanceMatchNearest | null }
  | { kind: "declined"; rationale: string };

export function ImportBalanceReceipt({
  source,
  others,
  money,
  bankValue,
  onBankValue,
  pad,
  difference,
  diagnosis,
  match,
  proposalFits,
  rowLabel,
  reconcileAfter,
  onReconcileAfter,
  onMatch,
  onApply,
  onApplyNearest,
  onDismiss,
}: {
  /** The import's source account: current balance, selected rows' effect, balance after. */
  source: ImportBalanceEffect | null;
  /** Other accounts the selection touches (rows moved by hand, transfer targets). */
  others: ImportBalanceEffect[];
  money: (minor: number) => string;
  bankValue: string;
  onBankValue: (value: string) => void;
  pad: readonly [AmountPadTarget | null, (target: AmountPadTarget | null) => void];
  /** Bank balance minus balance after import; null until a bank figure is typed. */
  difference: number | null;
  /** Why nothing fits, computed only when the search came back empty. */
  diagnosis: ImportBalanceDiagnosis | null;
  match: ImportBalanceMatchState;
  proposalFits: boolean;
  rowLabel: (rowId: string) => string;
  reconcileAfter: boolean;
  onReconcileAfter: (value: boolean) => void;
  onMatch: () => void;
  onApply: () => void;
  /** Applies the closest fit; the residual stays on the receipt for Reconcile. */
  onApplyNearest: () => void;
  onDismiss: () => void;
}) {
  const C = useTheme();
  const { t, tp } = useT();
  if (!source) return null;
  const figure = (value: number, tone: "text" | "soft" | "pos" | "neg" = "text"): ReactNode => (
    <span
      style={{
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        color: tone === "pos" ? TEAL : tone === "neg" ? CORAL : tone === "soft" ? C.soft : C.text,
      }}
    >
      {value < 0 ? `−${money(-value)}` : money(value)}
    </span>
  );
  const line = (label: ReactNode, value: ReactNode, extra?: { strong?: boolean; rule?: boolean; testId?: string }) => (
    <div
      data-testid={extra?.testId}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: extra?.rule ? "7px 0 0" : "3px 0",
        marginTop: extra?.rule ? 4 : 0,
        borderTop: extra?.rule ? `1px solid ${C.line}` : undefined,
        fontSize: extra?.strong ? 15 : 13,
        fontWeight: extra?.strong ? 650 : 500,
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: extra?.strong ? C.text : C.soft, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {value}
    </div>
  );
  const signed = (value: number) => `${value < 0 ? "−" : "+"}${money(Math.abs(value))}`;
  const changeLine = (change: BalanceMatchChange) =>
    line(
      change.action === "exclude"
        ? t("Uncheck {row}", { row: rowLabel(change.id) })
        : change.action === "include"
          ? t("Check {row}", { row: rowLabel(change.id) })
          : t("Reverse {row}", { row: rowLabel(change.id) }),
      <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", color: C.soft }}>{signed(change.delta)}</span>,
    );

  return (
    <section
      data-testid="import-balance-receipt"
      aria-label={t("Balance reconciliation")}
      style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 10 }}
    >
      <div style={{ fontSize: 13, fontWeight: 650, color: C.text, marginBottom: 4 }}>{source.name}</div>
      {line(t("In the app now"), figure(source.before, "soft"))}
      {line(t("Selected rows"), figure(source.delta, "soft"))}
      {line(t("After import"), figure(source.after), { strong: true, rule: true, testId: "import-balance-after" })}
      {others.map((effect) => line(t("{account} after import", { account: effect.name }), figure(effect.after)))}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "3px 0", fontSize: 13 }}>
        <span style={{ color: C.soft }}>{t("Bank shows")}</span>
        <AmountField
          value={bankValue}
          onCommit={onBankValue}
          label={t("Bank shows")}
          placeholder={t("Type the balance")}
          allowNegative
          inline
          externalPad={pad}
        />
      </div>
      {difference !== null &&
        line(
          difference === 0 ? t("Matches the bank") : t("Difference"),
          difference === 0 ? <span style={{ color: TEAL }}>✓</span> : figure(difference, difference > 0 ? "pos" : "neg"),
          { strong: true, testId: "import-bank-difference" },
        )}

      {difference !== null && difference !== 0 && match.kind !== "proposal" && (
        <button
          type="button"
          onClick={onMatch}
          disabled={match.kind === "searching"}
          style={{
            marginTop: 8,
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: `1px solid ${C.line}`,
            background: C.bg,
            color: C.text,
            fontWeight: 650,
            fontSize: 13,
            cursor: "pointer",
            opacity: match.kind === "searching" ? 0.6 : 1,
          }}
        >
          {match.kind === "searching" ? t("Choosing the best match…") : t("Match to the bank balance")}
        </button>
      )}

      {match.kind === "proposal" && (
        <div data-testid="import-bank-proposal" style={{ marginTop: 10, paddingLeft: 12, borderLeft: `2px solid ${C.line}` }}>
          <div style={{ fontSize: 13, fontWeight: 650, color: C.text, marginBottom: 2 }}>{t("Suggested changes")}</div>
          {match.changes.map(changeLine)}
          {proposalFits && difference !== null && source && line(t("After changes"), figure(source.after + difference), { strong: true, rule: true })}
          {match.rationale && <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.45, color: C.soft }}>{match.rationale}</div>}
          {match.alternatives > 0 && (
            <div style={{ marginTop: 4, fontSize: 12, color: C.mute }}>
              {tp("{n} other combination also fits. | {n} other combinations also fit.", match.alternatives)}
            </div>
          )}
          {!proposalFits && <div style={{ marginTop: 6, fontSize: 12.5, color: C.warn }}>{t("The selection changed since this suggestion. Match again.")}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              type="button"
              onClick={onApply}
              disabled={!proposalFits}
              style={{
                flex: 1.4,
                padding: "10px 8px",
                borderRadius: 10,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontWeight: 650,
                fontSize: 13,
                cursor: "pointer",
                opacity: proposalFits ? 1 : 0.5,
              }}
            >
              {t("Apply changes")}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              style={{
                flex: 1,
                padding: "10px 8px",
                borderRadius: 10,
                border: `1px solid ${C.line}`,
                background: C.bg,
                color: C.soft,
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {t("Dismiss")}
            </button>
          </div>
        </div>
      )}

      {(match.kind === "none" || match.kind === "declined") && difference !== null && difference !== 0 && (
        <div data-testid="import-bank-no-match" style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.45, color: C.text }}>
          <div>
            {match.kind === "declined"
              ? t("The assistant found no convincing combination.")
              : diagnosis && Math.abs(difference) > diagnosis.reach
                ? t(
                    "The uncertain rows could explain at most {amount}. A transaction is probably missing from the screenshots, or the app already differed from the bank before this import.",
                    {
                      amount: money(diagnosis.reach),
                    },
                  )
                : t("No combination of uncertain rows explains the difference.")}
          </div>
          {match.kind === "declined" && match.rationale && <div style={{ marginTop: 4, color: C.soft }}>{match.rationale}</div>}
          {match.kind === "none" && match.nearest && (
            <div data-testid="import-bank-nearest" style={{ marginTop: 10, paddingLeft: 12, borderLeft: `2px solid ${C.line}` }}>
              <div style={{ fontSize: 13, fontWeight: 650, color: C.text, marginBottom: 2 }}>{t("Closest fit")}</div>
              {match.nearest.changes.map(changeLine)}
              {line(t("Still unexplained"), figure(match.nearest.residual, match.nearest.residual > 0 ? "pos" : "neg"), { strong: true, rule: true })}
              <button
                type="button"
                onClick={onApplyNearest}
                style={{
                  marginTop: 8,
                  width: "100%",
                  padding: "10px 8px",
                  borderRadius: 10,
                  border: `1px solid ${C.line}`,
                  background: C.bg,
                  color: C.text,
                  fontWeight: 650,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {t("Apply the closest fit")}
              </button>
            </div>
          )}
          {diagnosis && diagnosis.manualEntries.length > 0 && (
            <div data-testid="import-manual-entries" style={{ marginTop: 8 }}>
              <div style={{ color: C.soft }}>{t("Entered by hand in this period, worth a second look:")}</div>
              {diagnosis.manualEntries.map((entry) =>
                line(
                  `${entry.date} · ${entry.name ?? (entry.transfer ? t("Transfer") : t("No name"))}`,
                  <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", color: C.soft }}>{signed(entry.effect)}</span>,
                ),
              )}
            </div>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={reconcileAfter} onChange={(event) => onReconcileAfter(event.target.checked)} />
            <span>{t("Reconcile to the bank balance after adding")}</span>
          </label>
        </div>
      )}
    </section>
  );
}
