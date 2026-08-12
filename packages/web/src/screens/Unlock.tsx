import { useState } from "react";
import { apiErrorMessage } from "../lib/api";
import { LogoMark } from "../components/chrome";
import { deriveKek, unwrapDek, decodePairing, type KdfParams } from "../lib/crypto";
import { useTheme } from "../lib/contexts";
import * as e2ee from "../lib/e2ee";
import { useT } from "../lib/i18n";
import { store } from "../lib/store";
import { retryBoot } from "../lib/sync";
import { CORAL, TEAL, font } from "../lib/theme";

/**
 * E2EE unlock screen (BootStatus "locked") — the budget is on the e2ee tier
 * and this device has no DEK. Two paths:
 *  - password: GET /sync2/snapshot → deriveKek(Argon2id) → unwrapDek; verification
 *    = decrypting the checkpoint (blob) MUST succeed (GCM rejects a bad KEK
 *    at unwrap anyway) → setDek → retryBoot,
 *  - pairing code "enveo1.…" pasted from a trusted device (Settings →
 *    Pairing code): decodePairing → budgetId validation (if known locally)
 *    → the same checkpoint verification → setDek → retryBoot.
 * QR-SCAN deliberately omitted (BarcodeDetector unreliable on iOS) — the code
 * is shown by the trusted device, here it's paste-only.
 *
 * 409 tier_mismatch (budget went back to plain before unlocking): tierMeta from
 * the body + retryBoot — boot takes the v1 path and the screen disappears keyless.
 */

interface Snap2 {
  epoch: number;
  wrappedDek: string | null;
  kdfParams: string | null;
  uptoSeq: number;
  blob: string | null;
}

const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** "Bad passphrase/key" signal (crypto), distinguishable from network errors. */
class BadKeyError extends Error {}

/**
 * GET /api/sync2/snapshot; 409 tier_mismatch → tierMeta from the body + retryBoot
 * (returns null — the caller finishes without error, boot takes over on the right path).
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
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as Snap2;
}

/** DEK verification against the checkpoint (if any) → setDek + tierMeta → retryBoot. */
async function acceptDek(dek: Uint8Array, snap: Snap2): Promise<void> {
  if (snap.blob) {
    try {
      await e2ee.decryptSnapshot(snap.blob, dek);
    } catch {
      throw new BadKeyError("dek does not decrypt the checkpoint");
    }
  }
  e2ee.setTierMeta({ tier: "e2ee", epoch: snap.epoch });
  e2ee.setDek(dek);
  await retryBoot();
}

export function UnlockScreen() {
  const C = useTheme();
  const { t } = useT();
  const [mode, setMode] = useState<"pass" | "pair">("pass");
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
      if (!snap.wrappedDek || !snap.kdfParams) throw new BadKeyError("missing key envelope");
      let dek: Uint8Array;
      try {
        const kp = JSON.parse(snap.kdfParams) as KdfParams;
        const kek = await deriveKek(pass, unb64(kp.saltB64), kp);
        dek = await unwrapDek(snap.wrappedDek, kek); // wrong password = GCM rejects
      } catch {
        throw new BadKeyError("wrong password");
      }
      await acceptDek(dek, snap);
    } catch (e) {
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
      await acceptDek(dek, snap);
    } catch (e) {
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
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{t("This budget is encrypted")}</div>

      {mode === "pass" ? (
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
