import { useState } from "react";
import { LogoMark } from "../components/chrome";
import { signOutKeepingReplica } from "../lib/auth";
import { useTheme } from "../lib/contexts";
import { exportBackup } from "../lib/data";
import { useT } from "../lib/i18n";
import { discardForeignReplica, enterLoginKeepingReplica } from "../lib/sync";
import { CORAL, TEAL, font } from "../lib/theme";

/**
 * BootStatus "foreign" — the replica on this device carries an owner stamp naming a DIFFERENT
 * account than the one signed in (see the multi-tenant guard in sync.ts). Every server write is
 * already blocked; this screen exists because the remaining decision is NOT the app's to make:
 *
 *  - the local replica may be the LAST copy of that budget (local mode "wiped" deletes the
 *    server's copy on purpose, and the outbox can hold ops the server has never seen),
 *  - a user id is not stable across a server rebuild — a self-hoster who lost the database and
 *    re-registered with the same e-mail gets a NEW uuid, and their phone's complete replica would
 *    look "foreign" while being exactly the data they are trying to recover.
 *
 * So: export first (the button downloads the whole ledger as JSON, offline, no network), and only
 * an explicit "remove and continue" destroys anything.
 */
export function ForeignReplicaScreen() {
  const C = useTheme();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await discardForeignReplica(); // clears IDB + outbox + local mode, then reloads
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
      await signOutKeepingReplica(enterLoginKeepingReplica); // → Login; the replica stays
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
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 32, textAlign: "center" }}>
      <div style={{ marginBottom: 4 }}><LogoMark size={64} /></div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{t("foreign.title")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 300 }}>
        <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6 }}>{t("foreign.body")}</div>
        <button type="button" onClick={doExport} disabled={busy} style={btn(TEAL)}>
          {t("foreign.export")}
        </button>
        <button
          type="button"
          onClick={() => void doSignOut()}
          disabled={busy}
          style={{ ...btn("transparent"), color: C.text, border: `1px solid ${C.line}` }}
        >
          {t("foreign.signOut")}
        </button>
        {confirm ? (
          <>
            <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6 }}>{t("foreign.discardConfirm")}</div>
            <button type="button" onClick={() => void doDiscard()} disabled={busy} style={btn(CORAL)}>
              {busy ? t("foreign.discarding") : t("foreign.discardYes")}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              disabled={busy}
              style={{ ...btn("transparent"), color: C.soft, textDecoration: "underline" }}
            >
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={busy}
            style={{ ...btn("transparent"), color: CORAL, border: `1px solid ${C.line}` }}
          >
            {t("foreign.discard")}
          </button>
        )}
        <div style={{ fontSize: 11.5, color: C.mute, lineHeight: 1.6 }}>{t("foreign.hint")}</div>
      </div>
      {error && <div style={{ fontSize: 12, color: CORAL, lineHeight: 1.5, maxWidth: 280 }}>{error}</div>}
    </div>
  );
}
