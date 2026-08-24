import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { importFlow } from "../lib/aiProvider/capabilities";
import { useAiProvider } from "../lib/aiProvider/useAiProvider";
import { apiErrorMessage, type EditedImportItem, type ImportApplyItem, type StateResponse } from "../lib/api";
import { automaticEnvelopePreview, formatAutomaticEnvelopeEffect } from "../lib/automaticEnvelopeUi";
import { useCurrency, useTheme } from "../lib/contexts";
import * as e2ee from "../lib/e2ee";
import { formatMoney, isLight } from "../lib/format";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { storageMode } from "../lib/idb";
import type { ImportApplyProgress } from "../lib/importJobStorage";
import { importApplyErrorMessage } from "../lib/importJobs/applyError";
import { importJobManager } from "../lib/importJobs/manager";
import type { ImportActivityItem } from "../lib/importJobs/store";
import {
  buildImportReviewRows,
  type ImportReviewRow,
  importReviewBlockingCount,
  reviewBadges,
  reviewedImportRowsForApply,
  reviewRowControlLabels,
} from "../lib/importReview";
import { preferredAccountId, setLastAccountId } from "../lib/lastAccount";
import {
  applyLocalImportRecoverably,
  PartialImportApplyError,
  planLocalImport,
  recognitionCandidatesForDryRun,
  reconcileImportJobResult,
} from "../lib/localImport";
import * as outbox from "../lib/outbox";
import { store } from "../lib/store";
import { assertOwnReplica } from "../lib/sync";
import { CORAL, font, TEAL, TRANSFER, tint } from "../lib/theme";
import { PHONE_COL } from "../lib/viewMode";
import { AddScreen } from "../screens/Add";
import { AutomaticEnvelopeEffect } from "../screens/add/AutomaticEnvelopeEffect";
import { AiConsentSheet } from "./AiConsentSheet";
import { Sheet } from "./chrome";
import { ImportProgress, runImportProgressAction, sharedDeviceImportWarning } from "./ImportProgress";

/**
 * Expense import from screenshots (Apple Wallet / bank history).
 * Step 1: pick account + screenshots → extraction via AI dispatch (lib/ai.ts:
 *         server → /import/recognize, byok → OpenAI directly; off → consent sheet).
 * Step 2: review recognized items (duplicates marked) → local optimistic operations.
 */

type Phase = "pick" | "progress" | "review" | "done";
/** Downscales an image (longer side ≤ maxSide) and converts to a JPEG data-URL. */
async function downscale(f: File, maxSide = 1600): Promise<string> {
  const bmp = await createImageBitmap(f);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function ImportSheet({
  show,
  onClose,
  state,
  onApplied,
  initialJobId,
}: {
  show: boolean;
  onClose: () => void;
  state: StateResponse;
  onApplied?: () => void;
  initialJobId?: string;
}) {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const currency = useCurrency();
  const provider = useAiProvider();
  const { data: providerStatus } = useQuery({
    queryKey: ["aiProviderStatus", provider, show],
    queryFn: () => provider.status(),
    enabled: show,
    retry: false,
  });
  const accounts = [...state.accounts].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  const envById = new Map(state.envelopes.map((e) => [e.id, e]));

  const [accountId, setAccountId] = useState(() => preferredAccountId(accounts, accounts[0]?.id ?? ""));
  const [images, setImages] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("pick");
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [job, setJob] = useState<ImportActivityItem | undefined>();
  const [items, setItems] = useState<ImportReviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneStats, setDoneStats] = useState({ added: 0, dup: 0 });
  const [partialStats, setPartialStats] = useState<ImportApplyProgress | null>(null);
  const [sourceAccountUnavailable, setSourceAccountUnavailable] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [pendingProcess, setPendingProcess] = useState(false);
  // corrections from the full-screen editor (AddScreen in draft mode), keyed by item index
  const [edited, setEdited] = useState<Record<number, EditedImportItem>>({});
  const [editedAutomaticDefaults, setEditedAutomaticDefaults] = useState<Record<number, boolean>>({});
  const [editorIdx, setEditorIdx] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const editorWasOpen = useRef(false);
  const reviewE2eeEpoch = useRef<number | null>(null);
  const openedReadyRevision = useRef<string | null>(null);
  const viewGeneration = useRef(0);

  useEffect(() => {
    if (!show || !initialJobId) return;
    setJobId(initialJobId);
    setPhase("progress");
    void importJobManager.list().then((listed) => setJob(listed.find((candidate) => candidate.id === initialJobId)));
  }, [initialJobId, show]);

  useEffect(() => {
    if (!show || !jobId) return;
    return importJobManager.observe(jobId, setJob);
  }, [jobId, show]);

  useEffect(() => {
    if (!show || !job || job.status !== "ready" || !job.result || !job.accountId) return;
    const readyRevision = `${job.id}:${job.updatedAt}`;
    if (openedReadyRevision.current === readyRevision) return;
    openedReadyRevision.current = readyRevision;
    const generation = viewGeneration.current;
    void (async () => {
      const recoveredProgress = await importJobManager.appliedProgress(
        job.id,
        job.result!.proposals.map((proposal) => proposal.rowId),
      );
      if (generation !== viewGeneration.current) return;
      const ledger = store.getLedger();
      if (!ledger) {
        setError(t("The local replica is not ready."));
        return;
      }
      const recognition = reconcileImportJobResult({ result: job.result!, ledger, accountId: job.accountId! });
      const sourceAccount = ledger.accounts.find((account) => account.id === job.accountId);
      const accountInvalid = !sourceAccount || sourceAccount.archived;
      const candidates = recognitionCandidatesForDryRun(recognition, ledger);
      const dry = accountInvalid ? { results: [] } : planLocalImport({ ledger, globalAccountId: job.accountId!, items: candidates, dryRun: true });
      const automaticEnvelopeId = ledger.accounts.find((account) => account.id === job.accountId)?.automaticEnvelopeId;
      setAccountId(job.accountId!);
      setItems(
        buildImportReviewRows({
          recognition,
          ledger,
          dryRunResults: dry.results,
          automaticEnvelopeId,
          budgetCurrency: ledger.budgets[0]?.currency ?? currency,
          appliedRowIds: recoveredProgress.appliedRowIds,
          skippedRowIds: recoveredProgress.skippedRowIds,
        }),
      );
      setEdited({});
      setEditedAutomaticDefaults({});
      setPartialStats(recoveredProgress.appliedCount > 0 || recoveredProgress.skippedCount > 0 ? recoveredProgress : null);
      setSourceAccountUnavailable(accountInvalid);
      reviewE2eeEpoch.current = job.source === "e2ee" ? job.epoch : null;
      setPhase("review");
    })().catch(() => {
      if (generation === viewGeneration.current) setError(t("The local replica is not ready."));
    });
  }, [currency, job, show, t]);

  // iOS/WebKit: the full-screen item editor is a position:fixed portal on <body>
  // (sibling of #root). After it UNMOUNTS, the review panel — itself position:fixed
  // and promoted to its own layer by the Sheet's transform (chrome.tsx) — keeps
  // getting painted, but WebKit does not rebuild its hit-test region: taps on
  // rows/checkboxes stop working until the next layer rebuild
  // (the first edit still registers, subsequent ones don't). Chromium doesn't have this flaw.
  // After every editor close we force a layer rebuild: for a single frame we
  // change #root's opacity (opacity does NOT create a containing block for fixed —
  // unlike transform/filter — so the panel doesn't shift), then revert.
  useEffect(() => {
    const closed = editorWasOpen.current && editorIdx === null;
    editorWasOpen.current = editorIdx !== null;
    if (!closed) return;
    const root = document.getElementById("root");
    if (!root) return;
    root.style.opacity = "0.9999";
    const raf = requestAnimationFrame(() => {
      root.style.opacity = "";
    });
    return () => cancelAnimationFrame(raf);
  }, [editorIdx]);

  const reset = () => {
    viewGeneration.current++;
    setImages([]);
    setPhase("pick");
    setJobId(null);
    setJob(undefined);
    setItems([]);
    setError(null);
    setBusy(false);
    setShowConsent(false);
    setEdited({});
    setEditedAutomaticDefaults({});
    setPartialStats(null);
    setSourceAccountUnavailable(false);
    setEditorIdx(null);
    reviewE2eeEpoch.current = null;
    openedReadyRevision.current = null;
  };
  const close = () => {
    const applied = phase === "done" && doneStats.added > 0;
    reset();
    onClose();
    if (applied) onApplied?.();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      const list = [...files].slice(0, Math.max(0, 6 - images.length));
      const urls = await Promise.all(list.map((f) => downscale(f)));
      setImages((prev) => [...prev, ...urls]);
    } catch {
      setError(t("Failed to load the image."));
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const doProcess = async () => {
    setBusy(true);
    setError(null);
    const generation = viewGeneration.current;
    try {
      const created = await importJobManager.create({ accountId, locale: lang, images }, (published) => {
        if (!published || generation !== viewGeneration.current) return;
        setJob(published);
        setJobId(published.id);
        setPhase("progress");
      });
      if (generation !== viewGeneration.current) return;
      setJob(created);
      setJobId(created.id);
      setPhase("progress");
    } catch (e) {
      if (generation === viewGeneration.current) setError(apiErrorMessage(e));
    } finally {
      if (generation === viewGeneration.current) setBusy(false);
    }
  };

  // Deferred by one render: the AiConsentSheet decision saves settings in the same
  // React batch — the effect already sees the fresh mode/key from context.
  useEffect(() => {
    if (!pendingProcess) return;
    setPendingProcess(false);
    void doProcess();
  }, [pendingProcess]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rules and unavailable model providers cannot read screenshots.
  const process = () => {
    if (!providerStatus || importFlow(providerStatus, e2ee.getTierMeta().tier) === "unavailable") {
      setShowConsent(true);
      return;
    }
    void doProcess();
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      if (job?.status !== "ready" || !job.result || !job.accountId) throw new Error("invalid_import_job_state");
      // The review can sit open for minutes: re-prove ownership, reconcile the raw Stage-A
      // result again, then attach only current-ledger local operations to the outbox.
      await assertOwnReplica();
      const reviewEpoch = reviewE2eeEpoch.current;
      if (reviewEpoch !== null) {
        const current = e2ee.getTierMeta();
        if (current.tier !== "e2ee" || current.epoch !== reviewEpoch) throw new Error("no_encryption_key");
        e2ee.requireValidatedDek(reviewEpoch).fill(0);
      }
      const ledger = store.getLedger();
      if (!ledger) throw new Error("no_local_replica");
      const proposalRowIds = [...new Set(job.result.proposals.map((proposal) => proposal.rowId))];
      const previouslyApplied = await importJobManager.appliedProgress(job.id, proposalRowIds);
      const recognition = reconcileImportJobResult({ result: job.result, ledger, accountId: job.accountId });
      const sourceAccount = ledger.accounts.find((account) => account.id === job.accountId);
      const accountInvalid = !sourceAccount || sourceAccount.archived;
      const candidates = recognitionCandidatesForDryRun(recognition, ledger);
      const dry = accountInvalid ? { results: [] } : planLocalImport({ ledger, globalAccountId: job.accountId, items: candidates, dryRun: true });
      const automaticEnvelopeId = ledger.accounts.find((account) => account.id === job.accountId)?.automaticEnvelopeId;
      const previousById = new Map(items.map((row) => [row.rowId, row]));
      const currentRows = buildImportReviewRows({
        recognition,
        ledger,
        dryRunResults: dry.results,
        automaticEnvelopeId,
        budgetCurrency: ledger.budgets[0]?.currency ?? currency,
        appliedRowIds: previouslyApplied.appliedRowIds,
        skippedRowIds: previouslyApplied.skippedRowIds,
      }).map((row) => ({ ...row, include: row.duplicateStatus === "exists" ? false : (previousById.get(row.rowId)?.include ?? row.include) }));
      const currentEdited = { ...edited };
      let invalidatedEdit = false;
      const activeAccountIds = new Set(ledger.accounts.filter((account) => !account.archived).map((account) => account.id));
      const activeEnvelopeIds = new Set(ledger.envelopes.filter((envelope) => !envelope.archived).map((envelope) => envelope.id));
      const activeCategoryIds = new Set(ledger.categories.filter((category) => !category.archived).map((category) => category.id));
      currentRows.forEach((row, index) => {
        const edit = currentEdited[index];
        if (!edit) return;
        const accountUnavailable = !activeAccountIds.has(edit.accountId);
        const transferAccountUnavailable = edit.toAccountId !== null && !activeAccountIds.has(edit.toAccountId);
        const envelopeUnavailable = edit.envelopeId !== null && !activeEnvelopeIds.has(edit.envelopeId);
        const categoryUnavailable = edit.categoryId !== null && !activeCategoryIds.has(edit.categoryId);
        if (accountUnavailable || transferAccountUnavailable || envelopeUnavailable || categoryUnavailable) {
          delete currentEdited[index];
          invalidatedEdit = true;
          currentRows[index] = {
            ...row,
            requiresReview: true,
            blockingIssues: [...new Set([...row.blockingIssues, "assignment_unavailable" as const])],
            item: row.item
              ? {
                  ...row.item,
                  toAccountId: transferAccountUnavailable ? null : row.item.toAccountId,
                  envelopeId: envelopeUnavailable ? null : row.item.envelopeId,
                  categoryId: categoryUnavailable ? null : row.item.categoryId,
                }
              : null,
          };
        }
      });
      if (invalidatedEdit) setEdited(currentEdited);
      setItems(currentRows);
      setSourceAccountUnavailable(accountInvalid);
      if (accountInvalid || importReviewBlockingCount(currentRows, currentEdited) > 0) return;
      const chosen: ImportApplyItem[] = reviewedImportRowsForApply({ rows: currentRows, edited: currentEdited, editedAutomaticDefaults });
      const chosenRowIds = new Set(chosen.flatMap((item) => (item.importRowId ? [item.importRowId] : [])));
      await importJobManager.recordSkipped(
        job.id,
        proposalRowIds.filter((rowId) => !chosenRowIds.has(rowId) && !previouslyApplied.appliedRowIds.includes(rowId)),
      );
      const plan = planLocalImport({ ledger, globalAccountId: job.accountId, items: chosen, dryRun: false });
      await applyLocalImportRecoverably(plan, undefined, {
        apply: (rowId, mutation) =>
          importJobManager.applyRow(job.id, rowId, async (transactionId, assertCurrent) => {
            await assertCurrent();
            mutation(transactionId);
            await outbox.flushed();
            if (!outbox.isDurable()) throw new Error("local_persistence_failed");
          }),
      });
      const completedProgress = await importJobManager.appliedProgress(job.id, proposalRowIds);
      const accountedRowIds = new Set([...completedProgress.appliedRowIds, ...completedProgress.skippedRowIds]);
      if (proposalRowIds.some((rowId) => !accountedRowIds.has(rowId))) throw new Error("import_apply_incomplete");
      const appliedCount = Math.max(job.appliedCount, proposalRowIds.filter((rowId) => completedProgress.appliedRowIds.includes(rowId)).length);
      const skippedCount = Math.max(job.skippedCount, job.proposalCount - appliedCount);
      try {
        await importJobManager.complete(job.id, { appliedCount, skippedCount });
      } catch (completionError) {
        throw new PartialImportApplyError(completionError, {
          appliedRowIds: completedProgress.appliedRowIds,
          appliedCount: completedProgress.appliedCount,
          skippedCount: completedProgress.skippedCount,
        });
      }
      setLastAccountId(job.accountId); // per-device preference (same as on the Add screen)
      setDoneStats({ added: appliedCount, dup: skippedCount });
      setPhase("done");
    } catch (e) {
      if (e instanceof PartialImportApplyError) {
        const recoveredProgress = job
          ? await importJobManager.appliedProgress(job.id, job.result?.proposals.map((proposal) => proposal.rowId) ?? [])
          : { appliedRowIds: [], appliedCount: 0, skippedRowIds: [], skippedCount: 0 };
        setPartialStats(recoveredProgress.appliedCount > 0 || recoveredProgress.skippedCount > 0 ? recoveredProgress : null);
        const ledger = store.getLedger();
        if (ledger && job?.result && job.accountId) {
          const recognition = reconcileImportJobResult({ result: job.result, ledger, accountId: job.accountId });
          const sourceAccount = ledger.accounts.find((account) => account.id === job.accountId);
          const accountInvalid = !sourceAccount || sourceAccount.archived;
          const dry = accountInvalid
            ? { results: [] }
            : planLocalImport({
                ledger,
                globalAccountId: job.accountId,
                items: recognitionCandidatesForDryRun(recognition, ledger),
                dryRun: true,
              });
          const automaticEnvelopeId = ledger.accounts.find((account) => account.id === job.accountId)?.automaticEnvelopeId;
          const previousById = new Map(items.map((row) => [row.rowId, row]));
          setItems(
            buildImportReviewRows({
              recognition,
              ledger,
              dryRunResults: dry.results,
              automaticEnvelopeId,
              budgetCurrency: ledger.budgets[0]?.currency ?? currency,
              appliedRowIds: recoveredProgress.appliedRowIds,
              skippedRowIds: recoveredProgress.skippedRowIds,
            }).map((row) => ({ ...row, include: row.duplicateStatus === "exists" ? false : (previousById.get(row.rowId)?.include ?? row.include) })),
          );
          setSourceAccountUnavailable(accountInvalid);
        }
      }
      setError(e instanceof PartialImportApplyError ? t("Adding was interrupted. Review the remaining rows and try again.") : importApplyErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (idx: number) =>
    setItems((prev) => prev.map((row, i) => (i === idx && row.duplicateStatus !== "exists" ? { ...row, include: !row.include } : row)));

  const selectedCount = items.filter((row, i) => row.item && row.include && (row.item.status !== "exists" || !!edited[i])).length;
  const blockingCount = importReviewBlockingCount(items, edited);
  const deviceWarning = sharedDeviceImportWarning(e2ee.getTierMeta().tier, storageMode());
  const label = { fontSize: 10.5, color: C.mute, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.6, marginBottom: 6 };

  return (
    <>
      <Sheet show={show} onClose={close}>
        {phase === "pick" && (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 4 }}>{t("Import from screenshots")}</div>
            <div style={{ fontSize: 12, color: C.mute, textAlign: "center", marginBottom: 16 }}>
              {t("Apple Wallet or bank history — AI will recognize the transactions, duplicates will be skipped")}
            </div>

            <div style={label}>{t("Account")}</div>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${C.line}`,
                background: C.bg,
                color: C.text,
                fontSize: 14,
                fontFamily: font,
                marginBottom: 14,
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>

            <div style={label}>{t("Screenshots ({n}/6)", { n: images.length })}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
              {images.map((url, i) => (
                <div key={i} style={{ position: "relative" }}>
                  <img
                    src={url}
                    alt={t("Screenshot {n}", { n: i + 1 })}
                    style={{ width: "100%", height: 96, objectFit: "cover", borderRadius: 10, display: "block" }}
                  />
                  <button
                    onClick={() => setImages(images.filter((_, x) => x !== i))}
                    aria-label={t("Remove screenshot {n}", { n: i + 1 })}
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      border: "none",
                      background: CORAL,
                      color: "#fff",
                      fontSize: 12,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {images.length < 6 && (
                <button
                  onClick={() => fileRef.current?.click()}
                  style={{
                    height: 96,
                    borderRadius: 10,
                    border: `1.5px dashed ${C.line}`,
                    background: C.bg,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    color: C.soft,
                  }}
                >
                  <Ico
                    d="M4 8.5A1.5 1.5 0 015.5 7H8l1.6-2.4a1 1 0 01.9-.6h3a1 1 0 01.9.6L16 7h2.5A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-9zM12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7z"
                    size={22}
                    color={C.soft}
                    sw={1.5}
                  />
                  <span style={{ fontSize: 11, fontWeight: 600 }}>{t("Add screenshots")}</span>
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple onChange={(e) => addFiles(e.target.files)} style={{ display: "none" }} />

            {error && <div style={{ fontSize: 12.5, color: CORAL, marginBottom: 10 }}>{error}</div>}
            {deviceWarning && (
              <div role="note" style={{ fontSize: 12, lineHeight: 1.4, color: C.warn, marginBottom: 10 }}>
                {t(deviceWarning)}
              </div>
            )}

            <button
              onClick={process}
              disabled={images.length === 0 || busy}
              style={{
                width: "100%",
                padding: "13px 0",
                borderRadius: 12,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                opacity: images.length === 0 || busy ? 0.5 : 1,
              }}
            >
              {busy ? t("Recognizing…") : t("Process screenshots")}
            </button>
          </>
        )}

        {phase === "progress" &&
          (job ? (
            job.status === "failed" && job.phase !== "retry_scheduled" ? (
              <div style={{ textAlign: "center", padding: "12px 0" }}>
                <div role="alert" style={{ color: CORAL, fontSize: 13, lineHeight: 1.45 }}>
                  {t("The import needs attention. Retry it here or continue from Activity.")}
                </div>
                <button
                  type="button"
                  onClick={() => void importJobManager.retry(job.id)}
                  style={{ width: "100%", marginTop: 14, padding: "12px", borderRadius: 12, border: "none", background: TEAL, color: "#fff", fontWeight: 700 }}
                >
                  {t("Retry import")}
                </button>
                <button type="button" onClick={close} style={{ width: "100%", marginTop: 8, padding: 8, border: "none", background: "none", color: C.mute }}>
                  {t("Continue in Activity")}
                </button>
              </div>
            ) : (
              <ImportProgress
                item={job}
                onBackground={() => void runImportProgressAction("background", { jobId: job.id, close, cancel: (id) => importJobManager.cancel(id) })}
                onCancel={() => void runImportProgressAction("cancel", { jobId: job.id, close, cancel: (id) => importJobManager.cancel(id) })}
              />
            )
          ) : (
            <div role="status" style={{ textAlign: "center", color: C.mute, padding: "28px 0" }}>
              {t("Creating import…")}
            </div>
          ))}

        {phase === "review" && (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 4 }}>{t("Review recognized rows")}</div>
            <div style={{ fontSize: 12, color: C.mute, textAlign: "center", marginBottom: 12 }}>
              {t("Every recognized row stays visible. Only checked transaction candidates will be added.")}
            </div>

            {items.map((row, idx) => {
              const it = row.item;
              // Candidate rows show post-edit values; evidence-only rows stay faithful to extraction.
              const e = it ? (edited[idx] as EditedImportItem | undefined) : undefined;
              const type = e?.type ?? it?.type ?? null;
              const amount = e?.amount ?? it?.amount ?? row.amount;
              const name = it ? (e ? e.name : it.name) || it.tag || row.rawTextLines[0] : row.rawTextLines[0] || t("Unrecognized row");
              const envId = e ? e.envelopeId : it?.envelopeId;
              const env = envId ? envById.get(envId) : null;
              const catName = e ? (e.categoryId ? (state.categories.find((c) => c.id === e.categoryId)?.name ?? null) : null) : (it?.categoryName ?? null);
              const refund = e?.isRefund ?? it?.isRefund ?? false;
              const exists = row.duplicateStatus === "exists";
              const itemAccountId = e?.accountId ?? accountId;
              const itemToAccountId = e?.toAccountId ?? it?.toAccountId ?? null;
              const automaticPreview =
                it && type && amount !== null
                  ? automaticEnvelopePreview(state, { type, accountId: itemAccountId, toAccountId: itemToAccountId }, amount)
                  : null;
              const automaticEffect =
                automaticPreview &&
                (type === "income" || type === "transfer") &&
                amount !== null &&
                amount > 0 &&
                (automaticPreview.rows.length > 0 || automaticPreview.neutral)
                  ? formatAutomaticEnvelopeEffect(automaticPreview, (value) => formatMoney(value, currency, lang), {
                      heading: t("Automatic envelope effect"),
                      readyToAssign: t("Ready to assign"),
                      noEnvelopeChange: t("No envelope change"),
                      noChange: t("No change"),
                    })
                  : null;
              const fxMismatch = !!row.currency && row.currency !== currency;
              const badges = reviewBadges(row);
              const controlLabels = reviewRowControlLabels(row, idx);
              const ContentTag: "button" | "div" = it ? "button" : "div";
              const contentControlProps = it
                ? { type: "button" as const, onClick: () => setEditorIdx(idx), "aria-label": t(controlLabels.edit!.message, controlLabels.edit!.values) }
                : {};
              return (
                <div key={row.rowId} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 2px", opacity: exists ? 0.55 : 1 }}>
                  {controlLabels.select ? (
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={() => toggle(idx)}
                      aria-label={t(controlLabels.select.message, controlLabels.select.values)}
                      style={{ width: 22, height: 22, flexShrink: 0, marginTop: 3, cursor: "pointer", accentColor: TEAL }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        flexShrink: 0,
                        margin: "3px 2px 0",
                        border: `2px solid ${C.line}`,
                        opacity: 0.45,
                      }}
                    />
                  )}
                  <ContentTag
                    {...contentControlProps}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      width: "100%",
                      padding: 0,
                      border: "none",
                      background: "none",
                      color: "inherit",
                      font: "inherit",
                      textAlign: "left",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      cursor: it ? "pointer" : "default",
                    }}
                  >
                    <span
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        flexShrink: 0,
                        background: env?.color ?? C.inset,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Glyph name={env?.icon ?? "tag"} size={15} color={env ? (isLight(env.color) ? "#33312c" : "#fff") : C.mute} sw={1.6} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: C.text, display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                        {e && (
                          <span aria-label={t("edited")} title={t("edited")} style={{ color: TEAL, fontWeight: 700, flexShrink: 0 }}>
                            ✎{" "}
                          </span>
                        )}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{name}</span>
                        {fxMismatch && row.currency && (
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 9.5,
                              fontWeight: 700,
                              letterSpacing: 0.4,
                              padding: "2px 7px",
                              borderRadius: 8,
                              background: tint(C.warn, 0.15),
                              color: C.warn,
                            }}
                          >
                            {row.currency}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10.5, color: C.mute, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {(e?.date ?? it?.date ?? row.date) || t("Date unknown")}
                        {it ? ` · ${(e ? e.placeName : it.placeName) ?? it.tag}` : ""}
                        {env ? ` · ${env.name}` : ""}
                        {catName ? ` · ${catName}` : ""}
                      </div>
                      <div style={{ fontSize: 10, color: C.mute, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.sourceRef.replace(/\n/g, " · ")}
                      </div>
                      {badges.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                          {badges.map((badge) => (
                            <span
                              key={badge.label}
                              style={{
                                fontSize: 9.5,
                                fontWeight: 650,
                                padding: "2px 6px",
                                borderRadius: 8,
                                background: badge.tone === "positive" ? tint(C.pos, 0.14) : badge.tone === "warning" ? tint(C.warn, 0.15) : C.inset,
                                color: badge.tone === "positive" ? C.pos : badge.tone === "warning" ? C.warn : C.soft,
                              }}
                            >
                              {t(badge.label)}
                            </span>
                          ))}
                        </div>
                      )}
                      {fxMismatch && (
                        <div style={{ fontSize: 10, color: C.warn, marginTop: 1 }}>
                          {t("Recorded in {currency} — check the amount.", { currency: row.currency! })}
                        </div>
                      )}
                      {automaticEffect && <AutomaticEnvelopeEffect data={automaticEffect} compact />}
                    </div>
                    {amount !== null && type && (
                      <span
                        style={{
                          fontSize: 13.5,
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                          color: type === "transfer" ? TRANSFER : type === "income" || refund ? C.pos : C.text,
                          flexShrink: 0,
                        }}
                      >
                        {type === "transfer" ? "↔ " : type === "income" || refund ? "+" : "-"}
                        {formatMoney(amount, currency, lang)}
                      </span>
                    )}
                  </ContentTag>
                </div>
              );
            })}

            {error && <div style={{ fontSize: 12.5, color: CORAL, margin: "10px 0" }}>{error}</div>}

            {partialStats && (partialStats.appliedCount > 0 || partialStats.skippedCount > 0) && (
              <div role="status" style={{ fontSize: 12.5, color: C.warn, margin: "10px 0" }}>
                {t("Added: {added} · Skipped: {skipped}", { added: partialStats.appliedCount, skipped: partialStats.skippedCount })}
                {partialStats.appliedCount > 0 && (
                  <>
                    <br />
                    {t("Some rows were already added before the interruption. They now appear as existing and will not be added twice.")}
                  </>
                )}
              </div>
            )}

            {sourceAccountUnavailable && (
              <div role="alert" style={{ fontSize: 12.5, color: CORAL, margin: "10px 0" }}>
                {t("The source account was deleted or archived. This import cannot be applied.")}
              </div>
            )}

            {blockingCount > 0 && (
              <div role="alert" style={{ fontSize: 12.5, color: C.warn, margin: "10px 0" }}>
                {tp("Review or uncheck {n} transaction before adding. | Review or uncheck {n} transactions before adding.", blockingCount)}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                onClick={close}
                style={{
                  flex: 1,
                  padding: "12px 0",
                  borderRadius: 12,
                  border: `1px solid ${C.line}`,
                  background: C.bg,
                  color: C.soft,
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("Review later")}
              </button>
              <button
                onClick={apply}
                disabled={busy || blockingCount > 0 || sourceAccountUnavailable}
                style={{
                  flex: 2,
                  padding: "12px 0",
                  borderRadius: 12,
                  border: "none",
                  background: TEAL,
                  color: "#fff",
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: busy || blockingCount > 0 || sourceAccountUnavailable ? 0.5 : 1,
                }}
              >
                {busy ? t("Adding…") : selectedCount === 0 ? t("Complete without adding") : tp("Add {n} transaction | Add {n} transactions", selectedCount)}
              </button>
            </div>
          </>
        )}

        {phase === "done" && (
          <div style={{ textAlign: "center", padding: "10px 0 4px" }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: TEAL,
                margin: "0 auto 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ico d="M5 13l4 4L19 7" size={26} color="#fff" sw={2.6} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 4 }}>
              {tp("Added {n} transaction | Added {n} transactions", doneStats.added)}
            </div>
            {doneStats.dup > 0 && <div style={{ fontSize: 12.5, color: C.soft, marginBottom: 4 }}>{t("Duplicates skipped: {n}", { n: doneStats.dup })}</div>}
            <button
              onClick={close}
              style={{
                marginTop: 14,
                width: "100%",
                padding: "13px 0",
                borderRadius: 12,
                border: "none",
                background: TEAL,
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("Close")}
            </button>
          </div>
        )}
      </Sheet>
      {/* Full-screen item editor = AddScreen in draft mode. Portal to body
        (IconColorPicker pattern) — the Sheet has a transform, position:fixed inside it breaks. */}
      {show &&
        editorIdx !== null &&
        items[editorIdx]?.item &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 200,
              background: C.bg,
              maxWidth: PHONE_COL,
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              paddingTop: "env(safe-area-inset-top)",
              fontFamily: font,
            }}
          >
            <AddScreen
              state={state}
              editTxn={null}
              onDone={() => setEditorIdx(null)}
              draft={{
                item: items[editorIdx].item,
                accountId,
                initial: edited[editorIdx],
                automaticEnvelopeDefault: edited[editorIdx] ? (editedAutomaticDefaults[editorIdx] ?? false) : items[editorIdx].item.automaticEnvelopeDefault,
                onSave: (e, meta) => {
                  setEdited((prev) => ({ ...prev, [editorIdx]: e }));
                  setEditedAutomaticDefaults((prev) => ({ ...prev, [editorIdx]: meta.automaticEnvelopeDefault }));
                  setEditorIdx(null);
                },
                onCancel: () => setEditorIdx(null),
              }}
            />
          </div>,
          document.body,
        )}
      {/* Sibling of the Sheet (not a child) — the panel's transform would break position:fixed. */}
      <AiConsentSheet
        show={showConsent}
        feature="import"
        onClose={() => setShowConsent(false)}
        onDecided={(mode) => {
          // "Cancel" (rules) = abort the import — rules can't read screenshots;
          // server/byok saved settings — extraction will start with the fresh mode.
          setShowConsent(false);
          if (mode !== "rules") setPendingProcess(true);
        }}
      />
    </>
  );
}
