#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWebSecuritySource, type WebSecurityViolation } from "./lib/webSecurityPolicy";

export const EXIT_OK = 0;
export const EXIT_POLICY_VIOLATION = 1;
export const EXIT_FAILED_CLOSED = 2;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB_SOURCE = "packages/web/src";

const isProductionSource = (name: string): boolean =>
  (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test") && !name.endsWith(".d.ts") && name !== "messages.generated.ts";

function productionWebSources(directory = join(ROOT, WEB_SOURCE)): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionWebSources(path);
    return isProductionSource(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const formatViolations = (violations: readonly WebSecurityViolation[]): string =>
  violations.map((violation) => `  ${violation.file}:${violation.line}  [${violation.rule}] ${violation.detail}`).join("\n");

export function runWebSecurityPolicy(
  log: (line: string) => void = console.log,
  files?: readonly string[],
  /** Test seam for the fail-closed discovery boundary. */
  discover: () => readonly string[] = productionWebSources,
): number {
  let targets: readonly string[];
  try {
    targets = files ?? discover();
  } catch (error) {
    log(`policy:web-security: cannot discover production web sources — ${(error as Error).message}`);
    return EXIT_FAILED_CLOSED;
  }
  const violations: WebSecurityViolation[] = [];
  for (const file of targets) {
    let source: string;
    try {
      source = readFileSync(join(ROOT, file), "utf8");
    } catch (error) {
      log(`policy:web-security: cannot read ${file} — ${(error as Error).message}`);
      return EXIT_FAILED_CLOSED;
    }
    violations.push(...checkWebSecuritySource(file, source));
  }
  if (violations.length > 0) {
    log(`policy:web-security: ${violations.length} violation(s)\n${formatViolations(violations)}`);
    return EXIT_POLICY_VIOLATION;
  }
  log(`policy:web-security: OK — ${targets.length} production web source files, no unsafe execution sinks`);
  return EXIT_OK;
}

if (import.meta.main) process.exit(runWebSecurityPolicy());
