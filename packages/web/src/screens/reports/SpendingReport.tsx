import {
  availableGroupings,
  breakdownEntries,
  type ExploreDim,
  type ExploreGrouping,
  type ExploreRow,
  filterEntries,
  identicalLineKey,
  median,
  mergeByTransaction,
  monthlyTotals,
  openingGrouping,
  type SpendingEntry,
  type StatementLine,
  sortLargest,
  spendingEntries,
  statementLines,
  sumEntries,
} from "@enveo/shared";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "../../components/chrome";
import { ScrollPicker } from "../../components/pickers";
import { DeltaTag, useReportBand } from "../../components/reportKit";
import { type StateResponse, useLedgerVersion } from "../../lib/api";
import { useMask, useTheme } from "../../lib/contexts";
import { currentMonth, monthLabel, monthNames, monthShortLabel, shortDate } from "../../lib/dates";
import { LOCALE_OF } from "../../lib/format";
import { type Message, msg, useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { useWideHost } from "../../lib/shellContext";
import { store } from "../../lib/store";
import { font, P, tint } from "../../lib/theme";
import {
  defaultSpendingView,
  encodePath,
  filterOf,
  lastMonths,
  monthEnd,
  monthStart,
  PRESETS,
  presetOf,
  presetRange,
  type SpendingView,
  singleMonthOf,
  spansMonths,
} from "./spendingView";

const GROUPING_LABEL: Record<ExploreGrouping, Message> = {
  envelope: msg("Envelopes"),
  group: msg("Groups"),
  category: msg("Categories"),
  place: msg("Places"),
  account: msg("Accounts"),
  month: msg("Months"),
  txn: msg("Individual transactions"),
};
const GROUPING_HEADER: Record<Exclude<ExploreGrouping, "txn">, Message> = {
  envelope: msg("By envelope"),
  group: msg("By group"),
  category: msg("By category"),
  place: msg("By place"),
  account: msg("By account"),
  month: msg("By month"),
};
const SHARE_OF: Record<ExploreDim, Message> = {
  envelope: msg("{pct} of envelope {name}"),
  group: msg("{pct} of group {name}"),
  category: msg("{pct} of category {name}"),
  place: msg("{pct} of place {name}"),
};
const DIM_LABEL: Record<ExploreDim, Message> = { envelope: msg("Envelope"), group: msg("Group"), category: msg("Category"), place: msg("Place") };
const NULL_NAME: Record<ExploreDim, Message> = {
  envelope: msg("No envelope"),
  group: msg("No group"),
  category: msg("No category"),
  place: msg("No place"),
};
const ANY: Record<ExploreDim, Message> = { envelope: msg("Any envelope"), group: msg("Any group"), category: msg("Any category"), place: msg("Any place") };

const D_BACK = "M15 19l-7-7 7-7";
const D_CHEV = "M9 6l6 6-6 6";
const D_FILTER = "M4 6h16M7 12h10M10 18h4";
const D_CARET = "M7 10l5 5 5-5";
const D_X = "M7 7l10 10M17 7L7 17";

/** All expense entries of the replica, recomputed when the ledger changes. */
function useEntries(): SpendingEntry[] {
  const version = useLedgerVersion();
  return useMemo(() => {
    const l = store.getLedger();
    return l ? spendingEntries(l) : [];
  }, [version]);
}

/** A transaction's own name or note, for lines whose place is not set. */
function useTxnNames(): Map<string, string> {
  const version = useLedgerVersion();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const tx of store.getLedger()?.transactions ?? []) {
      const n = tx.name || tx.note;
      if (n) m.set(tx.id, n);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
}

function useNames(state: StateResponse) {
  const { t, lang } = useT();
  return useMemo(() => {
    const env = new Map(state.envelopes.map((e) => [e.id, e]));
    const grp = new Map(state.groups.map((g) => [g.id, g.name]));
    const cat = new Map(state.categories.map((c) => [c.id, c.name]));
    const plc = new Map(state.places.map((p) => [p.id, p.name]));
    const acc = new Map(state.accounts.map((a) => [a.id, a]));
    const name = (g: Exclude<ExploreGrouping, "txn">, key: string | null): string => {
      if (g === "month") return key ? monthLabel(key, lang) : "";
      if (g === "account") return (key && acc.get(key)?.name) || "?";
      if (key === null) return t(NULL_NAME[g]);
      const n = g === "envelope" ? env.get(key)?.name : g === "group" ? grp.get(key) : g === "category" ? cat.get(key) : plc.get(key);
      return n ?? t(NULL_NAME[g]);
    };
    const color = (g: ExploreGrouping, key: string | null): string | null =>
      key === null ? null : g === "envelope" ? (env.get(key)?.color ?? null) : g === "account" ? (acc.get(key)?.color ?? null) : null;
    return { name, color };
  }, [state, t, lang]);
}
type Names = ReturnType<typeof useNames>;

function pctLabel(x: number, lang: Parameters<typeof monthLabel>[1]): string {
  return new Intl.NumberFormat(LOCALE_OF[lang], { style: "percent", maximumFractionDigits: x < 0.1 ? 1 : 0 }).format(x);
}

function periodLabel(v: SpendingView, t: (m: Message) => string, lang: Parameters<typeof monthLabel>[1]): string {
  const preset = presetOf(v, currentMonth());
  if (preset) return t(PRESETS.find((p) => p.id === preset)!.label);
  const month = singleMonthOf(v);
  if (month) return monthLabel(month, lang);
  const withYear = v.from.slice(0, 4) !== v.to.slice(0, 4) || v.to.slice(0, 4) !== currentMonth().slice(0, 4);
  return `${shortDate(v.from, lang, withYear)} – ${shortDate(v.to, lang, withYear)}`;
}

/** The grouping this level shows: the user's pick for this exact level, else the natural next one
 *  that lists more than one row. */
export function groupingOf(entries: readonly SpendingEntry[], v: SpendingView): ExploreGrouping {
  const f = filterOf(v);
  const spans = spansMonths(v);
  const picked = v.grouping?.pathKey === encodePath(v.path) ? v.grouping.g : null;
  return picked && availableGroupings(f, spans).includes(picked) ? picked : openingGrouping(entries, f, spans);
}

/** Drilling into a row: a path dimension opens a new level; an account or a month narrows the
 *  current level in place (they are filters, not path steps). */
export function drillInto(v: SpendingView, g: ExploreGrouping, key: string | null): SpendingView {
  if (g === "account") return key ? { ...v, accounts: [key], grouping: null } : v;
  if (g === "month") return key ? { ...v, from: monthStart(key), to: monthEnd(key), custom: false, grouping: null } : v;
  if (g === "txn") return v;
  return { ...v, path: [...v.path, { dim: g, key }], grouping: null };
}

export function SpendingReport({
  state,
  view,
  setView,
  onBack,
  onOpenTxn,
  selectedTxnId = null,
  filtersOpen = false,
  onOpenFilters,
}: {
  state: StateResponse;
  view: SpendingView;
  /** `replace`: correct the current history entry instead of adding a level. */
  setView: (v: SpendingView, replace?: boolean) => void;
  onBack: () => void;
  onOpenTxn: (txnId: string) => void;
  /** Wide layout: the transaction shown in the side panel. */
  selectedTxnId?: string | null;
  /** Wide layout: the side panel shows the filters. */
  filtersOpen?: boolean;
  /** Wide layout: the filters live in the side panel; on a phone they open in a sheet. */
  onOpenFilters?: () => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp, lang } = useT();
  const { band, hc } = useReportBand();
  const wideHost = useWideHost();
  const wide = wideHost !== null;
  const desktop = wideHost?.mode === "desktop";
  const entries = useEntries();
  const names = useNames(state);
  const [sheet, setSheet] = useState(false);
  const [, rerender] = useState(0);

  const f = filterOf(view);
  const list = useMemo(() => filterEntries(entries, f), [entries, f.from, f.to, f.accounts, f.path]);
  const total = sumEntries(list);
  const grouping = useMemo(() => groupingOf(entries, view), [entries, view]);
  const txns = useMemo(() => sortLargest(mergeByTransaction(list)), [list]);
  const txnNames = useTxnNames();
  // A folded "n×" line stands only for payments that would read identically.
  const foldKey = useCallback((e: SpendingEntry) => identicalLineKey(e, txnNames.get(e.txnId) ?? null), [txnNames]);
  const rows = useMemo(() => (grouping === "txn" ? [] : breakdownEntries(list, grouping)), [list, grouping]);
  const pathKey = encodePath(view.path);
  // Each level is its own screen: a new level starts at the top with 50 transactions, and going
  // back (or returning from an edit, which remounts this) restores both how many were shown and
  // where the list was scrolled — the count first, so the position is not clamped to a shorter list.
  const levelKey = [pathKey, grouping, view.from, view.to, [...view.accounts].sort().join(",")].join("|");
  // Always merged into the map's current entry: scrolling updates `top` between renders.
  const remember = (patch: Partial<LevelState>) => levelMemory.set(levelKey, { ...(levelMemory.get(levelKey) ?? NEW_LEVEL), ...patch });
  const { shown, open: openSections } = levelMemory.get(levelKey) ?? NEW_LEVEL;
  const showMore = () => {
    remember({ shown: shown + 100 });
    rerender((n) => n + 1);
  };
  // A section's "n more" unfolds its remaining transactions on this screen; the header still drills.
  const toggleSection = (key: string | null) => {
    const k = key ?? "";
    remember({ open: openSections.includes(k) ? openSections.filter((x) => x !== k) : [...openSections, k] });
    rerender((n) => n + 1);
  };
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current?.closest<HTMLElement>(".gs");
    if (!el) return;
    el.scrollTop = levelMemory.get(levelKey)?.top ?? 0;
    // Recorded as it happens: by cleanup time the next level's content is already in place and the
    // browser has clamped the position to it.
    const onScroll = () => remember({ top: el.scrollTop });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [levelKey]);
  // A path from a link or history may name an envelope, category or place deleted or merged
  // since: keep the part that still exists. Same for a deleted account in the account filter.
  useEffect(() => {
    const ids = { group: state.groups, envelope: state.envelopes, category: state.categories, place: state.places };
    const stale = view.path.findIndex((s) => s.key !== null && !ids[s.dim].some((x) => x.id === s.key));
    const accounts = view.accounts.filter((id) => state.accounts.some((a) => a.id === id));
    if (stale < 0 && accounts.length === view.accounts.length) return;
    const path = stale < 0 ? view.path : view.path.slice(0, stale);
    // After this commit's effects: App's routing effect (a parent, so it runs after this one)
    // would otherwise consume the "replace" before the corrected path is rendered.
    queueMicrotask(() => setView({ ...view, path, accounts, grouping: null }, true));
  }, [state, view, setView]);

  const last = view.path.at(-1);
  const title = last ? names.name(last.dim, last.key) : t("Spending");
  const contextColor = (() => {
    const e = view.path.find((s) => s.dim === "envelope");
    return e ? names.color("envelope", e.key) : null;
  })();

  // Share of the parent level: whatever the last step narrowed, measured against the level above it.
  const share = (() => {
    if (!last && view.accounts.length === 0) return null;
    const whole = sumEntries(filterEntries(entries, last ? { ...f, path: view.path.slice(0, -1) } : { ...f, accounts: [] }));
    if (whole <= 0 || total >= whole) return null;
    const pct = pctLabel(total / whole, lang);
    const parent = view.path.at(-2);
    if (parent) return t(SHARE_OF[parent.dim], { pct, name: names.name(parent.dim, parent.key) });
    if (last && view.accounts.length > 1) return t("{pct} of spending from the selected accounts", { pct });
    if (last && view.accounts.length === 1) return t("{pct} of spending from {account}", { pct, account: accountsLabel(view.accounts, names) });
    return t("{pct} of all spending", { pct });
  })();
  const monthsSpanned = monthlyTotals([], view.from, view.to).length;
  const avg = monthsSpanned > 1 ? t("avg {amount} / mo", { amount: M(Math.round(total / monthsSpanned)) }) : null;
  const month = singleMonthOf(view);
  const pace = (() => {
    if (!month) return null;
    const before = lastMonths(month, 4).slice(0, 3);
    const totals = monthlyTotals(
      filterEntries(entries, { ...f, from: monthStart(before[0]!), to: monthEnd(before[2]!) }),
      monthStart(before[0]!),
      monthEnd(before[2]!),
    );
    const base = median(totals.map((p) => p.amount));
    return base > 0 ? { pct: (total - base) / base, base } : null;
  })();

  const bars = useMemo(() => {
    if (!month) return monthlyTotals(list, view.from, view.to);
    const months = lastMonths(month, 12);
    const from = monthStart(months[0]!);
    return monthlyTotals(filterEntries(entries, { ...f, from, to: monthEnd(month) }), from, monthEnd(month));
  }, [entries, list, month, view.from, view.to, f.accounts, f.path]);

  const drill = (g: ExploreGrouping, key: string | null) => setView(drillInto(view, g, key));
  const openFilters = () => (onOpenFilters ? onOpenFilters() : setSheet(true));

  const fixed = new Set<ExploreGrouping>(view.path.map((s) => s.dim));
  if (view.accounts.length === 1) fixed.add("account");

  const bandBg = band ? C.headerBg : C.bg;
  const ink = hc(C.headerInk, C.text);
  const inkMute = hc(C.headerMute, C.mute);
  const parent = view.path.at(-2);
  const up = view.path.length ? (parent ? names.name(parent.dim, parent.key) : t("Spending")) : t("Reports");

  const sub = (
    <>
      {[share, avg].filter(Boolean).join(" · ")}
      {pace && (
        <span style={{ display: "block" }}>
          <DeltaTag pct={pace.pct} /> {t("vs 3-mo median ({amount})", { amount: M(pace.base) })}
        </span>
      )}
    </>
  );

  const header = (
    <div style={{ position: "sticky", top: 0, zIndex: 3, background: bandBg, padding: `0 ${P}px 10px` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 48 }}>
        <button
          aria-label={t("Back")}
          title={wide ? up : undefined}
          onClick={onBack}
          style={{
            width: 32,
            height: 32,
            marginLeft: -8,
            border: "none",
            background: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 16,
          }}
        >
          <Ico d={D_BACK} size={20} color={ink} sw={2.2} />
        </button>
        {wide && view.path.length > 0 && <span style={{ fontSize: 13, color: inkMute, whiteSpace: "nowrap" }}>{up} ›</span>}
        <span style={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: 700, color: ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
      </div>
      <FilterBar view={view} names={names} full={desktop} active={filtersOpen} caret={!wide} onClick={openFilters} />
    </div>
  );

  const hero = (
    <div style={{ background: bandBg, padding: `2px ${P}px 14px`, display: "flex", gap: 28, alignItems: "flex-end", flexWrap: desktop ? "nowrap" : "wrap" }}>
      <div style={{ flex: desktop ? "none" : "1 1 100%", width: desktop ? 380 : undefined, minWidth: 0 }}>
        <div style={{ fontSize: 30, fontWeight: 750, color: ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{M(total)}</div>
        <div style={{ fontSize: 12.5, color: inkMute, marginTop: 3, lineHeight: 1.45, minHeight: 18 }}>{sub}</div>
      </div>
      <MonthBars
        bars={bars}
        highlight={month}
        color={contextColor ?? hc(tint(C.headerInk, 0.6), "var(--accent)")}
        labelColor={inkMute}
        height={desktop ? 46 : 24}
      />
    </div>
  );

  // A folded "12×" line stands for several payments: it opens the section's level, where they are listed.
  const line = (l: StatementLine, sectionDim: ExploreGrouping | null, onDrill?: () => void) => (
    <EntryLine
      key={l.entry.id}
      line={l}
      fixed={sectionDim ? new Set([...fixed, sectionDim]) : fixed}
      names={names}
      txnName={txnNames.get(l.entry.txnId) ?? null}
      selected={selectedTxnId === l.entry.txnId}
      columns={desktop}
      withYear={monthsSpanned > 12}
      onClick={() => (l.count > 1 && onDrill ? onDrill() : onOpenTxn(l.entry.txnId))}
    />
  );

  return (
    <div ref={rootRef} style={{ fontFamily: font }}>
      {header}
      {hero}
      <div style={{ padding: `4px ${P}px 24px` }}>
        <div style={{ fontSize: 12, color: C.mute, padding: "12px 0 4px" }}>
          {list.length === 0
            ? ""
            : grouping === "txn"
              ? tp("{n} transaction, largest first | {n} transactions, largest first", txns.length)
              : t(GROUPING_HEADER[grouping])}
        </div>
        {list.length === 0 && <div style={{ fontSize: 13, color: C.mute, padding: "18px 0" }}>{t("No spending for these filters.")}</div>}
        {grouping === "txn" ? (
          <>
            {txns.slice(0, shown).map((e) => line({ entry: e, count: 1, amount: e.amount }, null))}
            {txns.length > shown && (
              <button onClick={showMore} style={linkBtn}>
                {t("Show more")}
              </button>
            )}
          </>
        ) : (
          rows.map((r) => (
            <Section
              key={r.key ?? "none"}
              row={r}
              name={names.name(grouping, r.key)}
              dot={names.color(grouping, r.key)}
              barColor={names.color(grouping, r.key) ?? contextColor ?? "var(--accent)"}
              share={total > 0 ? r.amount / total : 0}
              max={rows[0]!.amount}
              onDrill={() => drill(grouping, r.key)}
              open={openSections.includes(r.key ?? "")}
              foldKey={foldKey}
              onToggle={() => toggleSection(r.key)}
            >
              {(lines) => lines.map((l) => line(l, grouping, () => drill(grouping, r.key)))}
            </Section>
          ))
        )}
      </div>
      {!onOpenFilters && (
        <FilterSheet
          show={sheet}
          view={view}
          entries={entries}
          names={names}
          state={state}
          onClose={() => setSheet(false)}
          onApply={(v) => {
            setSheet(false);
            setView(v);
          }}
        />
      )}
    </div>
  );
}

/** Scroll position and statement length of each level visited this session. */
type LevelState = { top: number; shown: number; open: string[] };
const levelMemory = new Map<string, LevelState>();
const NEW_LEVEL: LevelState = { top: 0, shown: 50, open: [] };

const moreRow = {
  display: "flex",
  justifyContent: "space-between",
  width: "100%",
  margin: 0,
  padding: "6px 0 0 56px",
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
} as const;

const linkBtn = {
  display: "block",
  margin: "8px 0",
  padding: "6px 0",
  background: "none",
  border: "none",
  color: "var(--accent)",
  fontWeight: 650,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
} as const;

function Section({
  row,
  name,
  dot,
  barColor,
  share,
  max,
  onDrill,
  open,
  onToggle,
  foldKey,
  children,
}: {
  row: ExploreRow;
  name: string;
  dot: string | null;
  barColor: string;
  share: number;
  max: number;
  onDrill: () => void;
  open: boolean;
  onToggle: () => void;
  foldKey: (e: SpendingEntry) => string | null;
  children: (lines: StatementLine[]) => ReactNode;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp, lang } = useT();
  const all = useMemo(() => statementLines(row.entries, foldKey), [row, foldKey]);
  const top = all.slice(0, 3);
  const restN = all.slice(3).reduce((n, l) => n + l.count, 0);
  const restAmt = row.amount - top.reduce((s, l) => s + l.amount, 0);
  // The toggle that was pressed is replaced by its counterpart; focus follows it there.
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  const toggle = () => {
    refocus.current = true;
    onToggle();
  };
  useEffect(() => {
    if (refocus.current) toggleRef.current?.focus();
    refocus.current = false;
  }, [open]);
  return (
    <section style={{ padding: "6px 0 12px", borderTop: `1px solid ${C.line}` }}>
      <button
        onClick={onDrill}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "10px 0 4px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 15,
            fontWeight: 700,
            color: C.text,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {dot && <span aria-hidden style={{ width: 9, height: 9, borderRadius: 3, background: dot, flexShrink: 0 }} />}
          {name}
        </span>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(row.amount)}</span>
        <Ico d={D_CHEV} size={14} color={C.mute} sw={2.2} />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 22, marginBottom: 4 }}>
        <span style={{ flex: 1, height: 4, borderRadius: 3, background: C.inset, overflow: "hidden" }}>
          <span style={{ display: "block", height: "100%", borderRadius: 3, width: `${Math.max(1.5, (row.amount / max) * 100)}%`, background: barColor }} />
        </span>
        <span style={{ width: 40, textAlign: "right", fontSize: 11.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{pctLabel(share, lang)}</span>
      </div>
      {children(top)}
      {restN > 0 && !open && (
        <button ref={toggleRef} onClick={toggle} aria-expanded={false} style={{ ...linkBtn, ...moreRow }}>
          <span>{tp("{n} more | {n} more", restN)}</span>
          <span>{M(restAmt)}</span>
        </button>
      )}
      {/* The unfolded rest sits in its own panel, with "Collapse" at both ends: the top one where
          "n more" was (it takes the focus), the bottom one where a long list ends. */}
      {open && (
        <div style={{ margin: "6px -8px 0", padding: "2px 8px 8px", borderRadius: 12, background: C.chip }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0 2px" }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
              {tp("{n} remaining · {amount} | {n} remaining · {amount}", restN, { amount: M(restAmt) })}
            </span>
            <button ref={toggleRef} onClick={toggle} aria-expanded style={{ ...linkBtn, margin: 0, padding: "4px 0", fontSize: 12 }}>
              {t("Collapse")} ⌃
            </button>
          </div>
          {children(all.slice(3))}
          <button onClick={toggle} aria-expanded style={{ ...linkBtn, margin: "6px auto 0", padding: "4px 8px", fontSize: 12 }}>
            {t("Collapse")} ⌃
          </button>
        </div>
      )}
    </section>
  );
}

function EntryLine({
  line,
  fixed,
  names,
  txnName,
  selected,
  columns,
  withYear,
  onClick,
}: {
  line: StatementLine;
  fixed: ReadonlySet<ExploreGrouping>;
  names: Names;
  txnName: string | null;
  selected: boolean;
  columns: boolean;
  /** The period is longer than a year, so a day and a month alone are ambiguous. */
  withYear: boolean;
  onClick: () => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const e = line.entry;
  // Label: the transaction itself — its name or note, else its place, category or envelope.
  // Meta: what the level has not fixed yet (place, then category or envelope), and the account
  // unless exactly one account is selected.
  const dimName = (d: "place" | "category" | "envelope") => (d !== "place" && e.mixed?.includes(d) ? t("Split transaction") : names.name(d, e[d]));
  const own = (["place", "category", "envelope"] as const).find((d) => e[d] !== null && !e.mixed?.includes(d));
  const label = txnName ?? (own ? dimName(own) : "—");
  const placeMeta = !fixed.has("place") && e.place !== null && txnName !== null && dimName("place") !== label ? dimName("place") : null;
  const kindMeta = !fixed.has("category") ? dimName("category") : !fixed.has("envelope") ? dimName("envelope") : null;
  const meta = [
    line.count > 1 ? t("{amount} each", { amount: M(e.amount) }) : null,
    placeMeta,
    kindMeta !== label ? kindMeta : null,
    fixed.has("account") ? null : names.name("account", e.account),
  ]
    .filter(Boolean)
    .join(", ");
  const when = line.count > 1 ? `${line.count}×` : shortDate(e.date, lang, withYear);
  return (
    <button
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: `${withYear ? 92 : columns ? 72 : 56}px ${columns ? "minmax(0,220px) minmax(0,1fr)" : "minmax(0,1fr)"} auto`,
        gap: 8,
        alignItems: "baseline",
        width: "100%",
        padding: columns ? "5px 8px" : "6px 0",
        margin: columns ? "0 -8px" : 0,
        boxSizing: columns ? "content-box" : "border-box",
        borderRadius: 8,
        background: selected ? "var(--accent-1a)" : "none",
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
        color: C.text,
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: line.count > 1 ? C.text : C.soft,
          fontWeight: line.count > 1 ? 650 : 400,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {when}
      </span>
      {columns ? (
        <>
          <span style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
          <span style={{ fontSize: 12, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta}</span>
        </>
      ) : (
        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", fontSize: 13.5 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
          {meta && <span style={{ fontSize: 11.5, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta}</span>}
        </span>
      )}
      <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textAlign: "right" }}>{M(line.amount)}</span>
    </button>
  );
}

function MonthBars({
  bars,
  highlight,
  color,
  labelColor,
  height,
}: {
  bars: Array<{ month: string; amount: number }>;
  highlight: string | null;
  color: string;
  labelColor: string;
  height: number;
}) {
  const { lang } = useT();
  const M = useMask();
  const max = Math.max(...bars.map((b) => b.amount), 1);
  const label = bars.length <= 14;
  return (
    <div
      aria-hidden
      style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "flex-end", gap: bars.length > 24 ? 1 : 4, height: height + (label ? 16 : 0) }}
    >
      {bars.map((b) => (
        <span
          key={b.month}
          title={`${monthLabel(b.month, lang)}: ${M(b.amount)}`}
          style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 3 }}
        >
          <i
            style={{
              display: "block",
              borderRadius: "3px 3px 1px 1px",
              background: color,
              height: b.amount > 0 ? Math.max(2, Math.round((b.amount / max) * height)) : 1,
              opacity: highlight && highlight !== b.month ? 0.32 : 0.9,
            }}
          />
          {label && (
            <em style={{ fontStyle: "normal", fontSize: 9.5, color: labelColor, textAlign: "center", overflow: "hidden", whiteSpace: "nowrap" }}>
              {monthShortLabel(b.month, lang).replace(".", "")}
            </em>
          )}
        </span>
      ))}
    </div>
  );
}

/** One account by name; several as the first name and how many more ("Checking +2"). */
function accountsLabel(ids: readonly string[], names: Names): string {
  const first = names.name("account", ids[0] ?? null);
  return ids.length > 1 ? `${first} +${ids.length - 1}` : first;
}

/** The one filter control: period and account on top, the drill path under it (middle levels
 *  collapse to "…" unless `full`). */
export function FilterBar({
  view,
  names,
  full,
  active,
  caret,
  onClick,
}: {
  view: SpendingView;
  names: Names;
  full: boolean;
  active: boolean;
  caret: boolean;
  onClick: () => void;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const { hc } = useReportBand();
  const ink = hc(C.headerInk, C.text);
  const mute = hc(C.headerMute, C.mute);
  const ctx = `${periodLabel(view, t, lang)} · ${view.accounts.length ? accountsLabel(view.accounts, names) : t("All accounts")}`;
  const all = view.path.map((s) => names.name(s.dim, s.key));
  const path = all.length > 2 && !full ? [all[0]!, "…", all.at(-1)!] : all;
  return (
    <button
      onClick={onClick}
      aria-label={t("Filters")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px 8px 12px",
        borderRadius: 12,
        border: "none",
        background: hc(tint(C.headerInk, 0.08), C.chip),
        boxShadow: active ? "inset 0 0 0 1.5px var(--accent)" : "none",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
        color: ink,
      }}
    >
      <Ico d={D_FILTER} size={16} color={mute} sw={2.2} />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            fontSize: all.length ? 12 : 14,
            fontWeight: all.length ? 400 : 600,
            color: all.length ? mute : ink,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {ctx}
        </span>
        {all.length > 0 && (
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden" }}>
            {path.map((n, i) => (
              <span key={i} style={{ display: "contents" }}>
                {i > 0 && <i style={{ fontStyle: "normal", color: mute, flex: "none" }}>›</i>}
                <b
                  style={{
                    fontWeight: 700,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                    flexShrink: i === path.length - 1 ? 0 : 1,
                    maxWidth: i === path.length - 1 ? "60%" : undefined,
                  }}
                >
                  {n}
                </b>
              </span>
            ))}
          </span>
        )}
      </span>
      {caret && <Ico d={D_CARET} size={13} color={mute} sw={2.2} />}
    </button>
  );
}

/** Phone: the filters in a sheet, applied together by the button at the bottom. */
function FilterSheet({
  show,
  view,
  entries,
  names,
  state,
  onClose,
  onApply,
}: {
  show: boolean;
  view: SpendingView;
  entries: readonly SpendingEntry[];
  names: Names;
  state: StateResponse;
  onClose: () => void;
  onApply: (v: SpendingView) => void;
}) {
  return (
    // Swipe-to-dismiss is off: the date wheels own vertical drags inside this sheet.
    <Sheet show={show} onClose={onClose} lockSwipe>
      <FilterSheetContent view={view} entries={entries} names={names} state={state} onApply={onApply} />
    </Sheet>
  );
}

function FilterSheetContent({
  view,
  entries,
  names,
  state,
  onApply,
}: {
  view: SpendingView;
  entries: readonly SpendingEntry[];
  names: Names;
  state: StateResponse;
  onApply: (v: SpendingView) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, tp } = useT();
  const [draft, setDraft] = useState(view);
  const matching = useMemo(() => filterEntries(entries, filterOf(draft)), [entries, draft]);
  const txnCount = useMemo(() => mergeByTransaction(matching).length, [matching]);
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <b style={{ fontSize: 17, color: C.text }}>{t("Filters")}</b>
        <button onClick={() => setDraft(clearedView())} style={{ ...linkBtn, margin: 0, padding: 0 }}>
          {t("Clear")}
        </button>
      </div>
      <FilterBody view={draft} onChange={setDraft} entries={entries} names={names} state={state} />
      <div
        style={{
          position: "sticky",
          bottom: -28,
          margin: "0 -20px -28px",
          padding: "10px 16px calc(14px + env(safe-area-inset-bottom))",
          background: C.sheet,
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <button
          onClick={() => onApply(draft)}
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "baseline",
            gap: 8,
            width: "100%",
            padding: 13,
            borderRadius: 14,
            border: "none",
            background: "var(--cta)",
            color: "#fff",
            fontSize: 15,
            fontWeight: 750,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {tp("Show {n} transaction | Show {n} transactions", txnCount)}
          <span style={{ fontWeight: 600, opacity: 0.8, fontSize: 13.5 }}>{M(sumEntries(matching))}</span>
        </button>
      </div>
    </>
  );
}

export function clearedView(): SpendingView {
  return defaultSpendingView(currentMonth());
}

/** Period, account, narrowing and grouping. Shared by the phone sheet (draft) and the wide side
 *  panel (applied as you go). */
export function FilterBody({
  view,
  onChange,
  entries,
  names,
  state,
}: {
  view: SpendingView;
  onChange: (v: SpendingView) => void;
  entries: readonly SpendingEntry[];
  names: Names;
  state: StateResponse;
}) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const [open, setOpen] = useState<ExploreDim | null>(null);
  const thisMonth = currentMonth();
  const preset = presetOf(view, thisMonth);
  const single = singleMonthOf(view);
  const set = (patch: Partial<SpendingView>) => onChange({ ...view, ...patch });
  const setDates = (from: string, to: string) => set({ from, to, custom: true });

  const narrowDims: ExploreDim[] = view.path.some((s) => s.dim === "group") ? ["group", "envelope", "category", "place"] : ["envelope", "category", "place"];
  const stepOf = (d: ExploreDim) => view.path.find((s) => s.dim === d);
  // Changing an earlier choice offers everything under the levels BEFORE it and drops the levels
  // after it, which belonged to the old choice; a dimension not on the path yet narrows the end.
  const before = (d: ExploreDim) => {
    const i = view.path.findIndex((s) => s.dim === d);
    return i < 0 ? view.path : view.path.slice(0, i);
  };
  const choose = (d: ExploreDim, key: string | null) => {
    const path = [...before(d), { dim: d, key }];
    setOpen(null);
    // An envelope already implies its group.
    set({ path: d === "envelope" ? path.filter((s) => s.dim !== "group") : path, grouping: null });
  };
  const remove = (d: ExploreDim) => set({ path: view.path.filter((s) => s.dim !== d), grouping: null });
  const accounts = state.accounts.filter((a) => !a.archived || view.accounts.includes(a.id));
  // Pills toggle: any set of accounts, none selected meaning all of them.
  const toggleAccount = (id: string) =>
    set({ accounts: view.accounts.includes(id) ? view.accounts.filter((x) => x !== id) : [...view.accounts, id], grouping: null });
  const grouping = groupingOf(entries, view);

  return (
    <div style={{ color: C.text }}>
      <Block label={t("Period")}>
        <Pills>
          {PRESETS.map((p) => (
            <Pill key={p.id} on={preset === p.id} onClick={() => set({ ...presetRange(p.id, thisMonth), custom: false })}>
              {t(p.label)}
            </Pill>
          ))}
          <Pill on={view.custom} onClick={() => set({ custom: true })}>
            {t("Custom range")}
          </Pill>
        </Pills>
        {view.custom ? (
          <DateRange from={view.from} to={view.to} onChange={setDates} />
        ) : (
          <>
            <div style={{ fontSize: 11.5, color: C.mute, margin: "10px 0 6px" }}>{t("or a single month")}</div>
            <Pills gap={4}>
              {lastMonths(thisMonth, 12).map((m) => (
                <Pill key={m} small on={single === m && !preset} onClick={() => set({ from: monthStart(m), to: monthEnd(m), custom: false })}>
                  {monthShortLabel(m, lang).replace(".", "")}
                </Pill>
              ))}
            </Pills>
          </>
        )}
      </Block>
      <Block label={t("Account")}>
        <Pills>
          <Pill on={view.accounts.length === 0} onClick={() => set({ accounts: [], grouping: null })}>
            {t("All accounts")}
          </Pill>
          {accounts.map((a) => (
            <Pill key={a.id} on={view.accounts.includes(a.id)} onClick={() => toggleAccount(a.id)}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: a.color, flexShrink: 0 }} />
              {a.name}
            </Pill>
          ))}
        </Pills>
      </Block>
      <Block label={t("Narrow to")}>
        {narrowDims.map((d) => {
          const step = stepOf(d);
          const isOpen = open === d;
          const options = isOpen ? breakdownEntries(filterEntries(entries, { ...filterOf(view), path: before(d) }), d) : [];
          return (
            <div key={d} style={{ borderRadius: 12, background: C.chip, marginBottom: 6, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <button
                  onClick={() => setOpen(isOpen ? null : d)}
                  aria-expanded={isOpen}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 12px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    color: C.text,
                  }}
                >
                  <span style={{ width: 78, fontSize: 13, color: C.mute, flexShrink: 0 }}>{t(DIM_LABEL[d])}</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 14.5,
                      fontWeight: step ? 650 : 500,
                      color: step ? C.text : C.mute,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {step ? names.name(d, step.key) : t(ANY[d])}
                  </span>
                  {!step && <Ico d={D_CARET} size={13} color={C.mute} sw={2.2} />}
                </button>
                {step && (
                  <button
                    onClick={() => remove(d)}
                    aria-label={t("Remove")}
                    style={{
                      width: 30,
                      height: 30,
                      marginRight: 8,
                      borderRadius: 15,
                      border: "none",
                      background: C.inset,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    <Ico d={D_X} size={12} color={C.mute} sw={2.4} />
                  </button>
                )}
              </div>
              {isOpen && (
                <div style={{ borderTop: `1px solid ${C.line}`, padding: "4px 0", maxHeight: 260, overflowY: "auto" }}>
                  {options.length === 0 && <div style={{ padding: "9px 12px", fontSize: 13, color: C.mute }}>{t("No spending for these filters.")}</div>}
                  {options.map((o) => (
                    <button
                      key={o.key ?? "none"}
                      onClick={() => choose(d, o.key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "9px 12px",
                        border: "none",
                        background: step?.key === o.key ? "var(--accent-1a)" : "none",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        textAlign: "left",
                        color: C.text,
                        fontSize: 14,
                      }}
                    >
                      {names.color(d, o.key) && (
                        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: names.color(d, o.key)!, flexShrink: 0 }} />
                      )}
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{names.name(d, o.key)}</span>
                      <b style={{ fontSize: 13, fontWeight: 600, color: C.soft, fontVariantNumeric: "tabular-nums" }}>{M(o.amount)}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Block>
      <Block label={t("Group by")} last>
        <Pills>
          {availableGroupings(filterOf(view), spansMonths(view)).map((g) => (
            <Pill key={g} on={grouping === g} onClick={() => set({ grouping: { pathKey: encodePath(view.path), g } })}>
              {t(GROUPING_LABEL[g])}
            </Pill>
          ))}
        </Pills>
      </Block>
    </div>
  );
}

function Block({ label, last = false, children }: { label: string; last?: boolean; children: ReactNode }) {
  const C = useTheme();
  return (
    <div style={{ padding: "12px 0 14px", borderBottom: last ? "none" : `1px solid ${C.line}` }}>
      <div style={{ fontSize: 12.5, color: C.mute, fontWeight: 600, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

function Pills({ gap = 6, children }: { gap?: number; children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap }}>{children}</div>;
}

function Pill({ on, small = false, onClick, children }: { on: boolean; small?: boolean; onClick: () => void; children: ReactNode }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minWidth: small ? 40 : undefined,
        padding: small ? "6px 8px" : "7px 12px",
        borderRadius: 10,
        border: "none",
        background: on ? "var(--accent)" : C.chip,
        color: on ? C.card : C.soft,
        fontSize: small ? 12.5 : 13.5,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

/**
 * Two dates that open the app's own wheels in place, under the pair — not a second sheet or the
 * system picker on top of the filters.
 */
function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const C = useTheme();
  const { t, lang } = useT();
  const [editing, setEditing] = useState<"from" | "to" | null>("from");
  const field = (which: "from" | "to", label: string, value: string) => (
    <button
      onClick={() => setEditing(editing === which ? null : which)}
      aria-expanded={editing === which}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 12px",
        borderRadius: 10,
        border: "none",
        background: C.chip,
        boxShadow: editing === which ? "inset 0 0 0 1.5px var(--accent)" : "none",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
      }}
    >
      <span style={{ fontSize: 11.5, color: C.mute }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 650, color: C.text, whiteSpace: "nowrap" }}>{shortDate(value, lang, true)}</span>
    </button>
  );
  const value = editing === "from" ? from : to;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const months = monthNames(lang);
  const thisYear = +currentMonth().slice(0, 4);
  const years = Array.from({ length: 6 }, (_, i) => thisYear - 5 + i);
  const setPart = (day: number, monIdx: number, year: number) => {
    const iso = `${year}-${String(monIdx + 1).padStart(2, "0")}-${String(Math.min(day, new Date(Date.UTC(year, monIdx + 1, 0)).getUTCDate())).padStart(2, "0")}`;
    // The other end moves along rather than swapping, so the wheel under the finger keeps its date.
    if (editing === "from") onChange(iso, iso > to ? iso : to);
    else onChange(iso < from ? iso : from, iso);
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {field("from", t("From"), from)}
        <span style={{ color: C.mute }}>–</span>
        {field("to", t("To"), to)}
      </div>
      {editing && (
        <div key={editing} style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
          <ScrollPicker label={t("Day")} items={DAYS} selected={d} onSelect={(v) => setPart(v, m - 1, y)} width="28%" />
          <ScrollPicker label={t("Month")} items={months} selected={months[m - 1]!} onSelect={(v) => setPart(d, months.indexOf(v), y)} width="44%" />
          <ScrollPicker label={t("Year")} items={years.includes(y) ? years : [y, ...years]} selected={y} onSelect={(v) => setPart(d, m - 1, v)} width="28%" />
        </div>
      )}
    </div>
  );
}

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/** Wide layout side panel: the filters, applied as you go. */
export function SpendingFiltersPanel({ state, view, setView }: { state: StateResponse; view: SpendingView; setView: (v: SpendingView) => void }) {
  const entries = useEntries();
  const names = useNames(state);
  return (
    <div className="gsh" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 16px 16px" }}>
      <FilterBody view={view} onChange={setView} entries={entries} names={names} state={state} />
    </div>
  );
}
