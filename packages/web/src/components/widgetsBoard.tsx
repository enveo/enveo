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
import { computeDailySpending, computeEnvelopeTrends, computeSpendingByDimension, computeStateResponse, goalProgress, type Transaction } from "@enveo/shared";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { useLedgerVersion } from "../lib/api";
import { useMask, useTheme } from "../lib/contexts";
import { currentMonth, shortDate, todayISO } from "../lib/dates";
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
import { Bar, CalendarHeatmap, dimNullLabel, SegBar, TrendSpark } from "./reportKit";
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
          const meta = metaLabel(tx);
          const metaText = chromeless && meta !== headline ? `${shortDate(tx.date, lang)} · ${meta}` : shortDate(tx.date, lang);
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
  // Same entry-visibility predicate as GoalsReport.tsx/Budget's "Fill by goals" button: a pool to
  // place AND at least one goal still short.
  const canFillGoals = state.readyToAssign > 0 && missSum > 0;

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
            {canFillGoals && onFillGoals && (
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

/* ── Trends: the top-5 movers over 6 months, same computeEnvelopeTrends/trendColor as the Trends
 * report. TrendSpark's width is MEASURED (the caller-supplied-width waiver — never the fixed 64/72
 * probe the report row uses), so a wide tile draws a proportionally wider chart.
 *
 * Owner round 3 item 17: the WIDE board tile (`chromeless`) forks to its own row grammar, matching
 * the design's home-board trends widget (v3.dc.html:546-560) rather than the phone/report grammar
 * above — a small FIXED-size sparkline (44×20, not measured) stroked in the ENVELOPE's own color
 * (`tr.color`) with a sign-verdict-colored dot (`trendColor`) and a right-aligned signed amount in
 * that same verdict color, no per-row divider. The phone body (chromeless falsy) is untouched:
 * measured-width spark, single `trendColor()` for line+dot+amount, bordered rows. ── */
export function TrendsWidget({ month, onOpenReport, chromeless }: WidgetProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const version = useLedgerVersion();
  const trends = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeEnvelopeTrends(ledger, month, 6).slice(0, 5) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const [rowsRef, rowsW] = useElementWidth<HTMLDivElement>(150);
  const sparkW = Math.max(64, rowsW);

  return (
    <WidgetShell title={t("Envelope trends")} chromeless={chromeless}>
      {trends.length === 0 ? (
        <div style={{ padding: "10px 2px", fontSize: 12, color: C.mute }}>{t("Not enough history yet — trends appear after two months of spending.")}</div>
      ) : chromeless ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {trends.map((tr) => {
            const signColor = trendColor(tr, C);
            const delta = tr.last - tr.baseline;
            return (
              <button key={tr.id} onClick={() => onOpenReport?.("trends")} style={{ ...rowBtnStyle(C, true), padding: "5px 0" }}>
                <TrendSpark
                  series={tr.series}
                  color={tr.color}
                  dotColor={signColor}
                  median={tr.baseline}
                  medianColor={C.line}
                  dot
                  w={44}
                  h={20}
                  strokeWidth={2.5}
                  medianStrokeWidth={1.5}
                  dotRadius={3}
                />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tr.name}
                </span>
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 750, color: signColor, fontVariantNumeric: "tabular-nums" }}>
                  {delta >= 0 ? "+" : "−"}
                  {M(Math.abs(delta))}
                </span>
              </button>
            );
          })}
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
 * report — day click deep-links to the Month report with that day's panel already open. ── */
export function HeatmapWidget({ month, onOpenMonthDay, chromeless }: WidgetProps) {
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  const days = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeDailySpending(ledger, month) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);

  return (
    <WidgetShell title={t("When you spend")} chromeless={chromeless}>
      <CalendarHeatmap days={days} lang={lang} mask={M} onSelectDay={(d) => onOpenMonthDay?.(d)} />
    </WidgetShell>
  );
}
