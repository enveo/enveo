/**
 * The rules that decide whether a PUSHED artifact is the one we meant to publish (§3d).
 *
 * These operate on `docker buildx imagetools inspect` output, so the fixtures below are trimmed
 * copies of real GHCR responses for `ghcr.io/enveo/enveo` — not invented shapes.
 *
 * The load-bearing case is `classifyInspectFailure`: "the tag is absent" means BUILD AND PUSH,
 * while "the registry said no" must never mean that. Reading a 401 as absent is how a release
 * overwrites an existing immutable version tag.
 */
import { describe, expect, it } from "bun:test";
import {
  checkAnnotations,
  checkAttachment,
  checkAttestationCoverage,
  checkLabels,
  classifyInspectFailure,
  runnableManifests,
  runnablePlatforms,
} from "./releaseImage";

/** Trimmed from `docker buildx imagetools inspect ghcr.io/enveo/enveo:3.7.3 --raw`. */
const INDEX = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: "sha256:amd",
      platform: { architecture: "amd64", os: "linux" },
    },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: "sha256:arm",
      platform: { architecture: "arm64", os: "linux" },
    },
  ],
};

/** The same index once BuildKit provenance/SBOM attestations are attached. */
const ATTESTED = {
  manifests: [
    ...INDEX.manifests,
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: "sha256:att-amd",
      platform: { architecture: "unknown", os: "unknown" },
      annotations: {
        "vnd.docker.reference.digest": "sha256:amd",
        "vnd.docker.reference.type": "attestation-manifest",
      },
    },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: "sha256:att-arm",
      platform: { architecture: "unknown", os: "unknown" },
      annotations: {
        "vnd.docker.reference.digest": "sha256:arm",
        "vnd.docker.reference.type": "attestation-manifest",
      },
    },
  ],
};

/** Trimmed from `--format '{{json .Image}}'` — a map keyed by platform for a multi-arch image. */
const labelsFor = (revision: string, version: string) => ({
  "linux/amd64": {
    config: {
      Labels: {
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.source": "https://github.com/enveo/enveo",
        "org.opencontainers.image.version": version,
      },
    },
  },
  "linux/arm64": {
    config: {
      Labels: {
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.source": "https://github.com/enveo/enveo",
        "org.opencontainers.image.version": version,
      },
    },
  },
});

const EXPECTED = {
  platforms: ["linux/amd64", "linux/arm64"],
  revision: "32d7034c446111c46207bcea35a23bf287db490c",
  version: "3.7.3",
  source: "https://github.com/enveo/enveo",
} as const;

describe("runnablePlatforms", () => {
  it("lists the platforms a docker run can actually use", () => {
    expect(runnablePlatforms(INDEX)).toEqual(["linux/amd64", "linux/arm64"]);
  });

  it("ignores attestation referrers — they are metadata, not architectures", () => {
    // This is the whole reason the check exists: with provenance enabled GHCR's package UI shows
    // `unknown/unknown` entries, and a naive count would read 4 platforms.
    expect(runnablePlatforms(ATTESTED)).toEqual(["linux/amd64", "linux/arm64"]);
  });

  it("ignores an unknown-architecture entry even without the annotation", () => {
    expect(runnablePlatforms({ manifests: [{ digest: "sha256:x", platform: { os: "unknown", architecture: "unknown" } }] })).toEqual([]);
  });

  it("reports an empty or missing manifest list rather than throwing", () => {
    expect(runnablePlatforms({})).toEqual([]);
    expect(runnablePlatforms({ manifests: [] })).toEqual([]);
  });

  it("keeps a variant visible, so linux/arm/v7 is not silently read as linux/arm", () => {
    expect(runnablePlatforms({ manifests: [{ digest: "sha256:x", platform: { os: "linux", architecture: "arm", variant: "v7" } }] })).toEqual(["linux/arm/v7"]);
  });
});

describe("runnableManifests", () => {
  it("pairs each runnable platform with its OWN manifest digest", () => {
    expect(runnableManifests(INDEX)).toEqual([
      { platform: "linux/amd64", digest: "sha256:amd" },
      { platform: "linux/arm64", digest: "sha256:arm" },
    ]);
  });

  it("excludes attestation referrers, so nothing tries to pull one as an image", () => {
    // Why the digests matter: pulling two platforms through the SAME index digest fails with
    // `cannot overwrite digest …`, which is exactly how the published inventory broke.
    expect(runnableManifests(ATTESTED).map((m) => m.digest)).toEqual(["sha256:amd", "sha256:arm"]);
  });
});

describe("checkAnnotations", () => {
  const expected = { revision: EXPECTED.revision, version: EXPECTED.version };
  const good = {
    "org.opencontainers.image.revision": EXPECTED.revision,
    "org.opencontainers.image.version": EXPECTED.version,
  };

  it("passes when the index and every manifest name the released commit", () => {
    expect(
      checkAnnotations(
        [
          { where: "index", annotations: good },
          { where: "linux/amd64", annotations: good },
          { where: "linux/arm64", annotations: good },
        ],
        expected,
      ),
    ).toEqual([]);
  });

  it("catches THE bug: annotations carrying github.sha while the label is correct", () => {
    // metadata-action honours a `labels:` override but re-derives ANNOTATIONS from github.sha,
    // which on a workflow_dispatch is the branch head, not the released commit. This shipped.
    const branchHead = "fb27b122bdc3664e09d9a599a551bdeefe2a811f";
    const violations = checkAnnotations([{ where: "index", annotations: { ...good, "org.opencontainers.image.revision": branchHead } }], expected);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("revision");
    expect(violations[0]).toContain(branchHead);
  });

  it("treats a source with NO annotations as a violation, not as nothing to check", () => {
    expect(checkAnnotations([{ where: "index", annotations: undefined }], expected)[0]).toMatch(/no OCI annotations/);
    expect(checkAnnotations([{ where: "index", annotations: {} }], expected)[0]).toMatch(/no OCI annotations/);
  });

  it("fails when nothing was inspected — an empty sweep must not read as a pass", () => {
    expect(checkAnnotations([], expected)[0]).toMatch(/nothing was verified/);
  });

  it("reports the offending platform by name", () => {
    const violations = checkAnnotations(
      [
        { where: "index", annotations: good },
        { where: "linux/arm64", annotations: { ...good, "org.opencontainers.image.version": "3.7.2" } },
      ],
      expected,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("linux/arm64");
  });
});

describe("checkLabels", () => {
  it("passes when every expected platform carries the expected identity", () => {
    expect(checkLabels(labelsFor(EXPECTED.revision, EXPECTED.version), EXPECTED)).toEqual([]);
  });

  it("fails on a revision that is not the released commit", () => {
    const violations = checkLabels(labelsFor("deadbeef", EXPECTED.version), EXPECTED);

    expect(violations).toHaveLength(2); // one per platform — both legs must be right
    expect(violations[0]).toMatch(/revision/);
  });

  it("fails on a version label that disagrees with the tag", () => {
    expect(checkLabels(labelsFor(EXPECTED.revision, "3.7.2"), EXPECTED)[0]).toMatch(/version/);
  });

  it("fails when a platform is missing from the config map entirely", () => {
    const partial = { "linux/amd64": labelsFor(EXPECTED.revision, EXPECTED.version)["linux/amd64"] };

    expect(checkLabels(partial, EXPECTED)[0]).toMatch(/linux\/arm64/);
  });

  it("fails on an absent label instead of comparing undefined to undefined", () => {
    expect(checkLabels({ "linux/amd64": { config: { Labels: {} } }, "linux/arm64": { config: { Labels: {} } } }, EXPECTED)).not.toEqual([]);
  });

  it("understands the single-platform shape, which has config at the root", () => {
    const single = {
      config: {
        Labels: {
          "org.opencontainers.image.revision": EXPECTED.revision,
          "org.opencontainers.image.source": EXPECTED.source,
          "org.opencontainers.image.version": EXPECTED.version,
        },
      },
    };

    expect(checkLabels(single, { ...EXPECTED, platforms: ["linux/amd64"] })).toEqual([]);
  });
});

describe("checkAttestationCoverage", () => {
  it("passes when every runnable manifest has an attestation referrer", () => {
    expect(checkAttestationCoverage(ATTESTED)).toEqual([]);
  });

  it("fails when a platform manifest has no attestation attached", () => {
    const halfAttested = { manifests: ATTESTED.manifests.filter((m) => m.digest !== "sha256:att-arm") };

    expect(checkAttestationCoverage(halfAttested)[0]).toMatch(/linux\/arm64/);
  });

  it("fails a completely unattested index — the reviewed workflow's provenance:false state", () => {
    expect(checkAttestationCoverage(INDEX)).toHaveLength(2);
  });
});

describe("checkAttachment", () => {
  it("passes when each platform has a non-empty entry", () => {
    const sbom = { "linux/amd64": { SPDX: { spdxVersion: "SPDX-2.3" } }, "linux/arm64": { SPDX: { spdxVersion: "SPDX-2.3" } } };

    expect(checkAttachment("SBOM", sbom, EXPECTED.platforms)).toEqual([]);
  });

  it("fails on the empty object buildx returns when nothing is attached", () => {
    // `--format '{{json .SBOM}}'` on an image built with sbom:false prints exactly `{}`.
    expect(checkAttachment("SBOM", {}, EXPECTED.platforms)).toHaveLength(2);
  });

  it("fails when only one platform got one", () => {
    expect(checkAttachment("provenance", { "linux/amd64": { SLSA: {} } }, EXPECTED.platforms)[0]).toMatch(/linux\/arm64/);
  });

  it("treats an empty per-platform entry as missing", () => {
    expect(checkAttachment("SBOM", { "linux/amd64": {}, "linux/arm64": {} }, EXPECTED.platforms)).toHaveLength(2);
  });

  it("accepts the single-platform shape where the payload is at the root", () => {
    expect(checkAttachment("SBOM", { SPDX: { spdxVersion: "SPDX-2.3" } }, ["linux/amd64"])).toEqual([]);
  });
});

describe("classifyInspectFailure", () => {
  it("reads a missing manifest as ABSENT, which is what authorises a build", () => {
    expect(classifyInspectFailure("ghcr.io/enveo/enveo:3.9.0: not found")).toBe("absent");
    expect(classifyInspectFailure("MANIFEST_UNKNOWN: manifest unknown; sha256:...")).toBe("absent");
    expect(classifyInspectFailure("failed to resolve reference: name unknown")).toBe("absent");
  });

  it("NEVER reads an authorization failure as absent — that would overwrite an existing tag", () => {
    expect(classifyInspectFailure("unexpected status from HEAD request: 401 Unauthorized")).toBe("error");
    expect(classifyInspectFailure("denied: permission_denied")).toBe("error");
    expect(classifyInspectFailure("unauthorized: authentication required")).toBe("error");
  });

  it("fails closed on a transport or rate-limit failure", () => {
    expect(classifyInspectFailure("dial tcp: i/o timeout")).toBe("error");
    expect(classifyInspectFailure("toomanyrequests: rate limit exceeded")).toBe("error");
    expect(classifyInspectFailure("")).toBe("error");
  });

  it("does not let the word 'unauthorized' inside a not-found message flip the verdict", () => {
    // Order matters: an authorization signal wins over a 'not found' substring.
    expect(classifyInspectFailure("not found: unauthorized")).toBe("error");
  });
});
