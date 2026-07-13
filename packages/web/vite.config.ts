import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const buildInfo = (() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let sha = "";
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    sha = ""; // .git absent (Docker image) — we rely on `time`
  }
  return { time, sha };
})();

export default defineConfig({
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
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
        theme_color: "#f4f3ef",
        background_color: "#f4f3ef",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
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
