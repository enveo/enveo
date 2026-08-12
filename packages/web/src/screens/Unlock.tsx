import { useState } from "react";
import { LogoMark } from "../components/chrome";
import { apiErrorMessage } from "../lib/api";
import { useTheme } from "../lib/contexts";
import { decodePairing, dekWrapAadContext, deriveKek, type KdfParams, unwrapDek } from "../lib/crypto";
import * as e2ee from "../lib/e2ee";
import { useT } from "../lib/i18n";
import { store } from "../lib/store";
import { broadcastKeysChanged, retryBoot } from "../lib/sync";
import { CORAL, font, TEAL } from "../lib/theme";
import { E2eeUpgradePanel } from "./settings/E2eeUpgradePanel";

/**
 * E2EE unlock screen (BootStatus "locked") — the budget is on the e2ee tier
 * and this device has no DEK. Two paths:
 *  - password: GET /sync2/snapshot → deriveKek(Argon2id) → unwrapDek under the envelope's
 *    authenticated context (budgetId, epoch) — a wrong password OR a lying context makes
 *    GCM reject the unwrap; verification = decrypting the checkpoint (blob) under its own
 *    (budgetId, epoch, uptoSeq) context MUST succeed → setDek → retryBoot,
 *  - pairing code "enveo1.…" pasted from a trusted device (Settings →
 *    Pairing code): decodePairing → budgetId validation (the code's budget is the TRUSTED
 *    expectation) → the same checkpoint verification → setDek → retryBoot.
 * QR-SCAN deliberately omitted (BarcodeDetector unreliable on iOS) — the code
 * is shown by the trusted device, here it's paste-only.
 *
 * 409 tier_mismatch (budget went back to plain before unlocking): tierMeta from
 * the body + retryBoot — boot takes the v1 path and the screen disappears keyless.
 *
 * 409 e2ee_upgrade_required (LEGACY v1-format budget): the dedicated upgrade state — never
 * "wrong password". Unlocking is impossible by design (the new build reads no v1 ciphertext);
 * a device that still holds a replica of the data runs the upgrade ceremony right here,
 * a device without one is pointed at the device that has it.
 */

interface Snap2 {
  budgetId?: string | null;
  epoch: number;
  cipherVersion?: number;
  wrappedDek: string | null;
  kdfParams: string | null;
  uptoSeq: number;
  blob: string | null;
}

const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** "Bad passphrase/key" signal (crypto), distinguishable from network errors. */
class BadKeyError extends Error {}

/** The server refuses every normal sync2 channel until the v1→v2 upgrade ceremony has run. */
class UpgradeRequiredSignal extends Error {}

/**
 * GET /api/sync2/snapshot; 409 tier_mismatch → tierMeta from the body + retryBoot
 * (returns null — the caller finishes without error, boot takes over on the right path);
 * 409 e2ee_upgrade_required → record the legacy format and throw the upgrade signal.
 */
async function fetchSnap2(): Promise<Snap2 | null> {
  const res = await fetch("/api/sync2/snapshot");
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: string; tier?: string; epoch?: number } | null;
    if (body?.error === "tier_mismatch" && (body.tier === "plain" || body.tier === "e2ee")) {
      e2ee.setTierMeta({ tier: body.tier, epoch: body.epoch ?? 0 });
      void retryBoot();
      return null;
    }
    if (body?.error === "e2ee_upgrade_required") {
      e2ee.setTierMeta({ tier: "e2ee", epoch: body.epoch ?? 0 });
      e2ee.setCipherVersion(1);
      throw new UpgradeRequiredSignal();
    }
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as Snap2;
}

/**
 * DEK verification against the checkpoint (if any) → setDek + tierMeta → retryBoot.
 * `expectedBudgetId` = the caller's authenticated expectation: the pairing code's budget
 * (trusted device) or the budget the key envelope's own unwrap just vouched for.
 */
async function acceptDek(dek: Uint8Array, snap: Snap2, expectedBudgetId: string): Promise<void> {
  if (snap.blob) {
    try {
      await e2ee.decryptSnapshot(snap.blob, dek, { budgetId: expectedBudgetId, epoch: snap.epoch, uptoSeq: snap.uptoSeq });
    } catch {
      throw new BadKeyError("dek does not decrypt the checkpoint");
    }
  }
  e2ee.setTierMeta({ tier: "e2ee", epoch: snap.epoch });
  e2ee.setCipherVersion(2);
  // Validated for exactly this epoch: the envelope unwrap (password path) or the checkpoint
  // decrypt above carried this epoch in its authenticated context.
  e2ee.setDek(dek, snap.epoch);
  void broadcastKeysChanged(); // other live tabs drop their stale key state
  await retryBoot();
}

export function UnlockScreen() {
  const C = useTheme();
  const { t } = useT();
  // The sync engine records the server's format BEFORE routing here (cipherVersion meta is
  // durable), so a legacy budget opens straight on the upgrade state — never "wrong password".
  const [mode, setMode] = useState<"pass" | "pair" | "upgrade">(e2ee.getCipherVersion() === 1 ? "upgrade" : "pass");
  const [pass, setPass] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const snap = await fetchSnap2();
      if (!snap) return; // tier went back to plain — retryBoot already on its way
      if (!snap.wrappedDek || !snap.kdfParams || !snap.budgetId) throw new BadKeyError("missing key envelope");
      let dek: Uint8Array;
      try {
        const kp = JSON.parse(snap.kdfParams) as KdfParams;
        const kek = await deriveKek(pass, unb64(kp.saltB64), kp);
        // Wrong password OR a context the envelope was not made for = GCM rejects. A successful
        // unwrap under (budgetId, epoch) is what authenticates those two response fields — only
        // the real budget's envelope for exactly this generation opens under them.
        dek = await unwrapDek(snap.wrappedDek, kek, dekWrapAadContext(snap.budgetId, snap.epoch));
      } catch {
        throw new BadKeyError("wrong password");
      }
      await acceptDek(dek, snap, snap.budgetId);
    } catch (e) {
      if (e instanceof UpgradeRequiredSignal) {
        setMode("upgrade");
        return;
      }
      setError(e instanceof BadKeyError ? t("Wrong encryption password.") : apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doPair = async () => {
    setBusy(true);
    setError(null);
    try {
      let dek: Uint8Array;
      let codeBudgetId: string;
      try {
        const decoded = decodePairing(code.trim());
        dek = decoded.dek;
        codeBudgetId = decoded.budgetId;
      } catch {
        setError(t("Invalid pairing code."));
        return;
      }
      const known = store.getBudgetId();
      if (known && known !== codeBudgetId) {
        setError(t("This pairing code belongs to a different budget."));
        return;
      }
      const snap = await fetchSnap2();
      if (!snap) return; // tier went back to plain — retryBoot already on its way
      if (snap.budgetId && snap.budgetId !== codeBudgetId) {
        setError(t("This pairing code belongs to a different budget."));
        return;
      }
      // The code's budget id came from a TRUSTED device — it is the expected context here.
      await acceptDek(dek, snap, codeBudgetId);
    } catch (e) {
      if (e instanceof UpgradeRequiredSignal) {
        setMode("upgrade");
        return;
      }
      setError(e instanceof BadKeyError ? t("Invalid pairing code.") : apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "11px 12px",
    borderRadius: 10,
    border: `1px solid ${C.line}`,
    background: C.surface,
    color: C.text,
    fontSize: 14,
    fontFamily: font,
  };
  const primaryBtn: React.CSSProperties = {
    marginTop: 4,
    padding: "12px 26px",
    borderRadius: 11,
    border: "none",
    background: TEAL,
    color: "#fff",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.5 : 1,
    fontFamily: font,
    width: "100%",
  };
  const linkBtn: React.CSSProperties = {
    marginTop: 2,
    padding: 8,
    border: "none",
    background: "none",
    color: C.soft,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: font,
    textDecoration: "underline",
  };

  return (
    <div
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 32, textAlign: "center" }}
    >
      <div style={{ marginBottom: 4 }}>
        <LogoMark size={64} />
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
        {mode === "upgrade" ? t("This budget needs an encryption upgrade") : t("This budget is encrypted")}
      </div>

      {mode === "upgrade" ? (
        <div style={{ width: "100%", maxWidth: 340 }}>
          {(() => {
            const ledger = store.getLedger();
            const hasData = !!ledger && ledger.accounts.length + ledger.envelopes.length + ledger.transactions.length + ledger.categories.length > 0;
            return hasData ? (
              // This device still holds the budget's data — the ceremony can run right here.
              <E2eeUpgradePanel onDone={() => void retryBoot()} />
            ) : (
              <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6 }}>
                {t(
                  "This budget was encrypted with an older format that this version of the app no longer reads, and this device has no copy of the data. Open Enveo on the device that holds the budget (or restore a JSON backup there) and run the encryption upgrade in Settings → Privacy — then unlock here with the new password.",
                )}
              </div>
            );
          })()}
        </div>
      ) : mode === "pass" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && pass.length > 0) void doPassword();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 300 }}
        >
          <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6 }}>
            {t("This budget's data is end-to-end encrypted. Enter the encryption password to unlock it on this device.")}
          </div>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder={t("Encryption password")}
            autoComplete="current-password"
            // biome-ignore lint/a11y/noAutofocus: the password field is this screen's single purpose — focusing it is the expected behavior
            autoFocus
            aria-label={t("Encryption password")}
            style={inputStyle}
          />
          <button type="submit" disabled={busy || pass.length === 0} style={primaryBtn}>
            {busy ? t("Unlocking…") : t("Unlock")}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("pair");
              setError(null);
            }}
            style={linkBtn}
          >
            {t("I have a pairing code")}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && code.trim().length > 0) void doPair();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 300 }}
        >
          <div style={{ fontSize: 13, color: C.soft, lineHeight: 1.6 }}>{t("Paste the pairing code shown on a trusted device (Settings → Pairing code).")}</div>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="enveo1.…"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            rows={4}
            // biome-ignore lint/a11y/noAutofocus: the pairing-code field is this screen's single purpose — focusing it is the expected behavior
            autoFocus
            aria-label={t("Pairing code")}
            style={{ ...inputStyle, resize: "none", fontSize: 12, wordBreak: "break-all" }}
          />
          <button type="submit" disabled={busy || code.trim().length === 0} style={primaryBtn}>
            {busy ? t("Unlocking…") : t("Unlock")}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("pass");
              setError(null);
            }}
            style={linkBtn}
          >
            {t("Unlock with password")}
          </button>
        </form>
      )}

      {error && <div style={{ fontSize: 12, color: CORAL, lineHeight: 1.5, maxWidth: 280 }}>{error}</div>}
    </div>
  );
}
