import type { AccountView, EnvelopeView } from "../lib/api";
import { useMask, useSettings, useTheme } from "../lib/contexts";
import { fmtTrimLocale } from "../lib/format";
import { goalProgress } from "../lib/goals";
import { useT } from "../lib/i18n";
import { Glyph } from "../lib/icons";
import { tint } from "../lib/theme";
import { spendMeter } from "../lib/uiState";
import { GoalRing, SpendLine } from "./kit";

/** Envelope list row: name (+goal ring), available amount, spend line (spec §3.2-3.3). */
export function EnvRow({ e, onClick, last }: { e: EnvelopeView; onClick: () => void; last?: boolean }) {
  const M = useMask();
  const C = useTheme();
  const { t, lang } = useT();
  const { settings } = useSettings();
  // Savings envelopes without spending show no meter — the line always means
  // "spent of assigned", and a funded savings pot has nothing to measure (spec §3.3).
  const meter = e.isSavings && e.spent <= 0 ? null : spendMeter(e);
  const gp = goalProgress(e);
  const neg = e.available < 0;
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        padding: "7px 0 8px",
        background: "none",
        border: "none",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 13, fontWeight: 550, color: C.text }}>
          {gp && <GoalRing pct={gp.pct} />}
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: neg ? C.neg : C.text, flexShrink: 0 }}>
          {neg ? "−" : ""}
          {M(Math.abs(e.available))}
        </span>
      </span>
      {meter ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
          <SpendLine meter={meter} />
          <span style={{ fontSize: 10, color: meter.state === "over" ? C.neg : C.mute, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
            {meter.state === "over"
              ? t("overspent")
              : settings.discreet
                ? `${M(Math.max(0, e.spent))} / ${M(meter.total)}`
                : `${fmtTrimLocale(Math.max(0, e.spent), lang)} / ${M(meter.total)}`}
          </span>
        </span>
      ) : gp ? (
        <span style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <span style={{ fontSize: 10, color: C.mute, fontVariantNumeric: "tabular-nums" }}>
            {t("monthly goal: {allocated} / {target} · {pct}%", {
              allocated: settings.discreet ? M(Math.max(0, e.allocated)) : fmtTrimLocale(Math.max(0, e.allocated), lang),
              target: M(e.monthlyTarget ?? 0),
              pct: String(Math.round(gp.pct)),
            })}
          </span>
        </span>
      ) : null}
    </button>
  );
}

const lightChip = (c: string) => c === "#e9e3d7" || c === "#cdeede";

export const accountIconColor = (color: string) => (lightChip(color) ? "#8a8576" : color);

/** Compact account cell for the Start 2-column grid: tinted icon, name, balance. */
export function AccCell({ a, onClick, last }: { a: AccountView; onClick: () => void; last?: boolean }) {
  const M = useMask();
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 0",
        background: "none",
        border: "none",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        cursor: "pointer",
        textAlign: "left",
        minWidth: 0,
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 8,
          background: tint(a.color, 0.15),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Glyph name={a.icon} size={13} color={a.color} sw={1.8} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 10.5, color: C.soft, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {a.name}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 700,
            color: C.text,
            lineHeight: 1.3,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {M(a.balance)}
        </span>
      </span>
    </button>
  );
}
