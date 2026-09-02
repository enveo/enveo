import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { getSignOutPhase, type SignOutPhase, subscribeSignOutPhase } from "../lib/signOutBarrier";
import { font, TEAL } from "../lib/theme";

export function SignOutShieldContent({ phase, onRetry }: { phase: SignOutPhase; onRetry?: () => void }) {
  const C = useTheme();
  const { t } = useT();
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase !== "idle") focusRef.current?.focus();
  }, [phase]);
  if (phase === "idle") return null;

  const failed = phase === "cleanup-failed";
  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live="assertive"
      aria-busy={!failed}
      tabIndex={-1}
      ref={focusRef}
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
        <strong style={{ fontSize: 18 }}>{failed ? t("Local cleanup could not be completed") : t("Signing out and removing local data…")}</strong>
        <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.6 }}>
          {failed
            ? t("The server session has ended, but Enveo could not finish removing local data. Retry the local cleanup.")
            : t("Enveo is safely finishing pending work and removing this account's local data.")}
        </span>
        {failed && (
          <button
            type="button"
            onClick={onRetry}
            style={{ minHeight: 42, padding: "0 18px", border: 0, borderRadius: 10, background: TEAL, color: "#fff", font: "inherit", fontWeight: 700 }}
          >
            {t("Retry local cleanup")}
          </button>
        )}
      </div>
    </div>
  );
}

export function accountContentAccessibility(phase: SignOutPhase): { "aria-hidden": true | undefined; inert: boolean } {
  const blocked = phase !== "idle";
  return { "aria-hidden": blocked ? true : undefined, inert: blocked };
}

export function SignOutBoundary({ children }: { children: ReactNode }) {
  const phase = useSyncExternalStore(subscribeSignOutPhase, getSignOutPhase, getSignOutPhase);
  return (
    <>
      <div {...accountContentAccessibility(phase)}>{children}</div>
      <SignOutShieldContent
        phase={phase}
        onRetry={() => {
          void import("../lib/signOut").then(({ retryLocalSignOutCleanup }) => retryLocalSignOutCleanup());
        }}
      />
    </>
  );
}
