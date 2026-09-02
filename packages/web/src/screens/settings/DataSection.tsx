import { type ClientLedger, E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "../../components/chrome";
import { api, apiErrorMessage, useLedgerVersion } from "../../lib/api";
import { hasSession } from "../../lib/auth";
import { useTheme } from "../../lib/contexts";
import {
  DEFAULT_KDF_PARAMS,
  dekWrapAadContext,
  deriveKek,
  encodePairing,
  freshKdfParams,
  generateDek,
  generateSalt,
  type KdfParams,
  unwrapDek,
  wrapDek,
} from "../../lib/crypto";
import { exportBackup, importBackup } from "../../lib/data";
import * as e2ee from "../../lib/e2ee";
import { prepareDisableCredentialAction, prepareEnableCredentialAction } from "../../lib/e2eeCredentialCeremonies";
import { useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import * as persist from "../../lib/persist";
import { completeExplicitSignOut, ExplicitSignOutPendingError, type SignOutPreparation } from "../../lib/signOut";
import { store } from "../../lib/store";
import { assertOwnReplica, broadcastKeysChanged, fullResync, syncNow } from "../../lib/sync";
import { CORAL, font } from "../../lib/theme";
import { DataToolsSection } from "./DataTools";
import { E2eeUpgradePanel } from "./E2eeUpgradePanel";
import { SyncSection } from "./SyncSection";
import { ActionGroup, ActionIcon, ActionRow, ConfirmWordHint, Eyebrow, Helper } from "./ui";

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
      <SyncSection />
      <DataBackup />
      <DataToolsSection />
    </div>
  );
}

export function PrivacySection() {
  const { t } = useT();
  return (
    <div style={{ marginTop: 4 }}>
      <Helper>{t("Encryption settings apply to this budget and follow it across devices.")}</Helper>
      <Helper>
        {t(
          "On a new device, enter the encryption password once to unlock both the budget and its encrypted Own OpenAI key. Enveo cannot recover either if you lose the password, every unlocked device, all pairing codes and your backups.",
        )}
      </Helper>
      <E2eeSection />
    </div>
  );
}

export function LogoutSection() {
  return <LogoutRow />;
}

/**
 * The explicit-sign-out state machine — shared by the phone row (`LogoutRow` below) and the wide
 * Settings Account section's bordered card (design parity wave E task 3,
 * `components/wide/WideSettings.tsx`): presentation differs per surface, the underlying handler
 * (`completeExplicitSignOut`/`ExplicitSignOutPendingError`, `lib/signOut.ts` — the SAME one the
 * rail popover's `LogoutMenuRow` already calls, design parity wave A task A3) does not.
 */
export function useLogoutFlow() {
  const [session, setSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Exclude<SignOutPreparation, { kind: "ready" }> | null>(null);
  useEffect(() => {
    void hasSession().then(setSession);
  }, []);

  const finish = async (decision: "retry" | "export" | "discard") => {
    setBusy(true);
    setError(null);
    try {
      await completeExplicitSignOut(decision);
    } catch (e) {
      if (e instanceof ExplicitSignOutPendingError) {
        setPending(e.preparation);
        setBusy(false);
        return;
      }
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return { session, busy, error, pending, finish };
}

/** Explicit sign-out is identical for cloud and self-hosted deployments. */
function LogoutRow() {
  const { t } = useT();
  const { session, busy, error, pending, finish } = useLogoutFlow();
  if (!session) return null;

  const doLogout = () => {
    if (!window.confirm(t("Sign out and remove this account's local data from this device? Your data already on the server will stay there."))) return;
    void finish("retry");
  };

  const discardPending = () => {
    if (!window.confirm(t("Discard the unsent changes and sign out? This cannot be undone."))) return;
    void finish("discard");
  };

  return (
    <div style={{ marginTop: 18 }}>
      <Eyebrow>{t("Account")}</Eyebrow>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.logout} />}
          label={t("Sign out")}
          desc={t("Signs you out and removes this account's local copy, encryption keys, and credentials from the device.")}
          tone="danger"
          onClick={() => void doLogout()}
          disabled={busy}
          busyLabel={busy ? t("Signing out…") : undefined}
        />
      </ActionGroup>
      {pending && (
        <div style={{ margin: "10px 4px 0", padding: 12, borderRadius: 11, border: `1px solid ${CORAL}55` }}>
          <div style={{ fontSize: 12, color: CORAL, lineHeight: 1.55, marginBottom: 10 }}>
            {t("{count} unsent changes are still on this device. Retry when online, export a backup, or explicitly discard them.", { count: pending.count })}
          </div>
          <ActionGroup>
            <ActionRow label={t("Retry sending changes")} onClick={() => void finish("retry")} disabled={busy} />
            {pending.kind === "pending" && <ActionRow label={t("Export backup and sign out")} onClick={() => void finish("export")} disabled={busy} />}
            <ActionRow label={t("Discard unsent changes and sign out")} tone="danger" onClick={discardPending} disabled={busy} />
          </ActionGroup>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: CORAL, margin: "8px 4px 0", lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

/** JSON backup export / import. */
function DataBackup() {
  const C = useTheme();
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
        <ActionRow
          icon={<ActionIcon paths={IC.download} />}
          label={t("Export backup (JSON)")}
          desc={t("Downloads all your data as a file. Keep a backup before destructive changes.")}
          onClick={doExport}
        />
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

      {error && <div style={{ fontSize: 12, color: C.neg, margin: "8px 4px 0", lineHeight: 1.5 }}>{error}</div>}
      {done && <div style={{ fontSize: 12, color: C.pos, margin: "8px 4px 0", lineHeight: 1.5 }}>{done}</div>}
    </div>
  );
}

/* ── End-to-end encryption (E2EE) ─────────────────────────────────────
 * Plain tier → enable wizard (sheet: forced JSON export + "I have a backup"
 * checkbox, then password ×2 with a strength meter; execution with a spinner).
 * E2ee tier → panel: password change, pairing code (QR + text for pasting),
 * disable (type the localized confirmation word). Crypto ENTIRELY on the device
 * (lib/crypto.ts) — the server receives only wrappedDek+kdfParams+ciphertexts. */

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Enveo AI cannot operate after the server becomes blind. Put the fallback in
 * the exact replica encrypted by the enable request, without mutating the live
 * plain replica if the ceremony fails before the server accepts it. */
export function prepareLedgerForE2eeEnable(ledger: ClientLedger): ClientLedger {
  const active = ledger.budgets[0];
  if (active?.preferences.aiProvider !== "enveo") return ledger;
  return {
    ...ledger,
    budgets: ledger.budgets.map((budget, index) => (index === 0 ? { ...budget, preferences: { ...budget.preferences, aiProvider: "rules" } } : budget)),
  };
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
  const colors = [C.neg, C.neg, C.warn, C.pos] as const;
  const labels = [t("Too short (min. 10 characters)"), t("Weak"), t("Good"), t("Strong")];
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: s >= i ? colors[s] : C.line }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: s === 0 ? C.neg : C.soft, marginTop: 4 }}>{labels[s]}</div>
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
  const budgetId = store.getBudgetId() || store.getLedger()?.budgets[0]?.id || "";
  const [hasServerCredential, setHasServerCredential] = useState(false);
  useEffect(() => {
    let current = true;
    if (budgetId)
      void api.byokCredentialStatus(budgetId).then(
        (status) => current && setHasServerCredential(status.configured),
        () => {},
      );
    return () => {
      current = false;
    };
  }, [budgetId]);
  const [sheet, setSheet] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [haveBackup, setHaveBackup] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [openAIKey, setOpenAIKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setStep(1);
    setHaveBackup(false);
    setPass("");
    setPass2("");
    setOpenAIKey("");
    setError(null);
    setSheet(true);
  };

  const close = () => {
    if (busy) return;
    setOpenAIKey("");
    setPass("");
    setPass2("");
    setSheet(false);
  };

  const run = async () => {
    let submittedOpenAIKey = openAIKey;
    setOpenAIKey("");
    setBusy(true);
    setError(null);
    try {
      const currentLedger = store.getLedger();
      if (!currentLedger) throw new Error(t("There is nothing to export yet — wait for the app to finish loading."));
      const ledger = prepareLedgerForE2eeEnable(currentLedger);
      // MULTI-TENANT GUARD — /e2ee/enable uploads a snapshot of THIS replica and flips the
      // SESSION budget's tier under this device's wrappedDek: a full-budget overwrite, exactly
      // like /sync/replace. It is reachable from a tab whose cookie was swapped by a sign-in
      // elsewhere, and from a replica whose owner sync refuses to establish. The verified user id
      // travels WITH the write (userId) — Argon2id + encrypting the whole ledger takes seconds,
      // and the cookie can be swapped in that window; the server refuses a mismatch.
      const userId = await assertOwnReplica();
      // The v2 contexts need the budget id — a plain replica always names its own (fail-closed
      // otherwise, same code the sync guard uses for a replica it cannot attribute).
      const budgetId = store.getBudgetId();
      if (!budgetId) throw new Error("foreign_replica");
      // crypto ON THE DEVICE: fresh DEK + KEK from the password (Argon2id) + ciphertext of the
      // whole replica, both bound to the NEXT epoch (enable bumps it — the server refuses a
      // stale expectation, and one retry recomputes from the fresh meta the 409 delivered).
      const salt = generateSalt();
      const dek = generateDek();
      const kek = await deriveKek(pass, salt, DEFAULT_KDF_PARAMS);
      const credentialStatus = await api.byokCredentialStatus(budgetId);
      setHasServerCredential(credentialStatus.configured);
      let epoch: number;
      for (let attempt = 0; ; attempt++) {
        const nextEpoch = e2ee.getTierMeta().epoch + 1;
        const wrappedDek = await wrapDek(dek, kek, dekWrapAadContext(budgetId, nextEpoch));
        const snapshotBlob = await e2ee.encryptSnapshot(ledger, dek, { budgetId, epoch: nextEpoch, uptoSeq: 0 });
        const credentialAction = await prepareEnableCredentialAction({
          configured: credentialStatus.configured,
          key: submittedOpenAIKey,
          budgetId,
          nextEpoch,
          dek,
        });
        try {
          ({ epoch } = await api.e2eeEnable({
            wrappedDek,
            kdfParams: freshKdfParams(salt),
            snapshotBlob,
            userId,
            budgetId,
            nextEpoch,
            credentialAction,
          }));
          break;
        } catch (err) {
          // 409 tier_mismatch with tier "plain" = only our epoch expectation was stale
          // (a fresh device may not know the budget's current epoch): adopt it, retry ONCE.
          const m = /\{.*\}$/s.exec(String((err as Error).message ?? ""));
          const body = m ? (JSON.parse(m[0]) as { error?: string; tier?: string; epoch?: number }) : null;
          if (attempt === 0 && body?.error === "tier_mismatch" && body.tier === "plain") {
            e2ee.setTierMeta({ tier: "plain", epoch: body.epoch ?? 0 });
            continue;
          }
          throw err;
        }
      }
      // local flip ONLY after server success (error above ⇒ nothing changed, replica untouched)
      // the v1 cursor makes no sense in the v2 journal (e2ee_ops counts seq from 1) —
      // the checkpoint from enable represents exactly THIS replica at seq 0
      store.replace(ledger, 0, store.getBudgetId() ?? "");
      // Append the downgrade after any old queued preference operation. The server snapshot
      // already contains rules atomically with the tier flip; this final op prevents a stale
      // pre-enable Enveo selection from winning when the preserved outbox drains.
      if (currentLedger.budgets[0]?.preferences.aiProvider === "enveo") {
        local.updateBudgetPreferences(budgetId, { aiProvider: "rules" });
      }
      e2ee.setDek(dek, epoch); // validated for the epoch the ciphertexts were bound to
      e2ee.setTierMeta({ tier: "e2ee", epoch });
      e2ee.setCipherVersion(2);
      e2ee.resetOpsCounter();
      void persist.persistLedger(store.snapshotForPersist());
      void broadcastKeysChanged(); // peer tabs pick up the fresh key state before their next cycle
      void syncNow("e2ee-enable"); // backlogged outbox ops go out via a normal v2 push
      setOpenAIKey("");
      setSheet(false); // the section switches to the e2ee panel (statusOn = confirmation)
    } catch (e) {
      setError(`${t("Enabling failed — nothing was changed, your data stays as it was.")} ${apiErrorMessage(e)}`);
    } finally {
      submittedOpenAIKey = "";
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
  });

  return (
    <>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.shield} />}
          label={t("Enable end-to-end encryption")}
          desc={
            hasServerCredential
              ? t(
                  "Your Own OpenAI key will move into the encrypted budget. Re-enter it once because the server vault cannot return the old key; Enveo will store only ciphertext after the switch.",
                )
              : t("Budget data will be encrypted on your device before it reaches the server. Server-side features will be unavailable.")
          }
          onClick={open}
          chevron
        />
      </ActionGroup>

      <Sheet show={sheet} onClose={close}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 6 }}>{t("Enable end-to-end encryption")}</div>
            {step === 1 ? (
              <>
                {/* STEP 1 — explanation + FORCED JSON export (Next disabled without the checkbox) */}
                <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 12 }}>
                  {t(
                    "Once enabled, the server stores ciphertexts only. The key is your password, which the server does NOT know — without it (or a pairing code from another unlocked device) the data cannot be recovered.",
                  )}
                </div>
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
                  <input
                    type="checkbox"
                    checked={haveBackup}
                    onChange={(e) => setHaveBackup(e.target.checked)}
                    style={{ width: 18, height: 18, flexShrink: 0 }}
                  />
                  <span style={{ fontSize: 13, color: SC.text }}>{t("I have a backup in a safe place")}</span>
                </label>
                <div style={{ marginTop: 14 }}>
                  <ActionGroup>
                    <ActionRow label={t("Next")} tone="neutral" onClick={() => setStep(2)} disabled={!haveBackup} chevron />
                  </ActionGroup>
                </div>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button
                  onClick={close}
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
                  {t("Cancel")}
                </button>
              </>
            ) : (
              <>
                {/* STEP 2 — password ×2 + strength meter; STEP 3 (execution) = the same button with a spinner */}
                <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6, marginBottom: 12 }}>
                  {t("Losing the password means losing your data — the server cannot reset it or decrypt your budget.")}
                </div>
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
                {hasServerCredential && (
                  <input
                    type="password"
                    value={openAIKey}
                    onChange={(e) => setOpenAIKey(e.target.value)}
                    placeholder={t("Re-enter your OpenAI API key")}
                    autoComplete="off"
                    aria-label={t("Re-enter your OpenAI API key")}
                    style={{ ...inputStyle(SC), marginTop: 10 }}
                  />
                )}
                <input
                  type="password"
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                  placeholder={t("Repeat password")}
                  autoComplete="new-password"
                  aria-label={t("Repeat password")}
                  style={{ ...inputStyle(SC), marginTop: 10 }}
                />
                {pass2.length > 0 && pass2 !== pass && <div style={{ fontSize: 11.5, color: CORAL, marginTop: 6 }}>{t("Passwords do not match.")}</div>}
                <div style={{ marginTop: 14 }}>
                  <ActionGroup>
                    <ActionRow
                      icon={<ActionIcon paths={IC.shield} />}
                      label={t("Encrypt and enable")}
                      onClick={() => void run()}
                      disabled={busy || passStrength(pass) === 0 || pass !== pass2 || (hasServerCredential && openAIKey.trim().length === 0)}
                      busyLabel={busy ? t("Encrypting…") : undefined}
                    />
                  </ActionGroup>
                </div>
                {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
                <button
                  onClick={() => setStep(1)}
                  disabled={busy}
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
                    cursor: busy ? "default" : "pointer",
                  }}
                >
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

/** E2ee tier panel: management rows (password change / pairing code / disable) + status below the group.
 *  When the server reported a LEGACY v1-format budget (409 e2ee_upgrade_required → cipherVersion
 *  meta 1), the mandatory upgrade action leads the panel — sync is refused until it has run. */
function E2eeManage() {
  const C = useTheme();
  const { t } = useT();
  return (
    <>
      {e2ee.getCipherVersion() === 1 && <E2eeUpgradeRow />}
      <ActionGroup>
        <E2eeChangePass />
        <E2eePairCode />
        <E2eeDisable />
      </ActionGroup>
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5, margin: "8px 4px 0" }}>
        {t("Enabled — the server stores only encrypted data and never knows your password or key.")}
      </div>
      <div style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.5, margin: "8px 4px 0" }}>
        {t(
          "Own OpenAI is encrypted by the same budget key. After unlocking on another device it works there too, while Enveo still cannot decrypt the credential.",
        )}
      </div>
    </>
  );
}

/** The mandatory v1→v2 encryption upgrade — an ActionRow + sheet hosting the shared panel. */
function E2eeUpgradeRow() {
  const { t } = useT();
  const [sheet, setSheet] = useState(false);
  return (
    <div style={{ marginBottom: 10 }}>
      <ActionGroup>
        <ActionRow
          icon={<ActionIcon paths={IC.shield} />}
          label={t("Upgrade encryption")}
          desc={t("The server refuses to sync this budget until its encryption is upgraded to the new format.")}
          onClick={() => setSheet(true)}
          chevron
        />
      </ActionGroup>
      <Sheet show={sheet} onClose={() => setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 6 }}>{t("Upgrade encryption")}</div>
            {/* server already v2 (upgraded elsewhere) → the row itself disappears on the next
                render (cipherVersion meta flipped); just close the sheet */}
            <E2eeUpgradePanel onDone={() => setSheet(false)} onServerNowV2={() => setSheet(false)} />
          </div>
        )}
      </Sheet>
    </div>
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
      // A password change REWRAPS the SAME DEK under the SAME epoch — the ciphertexts in the
      // journal/checkpoint stay valid; only the password wrapping of the key changes. (The
      // full data-key rotation is the separate v1→v2 upgrade ceremony, not this flow.)
      const envelopeCtx = dekWrapAadContext(snap.budgetId, snap.epoch);
      let dek: Uint8Array;
      try {
        const kp = JSON.parse(snap.kdfParams) as KdfParams;
        const kek = await deriveKek(oldPass, fromB64(kp.saltB64), kp);
        dek = await unwrapDek(snap.wrappedDek, kek, envelopeCtx); // wrong password = GCM rejects
      } catch {
        setError(t("Wrong encryption password."));
        return;
      }
      const salt = generateSalt();
      const newKek = await deriveKek(pass, salt, DEFAULT_KDF_PARAMS);
      const wrappedDek = await wrapDek(dek, newKek, envelopeCtx);
      // expectedEpoch = the epoch envelopeCtx was built for — the server refuses any other
      // generation (a stale rewrap would brick every future unlock under the v2 AAD).
      await api.e2eeRekey({ wrappedDek, kdfParams: freshKdfParams(salt), userId, expectedEpoch: snap.epoch });
      e2ee.setDek(dek, snap.epoch); // same key, same epoch — the unwrap above validated it
      void broadcastKeysChanged(); // peer tabs re-read the (re-validated) key state
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
          };
          return (
            <div>
              <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 12 }}>{t("Change encryption password")}</div>
              <input
                type="password"
                value={oldPass}
                onChange={(e) => setOldPass(e.target.value)}
                placeholder={t("Current password")}
                autoComplete="current-password"
                aria-label={t("Current password")}
                style={inputStyle}
              />
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                placeholder={t("Encryption password (min. 10 characters)")}
                autoComplete="new-password"
                aria-label={t("Encryption password (min. 10 characters)")}
                style={{ ...inputStyle, marginTop: 10 }}
              />
              <StrengthMeter pass={pass} />
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
                    icon={<ActionIcon paths={IC.key} />}
                    label={t("Change password")}
                    onClick={() => void run()}
                    disabled={busy || oldPass.length === 0 || passStrength(pass) === 0 || pass !== pass2}
                    busyLabel={busy ? t("Changing…") : undefined}
                  />
                </ActionGroup>
              </div>
              {error && <div style={{ fontSize: 12, color: SC.neg, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
              {done && <div style={{ fontSize: 12, color: SC.pos, marginTop: 10, lineHeight: 1.5 }}>{t("Password changed.")}</div>}
              <button
                onClick={() => !busy && setSheet(false)}
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
  /** A key exists but is NOT validated for the current epoch — the honest reason, not "no key". */
  const [stale, setStale] = useState(false);

  const open = () => {
    const dek = e2ee.getDek();
    // budgetId: known from the v1 era or from the budgets entity in the replica (pure v2 bootstrap)
    const budgetId = store.getBudgetId() || store.getLedger()?.budgets?.[0]?.id || "";
    // A pairing code EXPORTS the raw key — only a key VALIDATED for the budget's current epoch
    // may leave the device (round 3, R3): in the stale-key window after an epoch adoption the
    // held key may belong to a DEAD generation, and handing it out would ship a code that can
    // never unlock anything (or worse, mislead the receiver about which generation it opens).
    const valid = e2ee.isDekValidForEpoch(e2ee.getTierMeta().epoch);
    setCode(dek && budgetId && valid ? encodePairing(dek, budgetId) : null);
    setStale(!!dek && !valid);
    setCopied(false);
    setSheet(true);
  };

  const qrSvg = useMemo(() => {
    if (!code) return null;
    const qr = qrcode(0, "M");
    qr.addData(code);
    qr.make();
    const size = qr.getModuleCount();
    const dark = [];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (qr.isDark(row, col)) dark.push(<rect key={`${row}:${col}`} x={col} y={row} width={1} height={1} />);
      }
    }
    return (
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t("Pairing code")} style={{ display: "block", width: "100%", height: "auto" }}>
        {dark}
      </svg>
    );
  }, [code, t]);

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
      <ActionRow
        icon={<ActionIcon paths={IC.qr} />}
        label={t("Pairing code")}
        desc={t("unlock the budget on a new device without the password")}
        onClick={open}
      />
      <Sheet show={sheet} onClose={() => setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 700, color: SC.text, marginBottom: 8 }}>{t("Pairing code")}</div>
            <div style={{ fontSize: 12.5, color: CORAL, lineHeight: 1.6, marginBottom: 14 }}>
              {t("This code contains your encryption key in plain form. Show it only on your own private device — anyone with the code can read the budget.")}
            </div>
            {code && qrSvg ? (
              <>
                {/* white background under the QR — readable in dark mode too */}
                <div style={{ background: "#fff", padding: 12, borderRadius: 12, maxWidth: 220, margin: "0 auto 14px" }}>{qrSvg}</div>
                <div
                  style={{
                    fontSize: 10.5,
                    fontFamily: "ui-monospace, monospace",
                    color: SC.soft,
                    wordBreak: "break-all",
                    lineHeight: 1.5,
                    userSelect: "all",
                    background: SC.bg,
                    border: `1px solid ${SC.line}`,
                    borderRadius: 10,
                    padding: 10,
                    marginBottom: 12,
                  }}
                >
                  {code}
                </div>
                <ActionGroup>
                  <ActionRow label={copied ? t("Copied.") : t("Copy code")} onClick={() => void copy()} />
                </ActionGroup>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6 }}>
                {stale
                  ? t(
                      "Pairing code unavailable — this device's key has not been confirmed for the budget's current encryption yet. Unlock again or let a sync finish first.",
                    )
                  : t("Pairing code unavailable — no key on this device.")}
              </div>
            )}
            <button
              onClick={() => setSheet(false)}
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
      const budgetId = store.getBudgetId();
      if (!budgetId) throw new Error("foreign_replica");
      const tierMeta = e2ee.getTierMeta();
      if (tierMeta.tier !== "e2ee") throw new Error("tier_mismatch");
      const dek = e2ee.requireValidatedDek(tierMeta.epoch);
      const credentialRecord = await api.e2eeByokCredentialGet(budgetId);
      const credentialAction = await prepareDisableCredentialAction({ record: credentialRecord, budgetId, epoch: tierMeta.epoch, dek });
      const { epoch } = await api.e2eeDisable({
        confirm: E2EE_DISABLE_CONFIRM,
        ledger,
        userId,
        budgetId,
        expectedEpoch: tierMeta.epoch,
        credentialAction,
      });
      // return to the v1 path ONLY after server success; the local replica stays
      e2ee.clearDek();
      void broadcastKeysChanged(); // peer tabs drop the retired key
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
        onClick={() => {
          setText("");
          setError(null);
          setSheet(true);
        }}
      />
      <Sheet show={sheet} onClose={() => !busy && setSheet(false)}>
        {(SC) => (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: CORAL, marginBottom: 8 }}>{t("Disable end-to-end encryption?")}</div>
            <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 14 }}>
              {t("Your data will be decrypted and stored on the server in plain form (as before enabling). Make sure you have a current backup.")}
            </div>
            <div style={{ fontSize: 12.5, color: SC.soft, lineHeight: 1.6, marginBottom: 14 }}>
              {t("If Own OpenAI is configured, its key moves from zero-knowledge ciphertext into the server vault in the same atomic operation.")}
            </div>
            <div style={{ fontSize: 11, color: SC.mute, marginBottom: 6 }}>
              <ConfirmWordHint word={t("DISABLE-E2EE")} />
            </div>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder={t("DISABLE-E2EE")}
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
                label={t("Disable end-to-end encryption")}
                tone="danger"
                onClick={() => void run()}
                disabled={busy || text.trim().toUpperCase() !== t("DISABLE-E2EE")}
                busyLabel={busy ? t("Disabling…") : undefined}
              />
            </ActionGroup>
            {error && <div style={{ fontSize: 12, color: CORAL, marginTop: 10, lineHeight: 1.5 }}>{error}</div>}
            <button
              onClick={() => !busy && setSheet(false)}
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
              {t("Cancel")}
            </button>
          </div>
        )}
      </Sheet>
    </>
  );
}
