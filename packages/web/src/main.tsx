// FIRST import: one-time migration of pre-rebranding localStorage keys
// (side effect of the storage module) — must run before any settings read.
import "./lib/storage";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProviders } from "./lib/contexts";
import { loadLocale, uiLang } from "./lib/i18n";
import { initInstallPrompt } from "./lib/installPrompt";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

initInstallPrompt(); // capture beforeinstallprompt as early as possible

const render = () =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppProviders>
          <App />
        </AppProviders>
      </QueryClientProvider>
    </StrictMode>,
  );

// The locale chunk is fetched BEFORE the first render — otherwise the app paints English and
// repaints in the user's language. English resolves immediately (it is the source, no chunk).
// Deliberately a .then() rather than top-level await: TLA is not in the build target.
//
// THE FIRST PAINT MUST NEVER DEPEND ON A NETWORK FETCH: if the locale chunk cannot be loaded we
// render anyway, in English (loadLocale already swallows that failure — the .catch keeps the
// guarantee even if it ever regresses). Anything else is a white screen for translated users only.
void loadLocale(uiLang())
  .catch(() => {})
  .then(render);
