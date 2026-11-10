/**
 * The colour the visible phone screen wants behind the iOS status bar, or `null` for the theme
 * default. On a current iPhone a home-screen web app showed the status-bar area in the page colour,
 * blurred down into the band header as a light haze; a fixed strip of `env(safe-area-inset-top)`
 * height changed nothing there, so the colour is taken to come from the document background. The theme provider is the one writer of the document background
 * and `theme-color`; the shell only names the colour here.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export const statusBarColor = {
  get: (): string | null => current,
  set(next: string | null) {
    if (next === current) return;
    current = next;
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
