/**
 * The action-pinning gate (§3d).
 *
 * Same shape as the Bun-version gate: synthetic inputs pin the logic, and the final block runs
 * the collector over the REAL workflow files. A release job holds `packages: write` and
 * `id-token: write`; a floating `@v4` inside it is a third party's ability to change what runs
 * there, at any time, without a pull request.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectActionUses, findPinProblems } from "./actionPins";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

const SHA_A = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SHA_B = "0c5077e51419868618aeaa5fe8019c62421857d6";

const workflow = (...lines: string[]): string => lines.join("\n");

describe("collectActionUses", () => {
  it("reads the reference and the trailing version comment", () => {
    const uses = collectActionUses("ci.yml", workflow("steps:", `  - uses: actions/checkout@${SHA_A} # v7.0.1`));

    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ reference: `actions/checkout@${SHA_A}`, comment: "v7.0.1", line: 2 });
  });

  it("reads a `uses:` that is not the first key of its step", () => {
    const uses = collectActionUses("ci.yml", workflow("    name: Check out", `    uses: actions/checkout@${SHA_A} # v7.0.1`));

    expect(uses).toHaveLength(1);
  });

  it("reads a job-level reusable-workflow reference", () => {
    const uses = collectActionUses("ci.yml", workflow("jobs:", "  verify:", "    uses: ./.github/workflows/verify.yml"));

    expect(uses[0]?.reference).toBe("./.github/workflows/verify.yml");
  });

  it("does not mistake prose containing the word uses for a reference", () => {
    expect(collectActionUses("ci.yml", workflow("# this job uses: nothing"))).toEqual([]);
  });
});

describe("findPinProblems", () => {
  const use = (reference: string, comment: string | null = "v1.2.3") => [
    { file: "w.yml", reference, comment, line: 1 },
  ];

  it("accepts a full SHA with a version comment", () => {
    expect(findPinProblems(use(`actions/checkout@${SHA_A}`, "v7.0.1"))).toEqual([]);
  });

  it("rejects a floating major tag", () => {
    expect(findPinProblems(use("actions/checkout@v4"))[0]).toMatch(/MOVING pointer/);
  });

  it("rejects a branch", () => {
    expect(findPinProblems(use("some/action@main"))[0]).toMatch(/MOVING pointer/);
  });

  it("rejects a short SHA — GitHub resolves it, but it is not a full pin", () => {
    expect(findPinProblems(use("some/action@3d3c42e"))[0]).toMatch(/MOVING pointer/);
  });

  it("rejects a reference with no ref at all", () => {
    expect(findPinProblems(use("some/action"))[0]).toMatch(/no ref at all/);
  });

  it("rejects a correct pin with no maintainable version comment", () => {
    expect(findPinProblems(use(`actions/checkout@${SHA_A}`, null))[0]).toMatch(/version comment/);
    expect(findPinProblems(use(`actions/checkout@${SHA_A}`, "pinned"))[0]).toMatch(/version comment/);
  });

  it("accepts a local reusable workflow without a ref", () => {
    expect(findPinProblems(use("./.github/workflows/verify.yml", null))).toEqual([]);
  });

  it("rejects a ref on a local reusable workflow — the caller's revision is the point", () => {
    expect(findPinProblems(use("./.github/workflows/verify.yml@main", null))[0]).toMatch(/must not carry a ref/);
  });

  it("rejects one action pinned to two different SHAs", () => {
    const problems = findPinProblems([
      { file: "a.yml", reference: `actions/checkout@${SHA_A}`, comment: "v7.0.1", line: 1 },
      { file: "b.yml", reference: `actions/checkout@${SHA_B}`, comment: "v7.0.1", line: 9 },
    ]);

    expect(problems.at(-1)).toMatch(/more than one SHA/);
  });

  it("accepts the same action pinned identically in several files", () => {
    expect(
      findPinProblems([
        { file: "a.yml", reference: `actions/checkout@${SHA_A}`, comment: "v7.0.1", line: 1 },
        { file: "b.yml", reference: `actions/checkout@${SHA_A}`, comment: "v7.0.1", line: 9 },
      ]),
    ).toEqual([]);
  });
});

// ── The actual repository-wide gate ─────────────────────────────────────────────────────────
//
// Deliberately globbed rather than listed: a NEW workflow joins the gate the moment it is added,
// which is exactly when an unpinned action would otherwise slip in unnoticed.

describe("every workflow pins its third-party actions", () => {
  const files = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

  it("finds workflows to check", () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it("pins each one to a full commit SHA with a maintainable version comment", () => {
    const uses = files.flatMap((name) =>
      collectActionUses(`.github/workflows/${name}`, readFileSync(join(WORKFLOW_DIR, name), "utf8")),
    );

    // A gate that finds nothing is not a gate.
    expect(uses.length).toBeGreaterThan(5);
    expect(findPinProblems(uses)).toEqual([]);
  });
});
