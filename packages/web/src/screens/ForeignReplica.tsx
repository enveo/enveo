import { useState } from "react";
import { LogoMark } from "../components/chrome";
import { endSession } from "../lib/auth";
import { useTheme } from "../lib/contexts";
import { exportBackup } from "../lib/data";
import { getCachedDeployment } from "../lib/deviceStoragePolicy";
import { useT } from "../lib/i18n";
import { discardLocalReplica, enterLoginPreservingReplica } from "../lib/sync";
import { CORAL, font, TEAL } from "../lib/theme";
import { useViewMode } from "../lib/viewMode";

/**
 * BootStatus "foreign" — the replica on this device carries an owner stamp naming a DIFFERENT
 * account than the one signed in (see the multi-tenant guard in sync.ts). Every server write is
 * already blocked; this screen exists because on SELFHOST the remaining decision is NOT the
 * app's to make:
 *
 *  - the local replica may be the LAST copy of that budget (for example after offline edits or a
 *    server rebuild),
 *  - a user id is not stable across a server rebuild — a self-hoster who lost the database and
 *    re-registered with the same e-mail gets a NEW uuid, and their phone's complete replica would
 *    look "foreign" while being exactly the data they are trying to recover.
 *
 * So: export first (the button downloads the whole ledger as JSON, offline, no network), and only
 * an explicit "remove and continue" destroys anything.
 *
 * On CLOUD deployments this screen is normally never reached: a foreign replica is silently
 * discarded by the guard itself (enterForeignReplica — the server is the durable copy there,
 * and surfacing "another account's data is on this machine" to whoever sits at a shared
 * computer is exposure, not protection). The cloud branch below is defense in depth for the
 * states that can still land here (e.g. the deployment cache appearing mid-session): it hides
 * the export, so the previous user's ledger is never handed out.
 */
export function ForeignReplicaScreen() {
  const C = useTheme();
  const { t } = useT();
  // Layout only — same reasoning as LoginScreen (D1, pr7-context.md): the brand column already
  // carries the logo/title on fold/desktop, and this screen fills the shell's 440px form column.
  const wide = useViewMode() !== "phone";
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CLOUD: no export button. The server is the durable copy of that account's budget (operator
  // backups), and "download the previous user's whole ledger without being them" is exactly the
  // shared-computer hole the session-storage policy closes. SELFHOST keeps the export: the replica
  // there may be the LAST copy (see the header comment) and the rescue path must stay.
  const cloud = getCachedDeployment() === "cloud";

  const doExport = () => {
    setError(null);
    try {
      exportBackup(); // local mirror → JSON file; no server call
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDiscard = async () => {
    setBusy(true);
    setError(null);
    try {
      await discardLocalReplica(); // clears IDB + outbox, then reloads
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // The NON-destructive way out: the previous owner signs back in and their data resumes. Without
  // it "we destroy nothing" would be a dead end — the app is not rendered here, so Settings (and
  // its sign-out) are unreachable.
  const doSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await endSession();
      enterLoginPreservingReplica(); // → Login; the foreign replica stays
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const btn = (bg: string): React.CSSProperties => ({
    padding: "12px 26px",
    borderRadius: 11,
    border: "none",
    background: bg,
    color: "#fff",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.5 : 1,
    fontFamily: font,
    width: "100%",
  });

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: wide ? "stretch" : "center",
        justifyContent: "center",
        gap: 14,
        padding: 32,
        textAlign: wide ? "left" : "center",
      }}
    >
      {!wide && (
        <div style={{ marginBottom: 4 }}>
          <LogoMark size={64} />
        </div>
      )}
      <div style={{ fontSize: wide ? 22 : 18, fontWeight: 700, color: C.text }}>{t("Another account's data")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: wide ? "100%" : 300 }}>
        <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6 }}>
          {t(
            "The local copy of the budget on this device belongs to a different account than the one you are signed in with. Nothing has been sent to the server and nothing has been deleted.",
          )}
        </div>
        {!cloud && (
          <button type="button" onClick={doExport} disabled={busy} style={btn(TEAL)}>
            {t("Download a backup (JSON)")}
          </button>
        )}
        <button type="button" onClick={() => void doSignOut()} disabled={busy} style={{ ...btn("transparent"), color: C.text, border: `1px solid ${C.line}` }}>
          {t("Sign out and use another account")}
        </button>
        {confirm ? (
          <>
            <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6 }}>
              {cloud
                ? t(
                    "The local copy — including any unsent changes — will be permanently removed from this device. Your account's data on the server is not affected.",
                  )
                : t(
                    "The local copy — including any unsent changes — will be permanently removed from this device. If this is the only copy of that budget, download a backup first.",
                  )}
            </div>
            <button type="button" onClick={() => void doDiscard()} disabled={busy} style={btn(CORAL)}>
              {busy ? t("Removing…") : t("Yes, remove the data from this device")}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              disabled={busy}
              style={{ ...btn("transparent"), color: C.soft, textDecoration: "underline" }}
            >
              {t("Cancel")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} disabled={busy} style={{ ...btn("transparent"), color: CORAL, border: `1px solid ${C.line}` }}>
            {t("Remove this data and continue")}
          </button>
        )}
        <div style={{ fontSize: 11.5, color: C.mute, lineHeight: 1.6 }}>
          {t(
            "If this is your data, sign in with the previous account — the copy is intact. After restoring a server from a backup the account id can be new even though the e-mail is the same.",
          )}
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: CORAL, lineHeight: 1.5, maxWidth: wide ? "100%" : 280 }}>{error}</div>}
    </div>
  );
}
