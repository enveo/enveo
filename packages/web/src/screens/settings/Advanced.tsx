import { useEffect, useState } from "react";
import { Sheet } from "../../components/chrome";
import { api, apiErrorMessage, useSyncStatus } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { exportBackup } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { storageMode } from "../../lib/idb";
import { deleteEverythingAndStartFresh, isUnprovenReplicaError } from "../../lib/recovery";
import { getStorageDiag, type StorageDiag } from "../../lib/storage";
import { assertOwnReplica, disableLocal, enablePaused, enableWiped, getLastBootSource, wipeLocalData } from "../../lib/sync";
import { CORAL, font } from "../../lib/theme";
import { ActionGroup, ActionIcon, ActionRow, ConfirmWordHint, Eyebrow, Helper, Row } from "./ui";

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
  const mode = storageMode();
  const srcLabel = src === "replica" ? t("from local copy") : src === "snapshot" ? t("fetched from server") : src === "local" ? t("local mode") : "—";
  const srcColor = src === "snapshot" ? C.neg : src === "replica" ? C.pos : C.text;
  const persisted = diag?.persisted;
  const mb = (b: number | null) => (b == null ? "—" : `${(b / 1_048_576).toFixed(1)} MB`);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t("On-device storage")}</div>
      <Row label={t("Last launch")}>
        <span style={{ fontSize: 13, fontWeight: 600, color: srcColor }}>{srcLabel}</span>
      </Row>
      <Row label={t("Persistent storage")}>
        <span style={{ fontSize: 13, fontWeight: 600, color: persisted === true ? C.pos : persisted === false ? C.neg : C.soft }}>
          {persisted === true ? t("Yes") : persisted === false ? t("No") : "—"}
        </span>
      </Row>
      <Row label={t("Usage")}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>
          {diag ? `${mb(diag.usageBytes)} / ${mb(diag.quotaBytes)}` : "—"}
        </span>
      </Row>
      {mode === "memory-fallback" && (
        <Helper>{t("WARNING: IndexedDB unavailable — data is kept only in session memory (it will not survive closing the app).")}</Helper>
      )}
      {mode === "memory-session" && (
        <Helper>{t("Session storage — the budget lives only in this tab's memory and leaves no local copy after it closes.")}</Helper>
      )}
      <Helper>
        {t(
          "If “Last launch: fetched from server” appears every time you open the app, iOS is deleting the local copy between sessions — that is why the first load is slow. “Persistent storage: Yes” lowers the risk of such eviction.",
        )}
      </Helper>
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
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const doDisable = async () => {
    if (!window.confirm(t("Resume sync? Local changes will be sent to the server."))) return;
    setBusy(true);
    setError(null);
    try {
      await disableLocal();
    } catch (e) {
      // the upload to the server may be refused by the multi-tenant guard (foreign_replica);
      // a 401 does not land here — it routes the app to the Login screen (sync.ts)
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // ── ACTIVE local mode (paused / wiped) ──
  if (localMode !== "off") {
    const wiped = localMode === "wiped";
    return (
      <div>
        <Eyebrow>{t("Server connection")}</Eyebrow>
        <ActionGroup>
          <ActionRow
            icon={<ActionIcon paths={IC.unlock} />}
            label={t("Turn off local mode")}
            desc={
              wiped
                ? t("We will send your local data back to the server and resume sync.")
                : t("We will send pending changes and resume sync. Server data is untouched.")
            }
            onClick={() => void doDisable()}
            disabled={busy}
            busyLabel={busy ? t("Resuming…") : undefined}
          />
        </ActionGroup>
        <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, margin: "8px 4px 0" }}>
          {t("Local mode")} — {wiped ? t("data deleted from server") : t("offline")}.{" "}
          {wiped
            ? t("Your data now lives only on this device. Make a backup (Export) — it is the only way not to lose it.")
            : t("Sync is paused. Changes are saved locally and will be sent once you resume. Server data stays intact.")}
        </div>
        {error && <div style={{ fontSize: 12, color: CORAL, margin: "8px 4px 0", lineHeight: 1.5 }}>{error}</div>}
      </div>
    );
  }

  // ── Local mode OFF — row that opens the sheet ──
  return (
    <div>
      <Eyebrow>{t("Server connection")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.lock} />}
          label={t("Local mode")}
          desc={t("work offline or keep data only on this device")}
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
                <div style={{ fontSize: 15, fontWeight: 700, color: CORAL, marginBottom: 8 }}>{t("Delete data from the server?")}</div>
                <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 14 }}>
                  {t(
                    "We will irreversibly erase all data from the server — this cannot be undone from the app. Other devices will lose access. Your data will remain only on this device. Make a backup first (Export).",
                  )}
                </div>
                <div style={{ fontSize: 11, color: SC.mute, marginBottom: 6 }}>
                  <ConfirmWordHint word={t("DELETE")} />
                </div>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoCapitalize="characters"
                  placeholder={t("DELETE")}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: `1px solid var(--danger-66)`,
                    background: SC.bg,
                    color: SC.text,
                    fontSize: 14,
                    fontFamily: font,
                    marginBottom: 12,
                  }}
                />
                <ActionGroup>
                  <ActionRow
                    label={t("Delete data from server")}
                    tone="danger"
                    onClick={() => void doWipe()}
                    disabled={busy || confirmText.trim().toUpperCase() !== t("DELETE")}
                    busyLabel={busy ? t("Deleting from server…") : undefined}
                  />
                </ActionGroup>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button
                  onClick={() => setConfirmWipe(false)}
                  style={{
                    width: "100%",
                    marginTop: 12,
                    padding: "11px 0",
                    borderRadius: 11,
                    border: "none",
                    background: "transparent",
                    color: SC.soft,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {t("Back")}
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 6 }}>{t("Local mode")}</div>
                <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 18 }}>
                  {t("Cut the app off from the server. Choose how: work offline (server data stays) or keep your data only on this device.")}
                </div>

                {/* SAFE PATH — no confirmation (non-destructive) */}
                <ActionGroup>
                  <ActionRow
                    label={t("Work offline")}
                    desc={t("Sync is paused. Changes will be saved locally and sent once you resume. Server data stays intact.")}
                    onClick={doPause}
                  />
                </ActionGroup>

                <div style={{ height: 1, background: SC.line, margin: "18px 0" }} />

                {/* DESTRUCTIVE PATH — danger, clearly separated; leads to the "type USUŃ" step */}
                <ActionGroup>
                  <ActionRow
                    label={t("Enable and delete server data")}
                    desc={t("Irreversibly deletes data from the server; other devices will lose access. Make a backup first (Export).")}
                    tone="danger"
                    onClick={() => {
                      setConfirmWipe(true);
                      setConfirmText("");
                    }}
                    disabled={busy}
                  />
                </ActionGroup>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}

                <button
                  onClick={() => setSheet(false)}
                  style={{
                    width: "100%",
                    marginTop: 18,
                    padding: "11px 0",
                    borderRadius: 11,
                    border: "none",
                    background: "transparent",
                    color: SC.soft,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {t("Cancel")}
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
  // UNPROVEN-replica recovery dialog (owner decision, 2026-08-12) — see run() below.
  const [recovery, setRecovery] = useState(false);

  const wipe = async () => {
    const msg =
      localMode === "wiped"
        ? t(
            "WARNING: in local mode this data exists ONLY on this device (the server is empty). Clearing it will delete it permanently. Make a backup first (Export). Continue?",
          )
        : localMode === "paused"
          ? t("Clear local data? In local mode, unsent changes will be lost permanently. Make a backup first (Export). Continue?")
          : t(
              "Clear local data? We will delete the local copy on this device and download everything anew from the server. Changes still waiting in the queue will be lost.",
            );
    if (!window.confirm(msg)) return;
    // wipeLocalData: clears the stores (multi-tab safe — does not delete the DB) →
    // broadcasts "wipe" to other tabs → reload. Does not block on another tab's connection.
    await wipeLocalData();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // the multi-tenant guard first: the verified user id travels in the body (409 on a swap)
      const userId = await assertOwnReplica();
      await api.budgetReset(userId); // server FIRST — the local copy is cleared only after success
      await wipeLocalData(); // clears the stores + broadcasts to tabs → reload → wizard
    } catch (e) {
      // The guard refused because the replica cannot be linked to this account (UNPROVEN — e.g.
      // local-only → clear-local → re-enable-sync): the reset above IS the escape hatch from that
      // state, so a bare error would be a dead end. Show the recovery dialog instead (export the
      // local copy / delete everything and start fresh). A genuinely FOREIGN stamp never gets
      // here as a dialog: enterForeignReplica has already flipped the boot status, and the app
      // unmounts Settings into ForeignReplicaScreen.
      if (isUnprovenReplicaError(e)) {
        setConfirm(false);
        setRecovery(true);
        setBusy(false);
        return;
      }
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  const recoveryExport = () => {
    setError(null);
    try {
      exportBackup(); // local mirror → JSON file; no server call
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  const recoveryDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      // Server budget reset (session-scoped — nothing from the replica is sent) → sign out →
      // wipe the device (settings + replica), reload → Login. Order rationale in lib/recovery.ts.
      await deleteEverythingAndStartFresh();
    } catch (e) {
      setError(apiErrorMessage(e)); // nothing local was touched — the dialog (and export) stay
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <Eyebrow>{t("Clear & reset")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.trash} />}
          label={t("Clear local data")}
          desc={t("Deletes the local copy on this device and downloads everything anew from the server. Use when something looks off.")}
          tone="danger"
          onClick={() => void wipe()}
        />
        <ActionRow
          icon={<ActionIcon paths={IC.restart} />}
          label={t("Start from scratch")}
          desc={t(
            "Deletes ALL budget data from the server and this device — irreversible. Export a backup first. The app will reopen with the first-run wizard.",
          )}
          tone="danger"
          onClick={() => {
            setConfirmText("");
            setError(null);
            setRecovery(false); // the confirm card and the recovery dialog never stack
            setConfirm(true);
          }}
        />
      </ActionGroup>

      {confirm && (
        /* Confirmation form (type RESET) — unchanged, the row only triggers it. */
        <div style={{ marginTop: 10, padding: 14, background: C.bg, borderRadius: 11, border: `1px solid var(--danger-66)` }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: CORAL, marginBottom: 6 }}>{t("Start from scratch")}</div>
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>
            {t("Deletes ALL budget data from the server and this device — irreversible. Export a backup first. The app will reopen with the first-run wizard.")}
          </div>
          <div style={{ fontSize: 11, color: C.mute, marginBottom: 6 }}>
            <ConfirmWordHint word={t("RESET")} />
          </div>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoCapitalize="characters"
            placeholder={t("RESET")}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid var(--danger-66)`,
              background: C.bg,
              color: C.text,
              fontSize: 14,
              fontFamily: font,
              marginBottom: 12,
            }}
          />
          <ActionGroup>
            <ActionRow
              label={t("Delete everything and start over")}
              tone="danger"
              onClick={() => void run()}
              disabled={busy || confirmText.trim().toUpperCase() !== t("RESET")}
              busyLabel={busy ? t("Deleting…") : undefined}
            />
          </ActionGroup>
          {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
          <button
            onClick={() => setConfirm(false)}
            style={{
              width: "100%",
              marginTop: 12,
              padding: "11px 0",
              borderRadius: 11,
              border: "none",
              background: "transparent",
              color: C.soft,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Back")}
          </button>
        </div>
      )}

      {recovery && (
        /* UNPROVEN-replica recovery (owner decision, 2026-08-12): the reset refused to run because
         * the local copy cannot be linked to the signed-in account. ONE dialog, export FIRST —
         * the local copy may be the LAST copy of that data, and the explicit choice here is the
         * human in the loop the never-destroy-unattended invariant requires. */
        <div style={{ marginTop: 10, padding: 14, background: C.bg, borderRadius: 11, border: `1px solid var(--danger-66)` }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: CORAL, marginBottom: 6 }}>{t("This device's local copy cannot be linked to this account")}</div>
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>
            {t(
              "The budget data on this device could not be matched to the account you are signed in with, so nothing can be sent to the server. Nothing has been deleted yet. Download a backup first — this device may hold the only copy of that data. “Delete everything and start fresh” erases this account's data on the server and the local copy on this device, then signs you out.",
            )}
          </div>
          <ActionGroup>
            <ActionRow
              label={t("Download a backup (JSON)")}
              desc={t("the whole local copy as a file — no network needed")}
              onClick={recoveryExport}
              disabled={busy}
            />
            <ActionRow
              label={t("Delete everything and start fresh")}
              tone="danger"
              onClick={() => void recoveryDelete()}
              disabled={busy}
              busyLabel={busy ? t("Deleting…") : undefined}
            />
          </ActionGroup>
          {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
          <button
            onClick={() => setRecovery(false)}
            disabled={busy}
            style={{
              width: "100%",
              marginTop: 12,
              padding: "11px 0",
              borderRadius: 11,
              border: "none",
              background: "transparent",
              color: C.soft,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Back")}
          </button>
        </div>
      )}
    </div>
  );
}
