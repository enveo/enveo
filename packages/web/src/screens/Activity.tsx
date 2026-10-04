import type { ReconciledImportProposal, StateResponse } from "@enveo/shared";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { HeaderImportBadge } from "../components/HeaderImportBadge";
import { ImportDeleteConfirm } from "../components/ImportDelete";
import { importProgressPresentation } from "../components/ImportProgress";
import { ImportSheet } from "../components/ImportSheet";
import { CardBox, SectionEyebrow, useBand } from "../components/kit";
import { apiErrorMessage, useLedgerVersion } from "../lib/api";
import { useMask, useTheme } from "../lib/contexts";
import { type Message, msg, useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { importJobManager } from "../lib/importJobs/manager";
import { canRemoveImportActivity, type ImportActivityItem, importActivityAttention, importScreenshotProgress } from "../lib/importJobs/store";
import { reconcileImportJobResult } from "../lib/localImport";
import { useWideHost } from "../lib/shellContext";
import { store } from "../lib/store";
import { CORAL, P, tint } from "../lib/theme";

export interface ImportActivitySections {
  /** Everything that still needs the user or is about to: ready, reading, and failed imports. */
  current: ImportActivityItem[];
  completed: ImportActivityItem[];
}

export function activitySections(items: readonly ImportActivityItem[], now = new Date()): ImportActivitySections {
  const newest = new Map<string, ImportActivityItem>();
  for (const item of items) {
    const current = newest.get(item.id);
    if (
      !current ||
      item.updatedAt > current.updatedAt ||
      (item.updatedAt === current.updatedAt && current.source === "plain-draft" && item.source === "plain")
    ) {
      newest.set(item.id, item);
    }
  }
  const visible = [...newest.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  return {
    current: visible.filter((item) => item.status === "ready" || item.status === "queued" || item.status === "running" || item.status === "failed"),
    completed: visible.filter((item) => item.status === "completed" && Date.parse(item.expiresAt) > now.getTime()),
  };
}

export function activityAttentionCount(sections: ImportActivitySections): number {
  return sections.current.filter((item) => importActivityAttention(item) !== null).length;
}

/** What a list row says about its import's money: rows waiting for review and the balance change
 *  of the rows the review preselects, or what a completed import added and how it moved the
 *  account at the moment it was applied. `reconciled` are the ready job's proposals checked
 *  against the local ledger, the same duplicate check the review runs: a repeated import of
 *  already added rows must not claim new transactions. */
export type ImportActivityFigures =
  | { kind: "review"; toReview: number; delta: number | null }
  | { kind: "completed"; added: number; skipped: number; delta: number | null }
  | null;

export function importActivityFigures(item: ImportActivityItem, reconciled?: readonly ReconciledImportProposal[]): ImportActivityFigures {
  if (item.status === "ready") {
    const proposals = reconciled ?? item.result?.proposals;
    if (!proposals) return { kind: "review", toReview: item.proposalCount, delta: null };
    const candidates = proposals.filter(
      (proposal) => proposal.disposition === "candidate" && (!("duplicateStatus" in proposal) || proposal.duplicateStatus !== "exists"),
    );
    let delta = 0;
    for (const proposal of candidates) {
      if (!proposal.selected || proposal.amount === null || proposal.type === null) continue;
      if (proposal.type === "income") delta += proposal.amount;
      else if (proposal.type === "expense") delta += proposal.isRefund ? proposal.amount : -proposal.amount;
      else delta += proposal.toAccountId === item.accountId ? proposal.amount : -proposal.amount;
    }
    return { kind: "review", toReview: candidates.length, delta };
  }
  if (item.status === "completed") {
    const balance = item.result?.receipt?.balances.find((entry) => entry.accountId === item.accountId);
    const delta = balance && balance.before !== null && balance.after !== null ? balance.after - balance.before : null;
    return { kind: "completed", added: item.appliedCount, skipped: item.skippedCount, delta };
  }
  return null;
}

export function activityDismissMessage(item: ImportActivityItem): Message {
  return item.source === "e2ee" ? msg("Remove from this device") : msg("Hide for this session");
}

export function canRetryActivityImport(item: ImportActivityItem): boolean {
  return item.status === "failed" && item.errorCode !== "expired";
}

export const canRemoveActivityImport = canRemoveImportActivity;

export async function retryActivityImport(id: string, retry: (id: string) => Promise<void>, refresh: () => Promise<void>): Promise<string | null> {
  try {
    await retry(id);
    await refresh();
    return null;
  } catch (cause) {
    const message = apiErrorMessage(cause);
    try {
      await refresh();
    } catch {}
    return message;
  }
}

export function ActivityScreen({ state, onMenu }: { state: StateResponse; onMenu: () => void }) {
  const C = useTheme();
  const M = useMask();
  const { t, tp, lang } = useT();
  const wideHost = useWideHost();
  const { band, hc } = useBand();
  const [items, setItems] = useState<ImportActivityItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [clearing, setClearing] = useState<"confirm" | "busy" | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const ledgerVersion = useLedgerVersion();
  // The replica is a mutable store; its version is the change signal.
  const ledger = useMemo(() => store.getLedger(), [ledgerVersion]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setItems(await importJobManager.list());
      setError(null);
    } catch (cause) {
      setError(apiErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    const unsubscribe = importJobManager.subscribe(() => setItems(importJobManager.activityItems()));
    void refresh();
    return unsubscribe;
  }, [refresh]);

  const sections = activitySections(items);
  const empty = Object.values(sections).every((section) => section.length === 0);
  const day = (value: string) => new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(new Date(value));
  const clearCompleted = async () => {
    setClearing("busy");
    try {
      await importJobManager.removeMany(sections.completed.map((job) => job.id));
      await refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setClearing(null);
    }
  };

  const accountById = new Map(state.accounts.map((account) => [account.id, account]));
  const reconciled = (job: ImportActivityItem) =>
    ledger && job.status === "ready" && job.result && job.accountId
      ? reconcileImportJobResult({ result: job.result, ledger, accountId: job.accountId }).proposals
      : undefined;
  const money = (minor: number) => (minor < 0 ? `-${M(-minor)}` : `+${M(minor)}`);
  const visibleCompleted = wideHost || showOlder ? sections.completed : sections.completed.slice(0, PHONE_COMPLETED_LIMIT);
  const hiddenCompleted = sections.completed.length - visibleCompleted.length;

  const row = (job: ImportActivityItem, index: number) => {
    const account = job.accountId ? accountById.get(job.accountId) : undefined;
    const figures = importActivityFigures(job, reconciled(job));
    const presentation = importProgressPresentation(job);
    const failed = importActivityAttention(job) === "failed";
    const progressing = presentation.kind === "progress";
    // A failed import opens too: its sheet carries Retry and Delete import.
    const opens = job.status === "ready" || job.status === "completed" || failed;
    const open = wideHost !== null && selectedJobId === job.id;
    const activate = opens ? () => setSelectedJobId(job.id) : undefined;
    const color = account?.color ?? C.soft;
    const sub =
      figures?.kind === "completed"
        ? [
            tp("{n} transaction | {n} transactions", figures.added),
            figures.skipped > 0 ? tp("{n} duplicate skipped | {n} duplicates skipped", figures.skipped) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : failed || progressing
          ? t(presentation.message)
          : t("Expires {date}", { date: day(job.expiresAt) });
    const screenshots = importScreenshotProgress(job);
    return (
      <div
        key={job.id}
        data-import-row={job.status}
        role={activate ? "button" : undefined}
        tabIndex={activate ? 0 : undefined}
        onClick={activate}
        onKeyDown={(e) => {
          if (!activate || e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          activate();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 12px",
          margin: "0 -12px",
          cursor: activate ? "pointer" : "default",
          background: open ? C.selBg : "transparent",
          borderTop: index === 0 ? "none" : `1px solid ${C.line}`,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            flexShrink: 0,
            background: tint(color, 0.16),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Glyph name={account?.icon ?? "wallet"} size={14} color={color} sw={1.7} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: open ? "var(--accent)" : C.text,
              fontSize: 13.5,
              fontWeight: 650,
              lineHeight: 1.25,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {account?.name ?? t(job.tier === "e2ee" ? msg("Local encrypted import") : msg("Screenshot import"))}
          </div>
          <div
            role={failed ? "alert" : undefined}
            style={{
              color: failed ? CORAL : C.soft,
              fontSize: 10.5,
              lineHeight: 1.3,
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: wideHost ? "nowrap" : "normal",
            }}
          >
            {sub}
            {screenshots && ` · ${t("Read {read} of {total} screenshots", { read: screenshots.read, total: screenshots.total })}`}
          </div>
        </div>
        {wideHost && <span style={{ fontSize: 12, color: "var(--accent)", flexShrink: 0, width: 8 }}>{open ? "▸" : ""}</span>}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
          {figures?.kind === "review" && (
            <>
              {figures.toReview > 0 ? (
                <span style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25, color: C.pos }}>{tp("{n} to review | {n} to review", figures.toReview)}</span>
              ) : (
                <span style={{ fontSize: 12.5, fontWeight: 650, lineHeight: 1.25, color: C.soft }}>{t("Already added")}</span>
              )}
              {figures.delta !== null && figures.delta !== 0 && (
                <span style={{ fontSize: 10.5, fontWeight: 650, marginTop: 1, fontVariantNumeric: "tabular-nums", color: figures.delta > 0 ? C.pos : C.text }}>
                  {money(figures.delta)}
                </span>
              )}
            </>
          )}
          {figures?.kind === "completed" && (
            <>
              {figures.delta !== null && (
                <span
                  style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25, fontVariantNumeric: "tabular-nums", color: figures.delta > 0 ? C.pos : C.text }}
                >
                  {money(figures.delta)}
                </span>
              )}
              <span style={{ color: C.soft, fontSize: 10, marginTop: 1 }}>{day(job.updatedAt)}</span>
            </>
          )}
          {failed && canRetryActivityImport(job) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void retryActivityImport(job.id, (id) => importJobManager.retry(id), refresh).then(setError);
              }}
              style={{ ...textButton, color: CORAL, fontWeight: 700 }}
            >
              {t("Retry import")}
            </button>
          )}
          {progressing && presentation.canCancel && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void importJobManager.cancel(job.id).then(refresh);
              }}
              style={{ ...textButton, color: C.soft }}
            >
              {t("Cancel")}
            </button>
          )}
        </div>
        {!wideHost && opens && (
          <span aria-hidden style={{ color: C.soft, fontSize: 16, marginLeft: 2 }}>
            ›
          </span>
        )}
      </div>
    );
  };

  const list = (title: Message, jobs: ImportActivityItem[], right?: ReactNode, above?: ReactNode) =>
    jobs.length > 0 && (
      <section>
        <SectionEyebrow label={t(title)} right={right} />
        {above}
        <CardBox style={{ padding: "0 12px", overflow: "hidden", margin: 0, border: wideHost ? `1px solid ${C.line}` : undefined }}>{jobs.map(row)}</CardBox>
      </section>
    );

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 14 }}>
      {!wideHost && (
        <header
          data-imports-header
          data-band={band || undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: `12px ${P}px ${band ? 24 : 12}px`,
            background: band ? C.headerBg : undefined,
            clipPath: band ? "polygon(0 0, 100% 0, 100% calc(100% - 12px), 50% 100%, 0 calc(100% - 12px))" : undefined,
          }}
        >
          <div style={{ position: "relative", display: "flex" }}>
            {" "}
            <button type="button" onClick={onMenu} aria-label={t("Menu")} style={iconButton}>
              <Ico d="M4 6h16M4 12h16M4 18h16" size={21} color={hc(C.headerInk, C.text)} sw={2} />
            </button>
            <HeaderImportBadge />
          </div>
          <h1 style={{ margin: 0, color: hc(C.headerInk, C.text), fontSize: 18, fontWeight: 750 }}>{t("Imports")}</h1>
        </header>
      )}
      <main
        data-activity-content
        style={{ width: "100%", boxSizing: "border-box", maxWidth: wideHost ? 920 : undefined, margin: "0 auto", padding: `${wideHost ? 8 : 0}px ${P}px` }}
      >
        {error && (
          <div role="alert" style={{ color: CORAL, fontSize: 12.5, marginTop: 14 }}>
            {error}
          </div>
        )}
        {empty && !error && (
          <div style={{ color: C.soft, textAlign: "center", padding: "64px 12px" }}>
            <div
              aria-hidden
              style={{ width: 58, height: 58, borderRadius: 18, margin: "0 auto 16px", display: "grid", placeItems: "center", background: C.card }}
            >
              <Ico d="M4 7h16v12H4zM7 4h10M8 11l2.5 2.5L14.5 9l3.5 5" size={28} color={C.soft} sw={1.7} />
            </div>
            <div style={{ color: C.text, fontSize: 16, fontWeight: 700 }}>{t("No imports")}</div>
            <div style={{ marginTop: 6, fontSize: 12.5 }}>{t("Add screenshots or a PDF statement with the + button.")}</div>
          </div>
        )}
        {list(msg("To review"), sections.current)}
        {list(
          msg("Completed"),
          visibleCompleted,
          clearing === null && (
            <button
              type="button"
              data-import-clear-completed
              onClick={() => setClearing("confirm")}
              style={{ ...textButton, minHeight: 0, padding: 0, color: C.neg }}
            >
              {t("Clear completed")}
            </button>
          ),
          clearing !== null && (
            <div style={{ marginBottom: 8 }}>
              <ImportDeleteConfirm
                title={tp("Delete {n} completed import? | Delete {n} completed imports?", sections.completed.length)}
                body={t("The transactions they added stay in your budget.")}
                busy={clearing === "busy"}
                onCancel={() => setClearing(null)}
                onConfirm={() => void clearCompleted()}
              />
            </div>
          ),
        )}
        {hiddenCompleted > 0 && (
          <button type="button" onClick={() => setShowOlder(true)} style={{ ...textButton, display: "block", margin: "10px auto 0", color: C.soft }}>
            {tp("Show {n} older import | Show {n} older imports", hiddenCompleted)}
          </button>
        )}
      </main>
      {selectedJobId && (
        <ImportSheet
          show
          initialJobId={selectedJobId}
          onClose={() => {
            setSelectedJobId(null);
            void refresh();
          }}
          state={state}
        />
      )}
    </div>
  );
}

/** Phones show the newest few completed imports; the rest wait behind "Show older". */
const PHONE_COMPLETED_LIMIT = 3;

const iconButton = { background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" } as const;
const textButton = {
  minHeight: 30,
  padding: "4px 6px",
  border: "none",
  background: "none",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
} as const;
