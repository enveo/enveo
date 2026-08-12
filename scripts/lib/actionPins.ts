/**
 * Every third-party GitHub Action is pinned to a full commit SHA (§3d).
 *
 * A tag like `@v4` is a MOVING pointer the action's owner can repoint at any time, and a
 * compromised or simply careless upstream release then runs inside a job that holds
 * `packages: write` and `id-token: write`. A 40-character commit SHA is the only reference
 * GitHub resolves to exactly one tree.
 *
 * A SHA alone is unmaintainable, though: nobody can tell `53b7df9…` from a three-year-old
 * revision. So the policy has two halves — pin by SHA, and leave the human-readable upstream
 * release tag in a trailing comment. Both are checked here.
 *
 * Local reusable workflows (`./.github/workflows/…`) are deliberately exempt: they are resolved
 * from the CALLER's own revision, so pinning them would freeze a workflow to a stale copy of a
 * file in the same commit.
 *
 * Pure by design: the collector takes text, so the repository-wide assertion is one focused test.
 */

/** One `uses:` occurrence in a workflow. */
export type ActionUse = Readonly<{
  file: string;
  /** Everything after `uses:`, e.g. `actions/checkout@3d3c42…`. */
  reference: string;
  /** The trailing `# …` comment, without the `#`, or `null` when there is none. */
  comment: string | null;
  /** 1-based line number, for a message that points at the problem. */
  line: number;
}>;

const USES = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(?:#\s*(.*?))?\s*$/;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** A version-looking comment: `v7.0.1`, `v2`, `v4.2.2` — what a maintainer needs to see. */
const VERSION_COMMENT = /\bv\d+(\.\d+)*\b/;

/** Every `uses:` in a workflow file, in order. */
export function collectActionUses(file: string, yaml: string): ActionUse[] {
  const uses: ActionUse[] = [];
  yaml.split("\n").forEach((text, index) => {
    const match = USES.exec(text);
    if (match === null) return;
    uses.push({
      file,
      reference: match[1] ?? "",
      comment: match[2] === undefined || match[2] === "" ? null : match[2],
      line: index + 1,
    });
  });
  return uses;
}

/** True for a same-repository reusable workflow, which must NOT be pinned. */
export const isLocalReference = (reference: string): boolean => reference.startsWith("./");

/**
 * Policy violations across a set of `uses:` references:
 *
 * 1. a third-party action referenced by anything other than a 40-hex commit SHA;
 * 2. a pinned action with no human-readable upstream version in its comment;
 * 3. the SAME action pinned to two different SHAs — a partial upgrade nobody reviewed as one.
 */
export function findPinProblems(uses: readonly ActionUse[]): string[] {
  const problems: string[] = [];
  const shaByAction = new Map<string, Map<string, string[]>>();

  for (const use of uses) {
    const at = use.reference.lastIndexOf("@");
    const where = `${use.file}:${use.line}`;

    if (isLocalReference(use.reference)) {
      if (at !== -1) {
        problems.push(`${where}: a local reusable workflow must not carry a ref (${use.reference})`);
      }
      continue;
    }

    if (at === -1) {
      problems.push(`${where}: ${use.reference} has no ref at all — pin it to a full commit SHA`);
      continue;
    }
    const action = use.reference.slice(0, at);
    const ref = use.reference.slice(at + 1);

    if (!FULL_SHA.test(ref)) {
      problems.push(`${where}: ${action} is pinned to ${JSON.stringify(ref)} — a tag or branch is a MOVING ` + "pointer; use the full 40-character commit SHA");
      continue;
    }
    if (use.comment === null || !VERSION_COMMENT.test(use.comment)) {
      problems.push(`${where}: ${action}@${ref.slice(0, 7)}… has no upstream version comment — add ` + "`# vX.Y.Z` so the pin can be maintained");
    }

    const byRef = shaByAction.get(action) ?? new Map<string, string[]>();
    byRef.set(ref, [...(byRef.get(ref) ?? []), where]);
    shaByAction.set(action, byRef);
  }

  for (const [action, byRef] of shaByAction) {
    if (byRef.size > 1) {
      const spellings = [...byRef].map(([ref, places]) => `${ref.slice(0, 7)}… (${places.join(", ")})`).join(" vs ");
      problems.push(`${action} is pinned to more than one SHA: ${spellings}`);
    }
  }

  return problems;
}
