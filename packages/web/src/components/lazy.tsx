/**
 * Boundaries for the code-split surfaces (§3f).
 *
 * The initial-JS budget is bought by loading Reports, Settings, the onboarding wizard and the
 * AI/screenshot-import sheets from their own chunks. That trades a guaranteed cost (bytes on
 * every boot) for a conditional one (a fetch when the feature opens), so both sides of the
 * trade need a visible answer:
 *
 * - **In flight** — a themed placeholder in the app's own surface, never a white gap. In the
 *   installed PWA the chunk is precached and this is usually a single frame; on a cold, slow
 *   first visit it is the honest "working on it".
 * - **Rejected** — a network failure on a hashed chunk is caught HERE, next to the feature, so
 *   the rest of the app keeps running: the user is still on their budget, the outbox still
 *   holds their writes. The recovery offered is a page RELOAD, which is safe by construction —
 *   the replica lives in IndexedDB and the outbox is durable, so nothing local is lost, and a
 *   reload is what actually fixes the common cause (a deployed revision whose old chunk URLs
 *   are gone; the network-first navigation handler then serves the new shell). This boundary
 *   NEVER clears the replica, the outbox or IndexedDB, and it never signs anyone out.
 *
 * `React.lazy` caches a rejected import permanently for that component, so re-rendering cannot
 * retry — the reload is not laziness, it is the only recovery that works without rebuilding the
 * lazy component's identity.
 */
import { Component, type ErrorInfo, type ReactNode, Suspense, useRef } from "react";
import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { font, TEAL } from "../lib/theme";

/** Fills the screen slot a lazy screen is about to occupy. */
function ScreenPending() {
  const C = useTheme();
  const { t } = useT();
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <span style={{ color: C.mute, fontSize: 13 }}>{t("Loading…")}</span>
    </div>
  );
}

/** Sheets open over the current screen, so their pending state is a quiet pill, not a takeover. */
function OverlayPending() {
  const C = useTheme();
  const { t } = useT();
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 24, display: "flex", justifyContent: "center", zIndex: 60, pointerEvents: "none" }}>
      <span style={{ background: C.sheet, color: C.mute, fontSize: 13, padding: "9px 18px", borderRadius: 999, boxShadow: "0 4px 18px rgba(20,20,28,0.18)" }}>
        {t("Loading…")}
      </span>
    </div>
  );
}

function ChunkFailed({ onDismiss }: { onDismiss?: () => void }) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32, textAlign: "center" }}
    >
      <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.6 }}>{t("This part of the app could not be loaded.")}</span>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "11px 22px",
            borderRadius: 11,
            border: "none",
            background: TEAL,
            color: "#fff",
            fontSize: 13.5,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: font,
          }}
        >
          {t("Refresh")}
        </button>
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{
              padding: "11px 22px",
              borderRadius: 11,
              border: `1px solid ${C.line}`,
              background: "none",
              color: C.text,
              fontSize: 13.5,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            {t("Cancel")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Overlay variant of the failure notice, so a sheet's chunk error does not blank the screen behind it. */
function OverlayFailed({ onDismiss }: { onDismiss?: () => void }) {
  const C = useTheme();
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "flex-end", background: "rgba(0,0,0,0.35)" }}>
      <div style={{ width: "100%", background: C.sheet, borderRadius: "18px 18px 0 0", paddingBottom: "env(safe-area-inset-bottom)" }}>
        <ChunkFailed onDismiss={onDismiss} />
      </div>
    </div>
  );
}

type LazyVariant = "screen" | "overlay" | "silent";
type BoundaryProps = { children: ReactNode; variant: LazyVariant; onDismiss?: () => void };

class ChunkErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Loud in the console, silent for the rest of the app — nothing is reset or cleared here.
    console.error("lazy chunk failed to load", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.variant === "silent") return null;
    return this.props.variant === "overlay" ? <OverlayFailed onDismiss={this.props.onDismiss} /> : <ChunkFailed onDismiss={this.props.onDismiss} />;
  }
}

/**
 * Wraps one code-split surface: pending placeholder + failure boundary.
 *
 * `variant` picks the shape of both states — `screen` fills the content area (a lazy route),
 * `overlay` floats above the current screen (a lazy sheet), and `silent` renders nothing for
 * optional background UI such as the delayed install offer. `onDismiss` adds a way out that is
 * not a reload; sheets pass their `onClose`.
 */
export function LazyChunk({ children, variant = "screen", onDismiss }: { children: ReactNode; variant?: LazyVariant; onDismiss?: () => void }) {
  return (
    <ChunkErrorBoundary variant={variant} onDismiss={onDismiss}>
      <Suspense fallback={variant === "silent" ? null : variant === "overlay" ? <OverlayPending /> : <ScreenPending />}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}

/**
 * True from the first time `open` is true, and true forever after.
 *
 * Sheets are mounted unconditionally today and hide themselves (`Sheet` returns null while
 * `show` is false), so their state survives close→reopen. Gating the mount on `open` alone
 * would quietly change that into a reset on every open. The latch keeps the two indistinguishable:
 * before the first open there is nothing to preserve, and after it the component stays mounted
 * exactly as before — while the chunk is still fetched only when the feature is first used.
 */
export function useOpenedOnce(open: boolean): boolean {
  const opened = useRef(false);
  if (open) opened.current = true;
  return opened.current;
}
