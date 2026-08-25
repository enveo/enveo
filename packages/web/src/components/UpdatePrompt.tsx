import { registerSW } from "virtual:pwa-register";
import { useEffect, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n";
import { useWideHost } from "../lib/shellContext";
import { font, TEAL } from "../lib/theme";
import { APP_VERSION } from "../lib/version";
import { PHONE_COL } from "../lib/viewMode";

/**
 * Module-level SW-registration singleton (design-parity wave A, task A4 — extracted out of the
 * `UpdatePrompt` component so the rail's update card, `Rail.tsx`, can read the SAME
 * needRefresh/refresh state without a second `registerSW()` call). Everything below `need`/
 * `listeners` is plain mutable module state + a tiny pub-sub, not React state: two independent
 * consumers (phone/fold's `<UpdatePrompt/>` and desktop's rail card) may mount `useAppUpdate()`
 * at once during the fold↔desktop breakpoint transition, and both must observe one shared
 * "an update is waiting" flag rather than each running its own `registerSW()`.
 */
let liveRegistration: ServiceWorkerRegistration | null = null;
let registered = false;
let need = false;
let refreshFn: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Registers the service worker in "prompt" mode (idempotent — a second call from a second
 * `useAppUpdate()` mount is a harmless no-op) and flips the shared `need` flag when a new SW is
 * waiting (onNeedRefresh). Actively polls for updates (60 s interval + focus/visibilitychange),
 * because a standalone PWA can hang open with no navigation.
 */
function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  refreshFn = registerSW({
    immediate: true,
    onNeedRefresh() {
      need = true;
      notify();
    },
    onRegisteredSW(_swUrl, r) {
      if (!r) return;
      liveRegistration = r;
      const check = () => {
        void r.update();
      };
      setInterval(check, 60_000);
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function getNeedSnapshot(): boolean {
  return need;
}

/**
 * Manual "check for updates" entry point (rail user-menu footer, design v3:166). This IS the
 * byte-based check — `registration.update()` re-fetches `sw.js` and diffs it byte-for-byte, no
 * version comparison (see the PWA-versioning pitfall in AGENTS.md) — so there is no "you are on
 * the latest build" answer to give back; if a newer worker turns up, the existing
 * `onNeedRefresh` flow (above) is what surfaces it. Calling this before any `useAppUpdate()`
 * consumer has mounted (not reachable in practice — one mounts at the shell's top level, same
 * lifetime as the rail that calls this) is a harmless no-op.
 */
export function checkForUpdate(): void {
  void liveRegistration?.update();
}

/**
 * Shared update state (design-parity wave A, task A4). `needRefresh`/`refresh`/`dismiss` are the
 * ONE consumer surface for "is an update waiting" — `UpdatePrompt` (phone, and fold's anchored
 * banner) and the rail's update card (`Rail.tsx`, desktop) both call this instead of each running
 * their own `registerSW()`.
 *
 * `incomingVersion` is the DEPLOYED build's semver, fetched from `/version.json` (emitted by the
 * build, excluded from the SW precache, requested with `cache: "no-store"`) the moment an update
 * is detected — the server is already handing out the new build by then, so the file names the
 * INCOMING version even though SW update detection itself stays byte-based (the PWA-versioning
 * pitfall in AGENTS.md is about detection, not display). Null until fetched, and forced null when
 * the fetched version equals the RUNNING build's (a byte-only change, or a proxy served a stale
 * copy) — a "New version ready" card must never name the version it is replacing. An earlier
 * round shipped exactly that bug twice, which is why this guard is explicit.
 */
let incoming: string | null = null;
function fetchIncomingVersion(): void {
  fetch("/version.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { version?: string } | null) => {
      const v = j?.version;
      incoming = typeof v === "string" && v !== APP_VERSION ? v : null;
      notify();
    })
    .catch(() => {
      incoming = null;
    });
}
const getIncomingSnapshot = () => incoming;

export function useAppUpdate(): { needRefresh: boolean; incomingVersion: string | null; refresh: (reload?: boolean) => void; dismiss: () => void } {
  useEffect(() => {
    ensureRegistered();
  }, []);
  const needRefresh = useSyncExternalStore(subscribe, getNeedSnapshot);
  const incomingVersion = useSyncExternalStore(subscribe, getIncomingSnapshot);
  useEffect(() => {
    if (needRefresh) fetchIncomingVersion();
  }, [needRefresh]);
  return {
    needRefresh,
    incomingVersion,
    refresh: (reload = true) => void refreshFn?.(reload),
    dismiss: () => {
      need = false;
      notify();
    },
  };
}

/**
 * Phone (and fold) presentation: a fixed, viewport/pane-anchored banner shown while an update is
 * waiting. Desktop no longer mounts this — design-parity wave A, task A4 moved the desktop
 * surface into the rail (`Rail.tsx`'s update card, between the TBB card and the user block,
 * owner-requirements.md #3); this component's OWN presentation is otherwise unchanged so phone
 * behaviour stays byte-identical.
 */
export function UpdatePrompt() {
  const { t } = useT();
  const { needRefresh, refresh, dismiss } = useAppUpdate();
  // Wide anchor (PR6 Task 6 — sheet triage sweep measured this): mirrors DockedNumpad's own
  // anchor (Task 3). `null` on phone (no provider) and on fold (WideShell only renders this
  // instance from the PRIMARY pane, so `useWideHost()` is never null there while mounted) —
  // kept `?? null` defensive rather than assumed, matching DockedNumpad's own style. Anchoring
  // to `rects.primary` (not a static rail-width constant) is what makes this correct whether the
  // panel is open or closed: WideShell's own ResizeObserver already grows `rects.primary` to
  // fill the reclaimed space when the panel collapses, so this needs no separate branch for that.
  const pane = useWideHost();
  const anchor = pane?.rects.primary ?? null;

  if (!needRefresh) return null;
  // Measured (PR6 Task 6 — sheet triage sweep): at 1440x900 (desktop) a viewport-centered banner
  // never reaches the rail or panel, so that geometry is untouched. At 1104x992 (fold) with the
  // panel open, centering across the FULL viewport put the banner ~220px into the panel's own
  // column (panel starts at x=552 there; the pill's right edge reached ~774) — a real collision,
  // not a hypothetical one. Anchoring to the primary pane's measured rect (`anchor` above) fixes
  // both sizes at once and costs nothing on phone (`anchor` is `null` there, same fixed centering
  // as before).
  return (
    <div
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top) + 8px)",
        zIndex: 130,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
        ...(anchor ? { left: anchor.left, width: anchor.width } : { left: 0, right: 0 }),
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          maxWidth: PHONE_COL,
          width: "calc(100% - 24px)",
          background: TEAL,
          color: "#fff",
          borderRadius: 12,
          padding: "10px 12px",
          boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
          fontFamily: font,
        }}
      >
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{t("New version available")}</span>
        <button
          onClick={() => refresh(true)}
          style={{ border: "none", background: "#fff", color: TEAL, borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}
        >
          {t("Refresh")}
        </button>
        <button
          onClick={dismiss}
          aria-label={t("Close")}
          style={{ border: "none", background: "transparent", color: "#fff", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 4 }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
