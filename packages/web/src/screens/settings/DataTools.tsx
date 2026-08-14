import { useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { exportBackup } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { storageMode } from "../../lib/idb";
import { deleteEverythingAndStartFresh, isUnprovenReplicaError } from "../../lib/recovery";
import { getStorageDiag, type StorageDiag } from "../../lib/storage";
import { assertOwnReplica, getLastBootSource, wipeLocalData } from "../../lib/sync";
import { CORAL, font } from "../../lib/theme";
import { ActionGroup, ActionIcon, ActionRow, ConfirmWordHint, Eyebrow, Helper, Row } from "./ui";

const IC = {
  restart: ["M1 4v6h6", "M3.51 15a9 9 0 102.13-9.36L1 10"],
};

export function DataToolsSection() {
  return (
    <div style={{ marginTop: 4 }}>
      <StorageDiagSection />
      <ResetSection />
    </div>
  );
}

function StorageDiagSection() {
  const C = useTheme();
  const { t } = useT();
  const [diag, setDiag] = useState<StorageDiag | null>(null);
  useEffect(() => {
    void getStorageDiag().then(setDiag);
  }, []);
  const source = getLastBootSource();
  const mode = storageMode();
  const sourceLabel = source === "replica" ? t("from local copy") : source === "snapshot" ? t("fetched from server") : "—";
  const sourceColor = source === "snapshot" ? C.neg : source === "replica" ? C.pos : C.text;
  const persisted = diag?.persisted;
  const mb = (bytes: number | null) => (bytes == null ? "—" : `${(bytes / 1_048_576).toFixed(1)} MB`);

  return (
    <details style={{ marginTop: 18 }}>
      <summary style={{ fontSize: 11.5, fontWeight: 650, color: C.soft, cursor: "pointer", padding: "8px 0" }}>
        {t("Diagnostics and on-device storage")}
      </summary>
      <div style={{ marginTop: 4 }}>
        <Row label={t("Last launch")}>
          <span style={{ fontSize: 13, fontWeight: 600, color: sourceColor }}>{sourceLabel}</span>
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
    </details>
  );
}

function ResetSection() {
  const C = useTheme();
  const { t } = useT();
  const [confirm, setConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const userId = await assertOwnReplica();
      await api.budgetReset(userId);
      await wipeLocalData();
    } catch (cause) {
      if (isUnprovenReplicaError(cause)) {
        setConfirm(false);
        setRecovery(true);
      } else {
        setError(apiErrorMessage(cause));
      }
      setBusy(false);
    }
  };

  const recoveryExport = () => {
    setError(null);
    try {
      exportBackup();
    } catch (cause) {
      setError(apiErrorMessage(cause));
    }
  };

  const recoveryDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteEverythingAndStartFresh();
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <Eyebrow>{t("Clear & reset")}</Eyebrow>
      <ActionGroup>
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
            setRecovery(false);
            setConfirm(true);
          }}
        />
      </ActionGroup>

      {confirm && (
        <div style={{ marginTop: 10, padding: 14, background: C.bg, borderRadius: 11, border: "1px solid var(--danger-66)" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: CORAL, marginBottom: 6 }}>{t("Start from scratch")}</div>
          <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>
            {t("Deletes ALL budget data from the server and this device — irreversible. Export a backup first. The app will reopen with the first-run wizard.")}
          </div>
          <div style={{ fontSize: 11, color: C.mute, marginBottom: 6 }}>
            <ConfirmWordHint word={t("RESET")} />
          </div>
          <input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            autoCapitalize="characters"
            placeholder={t("RESET")}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--danger-66)",
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
          <button type="button" onClick={() => setConfirm(false)} style={backButton(C.soft)}>
            {t("Back")}
          </button>
        </div>
      )}

      {recovery && (
        <div style={{ marginTop: 10, padding: 14, background: C.bg, borderRadius: 11, border: "1px solid var(--danger-66)" }}>
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
          <button type="button" onClick={() => setRecovery(false)} disabled={busy} style={backButton(C.soft)}>
            {t("Back")}
          </button>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

function backButton(color: string): React.CSSProperties {
  return {
    width: "100%",
    marginTop: 12,
    padding: "11px 0",
    borderRadius: 11,
    border: "none",
    background: "transparent",
    color,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };
}
