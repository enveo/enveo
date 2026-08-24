/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { createImportManagerBootstrap } from "./bootstrap";

describe("import manager bootstrap status", () => {
  it("publishes an accessible retryable error and reaches ready after a successful retry", async () => {
     
    let attempts = 0;
    let starts = 0;
    let resumes = 0;
    const bootstrap = createImportManagerBootstrap(async () => {
      attempts++;
      if (attempts === 1) throw new Error("chunk unavailable");
      return {
        importJobManager: {
          start: () => void starts++,
          resume: async () => void resumes++,
        },
      };
    });
    const states: string[] = [];
    const unsubscribe = bootstrap.subscribe(() => states.push(bootstrap.getSnapshot()));

     
    await bootstrap.start();
    expect(bootstrap.getSnapshot()).toBe("error");
    await bootstrap.start();

     
    expect(bootstrap.getSnapshot()).toBe("ready");
    expect(states).toEqual(["loading", "error", "loading", "ready"]);
    expect({ attempts, starts, resumes }).toEqual({ attempts: 2, starts: 1, resumes: 1 });
    unsubscribe();
  });

  it("coalesces concurrent startup so one manager owns its observers", async () => {
    let resolveLoad!: (value: { importJobManager: { start(): void; resume(): Promise<void> } }) => void;
    let loads = 0;
    const bootstrap = createImportManagerBootstrap(
      () =>
        new Promise((resolve) => {
          loads++;
          resolveLoad = resolve;
        }),
    );
    const first = bootstrap.start();
    const second = bootstrap.start();

    resolveLoad({ importJobManager: { start() {}, resume: async () => {} } });
    await Promise.all([first, second]);

    expect(loads).toBe(1);
    expect(bootstrap.getSnapshot()).toBe("ready");
  });
});
