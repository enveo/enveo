#!/usr/bin/env bun
/**
 * Dependency-audit gate (§3a). `bun run security:audit`.
 *
 * Runs the FULL `bun audit --json` (dev/build dependencies included — the runtime image is built
 * from this tree) and hands the result to the pure evaluator in lib/auditPolicy.ts.
 *
 * Exit codes:
 *   0  every finding is either absent or covered by an exact, unexpired, reviewed exception
 *   1  policy violation — a forbidden/unknown/expired/stale/mismatched finding
 *   2  FAIL CLOSED — the audit could not be established at all (command missing, registry or
 *      network failure, unexpected exit status, malformed JSON, unreadable lockfile/policy)
 *
 * Deliberately NOT used: `bun audit --ignore` and `--audit-level`. Accepted findings must stay
 * visible to every reviewer, so suppression happens in the reviewed policy file, never in the
 * command line that produces the evidence.
 */
import {
  evaluateAudit,
  parseAuditJson,
  parseBunLock,
  parsePolicy,
  type AuditReport,
} from "./lib/auditPolicy";

export const EXIT_OK = 0;
export const EXIT_POLICY_VIOLATION = 1;
export const EXIT_FAILED_CLOSED = 2;

const DEFAULT_COMMAND = ["bun", "audit", "--json"] as const;
const ROOT = new URL("../", import.meta.url);

export type AuditRunOptions = Readonly<{
  command?: readonly string[];
  cwd?: string;
  lockfilePath?: string;
  policyPath?: string;
  now?: Date;
  log?: (line: string) => void;
}>;

/** Drop ANSI colours and anything that looks like `user:password@` before echoing tool output. */
export function sanitizeToolOutput(text: string, limit = 800): string {
  const plain = text
    // eslint-disable-next-line no-control-regex -- stripping ANSI escapes is the point
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***:***@")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Sanitized table of EVERY advisory — accepted ones included, with owner and days remaining. */
export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  if (report.entries.length === 0) {
    lines.push("No advisories reported for the installed dependency graph.");
  } else {
    const rows = report.entries.map((entry) => ({
      severity: entry.advisory.severity,
      pkg: entry.advisory.package,
      id: entry.advisory.advisoryId,
      where: entry.installed.map((i) => `${i.version} via ${i.path}`).join(", ") || "—",
      verdict: entry.verdict,
    }));
    const w = {
      severity: Math.max(8, ...rows.map((r) => r.severity.length)),
      pkg: Math.max(7, ...rows.map((r) => r.pkg.length)),
      id: Math.max(10, ...rows.map((r) => r.id.length)),
      verdict: 8,
    };
    lines.push(
      `${pad("SEVERITY", w.severity)}  ${pad("PACKAGE", w.pkg)}  ${pad("ADVISORY", w.id)}  ` +
        `${pad("VERDICT", w.verdict)}  INSTALLED`,
    );
    for (const r of rows) {
      lines.push(
        `${pad(r.severity, w.severity)}  ${pad(r.pkg, w.pkg)}  ${pad(r.id, w.id)}  ` +
          `${pad(r.verdict, w.verdict)}  ${r.where}`,
      );
    }
  }

  const accepted = report.entries.filter((e) => e.verdict === "accepted");
  if (accepted.length > 0) {
    lines.push("", "Accepted by reviewed exception:");
    for (const entry of accepted) {
      lines.push(
        `  • ${entry.advisory.advisoryId} (${entry.advisory.package}) — owner ${entry.owner}, ` +
          `expires ${entry.expires} (${entry.daysUntilExpiry} days left)`,
      );
      lines.push(`    ${entry.reason}`);
    }
  }

  if (report.problems.length > 0) {
    lines.push("", "POLICY VIOLATIONS:");
    for (const problem of report.problems) lines.push(`  ✗ ${problem}`);
  }
  return lines.join("\n");
}

export async function runAudit(options: AuditRunOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const command = options.command ?? DEFAULT_COMMAND;
  const cwd = options.cwd ?? ROOT.pathname;
  const lockfilePath = options.lockfilePath ?? new URL("bun.lock", ROOT).pathname;
  const policyPath = options.policyPath ?? new URL("security/audit-policy.json", ROOT).pathname;
  const now = options.now ?? new Date();

  const closed = (reason: string): number => {
    log(`\nsecurity:audit FAILED CLOSED — ${reason}`);
    log("The dependency audit could not be established, so it is NOT a pass.");
    return EXIT_FAILED_CLOSED;
  };

  let policyText: string;
  let lockText: string;
  try {
    policyText = await Bun.file(policyPath).text();
  } catch (error) {
    return closed(`cannot read the audit policy (${(error as Error).message})`);
  }
  try {
    lockText = await Bun.file(lockfilePath).text();
  } catch (error) {
    return closed(`cannot read bun.lock (${(error as Error).message})`);
  }

  const policy = parsePolicy(policyText);
  if (!policy.ok) return closed(`invalid audit policy: ${policy.error}`);
  const installed = parseBunLock(lockText);
  if (!installed.ok) return closed(installed.error);

  log(`security:audit — ${command.join(" ")}`);

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    exitCode = await child.exited;
    if (child.signalCode) return closed(`the audit command was terminated by ${child.signalCode}`);
  } catch (error) {
    return closed(`could not run the audit command (${(error as Error).message})`);
  }

  // Bun exits 1 BOTH for "advisories found" and for a tool/registry failure (the latter with
  // empty stdout), so the exit code alone can never be trusted — the body must parse.
  if (exitCode !== 0 && exitCode !== 1) {
    return closed(
      `unexpected exit code ${exitCode} from the audit command: ${sanitizeToolOutput(stderr)}`,
    );
  }
  const advisories = parseAuditJson(stdout);
  if (!advisories.ok) {
    return closed(
      `${advisories.error}` +
        (stderr.trim() ? ` — tool output: ${sanitizeToolOutput(stderr)}` : ""),
    );
  }

  const report = evaluateAudit({
    advisories: advisories.value,
    installed: installed.value,
    policy: policy.value,
    now,
  });

  log("");
  log(formatReport(report));
  log("");
  if (!report.ok) {
    log("security:audit FAILED — fix the dependency, or add/refresh a reviewed exception in");
    log("security/audit-policy.json. Critical/high advisories can never be excepted.");
    return EXIT_POLICY_VIOLATION;
  }
  log("security:audit PASSED — zero unreviewed findings.");
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(await runAudit());
}
