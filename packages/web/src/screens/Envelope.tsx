import { computeEnvelopeSummary, computeStateResponse } from "@enveo/shared";
import { useMemo, useState } from "react";
import { type EnvelopeView, useLedgerVersion } from "../lib/api";
import { useMask, useTheme } from "../lib/contexts";
import { monthLabel, shiftMonth } from "../lib/dates";
import { isLight } from "../lib/format";
import { msg, useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { store } from "../lib/store";
import { font, P, TEAL } from "../lib/theme";
import { EnvEdit } from "./Budget";

const PERIODS = [1, 3, 6, 12] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_KEY = { 1: msg("1 mo"), 3: msg("3 mo"), 6: msg("6 mo"), 12: msg("1 yr") } as const;

/**
 * Full-screen envelope summary (replaces the old summary sheet).
 * Everything computed EXCLUSIVELY locally from the IndexedDB replica (zero api
 * calls — e2ee parity): computeEnvelopeSummary (category windows) +
 * computeStateResponse (allocated/spent/available of the selected month).
 */
export function EnvelopeScreen({
  envelopeId,
  initialMonth,
  onBack,
  onOpenTxns,
}: {
  envelopeId: string;
  initialMonth: string;
  onBack: () => void;
  onOpenTxns: (f?: { envId?: string; accId?: string }) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  // the screen's local month — starts from the source screen's month
  const [m, setM] = useState(initialMonth);
  const [period, setPeriod] = useState<Period>(1);
  const [edit, setEdit] = useState<EnvelopeView | null>(null);

  const data = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeEnvelopeSummary(ledger, envelopeId, m, { categoryMonths: period }) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, envelopeId, m, period]);
  const stateM = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeStateResponse(ledger, m) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, m]);
  const env = stateM?.envelopes.find((e) => e.id === envelopeId);

  const backBtn = (
    <button onClick={onBack} aria-label={t("Back")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
      <Ico d="M15 19l-7-7 7-7" size={20} color={C.text} sw={2} />
    </button>
  );

  // envelope vanished from the replica (e.g. deleted on another device) → back only
  if (!data || !stateM || !env) {
    return (
      <div className="gs" style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", padding: `12px ${P}px 6px` }}>{backBtn}</div>
      </div>
    );
  }

  const txt = isLight(env.color) ? "#33312c" : "#fff";
  const neg = env.available < 0;
  const carryIn = data.carryIn;
  const progress = Math.min(1, Math.max(0, env.spent / Math.max(1, env.allocated + carryIn)));
  const series = data.series;
  const maxSpent = Math.max(...series.map((s) => s.spent), 1);
  const total = data.categoriesTotal;

  // single hero-card stat (uppercase label + value)
  const stat = (label: string, value: string, color: string) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.mute, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
        {/* header: back + icon + name */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: `12px ${P}px 4px` }}>
          {backBtn}
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: env.color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Glyph name={env.icon} size={17} color={txt} />
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{env.name}</span>
        </div>

        {/* month navigation (local to the screen) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "4px 0 12px" }}>
          <button
            onClick={() => setM(shiftMonth(m, -1))}
            aria-label={t("Previous month")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
          >
            <Ico d="M15 19l-7-7 7-7" size={17} />
          </button>
          <span style={{ color: C.text, fontSize: 16.5, fontWeight: 600, minWidth: 128, textAlign: "center", letterSpacing: 0.2 }}>{monthLabel(m, lang)}</span>
          <button
            onClick={() => setM(shiftMonth(m, 1))}
            aria-label={t("Next month")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
          >
            <Ico d="M9 5l7 7-7 7" size={17} />
          </button>
        </div>

        {/* hero card (2A): stats + progress + carry in ONE card */}
        <div style={{ margin: `0 ${P}px 18px`, background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px 12px" }}>
          <div style={{ display: "flex", textAlign: "center", gap: 8 }}>
            {stat(t("BUDGET"), M(env.allocated), C.text)}
            {stat(t("SPENT"), M(Math.max(0, env.spent)), C.text)}
            {stat(t("AVAILABLE"), `${neg ? "-" : ""}${M(Math.abs(env.available))}`, neg ? C.neg : C.pos)}
          </div>
          {/* progress bar INSIDE the card: spent / (allocated + carryIn) */}
          <div style={{ marginTop: 12, height: 7, background: C.inset, borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress * 100}%`, background: neg ? C.neg : env.color, borderRadius: 4, transition: "width .4s" }} />
          </div>
          {/* carry-over from the previous month (Variant A — may be negative) */}
          <div style={{ marginTop: 8, textAlign: "center", fontSize: 10, color: carryIn < 0 ? C.neg : C.mute, fontVariantNumeric: "tabular-nums" }}>
            {t("{amount} from the previous month", { amount: `${carryIn < 0 ? "-" : "+"}${M(Math.abs(carryIn))}` })}
          </div>
        </div>

        {/* monthly breakdown (6 bars) — before categories (2A) */}
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, margin: `0 ${P}px 10px` }}>{t("Monthly breakdown")}</div>
        {series.map((s) => (
          <div key={s.month} style={{ display: "flex", alignItems: "center", gap: 10, margin: `0 ${P}px 8px` }}>
            <span style={{ fontSize: 12, color: C.soft, width: 70, textAlign: "right" }}>{monthLabel(s.month, lang).split(" ")[0]}</span>
            <div style={{ flex: 1, height: 8, background: C.inset, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(Math.max(0, s.spent) / maxSpent) * 100}%`, background: env.color, borderRadius: 4 }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.text, width: 76, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {M(Math.max(0, s.spent))}
            </span>
          </div>
        ))}

        {/* breakdown by category + period switcher */}
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, margin: `10px ${P}px 8px` }}>{t("Breakdown by category")}</div>
        <div style={{ display: "flex", gap: 6, margin: `0 ${P}px 12px` }}>
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                flex: 1,
                padding: "6px 0",
                borderRadius: 9,
                border: `1px solid ${period === p ? TEAL : C.line}`,
                background: period === p ? "var(--accent-1a)" : "transparent",
                color: period === p ? TEAL : C.soft,
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: font,
              }}
            >
              {t(PERIOD_KEY[p])}
            </button>
          ))}
        </div>
        {data.categories.map((c) => {
          const share = total > 0 ? (c.amount / total) * 100 : 0;
          return (
            <div key={c.categoryId ?? "none"} style={{ margin: `0 ${P}px 10px` }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.name}
                </span>
                <span style={{ fontSize: 11.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{share.toFixed(1)}%</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(c.amount)}</span>
              </div>
              <div style={{ height: 4, background: C.inset, borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
                <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, share))}%`, background: env.color, borderRadius: 2 }} />
              </div>
            </div>
          );
        })}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "baseline",
            gap: 8,
            margin: `2px ${P}px 18px`,
            paddingTop: 8,
            borderTop: `1px solid ${C.line}`,
          }}
        >
          <span style={{ fontSize: 12.5, color: C.soft }}>{t("Total")}</span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(total)}</span>
        </div>
      </div>

      {/* bottom actions */}
      <div
        style={{
          display: "flex",
          gap: 10,
          padding: `10px ${P}px calc(10px + env(safe-area-inset-bottom))`,
          borderTop: `1px solid ${C.line}`,
          background: C.bg,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => onOpenTxns({ envId: envelopeId })}
          style={{
            flex: 1,
            padding: "12px 0",
            borderRadius: 12,
            border: `1px solid var(--accent-55)`,
            background: "var(--accent-1a)",
            color: TEAL,
            fontSize: 13.5,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: font,
          }}
        >
          {t("Transactions")}
        </button>
        <button
          onClick={() => setEdit(env)}
          style={{
            flex: 1,
            padding: "12px 0",
            borderRadius: 12,
            border: "none",
            background: TEAL,
            color: "#fff",
            fontSize: 13.5,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: font,
          }}
        >
          {t("Edit")}
        </button>
      </div>

      <EnvEdit env={edit} groups={stateM.groups} onClose={() => setEdit(null)} />
    </div>
  );
}
