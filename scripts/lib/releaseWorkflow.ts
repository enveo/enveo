/**
 * ONE list of architectures in the release workflow (§3d).
 *
 * The release used to name its platforms twice: a `platforms:` input for the push, and a
 * hardcoded `for arch in amd64 arm64` for the pre-push gate. Adding `linux/arm/v7` to the first
 * would have published a third architecture that no candidate build, no scan and no runtime
 * contract check ever saw — while the job summary still said "scanned per architecture".
 *
 * Two lists that must agree are a bug waiting for someone to edit one of them, and a comment
 * saying "keep these in sync" is not a mechanism. This is: the workflow may name architectures
 * in exactly one place, and everything else derives from it at runtime.
 *
 * Pure by design — the collector takes text, so the repository-wide assertion is one test.
 */

/** Architectures a `--platform` value can name. Deliberately broad: the point is to catch ANY. */
const PLATFORM = /\blinux\/(?:amd64|arm64|arm|386|ppc64le|s390x|riscv64|mips64le)\b[\w/]*/g;

/** The single permitted definition. */
const DEFINITION = /^\s*PLATFORMS:\s*(\S.*?)\s*$/;

/**
 * Strip comments so prose may discuss `linux/arm64` freely — only executable YAML is policed.
 *
 * Deliberately conservative: a `#` is treated as starting a comment only at the beginning of a
 * line or after whitespace, which is how every comment in these workflows is written.
 */
export function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return "";
      return line.replace(/\s+#.*$/, "");
    })
    .join("\n");
}

/**
 * Every place the workflow names an architecture outside the single `PLATFORMS:` definition,
 * plus a report if that definition is missing or duplicated.
 *
 * An empty array means the workflow has exactly one architecture list and derives the rest.
 */
export function findPlatformDivergence(file: string, yaml: string): string[] {
  const problems: string[] = [];
  const lines = stripComments(yaml).split("\n");

  const definitions = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => DEFINITION.test(line));

  if (definitions.length === 0) {
    return [`${file}: no PLATFORMS definition — the architecture list must live in exactly one place`];
  }
  if (definitions.length > 1) {
    problems.push(
      `${file}: PLATFORMS is defined ${definitions.length} times (lines ${definitions
        .map((d) => d.index + 1)
        .join(", ")}) — there can be only one`,
    );
  }
  const definitionLines = new Set(definitions.map((d) => d.index));

  lines.forEach((line, index) => {
    if (definitionLines.has(index)) return;
    for (const match of line.matchAll(PLATFORM)) {
      problems.push(
        `${file}:${index + 1}: names ${match[0]} directly — derive it from $PLATFORMS instead, ` +
          "or the gated architectures will drift from the published ones",
      );
    }
  });

  return problems;
}
