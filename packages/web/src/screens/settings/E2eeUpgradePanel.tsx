import { useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { exportBackup } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { store } from "../../lib/store";
import { TierMismatchError, upgradeServerE2eeV2 } from "../../lib/sync";
import { CORAL, font } from "../../lib/theme";
import { ActionGroup, ActionIcon, ActionRow } from "./ui";

/**
 * The v1→v2 encryption-upgrade ceremony (UI) — shared by Settings → Privacy (the normal
 * entry: the device booted from its replica and the sync engine recorded cipherVersion 1)
 * and the Unlock screen's dedicated upgrade state (a locked device that still holds a
 * replica). The ceremony itself lives in lib/sync.ts (upgradeServerE2eeV2): fresh DEK,
 * next epoch, the LOCAL ledger becomes the new v2 checkpoint — a REAL data-key rotation,
 * after which old pairing codes and other devices' keys stop working.
 *
 * The fresh-backup acknowledgement is FORCED here (checkbox gates the run button), because
 * the local replica is the canonical source the new generation is built from.
 */
export function E2eeUpgradePanel({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const theme = useTheme();
  const [haveBackup, setHaveBackup] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await upgradeServerE2eeV2(pass);
      onDone();
    } catch (e) {
      if (e instanceof TierMismatchError) {
        // Stale epoch / upgraded or flipped on another device — local meta is already fresh
        // (throwIfTierMismatch), so a retry recomputes the contexts from the new state.
        setError(t("The budget changed on the server in the meantime — nothing was written. Try again."));
      } else {
        setError(`${t("The upgrade failed — nothing was changed on the server.")} ${apiErrorMessage(e)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const C = { line: theme.line, bg: theme.surface, text: theme.text, soft: theme.soft };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 10,
    border: `1px solid ${C.line}`,
    background: C.bg,
    color: C.text,
    fontSize: 14,
    fontFamily: font,
  };

  return (
    <div style={{ textAlign: "left" }}>
      <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.6, marginBottom: 10 }}>
        {t(
          "This budget is encrypted with an older format that new versions of the app no longer read. Upgrading re-encrypts it with a fresh key built from the data on THIS device: pick a new encryption password (it may be the same one), and the server's copy is replaced in one step.",
        )}
      </div>
      <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.6, marginBottom: 12 }}>
        {t("Afterwards, other devices must unlock again with the new password or a fresh pairing code — old pairing codes stop working.")}
      </div>
      <div style={{ fontSize: 12.5, color: C.text, fontWeight: 600, lineHeight: 1.6, marginBottom: 12 }}>
        {t("Before you continue, download a JSON backup and keep it somewhere safe.")}
      </div>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={["M12 3v12m0 0l-4-4m4 4l4-4", "M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"]} />}
          label={t("Export backup (JSON)")}
          onClick={() => {
            setError(null);
            try {
              exportBackup();
            } catch (e) {
              setError(apiErrorMessage(e));
            }
          }}
        />
      </ActionGroup>
      <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={haveBackup} onChange={(e) => setHaveBackup(e.target.checked)} style={{ width: 18, height: 18, flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: C.text }}>{t("I have a backup in a safe place")}</span>
      </label>
      <input
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        placeholder={t("Encryption password (min. 10 characters)")}
        autoComplete="new-password"
        aria-label={t("Encryption password (min. 10 characters)")}
        style={{ ...inputStyle, marginTop: 14 }}
      />
      <input
        type="password"
        value={pass2}
        onChange={(e) => setPass2(e.target.value)}
        placeholder={t("Repeat password")}
        autoComplete="new-password"
        aria-label={t("Repeat password")}
        style={{ ...inputStyle, marginTop: 10 }}
      />
      {pass2.length > 0 && pass2 !== pass && <div style={{ fontSize: 11.5, color: CORAL, marginTop: 6 }}>{t("Passwords do not match.")}</div>}
      <div style={{ marginTop: 14 }}>
        <ActionGroup>
          <ActionRow
            icon={<ActionIcon paths={["M12 2l8 3v6c0 5-3.5 9.4-8 11-4.5-1.6-8-6-8-11V5z", "M12 11v3m0-6v.01"]} />}
            label={t("Re-encrypt and upgrade")}
            onClick={() => void run()}
            disabled={busy || !haveBackup || pass.length < 10 || pass !== pass2 || !store.getLedger()}
            busyLabel={busy ? t("Encrypting…") : undefined}
          />
        </ActionGroup>
      </div>
      {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}
