import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const buildInfo = (() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // The container build has no `.git` (it is in .dockerignore), so the release identity is
  // PASSED IN instead of recovered: Dockerfile `ARG SOURCE_COMMIT` → ENVEO_BUILD_SHA. The
  // release workflow (§3d) supplies the validated tag SHA, and the same value goes into the
  // OCI `org.opencontainers.image.revision` label, so the UI stamp and the image agree.
  // Absent (a plain local `docker build`) degrades to the old behaviour: timestamp only.
  const passed = process.env.ENVEO_BUILD_SHA?.trim();
  if (passed) return { time, sha: passed };

  let sha = "";
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    sha = ""; // no .git and no build arg — we rely on `time`
  }
  return { time, sha };
})();

export default defineConfig({
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
  },
  build: {
    // The initial-JS budget (§3f) is measured from this manifest by
    // `scripts/check-web-bundle.ts`: it starts at the HTML entry and follows STATIC
    // `imports` edges only, so moving eager code into another statically imported chunk
    // cannot buy headroom. `chunkSizeWarningLimit` stays at Vite's 500 kB default on
    // purpose — it is the secondary, per-chunk diagnostic, never the budget.
    manifest: true,
  },
  plugins: [
    react(),
    // Emits dist/version.json = the BUILT bundle's APP_VERSION. The deployed server hands out the
    // NEW build's file while a stale client still runs the old one, which is what lets the rail's
    // update card name the incoming version (owner rule 3) despite byte-based SW update detection.
    // Read by UpdatePrompt with cache:"no-store" and excluded from the SW precache below — a
    // precached copy would be the OLD version by definition.
    {
      name: "enveo-emit-version-json",
      generateBundle() {
        const src = readFileSync("src/lib/version.ts", "utf8");
        const m = /APP_VERSION = "([^"]+)"/.exec(src);
        if (!m) throw new Error("APP_VERSION not found in src/lib/version.ts");
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: m[1] }) });
      },
    },
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Enveo — Envelope Budgeting",
        short_name: "Enveo",
        description: "Private envelope budgeting that works offline.",
        lang: "en",
        theme_color: "#1d2a47",
        background_color: "#1d2a47",
        display: "standalone",
        // "any" (was "portrait"): the wide fold/desktop layout (spec §5-§10) is reachable on an
        // installed PWA only once this flips — a portrait-locked manifest would force a phone
        // layout on an unfolded foldable regardless of its actual aspect ratio. Landscape
        // handsets still fall back to the phone layout on their own merits (`useViewMode`'s
        // `MIN_WIDE_HEIGHT` clause, viewMode.test.ts), so this is not "landscape phones now get
        // the rail" — width AND height both have to clear the wide thresholds.
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // version.json must ALWAYS come from the network (see the emit plugin above).
        globIgnores: ["**/version.json"],
        // App start (navigation) ALWAYS network-first — after a deploy the client gets
        // a shell consistent with current assets instead of a stale precached index.html
        // that pointed at already-removed (re-hashed) chunks and hung the PWA.
        navigateFallback: null,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: { cacheName: "shell", networkTimeoutSeconds: 3 },
          },
          // /api/state is no longer cached: reads are computed LOCALLY
          // from the IndexedDB replica (lib/store.ts); the network is for sync only.
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    // DEV_API: proxy target override (e.g. a locally running prod container on another port)
    proxy: { "/api": process.env.DEV_API ?? "http://localhost:8080" },
  },
});
