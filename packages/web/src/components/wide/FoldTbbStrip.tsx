import { computeStateResponse } from "@enveo/shared";
import { useMemo, useState } from "react";
import type { StateResponse } from "../../lib/api";
import { useLedgerVersion } from "../../lib/api";
import { useMask, useTheme } from "../../lib/contexts";
import { currentMonth } from "../../lib/dates";
import { type Message, msg, useT } from "../../lib/i18n";
import { store } from "../../lib/store";
import { font } from "../../lib/theme";
import { sumBalances, tbbState } from "../../lib/uiState";
import type { ScreenId } from "../chrome";

/** New this task (pr4-task-5-brief.md) — outside a direct `t()`/`tp()` call (a ternary), so
 *  `msg()` marks both for the extractor per the house i18n convention.
 *  Task 9 i18n hygiene (`bun run i18n:ambiguity`): `"Collapse"` is flagged as reused (the other
 *  call site is `ChipPicker.tsx`'s section toggle) — checked and kept as-is, not renamed to a
 *  longer form: both sites are the same gender-neutral Polish imperative ("Zwiń", no referent to
 *  inflect for), and both mean the identical action (collapse an expandable section). `"Show
 *  all"` is brand-new here and not (yet) reused anywhere, so it isn't a collision candidate. */
const CHIPS_TOGGLE: Record<"open" | "closed", Message> = { open: msg("Collapse"), closed: msg("Show all") };

/**
 * Fold-only "to be budgeted" strip, above the primary pane's content (spec demo 212-240 +
 * 4169-4173) — the ONE surface this PR implements for the fold's money card (mockup
 * inconsistency 8 rejects the demo's second, overlapping band pill). Desktop never mounts this:
 * its rail already carries the equivalent card (`Rail.tsx`'s `TbbCard`).
 *
 * `compact` is the demo's third density tier for Transactions (tighter padding, smaller amount,
 * no income/expense line) — three inline ternaries on ONE boolean, not a new `dense` enum
 * (pr4-task-5-brief.md, following the shell inventory's recommendation).
 */
export function FoldTbbStrip({
  state,
  screen,
  onQuickAdd,
  onFillGoals,
  onNav,
}: {
  state: StateResponse;
  screen: ScreenId;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onNav: (s: ScreenId) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp } = useT();
  const [chipsOpen, setChipsOpen] = useState(false);
  const compact = screen === "transactions";
  const hs = tbbState(state.readyToAssign);
  const tbbColor = hs === "negative" ? C.neg : hs === "zero" ? C.pos : "var(--cta)";
  // GLOBAL balances (chrome.tsx Drawer pattern) — never the viewed month (3.6.2).
  const version = useLedgerVersion();
  const accountsGlobal = useMemo(() => {
    const ledger = store.getLedger();
    if (!ledger) return [];
    return computeStateResponse(ledger, currentMonth())
      .accounts.filter((a) => !a.archived)
      .sort((a, b) => a.sort - b.sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const pill = (primary: boolean): React.CSSProperties => ({
    minHeight: 30,
    padding: "0 13px",
    textAlign: "center",
    borderRadius: 999,
    border: primary ? "1.5px solid var(--cta)" : `1px solid ${C.line}`,
    background: "transparent",
    color: primary ? "var(--cta)" : C.soft,
    fontSize: 11.5,
    fontWeight: primary ? 700 : 650,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: font,
  });

  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        margin: "9px 14px 4px",
        padding: compact ? "7px 12px" : "11px 12px",
        border: `1px solid ${C.line}`,
        borderRadius: 14,
        background: C.card,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 9, fontWeight: 750, letterSpacing: "0.14em", textTransform: "uppercase", color: C.mute }}>{t("To be budgeted")}</span>
          <span
            style={{
              fontSize: compact ? 16 : 21,
              fontWeight: 800,
              letterSpacing: "-0.015em",
              color: tbbColor,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {M(state.readyToAssign)}
          </span>
          {!compact && (
            <span style={{ fontSize: 9.5, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
              <span style={{ color: C.pos }}>↑</span> {M(state.monthIncome)} · <span style={{ color: C.neg }}>↓</span> {M(state.monthExpense)}
            </span>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button onClick={onFillGoals} style={pill(false)}>
            {t("Fill by goals")}
          </button>
          <button onClick={() => onQuickAdd("suggest")} aria-label={t("Suggest a distribution")} style={pill(true)}>
            {"✨ "}
            {t("Suggest")}
          </button>
        </span>
      </div>
      <button
        onClick={() => setChipsOpen((v) => !v)}
        aria-expanded={chipsOpen}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          width: "100%",
          marginTop: compact ? 6 : 10,
          paddingTop: compact ? 6 : 9,
          border: "none",
          borderTop: `1px solid ${C.line}`,
          background: "none",
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 30 }}>
          <span style={{ fontSize: 12, color: C.text, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
            {tp("{n} account · total {amount} | {n} accounts · total {amount}", accountsGlobal.length, {
              n: String(accountsGlobal.length),
              amount: M(sumBalances(accountsGlobal)),
            })}
          </span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--cta)", display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
            {t(CHIPS_TOGGLE[chipsOpen ? "open" : "closed"])}
            <span aria-hidden>{chipsOpen ? "▴" : "▾"}</span>
          </span>
        </span>
      </button>
      {chipsOpen && accountsGlobal.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 10px", marginTop: 2 }}>
          {accountsGlobal.map((a) => (
            <button
              key={a.id}
              onClick={() => onNav("accounts")}
              style={{
                minWidth: 0,
                minHeight: 32,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 7px",
                borderRadius: 8,
                border: "none",
                background: C.inset,
                cursor: "pointer",
                fontFamily: font,
                textAlign: "left",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: a.color, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 9.5, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: a.balance < 0 ? C.neg : C.text,
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {M(a.balance)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
