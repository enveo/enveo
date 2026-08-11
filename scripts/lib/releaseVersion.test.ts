/**
 * The release-tag policy (§3d).
 *
 * A tag is the ONLY release trigger, so the parser is the first gate a release passes and the
 * last thing that stands between a typo and an immutable public image tag. Everything here is
 * pure, which is why it can be exhaustively negative-tested: every rejection class the spec
 * names gets a case, because "it looked like a version" is exactly how `v1.2.3-` or
 * `refs/tags/v1.2.3` reached a registry in the reviewed workflow.
 */
import { describe, expect, it } from "bun:test";
import {
  aliasImageTags,
  checkAppVersion,
  extractAppVersion,
  parseReleaseTag,
  type ReleaseTag,
} from "./releaseVersion";

/** Parse and assert success — the tests below are about the PARSED shape, not the wrapper. */
const parsed = (raw: string): ReleaseTag => {
  const verdict = parseReleaseTag(raw);
  if (!verdict.ok) throw new Error(`expected ${raw} to parse, got: ${verdict.reason}`);
  return verdict.release;
};

/** Assert rejection and return the reason, so each case can pin WHY it was rejected. */
const rejected = (raw: string): string => {
  const verdict = parseReleaseTag(raw);
  if (verdict.ok) throw new Error(`expected ${JSON.stringify(raw)} to be rejected`);
  return verdict.reason;
};

describe("parseReleaseTag — accepted", () => {
  it("accepts a stable vMAJOR.MINOR.PATCH and strips the v for the version", () => {
    expect(parsed("v3.8.0")).toMatchObject({
      tag: "v3.8.0",
      version: "3.8.0",
      core: "3.8.0",
      major: 3,
      minor: 8,
      patch: 0,
      prerelease: null,
      stable: true,
    });
  });

  it("accepts a prerelease and keeps its core separately", () => {
    expect(parsed("v3.8.0-rc.1")).toMatchObject({
      version: "3.8.0-rc.1",
      core: "3.8.0",
      prerelease: "rc.1",
      stable: false,
    });
  });

  it("accepts zero components — 0.0.0 is a valid version, only LEADING zeros are not", () => {
    expect(parsed("v0.0.0").version).toBe("0.0.0");
  });

  it("accepts multi-identifier and hyphenated prerelease identifiers", () => {
    expect(parsed("v1.0.0-alpha.1.beta").prerelease).toBe("alpha.1.beta");
    expect(parsed("v1.0.0-alpha-1").prerelease).toBe("alpha-1");
  });

  it("accepts a bare numeric prerelease identifier", () => {
    expect(parsed("v1.0.0-0").prerelease).toBe("0");
  });

  it("accepts large components without treating them as numbers to be normalised", () => {
    expect(parsed("v10.20.30").version).toBe("10.20.30");
  });
});

describe("parseReleaseTag — rejected", () => {
  it("rejects the empty string", () => {
    expect(rejected("")).toMatch(/empty/i);
  });

  it("rejects a missing v prefix, so a branch name cannot be released", () => {
    expect(rejected("3.8.0")).toMatch(/must start with/i);
    expect(rejected("main")).toMatch(/must start with/i);
  });

  it("rejects an uppercase V — the OCI tag policy is derived byte-wise, not case-folded", () => {
    expect(rejected("V3.8.0")).toMatch(/must start with/i);
  });

  it("rejects ref-like input", () => {
    expect(rejected("refs/tags/v3.8.0")).toMatch(/ref/i);
  });

  it("rejects whitespace anywhere, including a trailing newline from a shell capture", () => {
    expect(rejected(" v3.8.0")).toMatch(/whitespace/i);
    expect(rejected("v3.8.0 ")).toMatch(/whitespace/i);
    expect(rejected("v3.8.0\n")).toMatch(/whitespace/i);
    expect(rejected("v3.8 .0")).toMatch(/whitespace/i);
  });

  it("rejects SemVer build metadata — the chosen OCI tag policy cannot represent `+`", () => {
    expect(rejected("v3.8.0+build.5")).toMatch(/build metadata/i);
    expect(rejected("v3.8.0-rc.1+build.5")).toMatch(/build metadata/i);
  });

  it("rejects leading zeros in every numeric core component", () => {
    expect(rejected("v03.8.0")).toMatch(/leading zero/i);
    expect(rejected("v3.08.0")).toMatch(/leading zero/i);
    expect(rejected("v3.8.00")).toMatch(/leading zero/i);
  });

  it("rejects a leading zero in a NUMERIC prerelease identifier", () => {
    expect(rejected("v3.8.0-rc.01")).toMatch(/leading zero/i);
  });

  it("keeps a zero-prefixed ALPHANUMERIC identifier — SemVer only constrains numeric ones", () => {
    expect(parsed("v3.8.0-01a").prerelease).toBe("01a");
  });

  it("rejects an incomplete core", () => {
    expect(rejected("v3.8")).toMatch(/MAJOR\.MINOR\.PATCH/);
    expect(rejected("v3")).toMatch(/MAJOR\.MINOR\.PATCH/);
    expect(rejected("v3.8.0.1")).toMatch(/MAJOR\.MINOR\.PATCH/);
  });

  it("rejects arbitrary suffix garbage that the old shell glob accepted", () => {
    // `v[0-9]*.[0-9]*.[0-9]*` matched every one of these.
    expect(rejected("v3.8.0rc1")).toMatch(/MAJOR\.MINOR\.PATCH/);
    expect(rejected("v3.8.0_final")).toMatch(/MAJOR\.MINOR\.PATCH/);
    expect(rejected("v3.8.0.deploy")).toMatch(/MAJOR\.MINOR\.PATCH/);
  });

  it("rejects an empty prerelease and empty prerelease identifiers", () => {
    expect(rejected("v3.8.0-")).toMatch(/empty/i);
    expect(rejected("v3.8.0-rc..1")).toMatch(/empty/i);
    expect(rejected("v3.8.0-.rc")).toMatch(/empty/i);
    expect(rejected("v3.8.0-rc.")).toMatch(/empty/i);
  });

  it("rejects characters outside the SemVer prerelease alphabet", () => {
    expect(rejected("v3.8.0-rc_1")).toMatch(/character/i);
    expect(rejected("v3.8.0-rc/1")).toMatch(/ref/i); // caught earlier, but must still be rejected
  });

  it("rejects a raw commit SHA — a dispatch may only name an existing version tag", () => {
    expect(rejected("32d7034c446111c46207bcea35a23bf287db490c")).toMatch(/must start with/i);
  });
});

describe("extractAppVersion", () => {
  it("reads the exported constant from version.ts", () => {
    const source = ['export const APP_VERSION = "3.7.3";', "export const BUILD = 1;"].join("\n");

    expect(extractAppVersion(source)).toBe("3.7.3");
  });

  it("returns null when the export is absent, so a moved constant fails loudly", () => {
    expect(extractAppVersion("export const VERSION = '3.7.3';")).toBeNull();
  });

  it("ignores a mention inside a comment", () => {
    const source = ['// export const APP_VERSION = "9.9.9";', 'export const APP_VERSION = "3.7.3";'].join("\n");

    expect(extractAppVersion(source)).toBe("3.7.3");
  });
});

describe("checkAppVersion", () => {
  it("requires byte-for-byte equality for a STABLE release", () => {
    expect(checkAppVersion(parsed("v3.8.0"), "3.8.0")).toBeNull();
    expect(checkAppVersion(parsed("v3.8.0"), "3.8.1")).toMatch(/APP_VERSION/);
    expect(checkAppVersion(parsed("v3.8.0"), "3.8")).toMatch(/APP_VERSION/);
    expect(checkAppVersion(parsed("v3.8.0"), "v3.8.0")).toMatch(/APP_VERSION/);
  });

  it("accepts either the full version or the bare core for a PRERELEASE", () => {
    // An rc ships the version its core will become; carrying `-rc.1` in the user-visible
    // APP_VERSION string is allowed but not required. Stable releases stay byte-for-byte.
    expect(checkAppVersion(parsed("v3.8.0-rc.1"), "3.8.0")).toBeNull();
    expect(checkAppVersion(parsed("v3.8.0-rc.1"), "3.8.0-rc.1")).toBeNull();
  });

  it("still rejects a prerelease whose CORE disagrees with APP_VERSION", () => {
    expect(checkAppVersion(parsed("v3.9.0-rc.1"), "3.8.0")).toMatch(/APP_VERSION/);
    expect(checkAppVersion(parsed("v3.8.0-rc.1"), "3.8.0-rc.2")).toMatch(/APP_VERSION/);
  });

  it("reports a missing APP_VERSION rather than treating it as a match", () => {
    expect(checkAppVersion(parsed("v3.8.0"), null)).toMatch(/APP_VERSION/);
  });
});

describe("aliasImageTags", () => {
  it("gives a stable release the MAJOR.MINOR and latest aliases", () => {
    expect(aliasImageTags(parsed("v3.8.0"))).toEqual(["3.8", "latest"]);
  });

  it("gives a PRERELEASE no aliases at all — it may never move 3.8 or latest", () => {
    expect(aliasImageTags(parsed("v3.8.0-rc.1"))).toEqual([]);
  });

  it("derives the alias from the parsed components, not from string slicing", () => {
    expect(aliasImageTags(parsed("v10.20.30"))).toEqual(["10.20", "latest"]);
  });
});
