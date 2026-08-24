export type ImportManagerBootstrapStatus = "idle" | "loading" | "ready" | "error";

interface ImportManagerModule {
  importJobManager: {
    start(): void;
    resume(): Promise<void>;
  };
}

type ManagerLoader = () => Promise<ImportManagerModule>;

export function createImportManagerBootstrap(load: ManagerLoader) {
  let status: ImportManagerBootstrapStatus = "idle";
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: ImportManagerBootstrapStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): ImportManagerBootstrapStatus {
      return status;
    },
    start(): Promise<void> {
      if (status === "ready") return Promise.resolve();
      if (inFlight) return inFlight;
      publish("loading");
      inFlight = load()
        .then(async ({ importJobManager }) => {
          importJobManager.start();
          await importJobManager.resume();
          publish("ready");
        })
        .catch(() => publish("error"))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

export const importManagerBootstrap = createImportManagerBootstrap(() => import("./manager"));
export const startImportJobManager = () => importManagerBootstrap.start();
