# Releasing Enveo

A `v*` tag is a **request** to publish, never an authorisation. Everything below is enforced by
`.github/workflows/release.yml`; this page explains what it does, what to do when it stops
halfway, and the two rules that are never bent.

## The two rules

1. **An exact version image tag is immutable.** `ghcr.io/enveo/enveo:3.8.0` is written once and
   never overwritten, not even by a re-run of the same release. A broken published image is
   replaced by a new patch version, not by mutable history.
2. **`latest` and `MAJOR.MINOR` only ever move to an already-verified digest, and only ever
   forward.** They are repointed at the end, by digest, without rebuilding — so a partial failure
   can never leave them on an artifact no gate inspected. A prerelease moves neither.

   "Forward" is a real check, not a description. Before moving an alias the pipeline reads which
   version it currently serves and skips it if that is already newer. The case this prevents:
   v3.8.0 stops at attestation, v3.8.1 ships and correctly takes `latest`, and then someone
   re-runs v3.8.0 to finish its missing GitHub Release — an entirely legitimate recovery — which
   would otherwise drag `latest` back to 3.8.0 for everyone pulling it. A skipped alias is
   reported loudly in the job summary and does **not** fail the run; the rest of the resume is
   valid work. An alias that does not say which version it serves is skipped too: refusing to
   move is recoverable by hand, an unnoticed downgrade is not.

## Cutting a release

1. Bump `APP_VERSION` in `packages/web/src/lib/version.ts` and merge it to `main`. The tag and
   this constant must agree — a stable release byte-for-byte.
2. Tag that commit on `main` and push the tag:

   ```sh
   git tag -a v3.8.0 -m "3.8.0" && git push origin v3.8.0
   ```

3. Watch the run. It publishes the image, attaches provenance and an SBOM, attests the digest to
   this repository, moves the aliases and creates the GitHub Release.

A manual re-run of an **existing** tag is the recovery path:

```sh
gh workflow run release.yml -f tag=v3.8.0
```

There is no branch path into the workflow. A branch name, a raw commit SHA, a tag that does not
exist and a tag that is not an ancestor of `main` are all rejected before anything is built.

## What the pipeline checks, in order

| Job | Permissions | What it does |
|---|---|---|
| `validate` | `contents: read` | The tag is `vMAJOR.MINOR.PATCH[-prerelease]` under a strict SemVer subset (no build metadata, no leading zeros, no suffix garbage, no ref-like input); it **exists** and dereferences to a commit; that commit is an ancestor of `main`; `APP_VERSION` **at that commit** agrees with it. |
| `verify` | `contents: read` | `bun run verify:ci` — typecheck, DB-backed tests, PWA build, dependency audit — on the resolved commit. The same reusable workflow branch CI calls. |
| `publish` | `packages`, `id-token`, `attestations: write` | Probe the exact tag, build both architectures, gate each with `image:scan` and `image:inventory`, push, attest, verify what the registry now holds, then move the aliases. |
| `github-release` | `contents: write` | Creates the release with generated notes and the verified digest. Idempotent. |

Nothing before `publish` can write anywhere. An invalid version string, an `APP_VERSION`
mismatch or a tag outside `main` fails with no registry login having happened.

Every version the workflow resolves comes from the **tag**, never from `github.sha` — on a manual
re-run `github.sha` is the default branch head, not the released commit, and it would otherwise
end up in the OCI revision label and the in-app build stamp.

## Nothing unscanned is ever released

The scan runs **twice**, and the second one is the authority.

**Before the push**, each architecture is built, loaded locally and checked on its own. This is
fast feedback: it catches a bad build in minutes rather than after a push.

**After the push**, every architecture the index actually contains is pulled back from the
registry by its own manifest digest and scanned and inventoried again — before attestation and
before any alias moves.

The second pass is not belt-and-braces, it is the real gate. The push is a *separate* BuildKit
invocation; its only link to the gated candidates is a best-effort layer cache, and the runtime
stage's `apk upgrade` deliberately carries no version pin (Alpine keeps only one build per
package per branch). On a cache miss the published image can legitimately contain different OS
package builds than Trivy judged minutes earlier. Scanning only the candidate would let a
CRITICAL reach users while the log claimed the opposite.

So the honest guarantee is: **nothing unscanned is ever *released***. A finding on the published
artifact stops the run with the exact tag pushed but never attested, never aliased and never
released — recover by publishing a new patch version, exactly as for any other post-push failure.
The exact tag is never overwritten.

Both passes check the same two things per architecture:

- `bun run image:scan` — digest-pinned Trivy over OS and application layers, fail-closed. A
  critical/high finding blocks the release; so does a scanner-database outage or an unparseable
  report, because an unscanned image is not a clean one. Accepted findings are exact, reviewed
  and expiring entries in `security/image-scan-ignore.yaml`.
- `bun run image:inventory` — the runtime contract: the allowlist, no dev/build packages, every
  shipped module's imports resolve, zero ELF binaries, non-root, `/app` read-only, and the
  identity labels.

Per-architecture is not pedantry: the dependency prune runs inside the per-architecture `deps`
stage, so the closure and ELF-purity are per-arch properties. CI's single-arch build says nothing
about the `linux/arm64` image a Raspberry Pi or Graviton self-hoster pulls.

The architecture list lives in exactly **one** place — the `PLATFORMS` environment value. The
candidate builds, the pre-push gate and the published-artifact loop all derive from it (the last
one from the published index itself), so the set that gets gated cannot drift from the set that
gets published. `scripts/lib/releaseWorkflow.ts` fails the test suite if any architecture is ever
named anywhere else in the workflow.

## Attestations

The pushed digest gets a GitHub artifact attestation with `push-to-registry: true`, and the
workflow verifies it before doing anything else:

```sh
gh attestation verify oci://ghcr.io/enveo/enveo@sha256:… -R enveo/enveo
```

**On GitHub Free/Pro/Team, artifact attestations are available for public repositories only.**
While this repository is private the attestation step fails, with GitHub's own message:

```
Failed to persist attestation: Feature not available for the enveo organization.
To enable this feature, please upgrade the billing plan, or make this repository public.
```

That failure is the intended behaviour — the release stops there, before the mutable aliases move
and before the GitHub Release exists. It is deliberately not conditional and not
`continue-on-error`: a release that silently skips its provenance is worse than one that stops.

**The first release after the repository becomes public is the moment attestation becomes real,
and it must be watched.** Everything up to and including the published per-architecture inventory
has been exercised; the attestation call itself, the `gh attestation verify` that follows it, the
alias move on a stable release and anonymous pulls have never run successfully, because they are
all downstream of a step that cannot succeed on a private repository. Treat that first public
release as a supervised run, not a routine one.

## When it stops halfway

The pipeline is built so that every stopping point is safe, and a re-run resumes rather than
repeats.

| Failed at | State | What to do |
|---|---|---|
| `validate` or `verify` | Nothing was written anywhere. | Fix the tag or the code. Deleting and recreating a tag is acceptable only before anything was published under it. |
| Candidate scan or inventory | Nothing was pushed. | Fix the finding, or add an exact, reviewed, expiring entry to `security/image-scan-ignore.yaml`. Then re-run. |
| After the push, before attestation | The exact immutable tag is published. The aliases have **not** moved and there is no GitHub Release. | Re-run the same tag. The probe finds the tag, checks its identity labels against the release commit, and resumes from that digest **without rebuilding**. |
| Attestation, alias move or GitHub Release | As above. | Same: re-run the same tag. |

### A worked example (this actually happened)

`v3.7.4-rc.2` was published by a run that then stopped at attestation. The exact tag existed and
was immutable; `3.7`/`latest` had not moved; there was no GitHub Release. Separately, that image
turned out to carry the *wrong commit* in its manifest annotations (a `metadata-action` default —
see below), so it was not the artifact the tag was supposed to mean.

What the pipeline did about it, without anybody editing history:

- re-running `v3.7.4-rc.2` does **not** silently republish it. The probe finds the tag, compares
  its identity against the release commit, sees the annotation mismatch and **stops for
  investigation** — exit 1, nothing written;
- the fix shipped as **`v3.7.4-rc.3`**, a new version. The broken image stays exactly where it is.

That is the no-overwrite policy working: a published exact tag is never repaired in place, because
"the same tag now means something different" is precisely the property self-hosters rely on not
happening. When the tag is genuinely correct, the same probe reports `state=present` and the run
**resumes from that digest without rebuilding**.

Two things the probe deliberately refuses to do:

- If the exact tag exists but its `revision`/`version`/`source` labels do not match the release,
  it **stops for investigation** instead of overwriting. Rebuilding is not idempotent — Vite
  stamps a build time into the bundle, so the same source produces a different digest.
- If the registry cannot answer (a 401, a timeout, a rate limit), it fails closed. An unresolved
  answer is never read as "the tag is absent", because that would rebuild over a released tag.

Never delete or overwrite a published exact version tag to fix a release. Destructive package
cleanup is an explicit owner action with a recorded reason.

One consequence worth knowing: the image is built from the **released** commit, and so are the
checks that judge it against the repository (the expected migration set, `.bun-version`, the scan
ignore file) — but the release machinery itself comes from the revision of the workflow that is
running. Re-publishing a tag from before these gates existed therefore fails at the candidate
gate, because that tree has no `image:scan`. That is intended: an old tag cannot be rebuilt under
a gate it was never written for.

## Tag protection, and what the ancestry check is *not*

Create a GitHub **tag ruleset** for `v*`:

- block deletion and force-update — the pipeline's guarantees rest on a tag naming one commit
  forever;
- restrict creation to maintainers.

Signed tags may be added later; the pipeline does not require local signing infrastructure.

**This ruleset is the actual security boundary — the ancestry check is not.** Being honest about
why: on a tag push, GitHub reads `release.yml` *itself* from the tag's ref. Someone able to create
a `v*` tag can therefore point it at a commit carrying their own workflow file, and no check
inside this pipeline runs at all. The validation and publish jobs do take their tooling from a
trusted ref rather than from the tagged tree — so a tag cannot supply the code that judges its own
ancestry, and an accident cannot quietly approve itself — but that is defence against a mistake,
not against a hostile tag creator.

What actually keeps a hostile release out is: who may create a `v*` tag (the ruleset above), and
who may push to `main` (branch protection). Treat those two settings as the boundary and this
pipeline as the correctness gate inside it.

## Identity: labels *and* annotations

The released commit has to appear in two places, and they are separate outputs:

- **labels** — in the image config, what `docker inspect` shows;
- **annotations** — on the index and each platform manifest, what registries display and what
  supply-chain tooling reads without pulling the config blob.

`docker/metadata-action` honours a `labels:` override but re-derives **annotations** from
`github.sha`, which on a manual re-run is the branch head rather than the released commit. A
release shipped that way once: correct commit in the config, branch head on both manifests, and no
annotations on the index at all, because the default annotation level covers manifests only. The
workflow therefore overrides `annotations:` alongside `labels:` and sets
`DOCKER_METADATA_ANNOTATIONS_LEVELS: manifest,index`, and `release-image.ts verify` checks the
index and every platform manifest — treating "no annotations" as a violation, not as nothing to
compare.

## Pinning

Every third-party action is pinned to a full commit SHA with its upstream release tag in a
trailing comment, and `scripts/lib/actionPins.test.ts` fails the suite if that slips — a floating
`@v4` inside a job holding `packages: write` and `id-token: write` is a third party's ability to
change what runs there without a pull request. Local reusable workflows use the `./` form on
purpose, so the caller's own revision is what runs.

Bun is pinned by `.bun-version` across every workflow, the Dockerfile and `@types/bun`
(`scripts/lib/bunVersion.test.ts`), and the Trivy scanner by version **and** digest.
