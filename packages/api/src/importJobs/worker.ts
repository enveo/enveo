import type { ClaimedImportJob, ImportJobRepository } from "./repository";

export interface ImportJobWorkerDeps {
  workerId: string;
  repository: Pick<ImportJobRepository, "claimNext" | "cleanupExpired">;
  processJob: (job: ClaimedImportJob) => Promise<unknown>;
  idleMs?: number;
  cleanupIntervalMs?: number;
  now?: () => Date;
}

export function startImportJobWorker(deps: ImportJobWorkerDeps): { wake(): void; stop(): Promise<void> } {
  const idleMs = Math.min(deps.idleMs ?? 1_000, 1_000);
  const cleanupIntervalMs = deps.cleanupIntervalMs ?? 60 * 60 * 1_000;
  const now = deps.now ?? (() => new Date());
  let stopping = false;
  let wakeResolve: (() => void) | null = null;

  const wait = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeResolve = null;
        resolve();
      }, idleMs);
      wakeResolve = () => {
        clearTimeout(timer);
        wakeResolve = null;
        resolve();
      };
    });

  const running = (async () => {
    let nextCleanupAt = 0;
    while (!stopping) {
      const currentMs = now().getTime();
      if (currentMs >= nextCleanupAt) {
        try {
          await deps.repository.cleanupExpired(now());
          nextCleanupAt = currentMs + cleanupIntervalMs;
        } catch {
          console.error("import-job worker: retention cleanup failed");
          if (!stopping) await wait();
          continue;
        }
        if (stopping) break;
      }
      let job: ClaimedImportJob | null;
      try {
        job = await deps.repository.claimNext(deps.workerId, now());
      } catch {
        console.error("import-job worker: claim failed");
        if (!stopping) await wait();
        continue;
      }
      if (job) {
        try {
          await deps.processJob(job);
        } catch (error) {
          console.error("import-job worker: unhandled processor failure", {
            errorType: error instanceof Error ? error.constructor.name : typeof error,
          });
        }
        if (stopping) break;
        continue;
      }
      if (stopping) break;
      await wait();
    }
  })();

  return {
    wake() {
      wakeResolve?.();
    },
    async stop() {
      stopping = true;
      wakeResolve?.();
      await running;
    },
  };
}
