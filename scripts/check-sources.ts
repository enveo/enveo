#!/usr/bin/env bun
/**
 * Self-host source policy gate (§5a). `bun run policy:sources`.
 *
 * Applies the pure rules in lib/sourcePolicy.ts to the real tree: canonical self-host
 * documentation may name the Enveo image only as `ghcr.io/enveo/enveo:latest`, and the
 * deployment bootstrap script may not download or execute anything from the network.
 *
 * Offline by construction — it reads files, never the registry. A documentation gate that
 * asked GHCR "what is the current version?" would fail on a network blip and, worse, would
 * make the docs' correctness a property of the registry rather than of the repository.
 *
 * Exit codes:
 *   0  policy holds
 *   1  policy violation (each one printed with file, line and rule)
 *   2  FAIL CLOSED — a file under policy could not be read at all
 */
import { readFileSync } from "node:fs";
import { checkDeployScript, checkSelfHostImageRefs, DEPLOY_SCRIPT, formatViolations, SELF_HOST_DOCS, type PolicyViolation } from "./lib/sourcePolicy";

export const EXIT_OK = 0;
export const EXIT_POLICY_VIOLATION = 1;
export const EXIT_FAILED_CLOSED = 2;

const ROOT = new URL("../", import.meta.url);

export function runSourcePolicy(
  log: (line: string) => void = console.log,
  /** Overridable ONLY so the tests can drive the violation and unreadable-file paths. */
  paths: readonly string[] = [...SELF_HOST_DOCS, DEPLOY_SCRIPT],
): number {
  const violations: PolicyViolation[] = [];
  const files = paths;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(new URL(file, ROOT), "utf8");
    } catch (error) {
      log(`policy:sources: cannot read ${file} — ${(error as Error).message}`);
      return EXIT_FAILED_CLOSED;
    }
    violations.push(...(file === DEPLOY_SCRIPT ? checkDeployScript(text) : checkSelfHostImageRefs(file, text)));
  }
  if (violations.length > 0) {
    log(`policy:sources: ${violations.length} violation(s)\n${formatViolations(violations)}`);
    return EXIT_POLICY_VIOLATION;
  }
  log(`policy:sources: OK — ${files.length} files, image references on \`:latest\`, no remote installer`);
  return EXIT_OK;
}

if (import.meta.main) process.exit(runSourcePolicy());
