/**
 * PWA install exposure. The browser fires `beforeinstallprompt` when the app is
 * installable (Android + desktop Chromium); we capture it so a custom button can
 * trigger the native install dialog. iOS has no such API — the UI falls back to
 * "Share → Add to Home Screen" instructions. All platform branching flows from the
 * single pure `installState()`; the rest is a tiny useSyncExternalStore store.
 */
import { useSyncExternalStore } from "react";

export type InstallState = "installed" | "promptable" | "ios-safari" | "ios-other" | "unavailable";

/** The non-standard event Chromium fires; minimal shape we rely on. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Pure platform verdict. `deferred` truthy = a captured beforeinstallprompt event.
 * NOTE: iPadOS 13+ Safari reports a desktop-Mac UA and lands in "unavailable"
 * (no beforeinstallprompt on desktop Safari) — accepted; those users can still add
 * via Share manually, we just don't detect them.
 *
 * `ddg\/` / `gsa\/` below: iOS in-app browsers that KEEP the stock `Safari` token but
 * have no Share → Add-to-Home-Screen flow, so "ios-safari" instructions would describe
 * a menu that does not exist — they belong in "ios-other" ("open {host} in Safari").
 * Tokens verified against real UA strings: DuckDuckGo appends `Ddg/<version>`
 * (duckduckgo/iOS UserAgentManager), the Google app appends `GSA/<version>`
 * (documented in Google's "user agent strings for Google Search App" help page).
 * Keep this list CONSERVATIVE — add a token only with a named source; an unrecognized
 * in-app browser misclassified as Safari is a known, accepted gap.
 */
export function installState(deferred: unknown, userAgent: string, standalone: boolean): InstallState {
  if (standalone) return "installed";
  if (deferred) return "promptable";
  if (/iphone|ipad|ipod/i.test(userAgent)) {
    const otherBrowser = /crios|fxios|edgios|opios|ddg\/|gsa\//i.test(userAgent);
    const isSafari = !otherBrowser && /safari/i.test(userAgent);
    return isSafari ? "ios-safari" : "ios-other";
  }
  return "unavailable";
}

/**
 * The ONE installability predicate: is there anything to offer this user? Every UI site
 * (banner, Drawer row, Settings hub card, onboarding finish, InstallBody's null-return)
 * must call this instead of re-spelling the two-state comparison — five hand-written
 * copies in two polarities is how one of them drifts.
 */
export function isInstallable(state: InstallState): boolean {
  return state !== "installed" && state !== "unavailable";
}

/**
 * Fire the native install dialog and report the user's choice.
 * Exported as an intentional unit-test seam: installPrompt.test.ts drives it directly to
 * prove the native prompt is invoked and the browser's userChoice outcome is returned —
 * do not un-export it to trim the module API, and do not replace it with injection.
 */
export async function runPrompt(e: BeforeInstallPromptEvent): Promise<"accepted" | "dismissed"> {
  await e.prompt();
  return (await e.userChoice).outcome;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

let deferred: BeforeInstallPromptEvent | null = null;
let snapshot: InstallState = "unavailable";
let initialized = false;
const listeners = new Set<() => void>();

function recompute(): void {
  const next = installState(deferred, typeof navigator === "undefined" ? "" : navigator.userAgent, isStandalone());
  if (next === snapshot) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

/** Register the capture listeners. Call once, as early as possible (main.tsx). */
export function initInstallPrompt(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    recompute();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    recompute();
  });
  recompute(); // initial (e.g. already standalone)
}

/**
 * Fire the native dialog if we hold an event; "unavailable" otherwise.
 *
 * The event is single-use, so it is dropped in a `finally`: Chromium throws
 * InvalidStateError on an already-consumed event, and keeping a dead one would pin the
 * state at "promptable" forever — a visible Install button that does nothing until a
 * reload. A rejection is never re-thrown either; callers get "unavailable", not an
 * unhandled rejection.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = deferred;
  if (!e) return "unavailable";
  try {
    return await runPrompt(e);
  } catch {
    return "unavailable";
  } finally {
    deferred = null;
    recompute();
  }
}

const getSnapshot = (): InstallState => snapshot;

/** Non-hook read of the live state — for logic outside render (e.g. Onboarding's finish()). */
export function getInstallState(): InstallState {
  return snapshot;
}
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useInstall(): { state: InstallState; promptInstall: typeof promptInstall } {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return { state, promptInstall };
}
