import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import { api, apiErrorMessage, useLedgerVersion } from "../../lib/api";
import { hasSession, signOutKeepingReplica, signOutSessionOnly } from "../../lib/auth";
import { DEFAULT_KDF_PARAMS, deriveKek, encodePairing, generateDek, generateSalt, unwrapDek, wrapDek, type KdfParams } from "../../lib/crypto";
import { exportBackup, importBackup } from "../../lib/data";
import { clearDeviceTrust, getCachedDeployment } from "../../lib/deviceTrust";
import * as e2ee from "../../lib/e2ee";
import * as persist from "../../lib/persist";
import { assertOwnReplica, discardLocalReplica, enterLoginKeepingReplica, flushOutboxForSignOut, fullResync, syncNow } from "../../lib/sync";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { store } from "../../lib/store";
import { CORAL, INCOME, font } from "../../lib/theme";
import { Sheet } from "../../components/chrome";
import { ActionGroup, ActionIcon, ActionRow, ConfirmWordHint, Eyebrow } from "./ui";

/* ── Data: backup (export/import) + E2E encryption + account ────────── */

/** Action row glyphs (stroke 1.8, consistent with the variant A mock). */
const IC = {
  download: ["M12 3v12m0 0l-4-4m4 4l4-4", "M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"],
  upload: ["M12 21V9m0 0l-4 4m4-4l4 4", "M4 7V5a2 2 0 012-2h12a2 2 0 012 2v2"],
  shield: ["M12 2l8 3v6c0 5-3.5 9.4-8 11-4.5-1.6-8-6-8-11V5z", "M12 11v3m0-6v.01"],
  key: ["M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"],
  qr: ["M4 4h6.5v6.5H4z", "M13.5 4H20v6.5h-6.5z", "M4 13.5h6.5V20H4z", "M13.5 13.5h3v3h-3z", "M20 16.5V20h-3.5"],
  shieldOff: ["M19.7 14c.2-.65.3-1.32.3-2V5l-8-3-3.2 1.2", "M4.7 4.7L4 5v7c0 5 3.5 9.4 8 11a13.2 13.2 0 005.6-4.4", "M2 2l20 20"],
  logout: ["M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4", "M16 17l5-5-5-5", "M21 12H9"],
};

export function DataSection() {
  return (
    <div style={{ marginTop: 4 }}>
      <DataBackup />
      <E2eeSection />
      <LogoutRow />
    </div>
  );
}

/**
 * Logout — visible ONLY when the backend confirms a session (hasSession()). The behavior splits
 * by deployment (device-trust spec, 2026-07-17):
 *
 * SELFHOST does NOT wipe the local replica (spec §3, binding owner decision): the ledger mirror,
 * the DEK and — crucially — every op still queued in the durable outbox stay on the device, so a
 * sign-out while offline (or with a failing push) cannot silently throw unsynced data away, and a
 * replica that is the last copy of its budget (local mode "wiped") survives. Signing back in
 * resumes exactly where it stopped; a DIFFERENT account signing in is handled by the multi-tenant
 * guard in sync.ts (the foreign replica is neither rendered nor written anywhere, and the human
 * decides its fate). Deleting the local copy on purpose remains available: Settings → Clear local
 * data (Advanced).
 *
 * CLOUD is the deliberate exception: the server is the durable copy there (operator backups, not
 * this device), so sign-out flushes the outbox, ends the session and only then wipes the local
 * copy — a non-empty remainder after the flush still requires the human's explicit consent before
 * anything is discarded.
 */
function LogoutRow() {
  const { t } = useT();
  const [session, setSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void hasSession().then(setSession);
  }, []);
  if (!session) return null;

  const cloud = getCachedDeployment() === "cloud";

  const doLogout = async () => {
    const prompt = cloud
      ? t("Sign out? The local copy will be removed from this device — your data stays on the server.")
      : t("Sign out? Your data stays on this device and on the server.");
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setError(null);
    try {
      if (!cloud) {
        await signOutKeepingReplica(enterLoginKeepingReplica); // sign out → Login; the replica stays
        return;
      }
      // Cloud: the server is the durable copy — flush, end the session, then wipe this device.
      // Order: a failed wipe after a successful signOut leaves the same state as an expired
      // session on a trusted device (accepted residual risk of the trust choice); a wipe before
      // a failed signOut would strand a signed-in session on an empty replica.
      const left = await flushOutboxForSignOut();
      if (left > 0 && !window.confirm(t("Some changes have not reached the server yet. Sign out anyway and lose them?"))) {
        setBusy(false);
        return;
      }
      await signOutSessionOnly();
      clearDeviceTrust(); // the next login asks again (default per deployment)
      await discardLocalReplica(); // clears the local copy (memory or IDB) and reloads → Login
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <Eyebrow>{t("Account")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.logout} />}
          label={t("Sign out")}
          desc={cloud
            ? t("Signs you out and removes the local copy from this device. Your data stays on the server and comes back when you sign in again.")
            : t("Signs you out of this device. The local copy and the server data both stay — everything resumes when you sign back in. To remove the copy from this device, use “Clear local data”.")}
          tone="danger"
          onClick={() => void doLogout()}
          disabled={busy}
          busyLabel={busy ? t("Signing out…") : undefined}
        />
      </ActionGroup>
      {error && <div style={{ fontSize: 12, color: CORAL, margin: "8px 4px 0", lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

/** JSON backup export / import. */
function DataBackup() {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const doExport = () => {
    setError(null);
    setDone(null);
    try {
      exportBackup();
      setDone(t("Backup downloaded."));
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow selecting the same file again
    if (!file) return;
    if (!window.confirm(t("This will replace all current data. Continue?"))) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await importBackup(file);
      setDone(t("Backup loaded — data has been replaced."));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <Eyebrow>{t("Backup")}</Eyebrow>
      <ActionGroup>
        <ActionRow icon={<ActionIcon paths={IC.download} />} label={t("Export backup (JSON)")} desc={t("Downloads all your data as a file. Keep a backup, especially in local mode.")} onClick={doExport} />
        <ActionRow
          icon={<ActionIcon paths={IC.upload} />}
          label={t("Load backup (JSON)")}
          desc={t("Replaces all current data with the data from the selected file.")}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          busyLabel={busy ? t("Loading…") : undefined}
        />
      </ActionGroup>
      <input ref={fileRef} type="file" accept="application/json,.json" onChange={(e) => void onFile(e)} style={{ display: "none" }} />

      {error && <div style={{ fontSize: 12, color: CORAL, margin: "8px 4px 0", lineHeight: 1.5 }}>{error}</div>}
      {done && <div style={{ fontSize: 12, color: INCOME, margin: "8px 4px 0", lineHeight: 1.5 }}>{done}</div>}
    </div>
  );
}

/* ── End-to-end encryption (E2EE) ─────────────────────────────────────
 * Plain tier → enable wizard (sheet: forced JSON export + "I have a backup"
 * checkbox, then password ×2 with a strength meter; execution with a spinner).
 * E2ee tier → panel: password change, pairing code (QR + text for pasting),
 * disable (type the localized confirmation word). Crypto ENTIRELY on the device
 * (lib/crypto.ts) — the server receives only wrappedDek+kdfParams+ciphertexts. */

const toB64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Fresh kdfParams (new salt) as a string for the server — Unlock reads this shape. */
function freshKdfParams(salt: Uint8Array): string {
  const kp: KdfParams = { ...DEFAULT_KDF_PARAMS, saltB64: toB64(salt) };
  return JSON.stringify(kp);
}

/** Simple strength meter: 0 = too short (<10 chars — blocks), 1..3 = length + character classes. */
function passStrength(p: string): 0 | 1 | 2 | 3 {
  if (p.length < 10) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(p)).length;
  if (p.length >= 16 && classes >= 3) return 3;
  if (p.length >= 12 && classes >= 2) return 2;
  return 1;
}

function StrengthMeter({ pass }: { pass: string }) {
  const C = useTheme();
  const { t } = useT();
  if (pass.length === 0) return null;
  const s = passStrength(pass);
  const colors = [CORAL, CORAL, "#d99a06", INCOME] as const;
  const labels = [t("Too short (min. 10 characters)"), t("Weak"), t("Good"), t("Strong")];
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: s >= i ? colors[s] : C.line }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: s === 0 ? CORAL : C.soft, marginTop: 4 }}>{labels[s]}</div>
    </div>
  );
}

function E2eeSection() {
  // a tier flip bumps the mirror version (store.replace in handleTierFlip / the wizard),
  // so the version subscription also refreshes the section on a flip from another device
  useLedgerVersion();
  const { t } = useT();
  return (
    <div style={{ marginTop: 18 }}>
      <Eyebrow>{t("Privacy")}</Eyebrow>
      {e2ee.getTierMeta().tier === "e2ee" ? <E2eeManage /> : <E2eeEnableWizard />}
    </div>
  );
}

/** Enable wizard (plain tier). Does NOT flip without "I have a backup" checked. */
function E2eeEnableWizard() {
  const { t } = useT();
  const [sheet, setSheet] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [haveBackup, setHaveBackup] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setStep(1);
    setHaveBackup(false);
    setPass("");
    setPass2("");
    setError(null);
    setSheet(true);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const ledger = store.getLedger();
      if (!ledger) throw new Error(t("There is nothing to export yet — wait for the app to finish loading."));
      // MULTI-TENANT GUARD — /e2ee/enable uploads a snapshot of THIS replica and flips the
      // SESSION budget's tier under this device's wrappedDek: a full-budget overwrite, exactly
      // like /sync/replace. It is reachable from a tab whose cookie was swapped by a sign-in
      // elsewhere, and from a replica whose owner sync refuses to establish. The verified user id
      // travels WITH the write (userId) — Argon2id + encrypting the whole ledger takes seconds,
      // and the cookie can be swapped in that window; the server refuses a mismatch.
      const userId = await assertOwnReplica();
      // crypto ON THE DEVICE: fresh DEK + KEK from the password (Argon2id) + ciphertext of the whole replica
      const salt = generateSalt();
      const dek = generateDek();
      const kek = await deriveKek(pass, salt, DEFAULT_KDF_PARAMS);
      const wrappedDek = await wrapDek(dek, kek);
      const snapshotBlob = await e2ee.encryptSnapshot(ledger, dek);
      const { epoch } = await api.e2eeEnable({ wrappedDek, kdfParams: freshKdfParams(salt), snapshotBlob, userId });
      // local flip ONLY after server success (error above ⇒ nothing changed, replica untouched)
      e2ee.setDek(dek);
      e2ee.setTierMeta({ tier: "e2ee", epoch });
      e2ee.resetOpsCounter();
      // the v1 cursor makes no sense in the v2 journal (e2ee_ops counts seq from 1) —
      // the checkpoint from enable represents exactly THIS replica at seq 0
      store.replace(ledger, 0, store.getBudgetId() ?? "");
      void persist.persistLedger(store.snapshotForPersist());
      void syncNow("e2ee-enable"); // backlogged outbox ops go out via a normal v2 push
      setSheet(false); // the section switches to the e2ee panel (statusOn = confirmation)
    } catch (e) {
      setError(`${t("Enabling failed — nothing was changed, your data stays as it was.")} ${apiErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = (SC: { line: string; bg: string; text: string }): React.CSSProperties => ({
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 10,
    border: `1px solid ${SC.line}`,
    background: SC.bg,
    color: SC.text,
    fontSize: 14,
    fontFamily: font,
    outline: "none",
  });

  return (
    <>
      <ActionGroup>
        <ActionRow icon={<ActionIcon paths={IC.shield} />} label={t("Enable end-to-end encryption")} desc={t("Budget data will be encrypted on your device before it reaches the server. Server-side features will be unavailable.")} onClick={open} chevron />
      </ActionGroup>

      <Sheet show={sheet} onClose={() => !busy && setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 6 }}>{t("Enable end-to-end encryption")}</div>
            {step === 1 ? (
              <>
                {/* STEP 1 — explanation + FORCED JSON export (Next disabled without the checkbox) */}
                <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 12 }}>{t("Once enabled, the server stores ciphertexts only. The key is your password, which the server does NOT know — without it (or a pairing code from a trusted device) the data cannot be recovered.")}</div>
                <div style={{ fontSize: 12.5, color: SC.text, fontWeight: 600, lineHeight: 1.6, marginBottom: 12 }}>
                  {t("Before you continue, download a JSON backup and keep it somewhere safe.")}
                </div>
                <ActionGroup>
                  <ActionRow
                    icon={<ActionIcon paths={IC.download} />}
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
                  <span style={{ fontSize: 13, color: SC.text }}>{t("I have a backup in a safe place")}</span>
                </label>
                <div style={{ marginTop: 14 }}>
                  <ActionGroup>
                    <ActionRow label={t("Next")} tone="neutral" onClick={() => setStep(2)} disabled={!haveBackup} chevron />
                  </ActionGroup>
                </div>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button onClick={() => setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  {t("Cancel")}
                </button>
              </>
            ) : (
              <>
                {/* STEP 2 — password ×2 + strength meter; STEP 3 (execution) = the same button with a spinner */}
                <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6, marginBottom: 12 }}>{t("Losing the password means losing your data — the server cannot reset it or decrypt your budget.")}</div>
                <input
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder={t("Encryption password (min. 10 characters)")}
                  autoComplete="new-password"
                  aria-label={t("Encryption password (min. 10 characters)")}
                  style={inputStyle(SC)}
                />
                <StrengthMeter pass={pass} />
                <input
                  type="password"
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                  placeholder={t("Repeat password")}
                  autoComplete="new-password"
                  aria-label={t("Repeat password")}
                  style={{ ...inputStyle(SC), marginTop: 10 }}
                />
                {pass2.length > 0 && pass2 !== pass && (
                  <div style={{ fontSize: 11.5, color: CORAL, marginTop: 6 }}>{t("Passwords do not match.")}</div>
                )}
                <div style={{ marginTop: 14 }}>
                  <ActionGroup>
                    <ActionRow
                      icon={<ActionIcon paths={IC.shield} />}
                      label={t("Encrypt and enable")}
                      onClick={() => void run()}
                      disabled={busy || passStrength(pass) === 0 || pass !== pass2}
                      busyLabel={busy ? t("Encrypting…") : undefined}
                    />
                  </ActionGroup>
                </div>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button onClick={() => setStep(1)} disabled={busy} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>
                  {t("Back")}
                </button>
              </>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}

/** E2ee tier panel: management rows (password change / pairing code / disable) + status below the group. */
function E2eeManage() {
  const C = useTheme();
  const { t } = useT();
  return (
    <>
      <ActionGroup>
        <E2eeChangePass />
        <E2eePairCode />
        <E2eeDisable />
      </ActionGroup>
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5, margin: "8px 4px 0" }}>{t("Enabled — the server stores only encrypted data and never knows your password or key.")}</div>
    </>
  );
}

/** Password change: old one verified by unwrapping wrappedDek from GET /sync2/snapshot. */
function E2eeChangePass() {
  const { t } = useT();
  const [sheet, setSheet] = useState(false);
  const [oldPass, setOldPass] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const open = () => {
    setOldPass("");
    setPass("");
    setPass2("");
    setError(null);
    setDone(false);
    setSheet(true);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      // MULTI-TENANT GUARD — /sync2/rekey rewrites the SESSION budget's key envelope, and the
      // unwrap below puts that budget's DEK on this device (e2ee.setDek). On a device holding
      // ANOTHER account's replica that key is not just useless, it is dangerous: the sync guard
      // would otherwise be left with a DEK that opens the session's checkpoint by construction.
      // Same class as enable/disable — the replica must be proven ours BEFORE we touch either.
      const userId = await assertOwnReplica();
      const snap = await api.e2eeSnapshot();
      if (!snap.wrappedDek || !snap.kdfParams) throw new Error(t("Wrong encryption password."));
      let dek: Uint8Array;
      try {
        const kp = JSON.parse(snap.kdfParams) as KdfParams;
        const kek = await deriveKek(oldPass, fromB64(kp.saltB64), kp);
        dek = await unwrapDek(snap.wrappedDek, kek); // wrong password = GCM rejects
      } catch {
        setError(t("Wrong encryption password."));
        return;
      }
      const salt = generateSalt();
      const newKek = await deriveKek(pass, salt, DEFAULT_KDF_PARAMS);
      const wrappedDek = await wrapDek(dek, newKek);
      await api.e2eeRekey({ wrappedDek, kdfParams: freshKdfParams(salt), userId });
      e2ee.setDek(dek); // refresh the local DEK from the canonical unwrap (same key)
      setDone(true);
      setOldPass("");
      setPass("");
      setPass2("");
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionRow icon={<ActionIcon paths={IC.key} />} label={t("Change encryption password")} desc={t("new password for all devices")} onClick={open} />
      <Sheet show={sheet} onClose={() => !busy && setSheet(false)}>
        {(SC) => {
          const inputStyle: React.CSSProperties = {
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            borderRadius: 10,
            border: `1px solid ${SC.line}`,
            background: SC.bg,
            color: SC.text,
            fontSize: 14,
            fontFamily: font,
            outline: "none",
          };
          return (
            <div>
              <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 12 }}>{t("Change encryption password")}</div>
              <input type="password" value={oldPass} onChange={(e) => setOldPass(e.target.value)} placeholder={t("Current password")} autoComplete="current-password" aria-label={t("Current password")} style={inputStyle} />
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t("Encryption password (min. 10 characters)")} autoComplete="new-password" aria-label={t("Encryption password (min. 10 characters)")} style={{ ...inputStyle, marginTop: 10 }} />
              <StrengthMeter pass={pass} />
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder={t("Repeat password")} autoComplete="new-password" aria-label={t("Repeat password")} style={{ ...inputStyle, marginTop: 10 }} />
              {pass2.length > 0 && pass2 !== pass && (
                <div style={{ fontSize: 11.5, color: CORAL, marginTop: 6 }}>{t("Passwords do not match.")}</div>
              )}
              <div style={{ marginTop: 14 }}>
                <ActionGroup>
                  <ActionRow
                    icon={<ActionIcon paths={IC.key} />}
                    label={t("Change password")}
                    onClick={() => void run()}
                    disabled={busy || oldPass.length === 0 || passStrength(pass) === 0 || pass !== pass2}
                    busyLabel={busy ? t("Changing…") : undefined}
                  />
                </ActionGroup>
              </div>
              {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
              {done && <div style={{ fontSize: 12, color: INCOME, marginTop: 10, lineHeight: 1.5 }}>{t("Password changed.")}</div>}
              <button onClick={() => !busy && setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {t("Close")}
              </button>
            </div>
          );
        }}
      </Sheet>
    </>
  );
}

/** Pairing code: QR (qrcode-generator → SVG) + `enveo1.…` text with copying. */
function E2eePairCode() {
  const { t } = useT();
  const [sheet, setSheet] = useState(false);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const open = () => {
    const dek = e2ee.getDek();
    // budgetId: known from the v1 era or from the budgets entity in the replica (pure v2 bootstrap)
    const budgetId = store.getBudgetId() || store.getLedger()?.budgets?.[0]?.id || "";
    setCode(dek && budgetId ? encodePairing(dek, budgetId) : null);
    setCopied(false);
    setSheet(true);
  };

  const svg = useMemo(() => {
    if (!code) return null;
    const qr = qrcode(0, "M");
    qr.addData(code);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [code]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* clipboard unavailable (e.g. no gesture) — the code can be selected manually */
    }
  };

  return (
    <>
      <ActionRow icon={<ActionIcon paths={IC.qr} />} label={t("Pairing code")} desc={t("unlock the budget on a new device without the password")} onClick={open} />
      <Sheet show={sheet} onClose={() => setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 8 }}>{t("Pairing code")}</div>
            <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6, marginBottom: 14 }}>{t("This code contains your encryption key in plain form. Show it only on your own trusted device — anyone with the code can read the budget.")}</div>
            {code && svg ? (
              <>
                {/* white background under the QR — readable in dark mode too */}
                <div style={{ background: "#fff", padding: 12, borderRadius: 12, maxWidth: 220, margin: "0 auto 14px" }} dangerouslySetInnerHTML={{ __html: svg }} />
                <div style={{ fontSize: 10.5, fontFamily: "ui-monospace, monospace", color: SC.soft, wordBreak: "break-all", lineHeight: 1.5, userSelect: "all", background: SC.bg, border: `1px solid ${SC.line}`, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                  {code}
                </div>
                <ActionGroup>
                  <ActionRow label={copied ? t("Copied.") : t("Copy code")} onClick={() => void copy()} />
                </ActionGroup>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6 }}>{t("Pairing code unavailable — no key on this device.")}</div>
            )}
            <button onClick={() => setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {t("Close")}
            </button>
          </div>
        )}
      </Sheet>
    </>
  );
}

/**
 * E2EE disable: type the confirmation word (the wipe/"DELETE" pattern) → the server reconstructs
 * plaintext. The typed word is LOCALIZED (`e2ee.disableWord`) and matched here on the device; the
 * POST always carries the fixed ASCII constant E2EE_DISABLE_CONFIRM — gating on the wire literal
 * would demand Polish characters (Ł/Ą) from every locale.
 */
function E2eeDisable() {
  const { t } = useT();
  const [sheet, setSheet] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const ledger = store.getLedger();
      if (!ledger) throw new Error(t("There is nothing to export yet — wait for the app to finish loading."));
      // MULTI-TENANT GUARD — /e2ee/disable ships the ENTIRE plaintext ledger and the server
      // rebuilds the session budget's rows from it: a full-budget overwrite (see assertOwnReplica).
      // The verified user id travels WITH the write — the check and the upload are two requests.
      const userId = await assertOwnReplica();
      const { epoch } = await api.e2eeDisable({ confirm: E2EE_DISABLE_CONFIRM, ledger, userId });
      // return to the v1 path ONLY after server success; the local replica stays
      e2ee.clearDek();
      e2ee.setTierMeta({ tier: "plain", epoch });
      e2ee.resetOpsCounter();
      setSheet(false);
      void fullResync(); // v1 sync starts: fresh snapshot (canonical cursor/budgetId) + outbox replay
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionRow
        icon={<ActionIcon paths={IC.shieldOff} />}
        label={t("Disable encryption")}
        desc={t("the server will store your data in plain form again")}
        tone="danger"
        onClick={() => { setText(""); setError(null); setSheet(true); }}
      />
      <Sheet show={sheet} onClose={() => !busy && setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: CORAL, marginBottom: 8 }}>{t("Disable end-to-end encryption?")}</div>
            <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 14 }}>{t("Your data will be decrypted and stored on the server in plain form (as before enabling). Make sure you have a current backup.")}</div>
            <div style={{ fontSize: 11, color: SC.mute, marginBottom: 6 }}>
              <ConfirmWordHint word={t("DISABLE-E2EE")} />
            </div>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder={t("DISABLE-E2EE")}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid var(--danger-66)`, background: SC.bg, color: SC.text, fontSize: 14, fontFamily: font, outline: "none", marginBottom: 12 }}
            />
            <ActionGroup>
              <ActionRow
                label={t("Disable end-to-end encryption")}
                tone="danger"
                onClick={() => void run()}
                disabled={busy || text.trim().toUpperCase() !== t("DISABLE-E2EE")}
                busyLabel={busy ? t("Disabling…") : undefined}
              />
            </ActionGroup>
            {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
            <button onClick={() => !busy && setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {t("Cancel")}
            </button>
          </div>
        )}
      </Sheet>
    </>
  );
}
