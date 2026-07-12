import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { api, apiErrorMessage, useLedgerVersion } from "../../lib/api";
import { hasSession, signOutKeepingReplica } from "../../lib/auth";
import { DEFAULT_KDF_PARAMS, deriveKek, encodePairing, generateDek, generateSalt, unwrapDek, wrapDek, type KdfParams } from "../../lib/crypto";
import { exportBackup, importBackup } from "../../lib/data";
import * as e2ee from "../../lib/e2ee";
import * as persist from "../../lib/persist";
import { assertOwnReplica, enterLoginKeepingReplica, fullResync, syncNow } from "../../lib/sync";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { store } from "../../lib/store";
import { CORAL, INCOME, font } from "../../lib/theme";
import { Sheet } from "../../components/chrome";
import { ActionGroup, ActionIcon, ActionRow, Eyebrow, writeErrorMessage } from "./ui";

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
 * Logout — visible ONLY when the backend confirms a session (hasSession()).
 *
 * It does NOT wipe the local replica (spec §3, binding owner decision): the ledger mirror, the
 * DEK and — crucially — every op still queued in the durable outbox stay on the device, so a
 * sign-out while offline (or with a failing push) cannot silently throw unsynced data away, and a
 * replica that is the last copy of its budget (local mode "wiped") survives. Signing back in
 * resumes exactly where it stopped; a DIFFERENT account signing in is handled by the multi-tenant
 * guard in sync.ts (the foreign replica is neither rendered nor written anywhere, and the human
 * decides its fate). Deleting the local copy on purpose remains available: Settings → Clear local
 * data (Advanced).
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

  const doLogout = async () => {
    if (!window.confirm(t("auth.logoutConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await signOutKeepingReplica(enterLoginKeepingReplica); // sign out → Login; the replica stays
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <Eyebrow>{t("settings.groupAccount")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.logout} />}
          label={t("auth.logout")}
          desc={t("auth.logoutHelp")}
          tone="danger"
          onClick={() => void doLogout()}
          disabled={busy}
          busyLabel={busy ? t("auth.loggingOut") : undefined}
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
      setDone(t("settings.exportDone"));
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow selecting the same file again
    if (!file) return;
    if (!window.confirm(t("settings.importConfirm"))) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await importBackup(file);
      setDone(t("settings.importDone"));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <Eyebrow>{t("settings.groupBackup")}</Eyebrow>
      <ActionGroup>
        <ActionRow icon={<ActionIcon paths={IC.download} />} label={t("settings.exportBtn")} desc={t("settings.exportHelp")} onClick={doExport} />
        <ActionRow
          icon={<ActionIcon paths={IC.upload} />}
          label={t("settings.importBtn")}
          desc={t("settings.importHelp")}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          busyLabel={busy ? t("settings.importing") : undefined}
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
 * disable (literal WYŁĄCZ-E2EE). Crypto ENTIRELY on the device
 * (lib/crypto.ts) — the server receives only wrappedDek+kdfParams+ciphertexts. */

const E2EE_DISABLE_WORD = "WYŁĄCZ-E2EE"; // literal required by the server (z.literal)

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
  const labels = [t("e2ee.strengthTooShort"), t("e2ee.strengthWeak"), t("e2ee.strengthGood"), t("e2ee.strengthStrong")];
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
      <Eyebrow>{t("settings.groupPrivacy")}</Eyebrow>
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
      if (!ledger) throw new Error(t("settings.exportNotReady"));
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
      setError(`${t("e2ee.enableFailed")} ${writeErrorMessage(e, t)}`);
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
        <ActionRow icon={<ActionIcon paths={IC.shield} />} label={t("e2ee.enableBtn")} desc={t("e2ee.enableHelp")} onClick={open} chevron />
      </ActionGroup>

      <Sheet show={sheet} onClose={() => !busy && setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 6 }}>{t("e2ee.wizTitle")}</div>
            {step === 1 ? (
              <>
                {/* STEP 1 — explanation + FORCED JSON export (Next disabled without the checkbox) */}
                <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 12 }}>{t("e2ee.wizIntro")}</div>
                <div style={{ fontSize: 12.5, color: SC.text, fontWeight: 600, lineHeight: 1.6, marginBottom: 12 }}>
                  {t("e2ee.wizBackupFirst")}
                </div>
                <ActionGroup>
                  <ActionRow
                    icon={<ActionIcon paths={IC.download} />}
                    label={t("settings.exportBtn")}
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
                  <span style={{ fontSize: 13, color: SC.text }}>{t("e2ee.haveBackup")}</span>
                </label>
                <div style={{ marginTop: 14 }}>
                  <ActionGroup>
                    <ActionRow label={t("e2ee.next")} tone="neutral" onClick={() => setStep(2)} disabled={!haveBackup} chevron />
                  </ActionGroup>
                </div>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button onClick={() => setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <>
                {/* STEP 2 — password ×2 + strength meter; STEP 3 (execution) = the same button with a spinner */}
                <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6, marginBottom: 12 }}>{t("e2ee.lossWarning")}</div>
                <input
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder={t("e2ee.passNew")}
                  autoComplete="new-password"
                  aria-label={t("e2ee.passNew")}
                  style={inputStyle(SC)}
                />
                <StrengthMeter pass={pass} />
                <input
                  type="password"
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                  placeholder={t("e2ee.passRepeat")}
                  autoComplete="new-password"
                  aria-label={t("e2ee.passRepeat")}
                  style={{ ...inputStyle(SC), marginTop: 10 }}
                />
                {pass2.length > 0 && pass2 !== pass && (
                  <div style={{ fontSize: 11.5, color: CORAL, marginTop: 6 }}>{t("e2ee.passMismatch")}</div>
                )}
                <div style={{ marginTop: 14 }}>
                  <ActionGroup>
                    <ActionRow
                      icon={<ActionIcon paths={IC.shield} />}
                      label={t("e2ee.enableRun")}
                      onClick={() => void run()}
                      disabled={busy || passStrength(pass) === 0 || pass !== pass2}
                      busyLabel={busy ? t("e2ee.enabling") : undefined}
                    />
                  </ActionGroup>
                </div>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button onClick={() => setStep(1)} disabled={busy} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>
                  {t("common.back")}
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
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5, margin: "8px 4px 0" }}>{t("e2ee.statusOn")}</div>
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
      if (!snap.wrappedDek || !snap.kdfParams) throw new Error(t("e2ee.wrongPass"));
      let dek: Uint8Array;
      try {
        const kp = JSON.parse(snap.kdfParams) as KdfParams;
        const kek = await deriveKek(oldPass, fromB64(kp.saltB64), kp);
        dek = await unwrapDek(snap.wrappedDek, kek); // wrong password = GCM rejects
      } catch {
        setError(t("e2ee.wrongPass"));
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
      setError(writeErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionRow icon={<ActionIcon paths={IC.key} />} label={t("e2ee.changePassBtn")} desc={t("e2ee.changePassDesc")} onClick={open} />
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
              <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 12 }}>{t("e2ee.changePassBtn")}</div>
              <input type="password" value={oldPass} onChange={(e) => setOldPass(e.target.value)} placeholder={t("e2ee.passOld")} autoComplete="current-password" aria-label={t("e2ee.passOld")} style={inputStyle} />
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t("e2ee.passNew")} autoComplete="new-password" aria-label={t("e2ee.passNew")} style={{ ...inputStyle, marginTop: 10 }} />
              <StrengthMeter pass={pass} />
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder={t("e2ee.passRepeat")} autoComplete="new-password" aria-label={t("e2ee.passRepeat")} style={{ ...inputStyle, marginTop: 10 }} />
              {pass2.length > 0 && pass2 !== pass && (
                <div style={{ fontSize: 11.5, color: CORAL, marginTop: 6 }}>{t("e2ee.passMismatch")}</div>
              )}
              <div style={{ marginTop: 14 }}>
                <ActionGroup>
                  <ActionRow
                    icon={<ActionIcon paths={IC.key} />}
                    label={t("e2ee.changePassRun")}
                    onClick={() => void run()}
                    disabled={busy || oldPass.length === 0 || passStrength(pass) === 0 || pass !== pass2}
                    busyLabel={busy ? t("e2ee.changing") : undefined}
                  />
                </ActionGroup>
              </div>
              {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
              {done && <div style={{ fontSize: 12, color: INCOME, marginTop: 10, lineHeight: 1.5 }}>{t("e2ee.passChanged")}</div>}
              <button onClick={() => !busy && setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {t("common.close")}
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
      <ActionRow icon={<ActionIcon paths={IC.qr} />} label={t("e2ee.pairShowBtn")} desc={t("e2ee.pairDesc")} onClick={open} />
      <Sheet show={sheet} onClose={() => setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 8 }}>{t("e2ee.pairShowBtn")}</div>
            <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6, marginBottom: 14 }}>{t("e2ee.pairWarning")}</div>
            {code && svg ? (
              <>
                {/* white background under the QR — readable in dark mode too */}
                <div style={{ background: "#fff", padding: 12, borderRadius: 12, maxWidth: 220, margin: "0 auto 14px" }} dangerouslySetInnerHTML={{ __html: svg }} />
                <div style={{ fontSize: 10.5, fontFamily: "ui-monospace, monospace", color: SC.soft, wordBreak: "break-all", lineHeight: 1.5, userSelect: "all", background: SC.bg, border: `1px solid ${SC.line}`, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                  {code}
                </div>
                <ActionGroup>
                  <ActionRow label={copied ? t("e2ee.pairCopied") : t("e2ee.pairCopy")} onClick={() => void copy()} />
                </ActionGroup>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6 }}>{t("e2ee.pairUnavailable")}</div>
            )}
            <button onClick={() => setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {t("common.close")}
            </button>
          </div>
        )}
      </Sheet>
    </>
  );
}

/** E2EE disable: the WYŁĄCZ-E2EE literal (USUŃ pattern) → the server reconstructs plaintext. */
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
      if (!ledger) throw new Error(t("settings.exportNotReady"));
      // MULTI-TENANT GUARD — /e2ee/disable ships the ENTIRE plaintext ledger and the server
      // rebuilds the session budget's rows from it: a full-budget overwrite (see assertOwnReplica).
      // The verified user id travels WITH the write — the check and the upload are two requests.
      const userId = await assertOwnReplica();
      const { epoch } = await api.e2eeDisable({ confirm: E2EE_DISABLE_WORD, ledger, userId });
      // return to the v1 path ONLY after server success; the local replica stays
      e2ee.clearDek();
      e2ee.setTierMeta({ tier: "plain", epoch });
      e2ee.resetOpsCounter();
      setSheet(false);
      void fullResync(); // v1 sync starts: fresh snapshot (canonical cursor/budgetId) + outbox replay
    } catch (e) {
      setError(writeErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionRow
        icon={<ActionIcon paths={IC.shieldOff} />}
        label={t("e2ee.disableBtn")}
        desc={t("e2ee.disableDesc")}
        tone="danger"
        onClick={() => { setText(""); setError(null); setSheet(true); }}
      />
      <Sheet show={sheet} onClose={() => !busy && setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: CORAL, marginBottom: 8 }}>{t("e2ee.disableTitle")}</div>
            <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 14 }}>{t("e2ee.disableBody")}</div>
            <div style={{ fontSize: 11, color: SC.mute, marginBottom: 6 }}>
              {t("settings.wipeTypePrompt1")} <b>{t("e2ee.disableWord")}</b>
              {t("settings.wipeTypePrompt2")}
            </div>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder={t("e2ee.disableWord")}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, border: `1px solid var(--danger-66)`, background: SC.bg, color: SC.text, fontSize: 14, fontFamily: font, outline: "none", marginBottom: 12 }}
            />
            <ActionGroup>
              <ActionRow
                label={t("e2ee.disableRun")}
                tone="danger"
                onClick={() => void run()}
                disabled={busy || text.trim().toUpperCase() !== E2EE_DISABLE_WORD}
                busyLabel={busy ? t("e2ee.disabling") : undefined}
              />
            </ActionGroup>
            {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
            <button onClick={() => !busy && setSheet(false)} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 11, border: "none", background: "transparent", color: SC.soft, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {t("common.cancel")}
            </button>
          </div>
        )}
      </Sheet>
    </>
  );
}
