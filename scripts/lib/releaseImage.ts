/**
 * What a PUBLISHED Enveo image must look like (§3d), as pure rules over registry metadata.
 *
 * `scripts/release-image.ts` collects the facts with `docker buildx imagetools inspect`; this
 * module decides. The split is the same one §3e made for the image inventory: collecting is
 * untestable I/O, judging is not, and a release gate whose rules were never exercised is a
 * decoration.
 *
 * Two properties are worth stating out loud, because both are easy to get subtly wrong:
 *
 * - **Attestation referrers are not architectures.** With BuildKit provenance enabled the index
 *   grows `unknown/unknown` entries that GHCR's package UI displays alongside the real ones.
 *   Counting manifests would report four platforms for a two-platform image; the runnable set
 *   must be filtered, never counted.
 * - **"Absent" and "the registry said no" are different answers.** Absent authorises a build and
 *   push; an error must stop the release. A 401 on a private repository literally reads as
 *   "no manifest for you", and mistaking it for absence is how an immutable version tag gets
 *   overwritten by a rebuild.
 */

export type IndexManifest = Readonly<{
  mediaType?: string;
  digest?: string;
  platform?: Readonly<{ os?: string; architecture?: string; variant?: string }>;
  annotations?: Readonly<Record<string, string>>;
}>;

export type ImageIndex = Readonly<{
  manifests?: readonly IndexManifest[];
  /** Annotations on the index itself (`DOCKER_METADATA_ANNOTATIONS_LEVELS` including `index`). */
  annotations?: Readonly<Record<string, string>>;
}>;

/** One place that carries OCI annotations, named so a violation says WHERE it was wrong. */
export type AnnotationSource = Readonly<{
  where: string;
  annotations: Readonly<Record<string, string>> | undefined;
}>;

export type IdentityExpectations = Readonly<{
  platforms: readonly string[];
  /** The commit the release resolved to — `org.opencontainers.image.revision`. */
  revision: string;
  /** The exact version being published — `org.opencontainers.image.version`. */
  version: string;
  /** `org.opencontainers.image.source`; this is what links the GHCR package back to the repo. */
  source: string;
}>;

const ATTESTATION_TYPE = "vnd.docker.reference.type";
const ATTESTATION_SUBJECT = "vnd.docker.reference.digest";

/** True for an attestation/referrer manifest: metadata about an image, not an image. */
const isAttestation = (manifest: IndexManifest): boolean =>
  manifest.annotations?.[ATTESTATION_TYPE] === "attestation-manifest" || manifest.platform?.architecture === "unknown";

/** `linux/amd64`, or `linux/arm/v7` when the platform carries a variant. */
const platformOf = (manifest: IndexManifest): string =>
  [manifest.platform?.os, manifest.platform?.architecture, manifest.platform?.variant]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("/");

/** A runnable platform manifest: what to pull, and what it claims to be. */
export type RunnableManifest = Readonly<{ platform: string; digest: string }>;

/**
 * Every runnable manifest in the index, WITH its own digest.
 *
 * The digest matters as much as the platform: pulling two platforms through the SAME index
 * digest reference fails (`cannot overwrite digest …`), because the reference can only map to
 * one local image. Per-platform manifest digests are distinct references, so each architecture
 * can be pulled and inspected independently — and it means the inventory covers exactly what
 * the index contains rather than an architecture list someone hardcoded next to it.
 */
export function runnableManifests(index: ImageIndex): RunnableManifest[] {
  return (index.manifests ?? []).filter((m) => !isAttestation(m)).map((m) => ({ platform: platformOf(m), digest: m.digest ?? "" }));
}

/** Every platform in the index that a `docker run` can actually use. */
export function runnablePlatforms(index: ImageIndex): string[] {
  return runnableManifests(index).map((m) => m.platform);
}

/**
 * Per-platform label maps out of `imagetools inspect --format '{{json .Image}}'`.
 *
 * A multi-platform image yields `{"linux/amd64": {config:{Labels:…}}, …}`; a single-platform one
 * yields the image config itself. Both shapes are accepted so the same rules can judge a
 * per-architecture artifact pulled by digest.
 */
function labelsByPlatform(imageJson: unknown, platforms: readonly string[]): Map<string, Record<string, string> | null> {
  const byPlatform = new Map<string, Record<string, string> | null>();
  const root = (imageJson ?? {}) as Record<string, unknown>;
  const single = "config" in root;

  for (const platform of platforms) {
    const entry = (single ? root : (root[platform] as Record<string, unknown> | undefined)) ?? null;
    if (entry === null) {
      byPlatform.set(platform, null);
      continue;
    }
    const config = entry.config as { Labels?: Record<string, string> } | undefined;
    byPlatform.set(platform, config?.Labels ?? {});
  }
  return byPlatform;
}

/** OCI identity labels, checked on EVERY platform: a per-arch leg can carry its own config. */
export function checkLabels(imageJson: unknown, expected: IdentityExpectations): string[] {
  const violations: string[] = [];
  const wanted: ReadonlyArray<readonly [string, string]> = [
    ["org.opencontainers.image.revision", expected.revision],
    ["org.opencontainers.image.version", expected.version],
    ["org.opencontainers.image.source", expected.source],
  ];

  for (const [platform, labels] of labelsByPlatform(imageJson, expected.platforms)) {
    if (labels === null) {
      violations.push(`${platform}: no image config in the manifest — the platform is missing`);
      continue;
    }
    for (const [label, value] of wanted) {
      const found = labels[label];
      if (found !== value) {
        violations.push(`${platform}: ${label} is ${JSON.stringify(found ?? null)}, expected ${JSON.stringify(value)}`);
      }
    }
  }
  return violations;
}

/**
 * OCI ANNOTATIONS on the index and on every platform manifest must name the released commit.
 *
 * This exists because of a bug that shipped past the label check: `docker/metadata-action`
 * honours a `labels:` override but re-derives ANNOTATIONS from `github.sha`, which on a
 * workflow_dispatch is the branch head rather than the released commit. The image config said
 * one commit and the published manifest metadata said another — and the inventory could not
 * notice, because it reads the config label.
 *
 * Annotations are not decoration: they travel on the index/manifest, which is what registries
 * display and what supply-chain tooling reads without pulling the config blob.
 *
 * A source with NO annotations at all is a violation, not a pass. "Nothing to compare" is how
 * this class of bug hides.
 */
export function checkAnnotations(sources: readonly AnnotationSource[], expected: Readonly<{ revision: string; version: string }>): string[] {
  if (sources.length === 0) return ["no annotation sources were inspected — nothing was verified"];

  const violations: string[] = [];
  const wanted: ReadonlyArray<readonly [string, string]> = [
    ["org.opencontainers.image.revision", expected.revision],
    ["org.opencontainers.image.version", expected.version],
  ];

  for (const source of sources) {
    if (source.annotations === undefined || Object.keys(source.annotations).length === 0) {
      violations.push(`${source.where}: no OCI annotations at all`);
      continue;
    }
    for (const [key, value] of wanted) {
      const found = source.annotations[key];
      if (found !== value) {
        violations.push(`${source.where}: ${key} is ${JSON.stringify(found ?? null)}, expected ${JSON.stringify(value)}`);
      }
    }
  }
  return violations;
}

/**
 * Every runnable manifest must have at least one attestation referrer pointing at it.
 *
 * This is the structural proof that provenance/SBOM describe THIS index — not a sibling build,
 * and not only the amd64 leg. It is exactly the gap §3e's review flagged: the arm64 image that
 * ships to Raspberry Pi and Graviton users is a separate manifest with separate metadata.
 */
export function checkAttestationCoverage(index: ImageIndex): string[] {
  const manifests = index.manifests ?? [];
  const attested = new Set(
    manifests
      .filter(isAttestation)
      .map((m) => m.annotations?.[ATTESTATION_SUBJECT])
      .filter((digest): digest is string => digest !== undefined),
  );

  return manifests
    .filter((m) => !isAttestation(m))
    .filter((m) => m.digest === undefined || !attested.has(m.digest))
    .map((m) => `${platformOf(m)} (${m.digest ?? "<no digest>"}) has no attestation manifest attached`);
}

/**
 * An SBOM/provenance attachment must exist for every published platform.
 *
 * `--format '{{json .SBOM}}'` prints exactly `{}` when nothing is attached, so "the command
 * succeeded" proves nothing on its own — which is how `sbom: false` survived unnoticed.
 */
export function checkAttachment(what: string, value: unknown, platforms: readonly string[]): string[] {
  const root = (value ?? {}) as Record<string, unknown>;
  const keys = Object.keys(root);
  // Single-platform shape: the payload (`SPDX`, `SLSA`, …) sits at the root.
  const single = keys.length > 0 && !keys.some((key) => key.includes("/"));

  return platforms
    .filter((platform) => {
      const entry = single ? root : (root[platform] as Record<string, unknown> | undefined);
      return entry === undefined || entry === null || Object.keys(entry).length === 0;
    })
    .map((platform) => `${platform}: no ${what} attached to the published manifest`);
}

/**
 * Why an `imagetools inspect` failed: the tag is genuinely not there, or something else is wrong.
 *
 * FAIL CLOSED — only a recognised not-found signal is "absent", and an authorization signal wins
 * even when the message also says "not found" (registries do phrase 401s that way).
 */
export function classifyInspectFailure(stderr: string): "absent" | "error" {
  const text = stderr.toLowerCase();
  const denied = ["unauthorized", "denied", "authentication", "forbidden", "401", "403"];
  if (denied.some((signal) => text.includes(signal))) return "error";

  const missing = ["not found", "manifest_unknown", "manifest unknown", "name unknown", "404"];
  return missing.some((signal) => text.includes(signal)) ? "absent" : "error";
}
