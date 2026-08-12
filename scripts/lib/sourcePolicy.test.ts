/**
 * The self-host source policy (§5a).
 *
 * Two halves, same shape as bunVersion.test.ts: `describe` blocks pin the PURE rules against
 * synthetic input, and the final block runs them over the REAL repository files — so this test
 * fails the moment a canonical self-host document grows a numeric image tag or `deploy.sh`
 * regains a remote installer. The runnable gate is `bun run policy:sources`; these tests exist
 * so the rules themselves are covered without a subprocess.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkDeployScript, checkSelfHostImageRefs, DEPLOY_SCRIPT, formatViolations, SELF_HOST_DOCS } from "./sourcePolicy";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

describe("checkSelfHostImageRefs", () => {
  it("accepts the canonical alias", () => {
    expect(checkSelfHostImageRefs("compose.selfhost.yml", "    image: ghcr.io/enveo/enveo:latest\n")).toEqual([]);
  });

  it("accepts a bare package name — it names the package, not a version to pull", () => {
    expect(checkSelfHostImageRefs("README.md", "`ghcr.io/enveo/enveo` becomes pullable when…")).toEqual([]);
  });

  it("rejects a numeric tag: the docs must not tell operators to pin a version", () => {
    const found = checkSelfHostImageRefs("docs/operations.md", "swap it for `ghcr.io/enveo/enveo:3.6.2`\n");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "docs/operations.md", line: 1, rule: "image-tag" });
    expect(found[0]!.detail).toContain("3.6.2");
  });

  it("rejects an `X.Y.Z` placeholder tag", () => {
    const found = checkSelfHostImageRefs("docs/hosting.md", "docker pull ghcr.io/enveo/enveo:X.Y.Z");
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe("image-tag");
  });

  it("rejects a digest pin — the canonical path is the alias, not a digest", () => {
    const found = checkSelfHostImageRefs("docs/hosting.md", "ghcr.io/enveo/enveo@sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(found).toHaveLength(1);
  });

  it("rejects a bare version placeholder anywhere in the file, not only in an image reference", () => {
    const found = checkSelfHostImageRefs("docs/hosting.md", "git tag vX.Y.Z && git push origin vX.Y.Z\n");
    expect(found.map((v) => v.rule)).toEqual(["version-placeholder", "version-placeholder"]);
  });

  it("reports the correct line number and every offender on a multi-line file", () => {
    const found = checkSelfHostImageRefs(
      "README.md",
      ["ok: ghcr.io/enveo/enveo:latest", "", "bad: ghcr.io/enveo/enveo:2.3.2", "bad: ghcr.io/enveo/enveo:3.0"].join("\n"),
    );
    expect(found.map((v) => v.line)).toEqual([3, 4]);
  });

  it("ignores trailing sentence punctuation when reading the tag", () => {
    expect(checkSelfHostImageRefs("README.md", "we publish ghcr.io/enveo/enveo:latest.\n")).toEqual([]);
  });

  it("ignores an image of another project", () => {
    expect(checkSelfHostImageRefs("compose.selfhost.yml", "image: postgres:16-alpine\n")).toEqual([]);
  });

  it("does not stop at the package name — a SIBLING package with a numeric tag is still caught", () => {
    // Without a boundary the pattern matches the `…/enveo` prefix of `…/enveo-web` and then
    // reads `-web:3.6.2` as "no tag", so a pinned sibling image would sail through.
    const found = checkSelfHostImageRefs("docs/hosting.md", "image: ghcr.io/enveo/enveo-web:3.6.2\n");
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe("image-tag");
  });

  it("accepts a sibling package on the alias", () => {
    expect(checkSelfHostImageRefs("docs/hosting.md", "ghcr.io/enveo/enveo-web:latest\n")).toEqual([]);
  });

  it("is case-insensitive — a registry reference is not case-sensitive to a reader", () => {
    const found = checkSelfHostImageRefs("README.md", "GHCR.IO/enveo/enveo:3.6.2\n");
    expect(found).toHaveLength(1);
  });

  it("rejects an alias that also carries a digest", () => {
    const found = checkSelfHostImageRefs("README.md", "ghcr.io/enveo/enveo:latest@sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(found).toHaveLength(1);
  });
});

describe("checkDeployScript", () => {
  it("accepts the localhost health probe — the rule bans installers, not every curl", () => {
    expect(checkDeployScript("curl -fsS http://127.0.0.1:8081/api/health >/dev/null 2>&1\n")).toEqual([]);
  });

  it("accepts an IPv6 loopback probe — brackets are host syntax, not a remote host", () => {
    expect(checkDeployScript("curl -fsS http://[::1]:8081/api/health >/dev/null 2>&1\n")).toEqual([]);
  });

  it("accepts printed guidance that merely MENTIONS sudo in a heredoc", () => {
    expect(checkDeployScript("cat <<'EOF'\n  sudo tailscale serve --bg https / http://127.0.0.1:8081\nEOF\n")).toEqual([]);
  });

  it("rejects the Docker convenience installer by name", () => {
    const found = checkDeployScript("curl -fsSL https://get.docker.com | sh\n");
    expect(found.map((v) => v.rule).sort()).toEqual(["pipe-to-shell", "remote-download"]);
  });

  it("rejects any download piped into a shell, whatever the host", () => {
    const found = checkDeployScript("wget -qO- https://example.test/install.sh | bash\n");
    expect(found.some((v) => v.rule === "pipe-to-shell")).toBe(true);
  });

  it("rejects a remote download even when it is not piped", () => {
    const found = checkDeployScript("curl -fsSL https://example.test/install.sh -o /tmp/i.sh\n");
    expect(found.map((v) => v.rule)).toEqual(["remote-download"]);
  });

  it("rejects package-manager automation", () => {
    expect(checkDeployScript("sudo apt-get install -y docker.io\n").map((v) => v.rule)).toEqual(["package-manager"]);
  });

  it("carries the offending line number", () => {
    const found = checkDeployScript("#!/usr/bin/env bash\nset -eu\ncurl -fsSL https://get.docker.com | sh\n");
    expect(found[0]!.line).toBe(3);
  });
});

describe("formatViolations", () => {
  it("names the file, the line and the rule so the failure is actionable", () => {
    const text = formatViolations([{ file: "README.md", line: 7, rule: "image-tag", detail: "found `:1.2.3`" }]);
    expect(text).toContain("README.md:7");
    expect(text).toContain("image-tag");
    expect(text).toContain("found `:1.2.3`");
  });
});

describe("the real repository", () => {
  it("keeps every Enveo image reference in the self-host documentation on `:latest`", () => {
    const violations = SELF_HOST_DOCS.flatMap((file) => checkSelfHostImageRefs(file, read(file)));
    expect(formatViolations(violations)).toBe("");
  });

  it("keeps `scripts/deploy.sh` free of remote installers", () => {
    expect(formatViolations(checkDeployScript(read(DEPLOY_SCRIPT)))).toBe("");
  });

  it("actually covers the files the policy claims to cover", () => {
    // A typo'd path would silently check nothing; assert each file exists and is non-empty.
    for (const file of [...SELF_HOST_DOCS, DEPLOY_SCRIPT]) expect(read(file).length).toBeGreaterThan(0);
  });
});
