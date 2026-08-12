/**
 * The single-architecture-list gate (§3d).
 *
 * Synthetic inputs pin the logic; the final block runs it over the REAL release workflow, so the
 * day someone adds `linux/arm/v7` to the push without extending the gate, `bun run test` fails
 * instead of a third architecture shipping unscanned.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPlatformDivergence, stripComments } from "./releaseWorkflow";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RELEASE = ".github/workflows/release.yml";

const workflow = (...lines: string[]): string => lines.join("\n");

describe("stripComments", () => {
  it("drops whole-line comments", () => {
    expect(stripComments("  # linux/arm64 is discussed here\nfoo: bar").trim()).toBe("foo: bar");
  });

  it("drops trailing comments but keeps the code", () => {
    expect(stripComments("  run: thing  # see linux/arm64")).toBe("  run: thing");
  });

  it("does not treat a mid-token # as a comment", () => {
    expect(stripComments("  tag: sha256:ab#cd")).toBe("  tag: sha256:ab#cd");
  });
});

describe("findPlatformDivergence", () => {
  it("accepts a workflow with exactly one definition and derived use", () => {
    const yaml = workflow(
      "env:",
      "  PLATFORMS: linux/amd64,linux/arm64",
      "jobs:",
      "  publish:",
      "    steps:",
      "      - run: for p in $(echo \"$PLATFORMS\" | tr ',' ' '); do build $p; done",
      "      - with:",
      "          platforms: ${{ env.PLATFORMS }}",
    );

    expect(findPlatformDivergence(RELEASE, yaml)).toEqual([]);
  });

  it("catches the exact defect: a hardcoded gate loop beside a PLATFORMS push", () => {
    const yaml = workflow("env:", "  PLATFORMS: linux/amd64,linux/arm64", "      - run: for arch in linux/amd64 linux/arm64; do gate $arch; done");

    const problems = findPlatformDivergence(RELEASE, yaml);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/names linux\/amd64 directly/);
  });

  it("catches a platform named in a step input", () => {
    const yaml = workflow("env:", "  PLATFORMS: linux/amd64", "          platforms: linux/arm64");

    expect(findPlatformDivergence(RELEASE, yaml)[0]).toMatch(/linux\/arm64/);
  });

  it("allows prose to discuss architectures", () => {
    const yaml = workflow(
      "env:",
      "  PLATFORMS: linux/amd64,linux/arm64",
      "      # the linux/arm64 leg is emulated under QEMU and is slow",
      "      - run: build  # not linux/amd64 specific",
    );

    expect(findPlatformDivergence(RELEASE, yaml)).toEqual([]);
  });

  it("rejects a workflow with no definition at all", () => {
    expect(findPlatformDivergence(RELEASE, "jobs: {}")[0]).toMatch(/no PLATFORMS definition/);
  });

  it("rejects two definitions — which one wins is exactly the ambiguity being removed", () => {
    const yaml = workflow("env:", "  PLATFORMS: linux/amd64", "  PLATFORMS: linux/amd64,linux/arm64");

    expect(findPlatformDivergence(RELEASE, yaml)[0]).toMatch(/defined 2 times/);
  });

  it("catches a variant-qualified platform", () => {
    const yaml = workflow("env:", "  PLATFORMS: linux/amd64", "      - run: docker build --platform linux/arm/v7 .");

    expect(findPlatformDivergence(RELEASE, yaml)[0]).toMatch(/linux\/arm/);
  });
});

describe("the real release workflow keeps ONE architecture list", () => {
  it("names its platforms in exactly one place", () => {
    const yaml = readFileSync(join(REPO_ROOT, RELEASE), "utf8");

    // A gate that finds nothing is not a gate: the definition must actually be there.
    expect(yaml).toContain("PLATFORMS:");
    expect(findPlatformDivergence(RELEASE, yaml)).toEqual([]);
  });
});
