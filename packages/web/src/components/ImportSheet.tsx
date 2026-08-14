import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { runImportExtract } from "../lib/ai";
import { useAiProvider } from "../lib/aiProvider/useAiProvider";
import { api, apiErrorMessage, type EditedImportItem, type ImportApplyItem, type ImportItem, type StateResponse } from "../lib/api";
import { useCurrency, useSettings, useTheme } from "../lib/contexts";
import * as e2ee from "../lib/e2ee";
import { formatMoney, isLight } from "../lib/format";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { preferredAccountId, setLastAccountId } from "../lib/lastAccount";
import { store } from "../lib/store";
import { assertOwnReplica, pullNow } from "../lib/sync";
import { CORAL, font, TEAL, TRANSFER, tint } from "../lib/theme";
import { AddScreen } from "../screens/Add";
import { AiConsentSheet } from "./AiConsentSheet";
import { Sheet } from "./chrome";

/**
 * Expense import from screenshots (Apple Wallet / bank history).
 * Step 1: pick account + screenshots → extraction via AI dispatch (lib/ai.ts:
 *         server → /import/extract, byok → OpenAI directly; off → consent sheet).
 * Step 2: review recognized items (duplicates marked) → /import/apply.
 */

type Phase = "pick" | "review" | "done";
type ReviewItem = ImportItem & { status: "added" | "exists" | "probable"; include: boolean };

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
  const { settings } = useSettings();
  const provider = useAiProvider();
  const accounts = [...state.accounts].filter((a) => !a.archived).sort((a, b) => a.sort - b.sort);
  const envById = new Map(state.envelopes.map((e) => [e.id, e]));

  const [accountId, setAccountId] = useState(() => preferredAccountId(accounts, accounts[0]?.id ?? ""));
  const [images, setImages] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("pick");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneStats, setDoneStats] = useState({ added: 0, dup: 0 });
  const [showConsent, setShowConsent] = useState(false);
  const [pendingProcess, setPendingProcess] = useState(false);
  // corrections from the full-screen editor (AddScreen in draft mode), keyed by item index
  const [edited, setEdited] = useState<Record<number, EditedImportItem>>({});
  const [editorIdx, setEditorIdx] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const editorWasOpen = useRef(false);

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
    setError(null);
    setBusy(false);
    setShowConsent(false);
    setEdited({});
    setEditorIdx(null);
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
      // extraction via AI dispatch (server → /api, byok → OpenAI directly);
      // apply/dry-run ALWAYS through the API (writing to the ledger is the server's domain)
      const extracted = await runImportExtract({ images, locale: lang, ledger, provider });
      if (extracted.length === 0) {
        setError(t("No transactions were recognized in the screenshots."));
        return;
      }
      // dry run marks duplicates (certain: date+amount+source_ref; probable: date+amount) without
      // writing — but its verdicts feed the user's decision, so it must run against the replica's
      // budget too: verify ownership and name the budget (per-request tenant assertion).
      await assertOwnReplica(); // foreign/unverified replica — no server call at all
      const dry = await api.importApply({ accountId, budgetId: store.getBudgetId() || undefined, items: extracted, dryRun: true });
      // fx rows (currency differs from the budget's) default to UNCHECKED — the user must
      // consciously confirm the amount before it's included (the amber chip explains why).
      setItems(dry.results.map((r) => ({ ...r, include: r.status === "added" && !(!!r.currency && r.currency !== currency) })));
      setEdited({}); // fresh review = no corrections (edited is keyed by index)
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

  // Rules can't read screenshots — in off mode the import requires AI consent.
  const process = () => {
    if (settings.aiMode === "off") {
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
      const chosen: ImportApplyItem[] = items
        .map((it, i) => ({ it, e: edited[i] }))
        .filter(({ it, e }) => it.include && (it.status !== "exists" || !!e)) // edited duplicate = deliberate add
        .map(({ it, e }) =>
          !e
            ? it
            : {
                ...it,
                type: e.type,
                accountId: e.accountId,
                toAccountId: e.toAccountId,
                isRefund: e.isRefund,
                amount: e.amount,
                date: e.date,
                name: e.name,
                envelopeId: e.envelopeId,
                categoryId: e.categoryId,
                placeName: e.placeName,
                note: e.note,
                force: it.status === "exists", // skip dedupe — the user edited the duplicate deliberately
                rawPlace: it.rawPlace, // UNTOUCHED on edit
              },
        );
      // The review can sit open for minutes and the session cookie is shared by every tab —
      // re-verify ownership and NAME the budget the items' FKs belong to: the server refuses
      // a mismatch before anything is written (409 budget_mismatch).
      let res = { added: 0, skipped: 0 };
      if (chosen.length > 0) {
        await assertOwnReplica(); // foreign/unverified replica — no server write
        res = await api.importApply({ accountId, budgetId: store.getBudgetId() || undefined, items: chosen });
      }
      setLastAccountId(accountId); // per-device preference (same as on the Add screen)
      void pullNow(); // pull the imported entries down into the local replica
      setDoneStats({ added: res.added, dup: items.filter((i) => i.status === "exists").length + res.skipped });
      setPhase("done");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (idx: number) =>
    setItems((prev) => prev.map((it, i) => (i === idx && (it.status !== "exists" || !!edited[idx]) ? { ...it, include: !it.include } : it)));

  const selectedCount = items.filter((it, i) => it.include && (it.status !== "exists" || !!edited[i])).length;
  const label = { fontSize: 10.5, color: C.mute, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: 0.6, marginBottom: 6 };

  // E2EE gating: extraction/write go through the server (plain-tier routes) — in the
  // e2ee tier the server can't see the ledger, so screenshot import is unavailable.
  // Early return ONLY after all hooks (rules of hooks across a tier flip).
  if (e2ee.getTierMeta().tier === "e2ee") {
    return (
      <Sheet show={show} onClose={close}>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 10 }}>{t("Import from screenshots")}</div>
        <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.6, textAlign: "center", marginBottom: 8 }}>
          {t(
            "Server-side import is unavailable while end-to-end encryption is on — the server cannot see your data. Use a JSON backup (export/import) or disable encryption.",
          )}
        </div>
      </Sheet>
    );
  }

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
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 4 }}>{t("Recognized transactions")}</div>
            <div style={{ fontSize: 12, color: C.mute, textAlign: "center", marginBottom: 12 }}>
              {t("Untick what you don't want. Duplicates are skipped — tap one to edit and add it anyway.")}
            </div>

            {items.map((it, idx) => {
              // the row shows post-edit values (edited[idx]), the original when there are no corrections
              const e = edited[idx] as EditedImportItem | undefined;
              const type = e?.type ?? it.type;
              const amount = e?.amount ?? it.amount;
              const name = (e ? e.name : it.name) || it.tag;
              const envId = e ? e.envelopeId : it.envelopeId;
              const env = envId ? envById.get(envId) : null;
              const catName = e ? (e.categoryId ? (state.categories.find((c) => c.id === e.categoryId)?.name ?? null) : null) : (it.categoryName ?? null);
              const refund = e?.isRefund ?? it.isRefund ?? false;
              const exists = it.status === "exists" && !e; // an edited duplicate is treated as a new item
              // FX row: the extracted amount is in a currency other than the budget's — nothing was
              // converted (we never guess a rate), so the user must eyeball it. fxOriginal (when
              // present) is the original foreign charge that WAS converted/settled server-side.
              const fxMismatch = !!it.currency && it.currency !== currency;
              return (
                <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", opacity: exists ? 0.45 : 1 }}>
                  <span
                    onClick={() => toggle(idx)}
                    role="checkbox"
                    aria-checked={it.include}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      flexShrink: 0,
                      cursor: exists ? "default" : "pointer",
                      border: `2px solid ${it.include ? TEAL : C.line}`,
                      background: it.include ? TEAL : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {it.include && <Ico d="M5 13l4 4L19 7" size={12} color="#fff" sw={3} />}
                  </span>
                  {/* tap on content (outside the checkbox) → full-screen item editor */}
                  <div
                    onClick={() => setEditorIdx(idx)} /* duplicates are editable too — once saved they count as new (force) */
                    role="button"
                    aria-label={t("Edit item {n}", { n: idx + 1 })}
                    style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
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
                        {fxMismatch && (
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
                            {it.currency}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10.5, color: C.mute, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e?.date ?? it.date} · {(e ? e.placeName : it.placeName) ?? it.tag}
                        {env ? ` · ${env.name}` : ""}
                        {catName ? ` · ${catName}` : ""}
                        {refund ? ` · ${t("refund")}` : ""}
                        {exists ? ` · ${t("already exists")}` : ""}
                        {it.status === "probable" && <span style={{ color: C.warn, fontWeight: 600 }}> · {t("probable duplicate")}</span>}
                      </div>
                      {it.fxOriginal && <div style={{ fontSize: 10, color: C.mute, marginTop: 1 }}>{it.fxOriginal}</div>}
                      {fxMismatch && (
                        <div style={{ fontSize: 10, color: C.warn, marginTop: 1 }}>
                          {t("Recorded in {currency} — check the amount.", { currency: it.currency! })}
                        </div>
                      )}
                    </div>
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
        items[editorIdx] &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 200,
              background: C.bg,
              maxWidth: 420,
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
                item: items[editorIdx],
                accountId,
                initial: edited[editorIdx],
                onSave: (e) => {
                  setEdited((prev) => ({ ...prev, [editorIdx]: e }));
                  setItems((prev) => prev.map((x, k) => (k === editorIdx ? { ...x, include: true } : x)));
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
