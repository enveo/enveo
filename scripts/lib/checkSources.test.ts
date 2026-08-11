/**
 * The `policy:sources` RUNNER (scripts/check-sources.ts).
 *
 * sourcePolicy.test.ts covers the rules; this covers the thing CI actually invokes — including
 * the exit-2 fail-closed path, which by definition never runs by accident and would otherwise
 * ship untested. A gate that silently passed when it could not read its own inputs would be
 * worse than no gate: it would report OK for a file nobody checked.
 */
import { describe, expect, it } from "bun:test";
import { EXIT_FAILED_CLOSED, EXIT_OK, EXIT_POLICY_VIOLATION, runSourcePolicy } from "../check-sources";

const collect = (): { code: number; log: string } => {
  const lines: string[] = [];
  const code = runSourcePolicy((line) => lines.push(line));
  return { code, log: lines.join("\n") };
};

describe("runSourcePolicy against the real repository", () => {
  it("passes, and says what it actually checked", () => {
    const { code, log } = collect();
    expect(code).toBe(EXIT_OK);
    expect(log).toContain("OK");
    expect(log).toMatch(/\d+ files/);
  });

  it("distinguishes its three exit codes", () => {
    // Kept honest as constants rather than magic numbers in CI: a violation and a failure to
    // establish the result are different events and must not collapse into one.
    expect(EXIT_OK).toBe(0);
    expect(EXIT_POLICY_VIOLATION).toBe(1);
    expect(EXIT_FAILED_CLOSED).toBe(2);
  });
});

describe("fail-closed", () => {
  it("returns exit 2 and names the file when one under policy cannot be read", async () => {
    // Drive the same logic against a missing file by importing the rules directly through a
    // read that throws: the runner's contract is "unreadable input is a FAILURE, never a pass".
    const { readFileSync } = await import("node:fs");
    let threw = false;
    try {
      readFileSync(new URL("definitely-not-here.md", new URL("../../", import.meta.url)), "utf8");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // And the runner reports that shape rather than swallowing it.
    const lines: string[] = [];
    const code = runSourcePolicy((line) => lines.push(line), ["docs/definitely-not-here.md"]);
    expect(code).toBe(EXIT_FAILED_CLOSED);
    expect(lines.join("\n")).toContain("docs/definitely-not-here.md");
    expect(lines.join("\n")).toMatch(/cannot read/i);
  });

  it("reports a violation (exit 1) for a file that breaks the image rule", () => {
    const lines: string[] = [];
    // `docs/releasing.md` is deliberately OUTSIDE the policy — it names exact versions by
    // design. Pointing the runner at it proves the rule fires, and proves the default scope is
    // a deliberate choice rather than an accident of which files happen to be clean.
    const code = runSourcePolicy((line) => lines.push(line), ["docs/releasing.md"]);
    expect(code).toBe(EXIT_POLICY_VIOLATION);
    expect(lines.join("\n")).toContain("image-tag");
  });
});
