#!/usr/bin/env bun
/**
 * Runs the REAL `runAudit` in its own process against the fake audit command, then exits with
 * whatever it returned. Used by audit.process.test.ts to check exit-code propagation without
 * touching the network.
 *
 *   bun audit-harness.ts <fake-audit-mode> [policy-path]
 */
import { runAudit } from "../../audit";

const mode = process.argv[2] ?? "clean";
const policyPath = process.argv[3] ?? new URL("../../../security/audit-policy.json", import.meta.url).pathname;

process.exit(
  await runAudit({
    command: ["bun", new URL("./fake-audit.ts", import.meta.url).pathname, mode],
    policyPath,
    lockfilePath: new URL("../../../bun.lock", import.meta.url).pathname,
    // Fixed so the reviewed exception's expiry cannot make this test drift with the calendar.
    now: new Date("2026-08-12T00:00:00Z"),
  }),
);
