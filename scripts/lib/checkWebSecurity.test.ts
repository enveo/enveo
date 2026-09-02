import { describe, expect, it } from "bun:test";
import { EXIT_FAILED_CLOSED, EXIT_OK, EXIT_POLICY_VIOLATION, runWebSecurityPolicy } from "../check-web-security";

const run = (files?: readonly string[]) => {
  const lines: string[] = [];
  const code = runWebSecurityPolicy((line) => lines.push(line), files);
  return { code, log: lines.join("\n") };
};

describe("runWebSecurityPolicy", () => {
  it("returns zero for a clean production source fixture", () => {
    expect(run(["packages/web/src/lib/version.ts"]).code).toBe(EXIT_OK);
  });

  it("passes the complete production web tree", () => {
    const result = run();
    expect(result.code).toBe(EXIT_OK);
    expect(result.log).toContain("OK");
  });

  it("returns two rather than passing when a source file cannot be read", () => {
    const result = run(["packages/web/src/definitely-not-here.ts"]);
    expect(result.code).toBe(EXIT_FAILED_CLOSED);
    expect(result.log).toContain("cannot read");
  });

  it("keeps distinct exit codes for success, violations, and failed-closed reads", () => {
    expect([EXIT_OK, EXIT_POLICY_VIOLATION, EXIT_FAILED_CLOSED]).toEqual([0, 1, 2]);
  });
});
