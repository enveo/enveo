import type { StateResponse } from "@enveo/shared";
import { useCallback, useEffect, useState } from "react";
import { ImportProgress, importProgressPresentation } from "../components/ImportProgress";
import { ImportSheet } from "../components/ImportSheet";
import { useTheme } from "../lib/contexts";
import { type Message, msg, useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { importJobManager } from "../lib/importJobs/manager";
import { type ImportActivityItem, importActivityAttention, isScheduledImportRetry } from "../lib/importJobs/store";
import { useWideHost } from "../lib/shellContext";
import { CORAL, P } from "../lib/theme";

export interface ImportActivitySections {
  active: ImportActivityItem[];
  ready: ImportActivityItem[];
  failed: ImportActivityItem[];
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
    active: visible.filter((item) => item.status === "queued" || item.status === "running" || isScheduledImportRetry(item)),
    ready: visible.filter((item) => item.status === "ready"),
    failed: visible.filter((item) => importActivityAttention(item) === "failed"),
    completed: visible.filter((item) => item.status === "completed" && Date.parse(item.expiresAt) > now.getTime()),
  };
}

export function activityAttentionCount(sections: ImportActivitySections): number {
  return sections.ready.length + sections.failed.length;
}

export function activityDismissMessage(item: ImportActivityItem): Message {
  return item.source === "e2ee" ? msg("Remove from this device") : msg("Hide for this session");
}

export function ActivityScreen({ state, onMenu }: { state: StateResponse; onMenu: () => void }) {
  const C = useTheme();
  const { t, lang } = useT();
  const wideHost = useWideHost();
  const [items, setItems] = useState<ImportActivityItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setItems(await importJobManager.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "import_activity_unavailable");
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
  const dismiss = async (job: ImportActivityItem) => {
    await importJobManager.dismiss(job.id);
    await refresh();
  };

  const list = (title: Message, jobs: ImportActivityItem[]) =>
    jobs.length > 0 && (
      <section style={{ marginTop: 18 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.7, color: C.soft }}>{t(title)}</h2>
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
              <article key={job.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 13px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ color: C.text, fontSize: 14, fontWeight: 700 }}>
                      {t(job.tier === "e2ee" ? msg("Local encrypted import") : msg("Screenshot import"))}
                    </div>
                    <div style={{ color: C.soft, fontSize: 10.5, marginTop: 2 }}>{date(job.updatedAt)}</div>
                  </div>
                  {job.status === "ready" && <span style={{ color: C.pos, fontSize: 11, fontWeight: 700 }}>{t("Ready to review")}</span>}
                  {job.status === "failed" && !scheduledRetry && <span style={{ color: CORAL, fontSize: 11, fontWeight: 700 }}>{t("Needs attention")}</span>}
                </div>
                {job.status === "completed" && (
                  <div style={{ color: C.soft, fontSize: 12, marginTop: 7 }}>
                    {t("Added: {added} · Skipped: {skipped}", { added: job.appliedCount, skipped: job.skippedCount })}
                  </div>
                )}
                {job.status === "ready" && (
                  <button type="button" onClick={() => setSelectedJobId(job.id)} style={{ ...primaryButton, background: C.text, color: C.card }}>
                    {t("Review import")}
                  </button>
                )}
                {job.status === "failed" && !scheduledRetry && (
                  <>
                    <div role="alert" style={{ color: CORAL, fontSize: 12, lineHeight: 1.4, marginTop: 8 }}>
                      {t(importProgressPresentation(job).message)}
                    </div>
                    <button
                      type="button"
                      onClick={() => void importJobManager.retry(job.id).then(refresh)}
                      style={{ ...primaryButton, background: C.bg, color: C.text, border: `1px solid ${C.line}` }}
                    >
                      {t("Retry import")}
                    </button>
                  </>
                )}
                {(job.status === "completed" || (job.status === "failed" && !scheduledRetry)) && (
                  <button type="button" onClick={() => void dismiss(job)} style={{ ...linkButton, color: C.soft }}>
                    {t(activityDismissMessage(job))}
                  </button>
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
    );

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 14 }}>
      {!wideHost && (
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: `12px ${P}px` }}>
          <button type="button" onClick={onMenu} aria-label={t("Menu")} style={iconButton}>
            <Ico d="M4 6h16M4 12h16M4 18h16" size={21} color={C.text} sw={2} />
          </button>
          <h1 style={{ margin: 0, color: C.text, fontSize: 18, fontWeight: 750 }}>{t("Activity")}</h1>
        </header>
      )}
      <main
        data-activity-content
        style={{ width: "100%", boxSizing: "border-box", maxWidth: wideHost ? 920 : undefined, margin: "0 auto", padding: `${wideHost ? 18 : 0}px ${P}px` }}
      >
        <p style={{ margin: "2px 0 0", color: C.soft, fontSize: 12.5, lineHeight: 1.45 }}>
          {t("Imports continue independently of this screen. Encrypted imports run only on this device.")}
        </p>
        {error && (
          <div role="alert" style={{ color: CORAL, fontSize: 12.5, marginTop: 14 }}>
            {t("Activity could not be refreshed. Try again.")}
          </div>
        )}
        {empty && !error && <div style={{ color: C.soft, fontSize: 13, textAlign: "center", padding: "52px 12px" }}>{t("No import activity yet.")}</div>}
        {list(msg("Ready"), sections.ready)}
        {list(msg("In progress"), sections.active)}
        {list(msg("Needs attention"), sections.failed)}
        {list(msg("Recently completed"), sections.completed)}
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
