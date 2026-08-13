#!/usr/bin/env bun
/**
 * Web initial-JS budget gate (§3f). Runs as part of the root `build` contract, so `verify`,
 * `verify:ci` and release verification all enforce the same two ceilings.
 *
 * It reads the Vite build manifest, walks the STATIC import closure from the HTML entry and
 * sums real file bytes plus deterministic gzip bytes. The contributor table prints on every
 * run — a budget only visible on failure is a budget nobody watches creeping upwards.
 *
 * Requires a completed production build; `bun run build:web` emits the manifest.
 *
 * Exit codes:
 *   0  within budget
 *   1  over one or both ceilings
 *   2  FAIL CLOSED — no manifest, unreadable manifest, or a manifest naming files the build
 *      did not emit (all of which mean the number would be a fiction)
 */
import { readFileSync } from "node:fs";
import { DIST_DIR, evaluateBudget, formatReport, initialJsClosure, MANIFEST_PATH, ManifestError, measureClosure, parseManifest } from "./lib/webBundle";

export const EXIT_OK = 0;
export const EXIT_OVER_BUDGET = 1;
export const EXIT_FAILED_CLOSED = 2;

const ROOT = new URL("../", import.meta.url);

export function runWebBundleBudget(log: (line: string) => void = console.log, manifestPath: string = MANIFEST_PATH, distDir: string = DIST_DIR): number {
  let manifestText: string;
  try {
    manifestText = readFileSync(new URL(manifestPath, ROOT), "utf8");
  } catch (error) {
    log(`bundle:budget: cannot read ${manifestPath} — ${(error as Error).message}`);
    log("bundle:budget: run `bun run build:web` first (the manifest comes from `build.manifest: true`)");
    return EXIT_FAILED_CLOSED;
  }

  let report: ReturnType<typeof evaluateBudget>;
  try {
    const manifest = parseManifest(manifestText);
    const closure = initialJsClosure(manifest);
    const contributors = measureClosure(manifest, closure, (file) => {
      try {
        return readFileSync(new URL(`${distDir}/${file}`, ROOT));
      } catch {
        return null;
      }
    });
    report = evaluateBudget(contributors);
  } catch (error) {
    if (error instanceof ManifestError) {
      log(`bundle:budget: ${error.message}`);
      return EXIT_FAILED_CLOSED;
    }
    throw error;
  }

  log(formatReport(report));
  if (report.violations.length > 0) {
    log("bundle:budget: FAILED — move code behind a dynamic `import()`; the ceilings are decided and are not raised to pass a build");
    return EXIT_OVER_BUDGET;
  }
  return EXIT_OK;
}

if (import.meta.main) process.exit(runWebBundleBudget());
