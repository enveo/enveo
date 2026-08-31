import { useSyncStatus } from "../lib/api";
import { useT } from "../lib/i18n";
import { CORAL } from "../lib/theme";

/**
 * Sync indicator — mounted ONCE in the shell (App.tsx), positioned absolutely
 * in the top-right corner, left of the header kebab. A single accessory
 * (the Chanel rule): one glyph + an optional counter.
 *
 * Local-first semantics: an unreachable server is NOT an error when work is
 * safely queued — red is reserved EXCLUSIVELY for dead letters
 * (the server REJECTED something → a user decision is needed).
 *
 * - dead letters (>0) → red dot, tappable → opens "Sync",
 * - ownerUnproven (the replica's owner could not be matched to the signed-in account) → muted,
 *   tappable pill: nothing is being sent, and saying so is the whole point (the "pending" pill
 *   below would claim the opposite). Sticky across the re-proof cycles, so it does not blink,
 * - syncing → spinning ring ("sp" keyframes; no motion under reduce-motion),
 * - pending (>0), 0 dead letters → muted, REASSURING pill "⇄ N"
 *   REGARDLESS of state (offline / error / not-yet-pushed): changes are waiting
 *   and are safe,
 * - the rest (synced with no queue; also transient error/offline with no queue
 *   and no rejections) → hidden (zero noise, nothing is at risk).
 */
export function SyncBadge({ onOpenSync, inline = false }: { onOpenSync: () => void; inline?: boolean }) {
  const { t, tp } = useT();
  const { state, deadLetters, ownerUnproven } = useSyncStatus();

  const position: React.CSSProperties = inline
    ? { display: "flex", alignItems: "center", justifyContent: "center", height: 20, flexShrink: 0 }
    : {
        position: "absolute",
        top: "calc(env(safe-area-inset-top) + 13px)",
        right: 76,
        zIndex: 60,
      };

  if (deadLetters > 0) {
    const label = tp("The server rejected {n} change — tap to open settings | The server rejected {n} changes — tap to open settings", deadLetters);
    return (
      <button
        type="button"
        onClick={onOpenSync}
        aria-label={label}
        style={{ ...position, background: "none", color: CORAL, border: 0, cursor: "pointer", padding: 0 }}
      >
        ●
      </button>
    );
  }

  if (state === "unauthed" || ownerUnproven) {
    const authExpired = state === "unauthed";
    const label = authExpired
      ? t("Session expired")
      : t("This device's data has not been matched to your account — nothing is being sent to the server. Tap to open settings");
    return (
      <button
        type="button"
        onClick={onOpenSync}
        aria-label={label}
        style={{
          ...position,
          padding: "3px 8px",
          borderRadius: 999,
          border: 0,
          background: "var(--nav-bg)",
          color: "var(--nav-mute)",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        {authExpired ? label : t("Not sending")}
      </button>
    );
  }
  return null;
}
