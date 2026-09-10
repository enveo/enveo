import type { StateResponse } from "@enveo/shared";
import { useCallback, useEffect, useState } from "react";
import { HeaderImportBadge } from "../components/HeaderImportBadge";
import { ImportProgress, importProgressPresentation } from "../components/ImportProgress";
import { ImportSheet } from "../components/ImportSheet";
import { useBand } from "../components/kit";
import { apiErrorMessage } from "../lib/api";
import { useTheme } from "../lib/contexts";
import { type Message, msg, useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { importJobManager } from "../lib/importJobs/manager";
import { canRemoveImportActivity, type ImportActivityItem, importActivityAttention, isScheduledImportRetry } from "../lib/importJobs/store";
import { useWideHost } from "../lib/shellContext";
import { CORAL, P } from "../lib/theme";

export interface ImportActivitySections {
  active: ImportActivityItem[];
  ready: ImportActivityItem[];
  failed: ImportActivityItem[];
  completed: ImportActivityItem[];
  cancelled: ImportActivityItem[];
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
    active: visible.filter((item) => item.status === "queued" || item.status === "running" || isScheduledImportRetry(item)),
    ready: visible.filter((item) => item.status === "ready"),
    failed: visible.filter((item) => importActivityAttention(item) === "failed"),
    completed: visible.filter((item) => item.status === "completed" && Date.parse(item.expiresAt) > now.getTime()),
    cancelled: visible.filter((item) => item.status === "cancelled" && Date.parse(item.expiresAt) > now.getTime()),
  };
}

export function activityAttentionCount(sections: ImportActivitySections): number {
  return sections.ready.length + sections.failed.length;
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
    } catch {
      // Keep the mutation error: it is the actionable failure the user just triggered.
    }
    return message;
  }
}

export function ActivityScreen({ state, onMenu }: { state: StateResponse; onMenu: () => void }) {
  const C = useTheme();
  const { t, lang } = useT();
  const wideHost = useWideHost();
  const { band, hc } = useBand();
  const [items, setItems] = useState<ImportActivityItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedState, setSelected] = useState<Set<string>>(() => new Set());
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
  const date = (value: string) => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const removable = Object.values(sections).flat().filter(canRemoveActivityImport);
  const removableIds = new Set(removable.map((job) => job.id));
  const selected = new Set([...selectedState].filter((id) => removableIds.has(id)));
  const remove = async (jobs: ImportActivityItem[]) => {
    if (
      jobs.some((job) => job.status === "ready" || job.status === "failed") &&
      !window.confirm(t("Delete selected imports? Screenshots and retry data will be removed. Transactions already added to the budget will stay."))
    )
      return;
    try {
      await importJobManager.removeMany(jobs.map((job) => job.id));
      setSelected(new Set());
      await refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    }
  };

  const allSelected = removable.length > 0 && selected.size === removable.length;
  const selectionAnchorId = selected.values().next().value;
  const selectionHeadingOwner: ImportActivityItem[] | undefined = selectionAnchorId
    ? Object.values(sections).find((section: ImportActivityItem[]) => section.some((job) => job.id === selectionAnchorId))
    : undefined;
  const list = (title: Message, jobs: ImportActivityItem[]) => {
    const showSelectionActions = jobs === selectionHeadingOwner;
    return (
      jobs.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <div
            data-section-heading-actions={showSelectionActions || undefined}
            style={{ height: 34, marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
          >
            {showSelectionActions ? (
              <>
                <strong style={{ color: C.text, fontSize: 11.5, whiteSpace: "nowrap" }}>{t("Selected: {count}", { count: selected.size })}</strong>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => setSelected(allSelected ? new Set() : new Set([...selected, ...removable.map((job) => job.id)]))}
                    style={{ ...linkButton, width: "auto", marginTop: 0, color: C.text, whiteSpace: "nowrap" }}
                  >
                    {t(allSelected ? msg("Deselect all") : msg("Select all"))}
                  </button>
                  <button
                    type="button"
                    aria-label={t("Delete selected ({count})", { count: selected.size })}
                    onClick={() => void remove(removable.filter((job) => selected.has(job.id)))}
                    style={{ ...deleteIconButton, background: "var(--danger)", color: "#fff" }}
                  >
                    <Ico d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" size={18} color="currentColor" sw={1.8} />
                  </button>
                </div>
              </>
            ) : (
              <h2 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.7, color: C.soft }}>{t(title)}</h2>
            )}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: wideHost ? "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" : "1fr",
              gap: 9,
            }}
          >
            {jobs.map((job) => {
              const scheduledRetry = isScheduledImportRetry(job);
              return (
                <article
                  key={job.id}
                  style={{
                    position: "relative",
                    background: C.card,
                    border: `1px solid ${selected.has(job.id) ? "var(--cta)" : C.line}`,
                    borderRadius: 14,
                    padding: "12px 13px",
                  }}
                >
                  {canRemoveActivityImport(job) && (
                    <label
                      data-import-select
                      style={{ position: "absolute", top: 11, right: 11, width: 28, height: 28, display: "grid", placeItems: "center", cursor: "pointer" }}
                    >
                      <input
                        type="checkbox"
                        aria-label={t("Select import from {date}", { date: date(job.updatedAt) })}
                        checked={selected.has(job.id)}
                        style={{ width: 18, height: 18, margin: 0, accentColor: "var(--cta)", cursor: "pointer" }}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set([...current].filter((id) => removableIds.has(id)));
                            if (next.has(job.id)) next.delete(job.id);
                            else next.add(job.id);
                            return next;
                          })
                        }
                      />
                    </label>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, paddingRight: canRemoveActivityImport(job) ? 34 : 0 }}>
                      <div style={{ color: C.text, fontSize: 14, fontWeight: 700 }}>
                        {t(job.tier === "e2ee" ? msg("Local encrypted import") : msg("Screenshot import"))}
                      </div>
                      <div style={{ color: C.soft, fontSize: 10.5, marginTop: 2 }}>{date(job.updatedAt)}</div>
                    </div>
                    {job.status === "ready" && (
                      <span style={{ color: C.pos, fontSize: 11, fontWeight: 700, marginRight: canRemoveActivityImport(job) ? 34 : 0 }}>
                        {t("Ready to review")}
                      </span>
                    )}
                    {job.status === "failed" && !scheduledRetry && (
                      <span style={{ color: CORAL, fontSize: 11, fontWeight: 700, marginRight: canRemoveActivityImport(job) ? 34 : 0 }}>
                        {t("Needs attention")}
                      </span>
                    )}
                  </div>
                  {job.status === "completed" && (
                    <div style={{ color: C.soft, fontSize: 12, marginTop: 7 }}>
                      {t("Added: {added} · Skipped: {skipped}", { added: job.appliedCount, skipped: job.skippedCount })}
                    </div>
                  )}
                  {(job.status === "ready" || job.status === "completed") && (
                    <button type="button" onClick={() => setSelectedJobId(job.id)} style={{ ...primaryButton, background: C.text, color: C.card }}>
                      {job.status === "completed" ? t("Import details") : t("Review import")}
                    </button>
                  )}
                  {job.status === "failed" && !scheduledRetry && (
                    <>
                      <div role="alert" style={{ color: CORAL, fontSize: 12, lineHeight: 1.4, marginTop: 8 }}>
                        {t(importProgressPresentation(job).message)}
                      </div>
                      {canRetryActivityImport(job) && (
                        <button
                          type="button"
                          onClick={() => void retryActivityImport(job.id, (id) => importJobManager.retry(id), refresh).then(setError)}
                          style={{ ...primaryButton, background: C.bg, color: C.text, border: `1px solid ${C.line}` }}
                        >
                          {t("Retry import")}
                        </button>
                      )}
                    </>
                  )}
                  {(job.status === "queued" || job.status === "running" || scheduledRetry) && (
                    <ImportProgress
                      item={job}
                      showBackground={false}
                      onBackground={() => {}}
                      onCancel={() => void importJobManager.cancel(job.id).then(refresh)}
                    />
                  )}
                  <div style={{ color: C.soft, fontSize: 10.5, marginTop: 7 }}>{t("Expires {date}", { date: date(job.expiresAt) })}</div>
                </article>
              );
            })}
          </div>
        </section>
      )
    );
  };

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
        style={{ width: "100%", boxSizing: "border-box", maxWidth: wideHost ? 920 : undefined, margin: "0 auto", padding: `${wideHost ? 18 : 0}px ${P}px` }}
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
        {list(msg("Ready"), sections.ready)}
        {list(msg("In progress"), sections.active)}
        {list(msg("Needs attention"), sections.failed)}
        {list(msg("Recently completed"), sections.completed)}
        {list(msg("Cancelled"), sections.cancelled)}
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

const iconButton = { background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" } as const;
const primaryButton = {
  width: "100%",
  marginTop: 10,
  padding: "10px 8px",
  borderRadius: 10,
  border: "none",
  fontWeight: 700,
  cursor: "pointer",
} as const;
const linkButton = { width: "100%", marginTop: 8, padding: "5px", border: "none", background: "none", cursor: "pointer", fontSize: 11.5 } as const;
const deleteIconButton = {
  width: 34,
  height: 34,
  padding: 0,
  border: "none",
  borderRadius: 10,
  display: "grid",
  placeItems: "center",
  cursor: "pointer",
} as const;
