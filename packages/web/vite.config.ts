import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const buildInfo = (() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  




  const passed = process.env.ENVEO_BUILD_SHA?.trim();
  if (passed) return { time, sha: passed };

  let sha = "";
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    sha = "";  
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
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Enveo — Envelope Budgeting",
        short_name: "Enveo",
        description: "Envelope budgeting, mobile-first.",
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
        


        navigateFallback: null,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: { cacheName: "shell", networkTimeoutSeconds: 3 },
          },
          

        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
     
    proxy: { "/api": process.env.DEV_API ?? "http://localhost:8080" },
  },
});
