import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { runImportExtract } from "../lib/ai";
import { importFlow } from "../lib/aiProvider/capabilities";
import { useAiProvider } from "../lib/aiProvider/useAiProvider";
import { api, apiErrorMessage, type EditedImportItem, type ImportApplyItem, type ImportApplyResponse, type StateResponse } from "../lib/api";
import { automaticEnvelopePreview, formatAutomaticEnvelopeEffect } from "../lib/automaticEnvelopeUi";
import { useCurrency, useTheme } from "../lib/contexts";
import * as e2ee from "../lib/e2ee";
import { formatMoney, isLight } from "../lib/format";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { buildImportReviewRows, type ImportReviewRow, reviewBadges, reviewedImportRowsForApply } from "../lib/importReview";
import { preferredAccountId, setLastAccountId } from "../lib/lastAccount";
import { applyLocalImport, planLocalImport, recognitionCandidatesForDryRun } from "../lib/localImport";
import { store } from "../lib/store";
import { assertOwnReplica } from "../lib/sync";
import { CORAL, font, TEAL, TRANSFER, tint } from "../lib/theme";
import { PHONE_COL } from "../lib/viewMode";
import { AddScreen } from "../screens/Add";
import { AutomaticEnvelopeEffect } from "../screens/add/AutomaticEnvelopeEffect";
import { AiConsentSheet } from "./AiConsentSheet";
import { Sheet } from "./chrome";

/**
 * Expense import from screenshots (Apple Wallet / bank history).
 * Step 1: pick account + screenshots → extraction via AI dispatch (lib/ai.ts:
 *         server → /import/extract, byok → OpenAI directly; off → consent sheet).
 * Step 2: review recognized items (duplicates marked) → local optimistic operations.
 */

type Phase = "pick" | "review" | "done";
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

const errMsg = apiErrorMessage;

export function ImportSheet({ show, onClose, state, onApplied }: { show: boolean; onClose: () => void; state: StateResponse; onApplied?: () => void }) {
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
  const [items, setItems] = useState<ImportReviewRow[]>([]);
  const [, setRecognition] = useState<Awaited<ReturnType<typeof runImportExtract>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneStats, setDoneStats] = useState({ added: 0, dup: 0 });
  const [showConsent, setShowConsent] = useState(false);
  const [pendingProcess, setPendingProcess] = useState(false);
  // corrections from the full-screen editor (AddScreen in draft mode), keyed by item index
  const [edited, setEdited] = useState<Record<number, EditedImportItem>>({});
  const [editedAutomaticDefaults, setEditedAutomaticDefaults] = useState<Record<number, boolean>>({});
  const [editorIdx, setEditorIdx] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const editorWasOpen = useRef(false);
  const reviewE2eeEpoch = useRef<number | null>(null);

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
    setImages([]);
    setPhase("pick");
    setItems([]);
    setRecognition(null);
    setError(null);
    setBusy(false);
    setShowConsent(false);
    setEdited({});
    setEditedAutomaticDefaults({});
    setEditorIdx(null);
    reviewE2eeEpoch.current = null;
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
    try {
      const ledger = store.getLedger();
      if (!ledger) {
        setError(t("The local replica is not ready."));
        return;
      }
      const tierAtStart = e2ee.getTierMeta();
      if (tierAtStart.tier === "e2ee") await assertOwnReplica();
      // Plain extraction may use Enveo; E2EE Own OpenAI sends images directly to OpenAI.
      const recognition = await runImportExtract({ images, locale: lang, ledger, accountId, provider });
      setRecognition(recognition);
      if (recognition.rows.length === 0) {
        setError(t("No transactions were recognized in the screenshots."));
        return;
      }
      const extracted: ImportApplyItem[] = recognitionCandidatesForDryRun(recognition, ledger);
      let dry: Pick<ImportApplyResponse, "results">;
      if (extracted.length === 0) {
        dry = { results: [] };
      } else if (tierAtStart.tier === "e2ee") {
        const current = e2ee.getTierMeta();
        if (current.tier !== "e2ee" || current.epoch !== tierAtStart.epoch) throw new Error("no_encryption_key");
        e2ee.requireValidatedDek(current.epoch).fill(0);
        dry = planLocalImport({ ledger, globalAccountId: accountId, items: extracted, dryRun: true });
        reviewE2eeEpoch.current = current.epoch;
      } else {
        // The API verdict feeds the user's decision, so name the verified replica budget.
        await assertOwnReplica();
        dry = await api.importApply({ accountId, budgetId: store.getBudgetId() || undefined, items: extracted, dryRun: true });
        reviewE2eeEpoch.current = null;
      }
      const automaticEnvelopeId = accounts.find((account) => account.id === accountId)?.automaticEnvelopeId;
      setItems(buildImportReviewRows({ recognition, ledger, dryRunResults: dry.results, automaticEnvelopeId, budgetCurrency: currency }));
      setEdited({}); // fresh review = no corrections (edited is keyed by index)
      setEditedAutomaticDefaults({});
      setPhase("review");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
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
      // merge editor corrections: fields from edited[i] override the original (including
      // per-item account); rawPlace ALWAYS from the original — source_ref feeds self-learning
      const chosen: ImportApplyItem[] = reviewedImportRowsForApply({ rows: items, edited, editedAutomaticDefaults });
      // The review can sit open for minutes: re-prove ownership before attaching local ops
      // that the sync engine will later write for this replica.
      let res = { added: 0, skipped: 0 };
      if (chosen.length > 0) {
        await assertOwnReplica();
        const reviewEpoch = reviewE2eeEpoch.current;
        if (reviewEpoch !== null) {
          const current = e2ee.getTierMeta();
          if (current.tier !== "e2ee" || current.epoch !== reviewEpoch) throw new Error("no_encryption_key");
          e2ee.requireValidatedDek(reviewEpoch).fill(0);
        }
        const ledger = store.getLedger();
        if (!ledger) throw new Error("no_local_replica");
        res = applyLocalImport(planLocalImport({ ledger, globalAccountId: accountId, items: chosen, dryRun: false }));
      }
      setLastAccountId(accountId); // per-device preference (same as on the Add screen)
      setDoneStats({ added: res.added, dup: items.filter((row) => row.item?.status === "exists").length + res.skipped });
      setPhase("done");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (idx: number) =>
    setItems((prev) =>
      prev.map((row, i) => (i === idx && row.item && (row.item.status !== "exists" || !!edited[idx]) ? { ...row, include: !row.include } : row)),
    );

  const selectedCount = items.filter((row, i) => row.item && row.include && (row.item.status !== "exists" || !!edited[i])).length;
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
              const exists = it?.status === "exists" && !e;
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
              return (
                <div key={row.rowId} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 2px", opacity: exists ? 0.55 : 1 }}>
                  <span
                    onClick={it ? () => toggle(idx) : undefined}
                    role="checkbox"
                    aria-checked={row.include}
                    aria-disabled={!it || (exists && !e)}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      flexShrink: 0,
                      marginTop: 3,
                      cursor: !it || exists ? "default" : "pointer",
                      border: `2px solid ${row.include ? TEAL : C.line}`,
                      background: row.include ? TEAL : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: it ? 1 : 0.45,
                    }}
                  >
                    {row.include && <Ico d="M5 13l4 4L19 7" size={12} color="#fff" sw={3} />}
                  </span>
                  <div
                    onClick={it ? () => setEditorIdx(idx) : undefined}
                    role={it ? "button" : undefined}
                    aria-label={it ? t("Edit item {n}", { n: idx + 1 }) : undefined}
                    style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "flex-start", gap: 10, cursor: it ? "pointer" : "default" }}
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
                  </div>
                </div>
              );
            })}

            {error && <div style={{ fontSize: 12.5, color: CORAL, margin: "10px 0" }}>{error}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                onClick={() => {
                  setPhase("pick");
                  setItems([]);
                  setEdited({});
                  setEditedAutomaticDefaults({});
                }}
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
                {t("Back")}
              </button>
              <button
                onClick={apply}
                disabled={busy || selectedCount === 0}
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
                  opacity: busy || selectedCount === 0 ? 0.5 : 1,
                }}
              >
                {busy ? t("Adding…") : tp("Add {n} transaction | Add {n} transactions", selectedCount)}
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
