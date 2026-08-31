import { useSyncStatus } from "../lib/api";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { TEAL } from "../lib/theme";

function reduceMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Optional animation/reassurance layer. Rejected writes, auth, and ownership remain
 * in the eager SyncBadge so a chunk failure can never hide a required action. */
export function SyncActivityBadge() {
  const C = useTheme();
  const { t, tp } = useT();
  const { state, pending, deadLetters, ownerUnproven } = useSyncStatus();
  if (deadLetters > 0 || state === "unauthed" || ownerUnproven) return null;
  const anchor: React.CSSProperties = {
    position: "absolute",
    top: "calc(env(safe-area-inset-top) + 13px)",
    right: 76,
    zIndex: 60,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 20,
    pointerEvents: "none",
  };

  if (state === "syncing") {
    return (
      <div role="status" aria-label={t("Sync in progress")} style={anchor}>
        {reduceMotion() ? (
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: TEAL, opacity: 0.85 }} />
        ) : (
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: "50%",
              border: `2px solid ${C.line}`,
              borderTopColor: TEAL,
              animation: "sp .7s linear infinite",
            }}
          />
        )}
      </div>
    );
  }
  if (pending === 0) return null;
  return (
    <div
      role="status"
      aria-label={tp("{n} change is waiting to be sent | {n} changes are waiting to be sent", pending)}
      style={{
        ...anchor,
        gap: 4,
        padding: "3px 8px",
        borderRadius: 999,
        background: C.card,
        border: `1px solid ${C.line}`,
        color: C.mute,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        height: "auto",
      }}
    >
      <span style={{ fontSize: 12 }} aria-hidden>
        ⇄
      </span>
      <span>{pending}</span>
    </div>
  );
}
