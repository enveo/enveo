import { type EnvelopeView } from "../lib/api";
import { useMask } from "../lib/contexts";
import { isLight } from "../lib/format";
import { Glyph } from "../lib/icons";
import { useT } from "../lib/i18n";
import { CORAL, CTA, INCOME } from "../lib/theme";
import { Sheet } from "./chrome";

/**
 * Envelope actions sheet (tap on a tile/row on Start/Budget), variant 1B:
 * header with the icon tile and an "Added · Spent" line, two stat badges
 * (Available / From previous), primary action "Summary" as the
 * CTA + a row of secondary ones (Transactions, Edit). Navigation is the caller's (App) job.
 */
export function EnvActionsSheet({
  env,
  onClose,
  onTxns,
  onSummary,
  onEdit,
}: {
  env: EnvelopeView | null;
  onClose: () => void;
  onTxns: () => void;
  onSummary: () => void;
  onEdit: () => void;
}) {
  const M = useMask();
  const { t } = useT();
  return (
    <Sheet show={!!env} onClose={onClose}>
      {(C) => {
        if (!env) return null;
        const sign = env.carryIn < 0 ? "-" : "+";
        const badge = (label: string, value: string, color: string) => (
          <div style={{ flex: 1, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 12px" }}>
            <div style={{ fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase", color: C.mute }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{value}</div>
          </div>
        );
        const secondary = (label: string, onClick: () => void) => (
          <button onClick={onClick} style={{ flex: 1, padding: 11, borderRadius: 12, background: C.bg, border: `1px solid ${C.line}`, color: C.text, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>
            {label}
          </button>
        );
        return (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 14 }}>
              <div style={{ width: 44, height: 44, borderRadius: 11, background: env.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Glyph name={env.icon} size={20} color={isLight(env.color) ? "#33312c" : "#fff"} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 19, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{env.name}</div>
                <div style={{ fontSize: 12.5, color: C.soft, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
                  {t("env.statsLine", { allocated: M(env.allocated), spent: M(Math.max(0, env.spent)) })}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {badge(
                t("env.availableLabel"),
                `${env.available < 0 ? "-" : ""}${M(Math.abs(env.available))}`,
                env.available < 0 ? CORAL : INCOME,
              )}
              {badge(t("env.carryLabel"), `${sign}${M(Math.abs(env.carryIn))}`, C.soft)}
            </div>
            <button onClick={onSummary} style={{ width: "100%", padding: 12, borderRadius: 12, border: "none", background: CTA, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              {t("budget.summaryBtn")}
            </button>
            <div style={{ display: "flex", gap: 8, marginTop: 8, paddingBottom: 4 }}>
              {secondary(t("nav.transactions"), onTxns)}
              {secondary(t("common.edit"), onEdit)}
            </div>
          </>
        );
      }}
    </Sheet>
  );
}
