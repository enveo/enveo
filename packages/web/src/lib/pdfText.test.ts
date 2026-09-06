import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installPdfPolyfills } from "./pdfPolyfills";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

describe("pdf.js on older engines", () => {
  test("the polyfills load before pdf.js in the page and in the worker (import order is the mechanism)", () => {
    for (const [file, pdfjs] of [
      ["pdfText.ts", 'import("pdfjs-dist/legacy/build/pdf.mjs")'],
      ["pdfWorker.ts", 'import "pdfjs-dist/legacy/build/pdf.worker.min.mjs"'],
    ] as const) {
      const source = read(file);
      const polyfills = source.indexOf('import "./pdfPolyfills"');
      expect(polyfills, file).toBeGreaterThanOrEqual(0);
      expect(source.indexOf(pdfjs), file).toBeGreaterThan(polyfills);
    }
  });

  test("the worker is Enveo's entry on a classic Worker, never pdf.js's own file", () => {
    const source = read("pdfText.ts");
    expect(source).toContain('new Worker(new URL("./pdfWorker.ts", import.meta.url))');
    expect(source).not.toContain("workerSrc");
    expect(source).not.toContain("pdf.worker.min.mjs");
  });

  test("Promise.withResolvers is shimmed only where it is missing", async () => {
    const P = Promise as unknown as { withResolvers?: unknown };
    const native = P.withResolvers;
    delete P.withResolvers;
    try {
      installPdfPolyfills();
      expect(typeof P.withResolvers).toBe("function");
      const { promise, resolve } = (P.withResolvers as () => { promise: Promise<number>; resolve: (v: number) => void })();
      resolve(7);
      expect(await promise).toBe(7);
    } finally {
      P.withResolvers = native;
    }
  });
});
