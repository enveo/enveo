import { useSyncStatus } from "../lib/api";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { CORAL, TEAL } from "../lib/theme";

function reduceMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
 * - syncing → spinning ring ("sp" keyframes; no motion under reduce-motion),
 * - pending (>0), 0 dead letters → muted, REASSURING pill "⇄ N"
 *   REGARDLESS of state (offline / error / not-yet-pushed): changes are waiting
 *   and are safe,
 * - the rest (synced with no queue; also transient error/offline with no queue
 *   and no rejections) → hidden (zero noise, nothing is at risk).
 */
export function SyncBadge({ onOpenSync }: { onOpenSync: () => void }) {
  const C = useTheme();
  const { t, tp } = useT();
  const { state, pending, deadLetters, localMode } = useSyncStatus();

  // shared anchoring in the shell corner (above content, below sheet/drawer)
  const anchor: React.CSSProperties = {
    position: "absolute",
    top: "calc(env(safe-area-inset-top) + 13px)",
    right: 48,
    zIndex: 60,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 20,
  };

  // Red EXCLUSIVELY for dead letters: the server REJECTED something → a user
  // decision is needed. An unreachable server (error/offline) with safely
  // queued work is NOT an error — handled below with the reassuring pill.
  if (deadLetters > 0) {
    const label = tp("sync.badgeRejected", deadLetters);
    return (
      <button
        onClick={onOpenSync}
        aria-label={label}
        style={{ ...anchor, background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: CORAL,
            boxShadow: `0 0 0 3px var(--danger-22)`,
          }}
        />
      </button>
    );
  }

  // Session expired (401, AUTH_MODE=multi) — a user decision is needed
  // (re-login), but work is safely queued locally:
  // muted, tappable pill → Settings (same as today for dead letters).
  if (state === "unauthed") {
    const label = t("auth.sessionExpired");
    return (
      <button
        onClick={onOpenSync}
        aria-label={label}
        style={{
          ...anchor,
          gap: 5,
          padding: "3px 8px",
          borderRadius: 999,
          background: C.card,
          border: `1px solid ${C.line}`,
          color: C.mute,
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1,
          height: "auto",
          cursor: "pointer",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 11V8a4 4 0 118 0v3" />
          <path d="M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z" />
        </svg>
        <span>{label}</span>
      </button>
    );
  }

  // Local mode (sync DISABLED by choice) — a quiet, NON-red accessory:
  // a small padlock. Tappable → Settings. No counter (calm; details in the section).
  if (localMode !== "off" || state === "local") {
    const label = localMode === "wiped" ? t("sync.badgeLocalWiped") : t("sync.badgeLocalPaused");
    return (
      <button
        onClick={onOpenSync}
        aria-label={label}
        style={{ ...anchor, background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 11V8a4 4 0 118 0v3" />
          <path d="M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z" />
        </svg>
      </button>
    );
  }

  // sync in progress — spinning ring (static dot under reduce-motion)
  if (state === "syncing") {
    return (
      <div role="status" aria-label={t("sync.badgeSyncing")} style={{ ...anchor, pointerEvents: "none" }}>
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

  // Queued work (offline / server unreachable / not yet pushed) —
  // muted, REASSURING pill "⇄ N": changes are safe and will send themselves.
  // Same look regardless of state (error/offline), as long as 0 dead letters.
  if (pending > 0) {
    const label = tp("sync.pendingSend", pending);
    return (
      <div
        role="status"
        aria-label={label}
        style={{
          ...anchor,
          pointerEvents: "none",
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

  // synced (or transient error/offline with no queue and no rejections) → no noise
  return null;
}
