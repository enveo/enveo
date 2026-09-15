import { Fragment } from "react";
import { Bar, NetWorthChart, netWorthRangeLabel, ReportShell, SegBar, useReportBand } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { useWideHost } from "../../lib/shellContext";
import { SAGE_BG, TEAL } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

export function AssetsReport({
  netWorth,
  state,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  netWorth: { month: string; total: number }[];
  state: StateResponse;
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const { band } = useReportBand();
  const inWide = useWideHost() !== null;
  const nwLast = netWorth.at(-1)?.total ?? 0;
  const nwDelta = nwLast - (netWorth.at(-2)?.total ?? nwLast);
  const savings = state.envelopes.filter((e) => !e.archived && e.isSavings);
  const total = savings.reduce((s, e) => s + e.available, 0);
  const remaining = nwLast - total;
  // A part-to-whole bar is meaningful only when both parts are nonnegative.
  const showShares = nwLast > 0 && total >= 0 && remaining >= 0;
  const pct = showShares ? Math.round((total / nwLast) * 100) : 0;
  const max = Math.max(...savings.map((e) => Math.abs(e.available)), 1);
  const nwTotals = netWorth.map((p) => p.total);
  return (
    <ReportShell
      title={t(TITLES.assets)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Net worth")}
      hero={M(nwLast)}
      sub={
        nwDelta !== 0 ? (
          <>
            {nwDelta > 0 ? "▲ +" : "▼ "}
            {M(Math.abs(nwDelta))} {t("m/m")}
          </>
        ) : undefined
      }
      bandChart={netWorth.length > 1 ? <NetWorthChart points={netWorth} height={118} onBand={band} /> : undefined}
    >
      {netWorth.length > 1 && (
        <div style={{ fontSize: 10.5, color: C.mute, textAlign: "center", marginBottom: 12, fontVariantNumeric: "tabular-nums" }}>
          {}
          {inWide && <>{netWorthRangeLabel(netWorth, lang, tp)} · </>}
          {t("range {min}–{max}", { min: M(Math.min(...nwTotals)), max: M(Math.max(...nwTotals)) })}
        </div>
      )}
      <section aria-label={t("Net worth is made up of")} style={{ marginTop: 20, marginBottom: 28 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 12px" }}>{t("Net worth is made up of")}</h2>
        {showShares && (
          <div aria-hidden="true" style={{ marginBottom: 12 }}>
            <SegBar
              segments={[
                { weight: total, color: TEAL },
                { weight: remaining, color: SAGE_BG },
              ]}
            />
          </div>
        )}
        <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) max-content", gap: "10px 12px", margin: 0, alignItems: "baseline" }}>
          {[
            { label: t("Wealth"), amount: total, color: TEAL, share: pct },
            { label: t("Remaining funds"), amount: remaining, color: SAGE_BG, share: 100 - pct },
          ].map((part) => (
            <Fragment key={part.label}>
              <dt style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, color: C.text, fontSize: 13 }}>
                <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", flexShrink: 0, background: part.color }} />
                <span>
                  {part.label}
                  {showShares && (
                    <span
                      aria-label={t("{pct}% of net worth", { pct: part.share })}
                      style={{ marginLeft: 8, color: C.soft, fontSize: 12, whiteSpace: "nowrap" }}
                    >
                      {part.share}%
                    </span>
                  )}
                </span>
              </dt>
              <dd
                style={{
                  margin: 0,
                  textAlign: "right",
                  whiteSpace: "nowrap",
                  fontSize: 13,
                  fontWeight: 650,
                  color: part.amount < 0 ? C.neg : C.text,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {M(part.amount)}
              </dd>
            </Fragment>
          ))}
        </dl>
      </section>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "0 0 12px" }}>{t("Wealth breakdown")}</h2>
      {savings.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "4px 0", lineHeight: 1.6 }}>
          {t(
            "No envelopes are marked as wealth envelopes. Open an envelope → Edit and turn on “Wealth envelope” (e.g. Bonds, Retirement, Savings), and we will count them here.",
          )}
        </div>
      ) : (
        savings.map((e) => (
          <div key={e.id} style={{ marginBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>
                {M(e.available)}
              </span>
            </div>
            <Bar pct={(Math.max(0, e.available) / max) * 100} color={TEAL} />
          </div>
        ))
      )}
    </ReportShell>
  );
}
