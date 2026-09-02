import { useSyncExternalStore } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { getSignOutPhase, type SignOutPhase, subscribeSignOutPhase } from "../lib/signOutBarrier";
import { font, TEAL } from "../lib/theme";

export function SignOutShieldContent({ phase, onRetry }: { phase: SignOutPhase; onRetry?: () => void }) {
  const C = useTheme();
  const { t } = useT();
  if (phase === "idle") return null;

  const failed = phase === "server-failed";
  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live="assertive"
      aria-busy={!failed}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 28,
        background: C.bg,
        color: C.text,
        fontFamily: font,
      }}
    >
      <div style={{ width: "min(100%, 420px)", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <strong style={{ fontSize: 18 }}>{failed ? t("Sign-out could not be completed") : t("Signing out…")}</strong>
        <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.6 }}>
          {failed
            ? t("The server session could not be ended. Try signing out again before using the app.")
            : t("Enveo is safely finishing pending work and removing this account's local data.")}
        </span>
        {failed && (
          <button
            type="button"
            onClick={onRetry}
            style={{ minHeight: 42, padding: "0 18px", border: 0, borderRadius: 10, background: TEAL, color: "#fff", font: "inherit", fontWeight: 700 }}
          >
            {t("Try signing out again")}
          </button>
        )}
      </div>
    </div>
  );
}

export function SignOutShield() {
  const phase = useSyncExternalStore(subscribeSignOutPhase, getSignOutPhase, getSignOutPhase);
  return <SignOutShieldContent phase={phase} onRetry={() => location.reload()} />;
}
