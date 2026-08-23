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
export function SyncBadge({ onOpenSync, topOffset = 13 }: { onOpenSync: () => void; topOffset?: number }) {
  const C = useTheme();
  const { t, tp } = useT();
  const { state, pending, deadLetters, ownerUnproven } = useSyncStatus();

  // shared anchoring in the shell corner (above content, below sheet/drawer). `topOffset`
  // defaults to the phone shell's constant; the wide shell (WideShell.tsx) passes 56+13 so the
  // badge clears the band header instead of sitting under it (PR4 task 5).
  const anchor: React.CSSProperties = {
    position: "absolute",
    top: `calc(env(safe-area-inset-top) + ${topOffset}px)`,
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
    const label = tp("The server rejected {n} change — tap to open settings | The server rejected {n} changes — tap to open settings", deadLetters);
    return (
      <button onClick={onOpenSync} aria-label={label} style={{ ...anchor, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
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

  // Session expired (401) — a user decision is needed
  // (re-login), but work is safely queued locally:
  // muted, tappable pill → Settings (same as today for dead letters).
  if (state === "unauthed") {
    const label = t("Session expired");
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

  // The replica could not be matched to the signed-in account: NOTHING is being sent to the server,
  // and it will not start on its own until the ownership proof succeeds. This MUST precede the
  // "pending" pill below — that pill promises the queued changes will send themselves, which here is
  // exactly what does not happen. Muted, not red: nothing is broken and nothing is at risk; tappable
  // → Settings → Sync, which explains the state and offers the ways out (check again / export a
  // backup / remove the local copy).
  //
  // Keyed on the STICKY ownerUnproven, not SyncState "unverified": each re-proof runs as an ordinary
  // cycle ("syncing" first), and a state-keyed pill would blink into the spinner — and, once the
  // proof failed and something was queued, into the "⇄ N" pill — on every trigger.
  if (ownerUnproven) {
    return (
      <button
        onClick={onOpenSync}
        aria-label={t("This device's data has not been matched to your account — nothing is being sent to the server. Tap to open settings")}
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
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
        </svg>
        <span>{t("Not sending")}</span>
      </button>
    );
  }

  // sync in progress — spinning ring (static dot under reduce-motion)
  if (state === "syncing") {
    return (
      <div role="status" aria-label={t("Sync in progress")} style={{ ...anchor, pointerEvents: "none" }}>
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
    const label = tp("{n} change is waiting to be sent | {n} changes are waiting to be sent", pending);
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
