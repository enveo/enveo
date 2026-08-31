/**
 * The six report-backed Start widgets — attention/recent/spending/goals/trends/heatmap — split out
 * of `widgets.tsx` into their own lazy chunk (§3f, PR5): unlike the six original widgets, these
 * pull in `reportKit`'s chart primitives and `@enveo/shared`'s reports math, which the eager
 * closure's fixed byte budget cannot absorb. `widgets.tsx` mounts them via `lazy()` + `LazyChunk`
 * (its own `renderWidget`/`LAZY_WIDGETS`) — this module is never imported eagerly by anything.
 *
 * Every body reuses the SAME pure functions the full report screens use — `budgetSteps`/
 * `budgetPace` (via `homeAttention.attentionRows`), `computeSpendingByDimension`,
 * `computeEnvelopeTrends`, `computeDailySpending`, `goalProgress` — never a fresh, parallel
 * derivation that could drift from what the report itself shows.
 *
 * Every tile action NAVIGATES (F7 in pr5-context.md, ratified by the controller): none of these
 * bodies allocates money or opens a write sheet. `onOpenReport`/`onOpenMonthDay` deep-link into the
 * existing Reports screen (App.tsx's `openReports`/`setMonthDay`, already wired before this PR);
 * `onNav`/`onQuickAdd` are the same callbacks the original six widgets already use.
 *
 * `chromeless` (from `WidgetProps`) skips the phone SectionEyebrow+CardBox chrome for a future wide
 * board tile that owns its own title+card chrome (Task 6) — default `false`/absent renders exactly
 * the phone chrome below, so Start's own rendering is unaffected by this file existing.
 */
import {
  computeDailySpending,
  computeEnvelopeTrends,
  computeSpendingByDimension,
  computeStateResponse,
  goalProgress,
  largestExpenses,
  type Transaction,
  topPlaces,
} from "@enveo/shared";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { useLedgerVersion } from "../lib/api";
import { useMask, useTheme } from "../lib/contexts";
import { currentMonth, shortDate, todayISO } from "../lib/dates";
import { canFillGoals } from "../lib/goals";
import { haptic } from "../lib/haptics";
import { type AttentionRow, attentionRows } from "../lib/homeAttention";
import { useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { monthProgress } from "../lib/reportSummary";
import { store } from "../lib/store";
import { font, TEAL, type Theme, TRANSFER } from "../lib/theme";
import { useElementWidth } from "../lib/useElementWidth";
import { trendColor } from "../screens/reports/charts";
import { CardBox, GoalRing, SectionEyebrow } from "./kit";
import { Bar, CalendarHeatmap, dimNullLabel, heatColor, heatWeeks, SegBar, TrendRow, TrendSpark } from "./reportKit";
import type { WidgetProps } from "./widgets";

/** Wraps a widget body's rows in the phone SectionEyebrow+CardBox chrome, unless a wide board tile
 *  already owns title+card chrome (`chromeless`) — see this file's own header comment. */
function WidgetShell({ title, chromeless, children }: { title: string; chromeless?: boolean; children: ReactNode }) {
  if (chromeless) return <>{children}</>;
  return (
    <div>
      <SectionEyebrow label={title} />
      <CardBox>{children}</CardBox>
    </div>
  );
}

/** One row's shared button reset + hairline separator — the same idiom TrendsReport/BudgetsReport
 *  already use for their own rows, reused here rather than re-typed six times. */
function rowBtnStyle(C: Theme, last: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "8px 0",
    background: "none",
    border: "none",
    borderBottom: last ? "none" : `1px solid ${C.line}`,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  };
}

/* ── Attention: the app's triage, folded into one actionable list (F7 — every action navigates) ── */
export function AttentionWidget({ state, month, onNav, onOpenReport, onQuickAdd, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t, tp } = useT();
  const version = useLedgerVersion();
  const progress = monthProgress(month, todayISO());
  const rows = useMemo(() => {
    const ledger = store.getLedger();
    if (!ledger) return [];
    // Accounts are GLOBAL, current-month always — never the viewed month (homeAttention.ts's own
    // doc comment; same rule AccountsWidget/NetWorthWidget already follow in widgets.tsx).
    const globalAccounts = computeStateResponse(ledger, currentMonth()).accounts;
    return attentionRows({ ...state, accounts: globalAccounts }, progress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, version, progress]);

  const label = (row: AttentionRow): string => {
    switch (row.kind) {
      case "over":
        return row.n === 1 ? t("{name} is overspent", { name: row.name! }) : tp("{n} envelope is overspent | {n} envelopes are overspent", row.n);
      case "risk":
        return t("{name} will overspend at this pace", { name: row.name });
      case "pool":
        return t("Unassigned money is sitting in the pool");
      case "overAssigned":
        return t("You assigned more than you have");
      case "goals":
        return tp("{n} goal is short this month | {n} goals are short this month", row.n);
      case "debt":
        return row.n === 1 ? t("{name} is in the red", { name: row.name! }) : tp("{n} account is in the red | {n} accounts are in the red", row.n);
    }
  };
  const value = (row: AttentionRow): { text: string; color: string } => {
    switch (row.kind) {
      case "over":
      case "overAssigned":
      case "debt":
        return { text: M(row.amount), color: C.neg };
      case "risk":
        return { text: `≈ ${M(row.projected)}`, color: C.warn };
      case "pool":
        return { text: M(row.amount), color: TEAL };
      case "goals":
        return { text: M(row.amount), color: C.soft };
    }
  };
  const action = (row: AttentionRow): string => {
    switch (row.kind) {
      case "over":
        return t("Cover it ›");
      case "risk":
        return t("Top up ›");
      case "pool":
        return t("Suggest ›");
      case "overAssigned":
        return t("Budget ›");
      case "goals":
        return t("Fill ›");
      case "debt":
        return t("Reconcile ›");
    }
  };
  const onRowClick = (row: AttentionRow) => {
    if (row.kind === "over" || row.kind === "risk") onOpenReport?.("budgets");
    else if (row.kind === "pool") onQuickAdd("suggest");
    else if (row.kind === "overAssigned") onNav("budget");
    else if (row.kind === "goals") onOpenReport?.("goals");
    else onNav("accounts");
  };
  const rowKey = (row: AttentionRow): string => (row.kind === "risk" ? `risk-${row.envelopeId}` : row.kind);

  return (
    <WidgetShell title={t("Needs attention")} chromeless={chromeless}>
      {rows.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 2px" }}>
          <Ico d="M5 13l4 4L19 7" size={15} color={C.pos} sw={2.4} />
          <span style={{ fontSize: 12, color: C.mute }}>{t("Nothing needs you right now")}</span>
        </div>
      ) : (
        rows.map((row, i) => {
          const v = value(row);
          return (
            <button key={rowKey(row)} onClick={() => onRowClick(row)} style={rowBtnStyle(C, i === rows.length - 1)}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label(row)}
              </span>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                {/* v3.dc.html:428 — wide value is 13.5/750, a touch bigger than the phone row's
                    12.5/700; gated on `chromeless` so the phone widget stays byte-identical. */}
                <span
                  style={{
                    display: "block",
                    fontSize: chromeless ? 13.5 : 12.5,
                    fontWeight: chromeless ? 750 : 700,
                    color: v.color,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {v.text}
                </span>
                <span style={{ display: "block", fontSize: chromeless ? 10.5 : 10, color: TEAL, fontWeight: 650 }}>{action(row)}</span>
              </span>
            </button>
          );
        })
      )}
    </WidgetShell>
  );
}

/* ── Recent: the last 8 transactions across ALL months (state.transactions is month-scoped and
 * would go empty on day 1 — same NetWorthWidget/AccountsWidget pattern of reading the live ledger
 * directly rather than the viewed month's StateResponse) ── */
export function RecentWidget({ onOpenTxns, onNav, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  const rows = useMemo(() => {
    const ledger = store.getLedger();
    if (!ledger) return [];
    return [...ledger.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1)).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const envById = useMemo(() => {
    const ledger = store.getLedger();
    return new Map((ledger?.envelopes ?? []).map((e) => [e.id, e]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const accById = useMemo(() => {
    const ledger = store.getLedger();
    return new Map((ledger?.accounts ?? []).map((a) => [a.id, a]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const catById = useMemo(() => {
    const ledger = store.getLedger();
    return new Map((ledger?.categories ?? []).map((c) => [c.id, c]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const placeById = useMemo(() => {
    const ledger = store.getLedger();
    return new Map((ledger?.places ?? []).map((p) => [p.id, p]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Same sign/description rules as Transactions.tsx's own row (colorOf/signed/descOf) — a
  // deliberately smaller copy (no place/category sub-line) for the compact tile.
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
  // v3.dc.html:440/3738's grammar is `t.env && envById[t.env] ? envById[t.env].color : T.mute` —
  // in the design's flat mock data a transfer row can carry an `env` directly (its own synthetic
  // "Checking → Savings" example, v3:2079, sets `env: "emrg"`). The real domain never puts an
  // envelopeId on an income/transfer transaction (Add.tsx: "income has no envelope selection …
  // transfer likewise has none") — what the design is modelling there is money landing in an
  // envelope-LINKED account, captured on the real transaction as `allocationToEnvelopeId`/
  // `allocationFromEnvelopeId` (`captureAllocationFlow`, shared/automaticEnvelope.ts). Resolving
  // through that link is the faithful real-domain equivalent of the design's literal `t.env`, not
  // a new rule — an unlinked transfer/income still falls through to the same neutral `C.mute` as
  // before. Shared with `metaLabel` below (owner round 3 item 15) so the dot and the meta text
  // never disagree about which envelope a row belongs to.
  const resolvedEnvelope = (tx: Transaction) => {
    if (tx.envelopeId) return envById.get(tx.envelopeId) ?? null;
    if (tx.type === "income") return tx.allocationToEnvelopeId ? (envById.get(tx.allocationToEnvelopeId) ?? null) : null;
    if (tx.type === "transfer") {
      const linkedId = tx.allocationToEnvelopeId || tx.allocationFromEnvelopeId;
      return linkedId ? (envById.get(linkedId) ?? null) : null;
    }
    return null;
  };
  const dotColor = (tx: Transaction): string => resolvedEnvelope(tx)?.color ?? C.mute;
  // Owner round 3 item 15 — the wide meta line names the category/envelope, not just the date
  // (his crop: "July 14 · Groceries"; income falls back to a literal "July 13 · Income", transfer
  // to "July 13 · Emergency Fund" once a linked account resolves an envelope — v3.dc.html:3737's
  // `t.env && envById[t.env] ? envById[t.env].name : t.cat`). `t("Income")`/`t("Transfer")`/
  // `t("No category")`/`t("Split transaction")` are all pre-existing keys (TxnPanel.tsx/
  // reportKit.tsx) — no new i18n strings for this row. Phone's meta stays date-only, untouched.
  const metaLabel = (tx: Transaction): string => {
    const env = resolvedEnvelope(tx);
    if (env) return env.name;
    const cat = tx.categoryId ? catById.get(tx.categoryId) : null;
    if (cat) return cat.name;
    if (tx.type === "income") return t("Income");
    if (tx.type === "transfer") return t("Transfer");
    return tx.items.length ? t("Split transaction") : t("No category");
  };

  return (
    <WidgetShell title={t("Recent activity")} chromeless={chromeless}>
      {rows.length === 0 ? (
        <div style={{ padding: "10px 2px", fontSize: 12, color: C.mute }}>{t("No transactions.")}</div>
      ) : (
        rows.map((tx, i) => {
          const s = signed(tx);
          // v3.dc.html:439 — wide rows are gap-separated (no per-row divider) at 7px padding;
          // the phone row keeps its existing 8px-padded, border-bottomed list untouched.
          const rowStyle = chromeless ? { ...rowBtnStyle(C, true), padding: "7px 0" } : rowBtnStyle(C, i === rows.length - 1);
          const headline = descOf(tx);
          // Owner round 3 item 15 wants the meta line to name the category/envelope, but
          // descOf() ITSELF falls back to that same envelope/"Split transaction" label whenever
          // a transaction has no payee name and no note (Add.tsx stores a blank payee as
          // `name: null`, so this is a reachable state, not a hypothetical one). Repeating the
          // identical string on both lines ("Groceries" / "Jul 14 · Groceries") would tell the
          // user nothing the headline didn't already say — the design never hits this because
          // its mock payees are always distinct from the envelope/category name — so the wide
          // meta line drops the label and falls back to date-only (the phone's existing grammar)
          // whenever the two would collide.
          // Owner round 7 item 30: the wide row has the width for place AND category, so the meta
          // line carries every part that says something new — the place is dropped when it already
          // IS the headline (descOf falls back to the place name), same collision rule as `meta`.
          const meta = metaLabel(tx);
          const place = tx.placeId ? (placeById.get(tx.placeId)?.name ?? null) : null;
          const metaParts = chromeless
            ? [shortDate(tx.date, lang), place !== headline ? place : null, meta !== headline ? meta : null]
            : [shortDate(tx.date, lang)];
          const metaText = metaParts.filter(Boolean).join(" · ");
          return (
            <button key={tx.id} onClick={() => onOpenTxns()} style={rowStyle}>
              {chromeless && <span style={{ width: 9, height: 9, borderRadius: 3, background: dotColor(tx), display: "block", flexShrink: 0 }} />}
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontSize: 12.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{headline}</span>
                <span style={{ fontSize: chromeless ? 10 : 10.5, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {metaText}
                </span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: s.color, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{s.text}</span>
            </button>
          );
        })
      )}
      <button
        // v3.dc.html:449 — the wide footer deep-links through the wide panel machine
        // (`onOpenTxns`, same as every row above), top-bordered and left-aligned rather than the
        // phone's centered, borderless button; `onNav("transactions")` stays the phone behavior.
        onClick={chromeless ? () => onOpenTxns() : () => onNav("transactions")}
        style={{
          display: "block",
          width: "100%",
          padding: chromeless ? "7px 0 0" : "8px 0 4px",
          background: "none",
          border: "none",
          borderTop: chromeless ? `1px solid ${C.line}` : "none",
          fontSize: 11,
          fontWeight: chromeless ? 650 : 600,
          color: TEAL,
          cursor: "pointer",
          textAlign: chromeless ? "left" : "center",
          fontFamily: font,
        }}
      >
        {t("All transactions ›")}
      </button>
    </WidgetShell>
  );
}

/* ── Spending: this month's expense broken down by envelope, same math as the Spending report ── */
export function SpendingWidget({ state, month, onOpenReport, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const version = useLedgerVersion();
  const rows = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeSpendingByDimension(ledger, month, month, "envelope") : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));
  const rowColor = (key: string | null): string => (key && envColor.get(key)) || C.mute;
  const top = rows.slice(0, 5);
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const topAmount = Math.max(...top.map((r) => r.amount), 1);
  // v3.dc.html:460's `share` is this row's percentage of the FULL month total (every envelope,
  // `homeSpendSum`) — not of the top-5 slice and not of `topAmount` (the bar's own denominator).
  // Same "" guard as the design when there's nothing to divide by (unreachable here in practice:
  // the empty-rows case is handled above this branch, so `total` is always > 0 once we get here).
  const shareOf = (amount: number): string => (total > 0 ? `${Math.round((amount / total) * 100)}%` : "");

  return (
    <WidgetShell title={t("Spending")} chromeless={chromeless}>
      {rows.length === 0 ? (
        <div style={{ padding: "10px 2px", fontSize: 12, color: C.mute }}>{t("No spending this month.")}</div>
      ) : chromeless ? (
        // Owner round 3 item 16 — the design's compact grammar (v3.dc.html:451-464), not the
        // phone's bordered/padded row list: rows are spaced by the tile body's own 8px flex gap
        // (WideHome's `gsh` container) rather than a per-row border+padding, each row is a tight
        // name/share%/amount line (`gap:3`) over a slim 4px bar (design: `hint-size="100%,4px"`),
        // and the segmented header bar matches the design's 9px (`hint-size="100%,9px"`) instead
        // of the phone's default 8px. This is the actual height drop behind "ładniej i bardziej
        // kompaktowo" — not just a font tweak.
        //
        // Row content is ~22px tall — under the house's usual ≥30×30 glyph-button floor — but
        // unlike an isolated icon control (chromeBtn/fillOne) this row sits in the tile's own 8px
        // flex gap (WideHome's `gsh` container) with a sibling above and below on EVERY side, so
        // the floor is met with the padding+negative-margin hit-slop technique instead of a plain
        // `minHeight` bump: 4px of padding top/bottom grows the button's own border box to
        // 22+8=30px, and an equal negative margin pulls it back so the MARGIN box — what the flex
        // column actually spaces siblings by — still measures 22px, unchanged. Padding and margin
        // cancel exactly, so the rendered text/bar sit at the identical pixel position as before;
        // only the invisible hit area grows, spilling 4px into the gap on each side (two adjacent
        // rows' expanded boxes meet exactly at the middle of their shared gap, so a click anywhere
        // in it always lands on one row or the other, never nothing). This keeps the design's
        // literal compact height — the whole point of "ładniej i bardziej kompaktowo" — while
        // still clearing the 30px floor, rather than trading one off against the other.
        <>
          <SegBar segments={top.map((r) => ({ weight: Math.max(0, r.amount), color: rowColor(r.key) }))} height={9} />
          {top.map((r) => (
            <button
              key={r.key ?? "none"}
              onClick={() => onOpenReport?.("spending")}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                width: "100%",
                padding: "4px 0",
                margin: "-4px 0",
                background: "none",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5, color: C.text }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dimNullLabel(r.name, "envelope", t)}
                </span>
                <span style={{ fontSize: 10.5, color: C.mute, flexShrink: 0 }}>{shareOf(r.amount)}</span>
                <span style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(r.amount)}</span>
              </div>
              <Bar pct={(r.amount / topAmount) * 100} color={rowColor(r.key)} height={4} />
            </button>
          ))}
          {/* v3.dc.html:466 — a plain, non-interactive caption (its own text says "click a row for
              detail" — the rows are the click target, not this line). */}
          <span style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>
            {t("total {amount} this month · click a row for detail", { amount: M(total) })}
          </span>
        </>
      ) : (
        <>
          <div style={{ padding: "8px 0 6px" }}>
            <SegBar segments={top.map((r) => ({ weight: Math.max(0, r.amount), color: rowColor(r.key) }))} />
          </div>
          {top.map((r, i) => (
            <button key={r.key ?? "none"} onClick={() => onOpenReport?.("spending")} style={rowBtnStyle(C, i === top.length - 1)}>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dimNullLabel(r.name, "envelope", t)}
                </span>
                <Bar pct={(r.amount / topAmount) * 100} color={rowColor(r.key)} height={5} />
              </span>
              <span style={{ fontSize: 12, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(r.amount)}</span>
            </button>
          ))}
          <button
            onClick={() => onOpenReport?.("spending")}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 0 4px",
              background: "none",
              border: "none",
              fontSize: 11,
              fontWeight: 600,
              color: C.mute,
              cursor: "pointer",
              textAlign: "center",
              fontFamily: font,
            }}
          >
            {t("total {amount} this month", { amount: M(total) })}
          </button>
        </>
      )}
    </WidgetShell>
  );
}

/* ── Goals: monthly-target progress, same goalProgress math as the Goals report. The phone body's
 * "Fill" affordance is a LINK to that report (F7 — no tile-level write); the wide body (v3.dc.html
 * :502-527, waveB-t4-brief.md B4) is this file's one deliberate F7 exception — a per-row "Fill"
 * that writes directly, using the exact same `local.setDisplayedAllocation` op (re-read the live
 * ledger, cap to the pool, hide once unfillable) that GoalsReport.tsx's own per-card `fillOne` and
 * FillGoalsSheet's multi-envelope `confirm` already use for one envelope — not a third, divergent
 * write path. No undo toast here (unlike the full report): the compact tile has no room for one
 * and the design shows none; the write is still capped/re-read fresh so a stale close can't
 * over-allocate. ── */
export function GoalsWidget({ state, month, onOpenReport, onFillGoals, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const rows = state.envelopes
    .filter((e) => !e.archived)
    .flatMap((e) => {
      const gp = goalProgress(e);
      return gp ? [{ e, gp }] : [];
    })
    .sort((a, b) => a.gp.pct - b.gp.pct || a.e.name.localeCompare(b.e.name));

  // Mirrors GoalsReport.tsx's `fillOne` exactly, minus the undo bookkeeping: both `allocated` and
  // `readyToAssign` are re-read fresh off the live ledger at press time (never the render-scope
  // `state`/`gp` closure), because a tile can sit rendered a while before it's tapped.
  const fillOne = (envelopeId: string, missing: number) => {
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, month) : null;
    if (!live) return;
    const envFresh = live.envelopes.find((x) => x.id === envelopeId);
    if (!envFresh || envFresh.archived) return; // vanished/archived since this render started
    const fillable = Math.max(0, Math.min(missing, live.readyToAssign));
    if (fillable <= 0) return; // the button is hidden in this case already — defensive only
    local.setDisplayedAllocation({ envelopeId, month, amount: envFresh.allocated + fillable });
    haptic([10, 30, 14]);
  };

  const missSum = rows.reduce((s, { gp }) => s + gp.missing, 0);
  const allFunded = rows.length > 0 && missSum === 0;
  // The SHARED entry-visibility predicate (lib/goals.ts) every "Fill by goals" affordance calls.
  // `missSum > 0` over these same rows was the identical rule spelled out a third time.
  const fillPossible = canFillGoals(state);

  return (
    <WidgetShell title={t("Goals")} chromeless={chromeless}>
      {rows.length === 0 ? (
        <div style={{ padding: "10px 2px", fontSize: 12, color: C.mute }}>{t("No envelopes with a goal. Set a monthly target when editing an envelope.")}</div>
      ) : chromeless ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {rows.map(({ e, gp }) => {
            // Owner round 3 item 18: the ring is colored PER GOAL from the envelope's own
            // identity color (v3.dc.html:506's `g.color`), not the funded-status convention this
            // used to share with GoalsReport.tsx (`C.pos` once funded, `TEAL` otherwise) — see
            // that file's own comment for the fuller reversal rationale.
            const ringColor = e.color;
            const fundedAmt = Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0);
            const fillable = Math.max(0, Math.min(gp.missing, state.readyToAssign));
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <GoalRing pct={gp.pct} size={32} color={ringColor} />
                <button
                  type="button"
                  onClick={() => onOpenReport?.("goals")}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    // House >=30x30 touch-target floor (measured, not asserted): the ring beside
                    // this button is a SIBLING (not nested, unlike GoalsReport.tsx's equivalent
                    // open-envelope button), so the row's 32px height came from the ring alone and
                    // this button's own box — sized only by its two short text lines — measured
                    // 26px. box-sizing:border-box + minHeight makes 30 the TOTAL box height without
                    // touching the design's font sizes, colors or gap; the row itself stays 32px
                    // tall (the ring already drives that), so this adds no visible height anywhere.
                    boxSizing: "border-box",
                    minHeight: 30,
                    background: "none",
                    border: "none",
                    padding: 0,
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <span style={{ fontSize: 12.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                  <span style={{ fontSize: 10, color: C.mute, fontVariantNumeric: "tabular-nums" }}>
                    {t("{funded} of {target}", { funded: M(fundedAmt), target: M(e.monthlyTarget ?? 0) })}
                  </span>
                </button>
                <span style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(gp.pct)}%</span>
                  {fillable > 0 && (
                    <button
                      type="button"
                      onClick={() => fillOne(e.id, gp.missing)}
                      title={t("Move the missing amount from To be budgeted into this envelope")}
                      style={{
                        flexShrink: 0,
                        minHeight: 30,
                        display: "inline-flex",
                        alignItems: "center",
                        fontSize: 10,
                        fontWeight: 700,
                        color: TEAL,
                        border: `1px solid ${TEAL}`,
                        borderRadius: 7,
                        padding: "3px 8px",
                        background: "none",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      {/* v3.dc.html:3769 — the home tile's OWN fillLabel is "Fill " + fmt(missing),
                          no trailing arrow; the arrow belongs only to the Goals REPORT's per-card
                          button (v3.dc.html:3430), a different key GoalsReport.tsx already owns. */}
                      {t("Fill {amount}", { amount: M(fillable) })}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          <span style={{ fontSize: 11, color: C.soft }}>
            {allFunded ? t("All goals funded ✓") : t("{amount} to go", { amount: M(missSum) })}
            {fillPossible && onFillGoals && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={onFillGoals}
                  style={{
                    // House >=30x30 touch-target floor (measured, not asserted): this footer link
                    // is a real write affordance (fills every under-funded goal at once), same
                    // semantic action as GoalsReport.tsx's standalone "Fill all goals ›" button,
                    // which already carries this same minHeight for the same reason. `display:
                    // inline` ignores height entirely, so this needs inline-flex to make the
                    // minHeight take effect while still flowing inline after "{verdict} · ".
                    display: "inline-flex",
                    alignItems: "center",
                    verticalAlign: "middle",
                    boxSizing: "border-box",
                    minHeight: 30,
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    fontWeight: 700,
                    color: TEAL,
                    cursor: "pointer",
                  }}
                >
                  {t("Fill all ›")}
                </button>
              </>
            )}
          </span>
        </div>
      ) : (
        rows.map(({ e, gp }, i) => (
          <button key={e.id} onClick={() => onOpenReport?.("goals")} style={rowBtnStyle(C, i === rows.length - 1)}>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 12.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              <Bar pct={gp.pct} color={gp.funded ? C.pos : TEAL} height={5} />
            </span>
            <span style={{ textAlign: "right", flexShrink: 0 }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(gp.pct)}%</span>
              {!gp.funded && <span style={{ display: "block", fontSize: 10, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{M(gp.missing)}</span>}
            </span>
          </button>
        ))
      )}
    </WidgetShell>
  );
}

/** How many movers each host lists — they differ because the ROW does.
 *
 *  The phone body keeps its own compact grammar and its five, unchanged. The wide tile renders the
 *  REPORT's row (owner round 7 item 29), which measures 49px — 20px of padding, the 8px dot beside
 *  a 15px name over a 12px "{now} · median {median}" sub-line, and the hairline — and 61px wherever
 *  that sub-line takes a SECOND line, which at the default tile's 127px text column happens to any
 *  four-figure amount, in English as much as in Polish. Five of those plus the caption is ~272px of
 *  content; the mock's 2-high tile has 150px of body, so the tile opened already scrolled past two
 *  of the five movers it promised.
 *
 *  THREE is the design's own count for this widget (v3.dc.html:548, `hint-placeholder-count="3"`),
 *  and `createDefaultWideWidgets` now starts this tile 3 high so the three always fit (measured:
 *  198px of content in a 252px body at 1440 with the panel open, English and Polish, all four
 *  themes). A board SAVED before that — the height is the user's to keep — still shows three rows
 *  and scrolls a little; resizing the tile or "Reset layout" ends that, and five rows would have
 *  scrolled four times as far. Nothing is lost by the shorter list either: the caption below counts
 *  the FULL set of movers, not the rows drawn, and any row opens the Trends report, which lists
 *  every one of them. */
const WIDE_TREND_ROWS = 3;
const PHONE_TREND_ROWS = 5;

/* ── Trends: the biggest movers over 6 months (`WIDE_TREND_ROWS`/`PHONE_TREND_ROWS` of them), same
 * computeEnvelopeTrends/trendColor as the Trends report. TrendSpark's width is MEASURED (the
 * caller-supplied-width waiver — never the fixed 64/72 probe the report row uses), so a wide tile
 * draws a proportionally wider chart.
 *
 * Owner round 7 item 29 (his side-by-side of this tile against the Trends report preview) makes
 * the WIDE board tile (`chromeless`) render the REPORT's own row, `TrendRow` from reportKit: colour
 * dot + name over a "{now} · median {median}" sub-line, the spark in the middle, the signed delta
 * over "{arrow} {pct}% vs median" on the right. It is the same component the Trends subscreen
 * renders, not a lookalike, so the two cannot drift — and every figure in it (avg/median/pct, the
 * arrow glyph and its colour rule) stays where it already was, in `computeEnvelopeTrends`/
 * `trendColor`/`DeltaTag`. That supersedes round 3 item 17's compact design-html grammar (a 44×20
 * spark in the envelope's colour + a bare signed amount), which this branch rendered before.
 * The phone body (chromeless falsy) is untouched: measured-width spark, name+amount on one line,
 * chart underneath.
 *
 * v3.dc.html:558-559's trailing `home.trendsHero` caption ("{n} rising · {m} falling") is counted
 * over the FULL trend list (`trendRows`, before its `.slice(0,3..8)` for display) — never just the
 * rows the tile happens to show — so `allTrends` stays unsliced for this count and only `trends`
 * (the sliced head) feeds the rows. That is also what makes the tile's shorter list honest: the
 * caption still says how many envelopes are moving, whichever three are drawn. Reuses
 * TrendsReport.tsx's own `"{n} rising · {m} falling"` key and its
 * ±10% `deltaPct` threshold (a null `deltaPct` — no positive baseline — counts as neither) rather
 * than inventing a second copy of the same rising/falling classification. ── */
export function TrendsWidget({ month, onOpenReport, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const version = useLedgerVersion();
  const allTrends = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeEnvelopeTrends(ledger, month, 6) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const trends = allTrends.slice(0, chromeless ? WIDE_TREND_ROWS : PHONE_TREND_ROWS);
  const rising = allTrends.filter((tr) => tr.deltaPct !== null && tr.deltaPct > 0.1).length;
  const falling = allTrends.filter((tr) => tr.deltaPct !== null && tr.deltaPct < -0.1).length;
  const [rowsRef, rowsW] = useElementWidth<HTMLDivElement>(150);
  const sparkW = Math.max(64, rowsW);

  return (
    <WidgetShell title={t("Envelope trends")} chromeless={chromeless}>
      {trends.length === 0 ? (
        <div style={{ padding: "10px 2px", fontSize: 12, color: C.mute }}>{t("Not enough history yet — trends appear after two months of spending.")}</div>
      ) : chromeless ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {trends.map((tr, i) => (
            <TrendRow key={tr.id} tr={tr} M={M} last={i === trends.length - 1} onClick={() => onOpenReport?.("trends")} />
          ))}
          {/* v3.dc.html:559 — plain, non-interactive, always shown once there's any trend data. */}
          <span style={{ fontSize: 10.5, color: C.mute, paddingTop: 4 }}>{t("{n} rising · {m} falling", { n: rising, m: falling })}</span>
        </div>
      ) : (
        <div ref={rowsRef}>
          {trends.map((tr, i) => {
            const color = trendColor(tr, C);
            const delta = tr.last - tr.baseline;
            return (
              <button
                key={tr.id}
                onClick={() => onOpenReport?.("trends")}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  width: "100%",
                  gap: 4,
                  padding: "8px 0",
                  background: "none",
                  border: "none",
                  borderBottom: i === trends.length - 1 ? "none" : `1px solid ${C.line}`,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tr.name}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                    {delta >= 0 ? "+" : "−"}
                    {M(Math.abs(delta))}
                  </span>
                </div>
                <TrendSpark series={tr.series} color={color} median={tr.baseline} medianColor={C.line} dot w={sparkW} h={22} />
              </button>
            );
          })}
        </div>
      )}
    </WidgetShell>
  );
}

/* ── Heatmap: daily spending calendar, same computeDailySpending/CalendarHeatmap as the Month
 * report — day click deep-links to the Month report with that day's panel already open.
 *
 * Owner round 3 item 19: the WIDE board tile (`chromeless`) forks to the design's compact
 * home-board grammar (v3.dc.html:556-587) instead of the phone/report `CalendarHeatmap` below —
 * small fixed-height cells (17px tall, 4px gap/radius, no per-cell day number) built from the
 * SAME `heatWeeks`/`heatColor` primitives `CalendarHeatmap` itself uses (so the color ramp never
 * drifts from the phone widget or the Month report), an avg/peak caption reusing MonthReport's
 * own string verbatim ("avg {avg}/day · peak: {date} ({peak})" — `date` via `shortDate`, the
 * app's nominative short-date formatter, same one the wide Recent-activity row already uses), and
 * the design's two companion lists SCALED BY TILE WIDTH exactly like its own `sizeOf` (v3.dc.html
 * :3588-3590, :3792-3797): S (`tile.w<=1`) shows neither list at all, M (`w===2`) shows only
 * "Most frequent places" (top 3, `topPlaces` — shared/reports.ts, the same visit-count-led
 * function MonthReport's own places table calls, so rank/count/sum here never disagrees with the
 * Month report), and L (`w>=3`) widens that to the top 5 AND adds a second "Largest expenses"
 * table (`largestExpenses`, shared/reports.ts — the same amount-led function MonthReport's own
 * report-level table calls, top 3), matching the design's `heatPlaces`/`heatPlacesDisplay`/
 * `heatLargest`/`heatLargestDisplay`. `tile` is always supplied alongside `chromeless` today
 * (WideHome.tsx) — the `?? 2` fallback below only matters if that contract ever changes, and picks
 * the M bucket (the catalog's own default size for this widget, shared/preferences.ts). Both
 * tables are OMITTED entirely (not rendered empty) when there is nothing to show, the same rule
 * MonthReport's own header comment documents, and neither table's rows are click targets — same
 * as MonthReport's own equivalent rows, which are informational only. Row styling matches the
 * design's HOME-BOARD grammar specifically (name inherits the row's own text color, meta muted, no
 * bold) — a deliberately different arrangement from MonthReport's own already-shipped report-level
 * tables (soft name, bold text meta): the design gives the home tile and the full report two
 * different ROW treatments for the SAME underlying lists (v3.dc.html:571-586 vs 1614-1619), not two
 * different sets of lists — both lists exist at the tile level too, just gated by size. The
 * "{count}× · {amount}", "Most frequent places" and "Largest expenses" strings are pre-existing
 * i18n keys (MonthReport.tsx) — zero new translations. The phone body (chromeless falsy) is
 * untouched — plain `CalendarHeatmap`, no caption, no tables. ── */
export function HeatmapWidget({ month, onOpenMonthDay, chromeless, tile }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  const days = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeDailySpending(ledger, month) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const heatW = tile?.w ?? 2;
  const heatSize: "S" | "M" | "L" = heatW >= 3 ? "L" : heatW === 2 ? "M" : "S";
  const placesLimit = heatSize === "S" ? 0 : heatSize === "L" ? 5 : 3;
  const places = useMemo(() => {
    const ledger = store.getLedger();
    return ledger && placesLimit > 0 ? topPlaces(ledger, month, month, placesLimit) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, placesLimit]);
  const largest = useMemo(() => {
    const ledger = store.getLedger();
    return ledger && heatSize === "L" ? largestExpenses(ledger, month, 3) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, heatSize]);

  if (chromeless) {
    const max = Math.max(...days.map((d) => d.total), 1);
    const totalExpense = days.reduce((s, d) => s + d.total, 0);
    // Same "reduce with no seed needs a non-empty array" guard MonthReport.tsx's own peak/avg
    // computation uses (comment there); `totalExpense` here equals `computeCashflowSeries`'s
    // monthly `expense` for the same month (both route every expense through the identical
    // type/refund-sign/savings-exclusion rule — MonthReport.tsx's own header comment), so this
    // is not a fresh, differently-scoped average.
    const peak = days.length > 0 ? days.reduce((best, d) => (d.total > best.total ? d : best)) : undefined;
    const hasSpending = peak !== undefined && peak.total > 0;
    const avg = days.length > 0 ? Math.round(totalExpense / days.length) : 0;
    const cells = heatWeeks(days).flat();
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Cells paint 17px tall (the design's literal compact size, v3.dc.html:562-565) — a
         *  7-column calendar sized up to the house's usual ≥30×30 floor would no longer read as a
         *  compact monthly grid, the whole point of this task (owner round 3 item 19: "small
         *  cells"). Unlike the Spending tile's rows (item 16), which sit in a single-axis flex
         *  column with an 8px gap and fully cancel padding against an equal negative margin to
         *  reach 30px without ever overlapping a neighbor, this grid has a neighbor on ALL FOUR
         *  sides sharing a 4px gap in BOTH directions — the identical technique only has 2px of
         *  slack per side before two cells' invisible hit areas would overlap (meeting exactly at
         *  the middle of the shared gap, same rule as item 16, just scaled to this grid's smaller
         *  gap). That caps the safe, non-overlapping hit box at 21×21 (17 + 2 + 2): real growth
         *  over the bare 17px swatch, but a KNOWING, DOCUMENTED shortfall against the 30×30 floor —
         *  not a claimed match to item 16's fully-compensated outcome. The outer `<div>` below
         *  carries the padding/negative-margin (transparent — it never grows the VISIBLE swatch)
         *  plus the click/role/aria wiring; the inner `<div>` is the literal 17px colored cell,
         *  sized and positioned exactly as before. A mis-tap can still open an adjacent DAY, but
         *  every day's own panel lands inside the SAME Month report the tile deep-links to, and
         *  the wide cursor/keyboard user gets a per-cell `aria-label` naming the exact date. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {cells.map((cell, i) =>
            cell ? (
              <div
                key={cell.date}
                role={onOpenMonthDay ? "button" : undefined}
                tabIndex={onOpenMonthDay ? 0 : undefined}
                onClick={onOpenMonthDay ? () => onOpenMonthDay(cell.date) : undefined}
                onKeyDown={
                  onOpenMonthDay
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpenMonthDay(cell.date);
                        }
                      }
                    : undefined
                }
                aria-label={`${cell.date} · ${M(cell.total)}`}
                style={{ padding: 2, margin: -2, cursor: onOpenMonthDay ? "pointer" : "default" }}
              >
                <div style={{ height: 17, borderRadius: 4, background: heatColor(cell.total, max, C) }} />
              </div>
            ) : (
              <div key={`pad${i}`} aria-hidden="true" style={{ height: 17 }} />
            ),
          )}
        </div>
        <span style={{ fontSize: 10.5, color: C.mute }}>
          {hasSpending && peak
            ? t("avg {avg}/day · peak: {date} ({peak})", { avg: M(avg), date: shortDate(peak.date, lang), peak: M(peak.total) })
            : t("No spending this month.")}
        </span>
        {places.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", borderTop: `1px solid ${C.line}`, paddingTop: 7 }}>
            <span style={{ fontSize: 9.5, fontWeight: 750, letterSpacing: "0.14em", textTransform: "uppercase", color: C.mute, paddingBottom: 3 }}>
              {t("Most frequent places")}
            </span>
            {places.map((p) => (
              <div key={p.key} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5, color: C.text, padding: "3px 0" }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dimNullLabel(p.name, "place", t)}</span>
                <span style={{ flexShrink: 0, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {t("{count}× · {amount}", { count: p.count, amount: M(p.total) })}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Owner round 3 item 19 / v3.dc.html:580-586 — the L-only "Largest expenses" table the
         *  design's home tile adds alongside "Most frequent places" (both gated by `heatSize`
         *  above). Rows are informational only (no onClick) — same as MonthReport.tsx's own
         *  equivalent rows — so no touch-target floor applies here. */}
        {largest.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", borderTop: `1px solid ${C.line}`, paddingTop: 7 }}>
            <span style={{ fontSize: 9.5, fontWeight: 750, letterSpacing: "0.14em", textTransform: "uppercase", color: C.mute, paddingBottom: 3 }}>
              {t("Largest expenses")}
            </span>
            {largest.map((e) => (
              <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5, color: C.text, padding: "3px 0" }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.label} <span style={{ color: C.mute, fontSize: 10 }}>· {e.context ?? shortDate(e.date, lang)}</span>
                </span>
                <span style={{ flexShrink: 0, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{M(e.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <WidgetShell title={t("When you spend")} chromeless={chromeless}>
      <CalendarHeatmap days={days} lang={lang} mask={M} onSelectDay={(d) => onOpenMonthDay?.(d)} />
    </WidgetShell>
  );
}
