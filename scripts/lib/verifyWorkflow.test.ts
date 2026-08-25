import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/verify.yml"), "utf8");

describe("the reusable verification workflow", () => {
  it("checks out full history for the revision-bound recognition baseline", () => {
    expect(workflow.match(/uses: actions\/checkout@/g)).toHaveLength(1);
    expect(workflow).toContain("fetch-depth: 0");
  });
});
