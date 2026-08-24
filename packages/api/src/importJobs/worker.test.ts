import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startImportJobWorker } from "./worker";

const eventually = async (probe: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("condition_not_met");
    await Bun.sleep(5);
  }
};

describe("database import job worker", () => {
  test("never overlaps processing and drains all immediately claimable work", async () => {
    let remaining = 3;
    let active = 0;
    let maxActive = 0;
    const processed: number[] = [];
    const worker = startImportJobWorker({
      workerId: "worker-a",
      idleMs: 20,
      cleanupIntervalMs: 60_000,
      repository: {
        claimNext: async () => (remaining > 0 ? ({ id: String(remaining--) } as never) : null),
        cleanupExpired: async () => ({ imagesDeleted: 0, detailsCleared: 0, jobsDeleted: 0 }),
      },
      processJob: async (job) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        processed.push(Number(job.id));
        active--;
      },
    });

    await eventually(() => processed.length === 3);
    await worker.stop();

    expect(processed).toEqual([3, 2, 1]);
    expect(maxActive).toBe(1);
  });

  test("wake interrupts the idle delay and stop prevents another claim", async () => {
    let available = false;
    let claims = 0;
    const worker = startImportJobWorker({
      workerId: "worker-b",
      idleMs: 1_000,
      cleanupIntervalMs: 60_000,
      repository: {
        claimNext: async () => {
          claims++;
          return available ? ({ id: "job" } as never) : null;
        },
        cleanupExpired: async () => ({ imagesDeleted: 0, detailsCleared: 0, jobsDeleted: 0 }),
      },
      processJob: async () => {
        available = false;
      },
    });
    await eventually(() => claims >= 1);
    available = true;

    worker.wake();
    await eventually(() => claims >= 3, 200);
    await worker.stop();
    const stoppedAt = claims;
    await Bun.sleep(30);

    expect(claims).toBe(stoppedAt);
  });

  test("runs retention cleanup at boot", async () => {
    let cleanups = 0;
    const worker = startImportJobWorker({
      workerId: "worker-c",
      idleMs: 20,
      cleanupIntervalMs: 60_000,
      repository: {
        claimNext: async () => null,
        cleanupExpired: async () => {
          cleanups++;
          return { imagesDeleted: 0, detailsCleared: 0, jobsDeleted: 0 };
        },
      },
      processJob: async () => {},
    });

    await eventually(() => cleanups === 1);
    await worker.stop();

    expect(cleanups).toBe(1);
  });

  test("graceful stop finishes an already claimed job before returning", async () => {
    let claimed = false;
    let started = false;
    let finished = false;
    const worker = startImportJobWorker({
      workerId: "worker-stop",
      idleMs: 20,
      cleanupIntervalMs: 60_000,
      repository: {
        claimNext: async () => {
          if (claimed) return null;
          claimed = true;
          return { id: "claimed-before-stop" } as never;
        },
        cleanupExpired: async () => ({ imagesDeleted: 0, detailsCleared: 0, jobsDeleted: 0 }),
      },
      processJob: async () => {
        started = true;
        await Bun.sleep(20);
        finished = true;
      },
    });
    await eventually(() => started);

    await worker.stop();

    expect(finished).toBe(true);
  });

  test("the API module starts the worker only in its import.meta.main boot guard", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const guard = source.indexOf("if (import.meta.main)");
    const start = source.indexOf("startImportJobWorker(");

    expect(guard).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(guard);
  });
});
