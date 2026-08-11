/**
 * The Bun-version drift gate (§3e).
 *
 * Two halves. The `describe` blocks over synthetic inputs pin the PURE logic; the final block
 * runs the collectors over the REAL repository files, so this test is the check that fails when
 * the CI pin, the documented developer version, `@types/bun` and the Docker base drift apart.
 * It costs a few file reads and runs inside `bun run test` — no separate command to forget.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_VERSION_FILE,
  collectDockerfileBunBases,
  collectDocumentedBunVersions,
  collectTypesBunVersion,
  collectWorkflowBunVersions,
  findBunVersionDrift,
  findDockerBaseProblems,
  formatDrift,
  parseBunVersionFile,
  type VersionRef,
} from "./bunVersion";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

describe("parseBunVersionFile", () => {
  it("accepts one exact version and ignores surrounding whitespace", () => {
    expect(parseBunVersionFile("1.3.14\n")).toBe("1.3.14");
  });

  it("rejects a floating major — `1` is a moving target, not a pin", () => {
    expect(() => parseBunVersionFile("1\n")).toThrow(/exact Bun version/);
  });

  it("rejects a range", () => {
    expect(() => parseBunVersionFile("^1.3.14")).toThrow(/exact Bun version/);
  });
});

describe("collectWorkflowBunVersions", () => {
  it("reads the BUN_VERSION env value and literal setup-bun inputs", () => {
    const refs = collectWorkflowBunVersions(
      "ci.yml",
      ["env:", '  BUN_VERSION: "1.3.14"', "steps:", "  - uses: oven-sh/setup-bun@v2", "    with:", '      bun-version: "1.2.0"'].join("\n"),
    );

    expect(refs.map((r) => r.version)).toEqual(["1.3.14", "1.2.0"]);
  });

  it("skips a `${{ }}` expression — it is an indirection, checked where it is defined", () => {
    const refs = collectWorkflowBunVersions(
      "ci.yml",
      ["env:", '  BUN_VERSION: "1.3.14"', "      bun-version: ${{ env.BUN_VERSION }}"].join("\n"),
    );

    expect(refs).toHaveLength(1);
    expect(refs[0]?.version).toBe("1.3.14");
  });
});

describe("collectDockerfileBunBases", () => {
  it("reads version, digest and stage name from every FROM line", () => {
    const bases = collectDockerfileBunBases(
      ["FROM oven/bun:1.3.14@sha256:aa AS build", "RUN true", "FROM oven/bun:1.3.14@sha256:aa AS runtime"].join("\n"),
    );

    expect(bases).toHaveLength(2);
    expect(bases[0]).toMatchObject({ version: "1.3.14", digest: "sha256:aa" });
    expect(bases[1]?.where).toContain("runtime");
  });

  it("reports a bare tag as digestless rather than silently accepting it", () => {
    expect(collectDockerfileBunBases("FROM oven/bun:1 AS build")[0]?.digest).toBeNull();
  });
});

describe("findDockerBaseProblems", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  it("passes when every stage names the pinned version and one well-formed digest", () => {
    const bases = collectDockerfileBunBases(
      [`FROM oven/bun:1.3.14@${digest} AS build`, `FROM oven/bun:1.3.14@${digest} AS runtime`].join("\n"),
    );

    expect(findDockerBaseProblems("1.3.14", bases)).toEqual([]);
  });

  it("rejects a mutable bare tag", () => {
    const bases = collectDockerfileBunBases("FROM oven/bun:1.3.14 AS runtime");

    expect(findDockerBaseProblems("1.3.14", bases).join(" ")).toContain("no @sha256 digest");
  });

  it("rejects stages that disagree on the digest — build and ship must be one image", () => {
    const other = `sha256:${"b".repeat(64)}`;
    const bases = collectDockerfileBunBases(
      [`FROM oven/bun:1.3.14@${digest} AS build`, `FROM oven/bun:1.3.14@${other} AS runtime`].join("\n"),
    );

    expect(findDockerBaseProblems("1.3.14", bases).join(" ")).toContain("disagree on the base digest");
  });

  it("rejects a Dockerfile with no Bun base at all", () => {
    expect(findDockerBaseProblems("1.3.14", [])).toHaveLength(1);
  });
});

describe("collectTypesBunVersion", () => {
  it("strips the range operator so `^1.3.14` compares as `1.3.14`", () => {
    const refs = collectTypesBunVersion("package.json", JSON.stringify({ devDependencies: { "@types/bun": "^1.3.14" } }));

    expect(refs[0]?.version).toBe("1.3.14");
  });

  it("returns nothing when the dependency is absent", () => {
    expect(collectTypesBunVersion("package.json", "{}")).toEqual([]);
  });
});

describe("collectDocumentedBunVersions", () => {
  it("finds a version in prose regardless of bold/code decoration", () => {
    const refs = collectDocumentedBunVersions("docs.md", "Install Bun **1.3.14**, then Bun `1.3.14`.");

    expect(refs.map((r) => r.version)).toEqual(["1.3.14", "1.3.14"]);
  });
});

describe("findBunVersionDrift", () => {
  it("returns nothing when every reference agrees", () => {
    const refs: VersionRef[] = [{ file: "a", where: "x", version: "1.3.14" }];

    expect(findBunVersionDrift("1.3.14", refs)).toEqual([]);
  });

  it("names the file and locator of each disagreement", () => {
    const refs: VersionRef[] = [
      { file: "ci.yml", where: "BUN_VERSION", version: "1.3.14" },
      { file: "package.json", where: "@types/bun", version: "1.2.0" },
    ];

    expect(findBunVersionDrift("1.3.14", refs)).toEqual([
      { file: "package.json", where: "@types/bun", found: "1.2.0", expected: "1.3.14" },
    ]);
  });
});

// ── The actual repository-wide gate ─────────────────────────────────────────────────────────
//
// Everything above proves the logic; this proves the REPOSITORY. Add a new file that names a
// Bun version to DOC_FILES / WORKFLOW_FILES below and it joins the gate.

const WORKFLOW_FILES = [".github/workflows/ci.yml", ".github/workflows/security-audit.yml"] as const;
const DOC_FILES = ["README.md", "CONTRIBUTING.md", "docs/development.md", "docs/hosting.md", "docs/install.md"] as const;

describe(`the repository pins ONE Bun version (${BUN_VERSION_FILE})`, () => {
  const expected = parseBunVersionFile(read(BUN_VERSION_FILE));

  it("agrees across CI, the weekly audit, @types/bun and the documentation", () => {
    const refs: VersionRef[] = [
      ...WORKFLOW_FILES.flatMap((file) => collectWorkflowBunVersions(file, read(file))),
      ...collectTypesBunVersion("package.json", read("package.json")),
      ...DOC_FILES.flatMap((file) => collectDocumentedBunVersions(file, read(file))),
    ];

    // A gate that finds nothing is not a gate: if every collector came back empty the pins were
    // renamed or moved and this test would pass vacuously.
    expect(refs.length).toBeGreaterThan(3);
    expect(formatDrift(findBunVersionDrift(expected, refs))).toBe("");
  });

  it("is the version both Docker stages build and run on, at one immutable digest", () => {
    const bases = collectDockerfileBunBases(read("Dockerfile"));

    expect(bases.length).toBeGreaterThan(1);
    expect(findDockerBaseProblems(expected, bases)).toEqual([]);
  });
});
