import { useEffect, useState } from "react";
import { api, apiErrorMessage, useSyncStatus } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { isInMemoryMode } from "../../lib/idb";
import { getStorageDiag, type StorageDiag } from "../../lib/storage";
import { disableLocal, enablePaused, enableWiped, getLastBootSource, wipeLocalData } from "../../lib/sync";
import { CORAL, INCOME, font } from "../../lib/theme";
import { Sheet } from "../../components/chrome";
import { ActionGroup, ActionIcon, ActionRow, Eyebrow, Helper, Row, writeErrorMessage } from "./ui";

/* ── Advanced: device storage + local mode + clear local data + reset ── */

/** Action row glyphs (stroke 1.8, consistent with the variant A mock). */
const IC = {
  lock: ["M8 11V8a4 4 0 118 0v3", "M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z"],
  unlock: ["M7 11V7a5 5 0 019.9-1", "M5 11h14a1 1 0 011 1v7a1 1 0 01-1 1H5a1 1 0 01-1-1v-7a1 1 0 011-1z"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2", "M10 11v6", "M14 11v6"],
  restart: ["M1 4v6h6", "M3.51 15a9 9 0 102.13-9.36L1 10"],
};

export function AdvancedSection() {
  return (
    <div style={{ marginTop: 4 }}>
      <StorageDiagSection />
      <div style={{ marginTop: 18 }}>
        <LocalModeControl />
      </div>
      <ResetSection />
    </div>
  );
}

/* ── On-device storage (anti-eviction diagnostics) ────────────────────
 * Lets you CONFIRM on the device why the first load can be slow:
 *  - "Last boot: fetched from server" after EVERY open ⇒ iOS evicts the
 *    local copy between sessions (eviction) — the replica doesn't survive,
 *  - "from local copy" ⇒ local-first works, boot is fast. */
function StorageDiagSection() {
  const C = useTheme();
  const { t } = useT();
  const [diag, setDiag] = useState<StorageDiag | null>(null);
  useEffect(() => {
    void getStorageDiag().then(setDiag);
  }, []);
  const src = getLastBootSource();
  const inMem = isInMemoryMode();
  const srcLabel =
    src === "replica" ? t("settings.bootReplica") : src === "snapshot" ? t("settings.bootSnapshot") : src === "local" ? t("settings.bootLocal") : "—";
  const srcColor = src === "snapshot" ? CORAL : src === "replica" ? INCOME : C.text;
  const persisted = diag?.persisted;
  const mb = (b: number | null) => (b == null ? "—" : `${(b / 1_048_576).toFixed(1)} MB`);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t("settings.storageTitle")}</div>
      <Row label={t("settings.lastBoot")}>
        <span style={{ fontSize: 13, fontWeight: 600, color: srcColor }}>{srcLabel}</span>
      </Row>
      <Row label={t("settings.persisted")}>
        <span style={{ fontSize: 13, fontWeight: 600, color: persisted === true ? INCOME : persisted === false ? CORAL : C.soft }}>
          {persisted === true ? t("common.yes") : persisted === false ? t("common.no") : "—"}
        </span>
      </Row>
      <Row label={t("settings.usage")}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>
          {diag ? `${mb(diag.usageBytes)} / ${mb(diag.quotaBytes)}` : "—"}
        </span>
      </Row>
      {inMem && <Helper>{t("settings.inMemWarning")}</Helper>}
      <Helper>{t("settings.storageHelp")}</Helper>
    </div>
  );
}

/**
 * Local mode — offline/privacy control.
 *  - OFF: the action row opens a sheet with TWO paths: safe ("Work offline",
 *    emphasized, no confirmation — non-destructive) and a separate, destructive
 *    one ("Enable and delete server data", danger, extra confirm).
 *  - ON (paused/wiped): "Disable local mode" row (confirm) + the active mode
 *    status as a small line BELOW the group.
 */
function LocalModeControl() {
  const C = useTheme();
  const { t } = useT();
  const { localMode } = useSyncStatus();
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const doPause = () => {
    enablePaused(); // immediate, no network, non-destructive
    setSheet(false);
  };
  const doWipe = async () => {
    setBusy(true);
    setError(null);
    try {
      await enableWiped(); // wipes the server FIRST; the "wiped" flag only after success
      setSheet(false);
      setConfirmWipe(false);
    } catch (e) {
      // wipe failed → we stay synchronized; a refusal by the multi-tenant guard is a sentence
      setError(writeErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const doDisable = async () => {
    if (!window.confirm(t("settings.resumeConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await disableLocal();
    } catch (e) {
      // the upload to the server may be refused by the multi-tenant guard (foreign_replica);
      // a 401 does not land here — it routes the app to the Login screen (sync.ts)
      setError(writeErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  // ── ACTIVE local mode (paused / wiped) ──
  if (localMode !== "off") {
    const wiped = localMode === "wiped";
    return (
      <div>
        <Eyebrow>{t("settings.groupServer")}</Eyebrow>
        <ActionGroup>
          <ActionRow
            icon={<ActionIcon paths={IC.unlock} />}
            label={t("settings.disableLocal")}
            desc={wiped ? t("settings.resumeHelpWiped") : t("settings.resumeHelpPaused")}
            onClick={() => void doDisable()}
            disabled={busy}
            busyLabel={busy ? t("settings.resuming") : undefined}
          />
        </ActionGroup>
        <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, margin: "8px 4px 0" }}>
          {t("settings.localMode")} — {wiped ? t("settings.localWipedSuffix") : t("settings.localOfflineSuffix")}.{" "}
          {wiped ? t("settings.localWipedInfo") : t("settings.localPausedInfo")}
        </div>
        {error && <div style={{ fontSize: 12, color: CORAL, margin: "8px 4px 0", lineHeight: 1.5 }}>{error}</div>}
      </div>
    );
  }

  // ── Local mode OFF — row that opens the sheet ──
  return (
    <div>
      <Eyebrow>{t("settings.groupServer")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.lock} />}
          label={t("settings.localMode")}
          desc={t("settings.localModeDesc")}
          onClick={() => {
            setError(null);
            setConfirmWipe(false);
            setConfirmText("");
            setSheet(true);
          }}
          chevron
        />
      </ActionGroup>

      <Sheet
        show={sheet}
        onClose={() => {
          setSheet(false);
          setConfirmWipe(false);
          setConfirmText("");
        }}
      >
        {(SC) => (
          <div>
            {confirmWipe ? (
              /* CONFIRMATION STEP — type USUŃ/DELETE to wipe server data */
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: CORAL, marginBottom: 8 }}>{t("settings.wipeServerTitle")}</div>
                <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 14 }}>
                  {t("settings.wipeServerBody")}
                </div>
                <div style={{ fontSize: 11, color: SC.mute, marginBottom: 6 }}>
                  {t("settings.wipeTypePrompt1")} <b>{t("settings.wipeConfirmWord")}</b>
                  {t("settings.wipeTypePrompt2")}
                </div>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoCapitalize="characters"
                  placeholder={t("settings.wipeConfirmWord")}
                  style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid var(--danger-66)`, background: SC.bg, color: SC.text, fontSize: 14, fontFamily: font, outline: "none", marginBottom: 12 }}
                />
                <ActionGroup>
                  <ActionRow
                    label={t("settings.wipeServerBtn")}
                    tone="danger"
                    onClick={() => void doWipe()}
                    disabled={busy || confirmText.trim().toUpperCase() !== t("settings.wipeConfirmWord")}
                    busyLabel={busy ? t("settings.wiping") : undefined}
                  />
                </ActionGroup>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button onClick={() => setConfirmWipe(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  {t("common.back")}
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 6 }}>{t("settings.localMode")}</div>
                <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 18 }}>
                  {t("settings.localSheetBody")}
                </div>

                {/* SAFE PATH — no confirmation (non-destructive) */}
                <ActionGroup>
                  <ActionRow label={t("settings.workOffline")} desc={t("settings.workOfflineHelp")} onClick={doPause} />
                </ActionGroup>

                <div style={{ height: 1, background: SC.line, margin: "18px 0" }} />

                {/* DESTRUCTIVE PATH — danger, clearly separated; leads to the "type USUŃ" step */}
                <ActionGroup>
                  <ActionRow
                    label={t("settings.wipeAndEnable")}
                    desc={t("settings.wipeAndEnableHelp")}
                    tone="danger"
                    onClick={() => {
                      setConfirmWipe(true);
                      setConfirmText("");
                    }}
                    disabled={busy}
                  />
                </ActionGroup>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}

                <button onClick={() => setSheet(false)} style={{ width: "100%", marginTop: 18, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  {t("common.cancel")}
                </button>
              </>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** "Cleanup and reset" group: clear local data (multi-tab safe) + start over
 *  (type RESET). Handlers and confirms unchanged:
 *  - wipeLocalData: clears the stores → broadcasts "wipe" to other tabs → reload;
 *    in local mode a stronger warning + backup prompt (the data lives only here),
 *  - reset: deletes the WHOLE budget on the server and the local copy; the budgets
 *    row stays (stable id/currency). After reload the replica is empty → wizard. */
function ResetSection() {
  const C = useTheme();
  const { t } = useT();
  const { localMode } = useSyncStatus();
  const [confirm, setConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wipe = async () => {
    const msg =
      localMode === "wiped"
        ? t("settings.wipeLocalConfirmWiped")
        : localMode === "paused"
          ? t("settings.wipeLocalConfirmPaused")
          : t("settings.wipeLocalConfirm");
    if (!window.confirm(msg)) return;
    // wipeLocalData: clears the stores (multi-tab safe — does not delete the DB) →
    // broadcasts "wipe" to other tabs → reload. Does not block on another tab's connection.
    await wipeLocalData();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.budgetReset(); // server FIRST — the local copy is cleared only after success
      await wipeLocalData(); // clears the stores + broadcasts to tabs → reload → wizard
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <Eyebrow>{t("settings.groupReset")}</Eyebrow>
      <ActionGroup>
        <ActionRow icon={<ActionIcon paths={IC.trash} />} label={t("settings.wipeLocalBtn")} desc={t("settings.wipeLocalHelp")} tone="danger" onClick={() => void wipe()} />
        <ActionRow
          icon={<ActionIcon paths={IC.restart} />}
          label={t("onb.startOver")}
          desc={t("onb.startOverHelp")}
          tone="danger"
          onClick={() => {
            setConfirmText("");
            setError(null);
            setConfirm(true);
          }}
        />
      </ActionGroup>

      {confirm && (
        /* Confirmation form (type RESET) — unchanged, the row only triggers it. */
        <div style={{ marginTop: 10, padding: 14, background: C.bg, borderRadius: 11, border: `1px solid var(--danger-66)` }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: CORAL, marginBottom: 6 }}>{t("onb.startOver")}</div>
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>{t("onb.startOverHelp")}</div>
          <div style={{ fontSize: 11, color: C.mute, marginBottom: 6 }}>
            {t("settings.wipeTypePrompt1")} <b>{t("onb.resetConfirmWord")}</b>
            {t("settings.wipeTypePrompt2")}
          </div>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoCapitalize="characters"
            placeholder={t("onb.resetConfirmWord")}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid var(--danger-66)`, background: C.bg, color: C.text, fontSize: 14, fontFamily: font, outline: "none", marginBottom: 12 }}
          />
          <ActionGroup>
            <ActionRow
              label={t("onb.resetBtn")}
              tone="danger"
              onClick={() => void run()}
              disabled={busy || confirmText.trim().toUpperCase() !== t("onb.resetConfirmWord")}
              busyLabel={busy ? t("onb.resetting") : undefined}
            />
          </ActionGroup>
          {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
          <button
            onClick={() => setConfirm(false)}
            style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: C.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            {t("common.back")}
          </button>
        </div>
      )}
    </div>
  );
}
