/**
 * Process-level tests for the audit gate (§3a).
 *
 * The pure evaluator is covered by auditPolicy.test.ts; what is tested HERE is the part that
 * only shows up when a real child process is involved — above all that "exit 1 with parseable
 * findings" and "exit 1 because the tool failed" produce different verdicts.
 */
import { describe, expect, it } from "bun:test";
import { EXIT_FAILED_CLOSED, EXIT_OK, EXIT_POLICY_VIOLATION, runAudit, sanitizeToolOutput } from "../audit";

const FAKE = new URL("./fixtures/fake-audit.ts", import.meta.url).pathname;
const POLICY = new URL("../../security/audit-policy.json", import.meta.url).pathname;
const LOCK = new URL("../../bun.lock", import.meta.url).pathname;
const NOW = new Date("2026-08-12T00:00:00Z"); // inside the reviewed esbuild exception window

function silent(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}

async function run(mode: string, now = NOW) {
  const sink = silent();
  const code = await runAudit({
    command: ["bun", FAKE, mode],
    policyPath: POLICY,
    lockfilePath: LOCK,
    now,
    log: sink.log,
  });
  return { code, output: sink.lines.join("\n") };
}

describe("runAudit (real child process, fake audit command)", () => {
  it("fails the STALE exception when the command reports nothing (exit 0, `{}`)", async () => {
    // The repository policy currently excepts one real advisory, so a clean report means that
    // exception is dead wood — the gate must say so rather than quietly pass.
    const { code, output } = await run("clean");

    expect(code).toBe(EXIT_POLICY_VIOLATION);
    expect(output).toContain("stale exception");
  });

  it("accepts exit code 1 WITH parseable findings covered by the reviewed policy", async () => {
    const { code, output } = await run("findings");

    expect(code).toBe(EXIT_OK);
    expect(output).toContain("GHSA-67mh-4wv8-2f99");
    expect(output).toContain("accepted");
    expect(output).toContain("days left");
    expect(output).toContain("security:audit PASSED");
  });

  it("fails closed on exit code 1 caused by a registry/network failure (empty stdout)", async () => {
    const { code, output } = await run("toolfailure");

    expect(code).toBe(EXIT_FAILED_CLOSED);
    expect(output).toContain("FAILED CLOSED");
    expect(output).toContain("connection refused");
  });

  it("fails closed on exit code 1 with a VALID but empty body", async () => {
    // Exit 1 is the "advisories found" status. A body that parses to zero advisories therefore
    // contradicts it, and must never be reported as a clean scan — otherwise a degraded
    // registry that exits 1 while printing `{}` passes the gate. With an empty policy (the
    // normal steady state) nothing else would catch it.
    const { code, output } = await run("emptyfindings");

    expect(code).toBe(EXIT_FAILED_CLOSED);
    expect(output).toContain("FAILED CLOSED");
    expect(output).toContain("no advisories");
    expect(output).toContain("503");
    expect(output).not.toContain("PASSED");
  });

  it("fails closed on exit 1 + empty body even with an EMPTY policy", async () => {
    // The steady state: once no exception is needed, a stale entry can no longer accidentally
    // turn this into a failure. Without the explicit invariant this run reported
    // "PASSED — zero unreviewed findings" and exited 0.
    const sink = silent();
    const code = await runAudit({
      command: ["bun", FAKE, "emptyfindings"],
      policyPath: new URL("./fixtures/empty-policy.json", import.meta.url).pathname,
      lockfilePath: LOCK,
      now: NOW,
      log: sink.log,
    });

    expect(code).toBe(EXIT_FAILED_CLOSED);
    expect(sink.lines.join("\n")).not.toContain("PASSED");
  });

  it("passes cleanly on exit 0 with an empty body and an EMPTY policy", async () => {
    // The genuine clean scan, so the invariant above cannot be satisfied by rejecting everything.
    const sink = silent();
    const code = await runAudit({
      command: ["bun", FAKE, "clean"],
      policyPath: new URL("./fixtures/empty-policy.json", import.meta.url).pathname,
      lockfilePath: LOCK,
      now: NOW,
      log: sink.log,
    });

    expect(code).toBe(EXIT_OK);
    expect(sink.lines.join("\n")).toContain("security:audit PASSED");
  });

  it("still evaluates exit code 1 that carries a real finding", async () => {
    // The counterpart to the case above: this shape is legitimate and must NOT fail closed.
    const { code, output } = await run("findings");

    expect(code).toBe(EXIT_OK);
    expect(output).not.toContain("FAILED CLOSED");
    expect(output).toContain("security:audit PASSED");
  });

  it("fails closed on output that is not the documented JSON schema", async () => {
    const { code } = await run("garbage");

    expect(code).toBe(EXIT_FAILED_CLOSED);
  });

  it("fails closed on an unexpected exit status", async () => {
    const { code, output } = await run("crash");

    expect(code).toBe(EXIT_FAILED_CLOSED);
    expect(output).toContain("unexpected exit code 7");
  });

  it("fails closed when the audit command does not exist at all", async () => {
    const sink = silent();
    const code = await runAudit({
      command: ["definitely-not-a-real-command-9f3a"],
      policyPath: POLICY,
      lockfilePath: LOCK,
      now: NOW,
      log: sink.log,
    });

    expect(code).toBe(EXIT_FAILED_CLOSED);
  });

  it("rejects a high advisory reported by the command", async () => {
    const { code, output } = await run("high");

    expect(code).toBe(EXIT_POLICY_VIOLATION);
    expect(output).toContain("no exception path");
  });

  it("fails closed on an expired exception without touching the network", async () => {
    const { code, output } = await run("findings", new Date("2027-01-01T00:00:00Z"));

    expect(code).toBe(EXIT_POLICY_VIOLATION);
    expect(output).toContain("expired");
  });

  it("fails closed when the policy file is missing or invalid", async () => {
    const sink = silent();
    const missing = await runAudit({
      command: ["bun", FAKE, "clean"],
      policyPath: "/nonexistent/audit-policy.json",
      lockfilePath: LOCK,
      now: NOW,
      log: sink.log,
    });

    expect(missing).toBe(EXIT_FAILED_CLOSED);
  });

  // Exit-code propagation through a real process boundary. Driven by the fake audit command,
  // NOT the live registry: `bun run test` (and therefore `bun run verify`) must stay offline
  // and fast, and asserting "some exit code in {0,1,2}" would assert nothing at all.
  const HARNESS = new URL("./fixtures/audit-harness.ts", import.meta.url).pathname;
  const EMPTY_POLICY = new URL("./fixtures/empty-policy.json", import.meta.url).pathname;

  async function spawnHarness(mode: string, policyPath?: string) {
    const child = Bun.spawn(
      ["bun", HARNESS, mode, ...(policyPath ? [policyPath] : [])],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    return { code, stdout };
  }

  it("exits 0 through a real process boundary when the policy covers the finding", async () => {
    const { code, stdout } = await spawnHarness("findings");

    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("GHSA-67mh-4wv8-2f99");
    expect(stdout).toContain("security:audit PASSED");
  });

  it("exits 1 through a real process boundary on a forbidden advisory", async () => {
    const { code, stdout } = await spawnHarness("high", EMPTY_POLICY);

    expect(code).toBe(EXIT_POLICY_VIOLATION);
    expect(stdout).toContain("no exception path");
    expect(stdout).toContain("security:audit FAILED");
  });

  it("exits 2 through a real process boundary when the tool fails", async () => {
    const { code, stdout } = await spawnHarness("toolfailure", EMPTY_POLICY);

    expect(code).toBe(EXIT_FAILED_CLOSED);
    expect(stdout).toContain("FAILED CLOSED");
  });
});

describe("sanitizeToolOutput", () => {
  it("removes ANSI colour codes and credentials from echoed tool output", () => {
    const dirty = "[31merror[0m: https://user:hunter2@registry.example/x failed";
    const clean = sanitizeToolOutput(dirty);

    expect(clean).not.toContain("hunter2");
    expect(clean).not.toContain("[31m");
    expect(clean).toContain("//***:***@");
  });

  it("truncates very long output", () => {
    expect(sanitizeToolOutput("x".repeat(5000)).length).toBeLessThan(1000);
  });
});
