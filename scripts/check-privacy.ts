#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPrivacy, formatPrivacyViolations, isAllowedBinaryAsset, isBinary, type PrivacyViolation } from "./lib/privacyPolicy";

export const EXIT_OK = 0;
export const EXIT_POLICY_VIOLATION = 1;
export const EXIT_FAILED_CLOSED = 2;

type Entry = Readonly<{ path: string; bytes: Uint8Array; allowedBinary?: boolean }>;

function git(root: string, args: readonly string[]): Uint8Array {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args[0]} failed`);
  return result.stdout;
}

const records = (bytes: Uint8Array): string[] => new TextDecoder().decode(bytes).split("\0").filter(Boolean);

function blob(root: string, spec: string): Uint8Array {
  return git(root, ["cat-file", "blob", spec]);
}

function worktreeEntries(root: string): Entry[] {
  return records(git(root, ["ls-files", "-z"]))
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, bytes: readFileSync(join(root, path)), allowedBinary: isAllowedBinaryAsset(path) }));
}

function stagedEntries(root: string): Entry[] {
  const paths = records(git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));
  return paths.map((path) => {
    const entry = records(git(root, ["ls-files", "--stage", "-z", "--", path]))[0];
    const oid = /^\d+ ([0-9a-f]+) 0\t/.exec(entry ?? "")?.[1];
    if (!oid) throw new Error("staged blob missing");
    return { path, bytes: blob(root, oid), allowedBinary: isAllowedBinaryAsset(path) };
  });
}

function rangeEntries(root: string, range: string): Entry[] {
  const commits = new TextDecoder()
    .decode(git(root, ["rev-list", "--reverse", range]))
    .trim()
    .split("\n")
    .filter(Boolean);
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    entries.push({ path: `commit ${commit.slice(0, 12)} metadata and message`, bytes: git(root, ["cat-file", "commit", commit]) });
    const changes = records(git(root, ["diff-tree", "--root", "-m", "--no-commit-id", "-r", "--raw", "-z", commit]));
    for (let index = 0; index < changes.length; ) {
      const metadata = changes[index++]!;
      const oldPath = changes[index++]!;
      const fields = metadata.slice(1).split(" ");
      const status = fields[4] ?? "";
      const newPath = /^[RC]/.test(status) ? changes[index++]! : oldPath;
      for (const [oid, path] of [
        [fields[2], oldPath],
        [fields[3], newPath],
      ] as const) {
        if (!oid || /^0+$/.test(oid)) continue;
        const key = `${oid}\0${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ path: `${path} @ ${commit.slice(0, 12)}`, bytes: blob(root, oid), allowedBinary: isAllowedBinaryAsset(path) });
      }
    }
  }
  const commitSet = new Set(commits);
  const tags = new TextDecoder().decode(git(root, ["for-each-ref", "--format=%(*objectname) %(objectname) %(refname)", "refs/tags"]));
  for (const tag of tags.trim().split("\n")) {
    const [target, oid, ref] = tag.split(" ");
    if (!target || !oid || !ref || !commitSet.has(target)) continue;
    entries.push({ path: `annotated tag ${ref} message`, bytes: git(root, ["cat-file", "tag", oid]) });
  }
  return entries;
}

function knownValues(path: string | undefined): string[] {
  if (!path) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("known-value corpus must be a JSON array of strings");
  return parsed;
}

function scan(entries: readonly Entry[], corpus: readonly string[]): PrivacyViolation[] {
  return entries.flatMap(({ path, bytes, allowedBinary }) => {
    const pathViolations = checkPrivacy("[redacted path]", path, corpus);
    const displayPath = pathViolations.length ? "[redacted path]" : path;
    if (isBinary(bytes)) {
      return !allowedBinary
        ? [
            ...pathViolations,
            { path: displayPath, line: 1, rule: "binary-evidence" as const, detail: "new binary outside the established app icons (content not inspected)" },
          ]
        : pathViolations;
    }
    return [...pathViolations, ...checkPrivacy(displayPath, new TextDecoder().decode(bytes), corpus)];
  });
}

export async function runPrivacyPolicy(argv: readonly string[], log: (line: string) => void = console.log, root = process.cwd()): Promise<number> {
  try {
    const knownAt = argv.indexOf("--known-values");
    if (knownAt >= 0 && !argv[knownAt + 1]) throw new Error("--known-values requires a JSON file");
    const corpus = knownValues(knownAt >= 0 ? argv[knownAt + 1] : undefined);
    const modeArgs = knownAt < 0 ? [...argv] : argv.filter((_, index) => index !== knownAt && index !== knownAt + 1);
    let entries: Entry[];
    if (modeArgs.length === 0 || (modeArgs.length === 1 && modeArgs[0] === "--worktree")) entries = worktreeEntries(root);
    else if (modeArgs.length === 1 && modeArgs[0] === "--staged") entries = stagedEntries(root);
    else if (modeArgs.length === 2 && modeArgs[0] === "--range") entries = rangeEntries(root, modeArgs[1]!);
    else if (modeArgs.length === 2 && modeArgs[0] === "--message") {
      entries = [{ path: "commit message", bytes: new TextEncoder().encode(modeArgs[1]!) }];
    } else if (modeArgs.length === 2 && modeArgs[0] === "--message-file") {
      entries = [{ path: modeArgs[1]!, bytes: readFileSync(modeArgs[1]!) }];
    } else throw new Error("invalid arguments");

    const violations = scan(entries, corpus);
    if (violations.length) {
      log(`policy:privacy: ${violations.length} possible violation(s); values are redacted\n${formatPrivacyViolations(violations)}`);
      return EXIT_POLICY_VIOLATION;
    }
    log(`policy:privacy: OK — scanned ${entries.length} tracked input(s); heuristic checks cannot prove a repository contains no private data`);
    return EXIT_OK;
  } catch {
    log("policy:privacy: cannot complete scan — input, corpus, or Git data is unreadable or invalid (details redacted)");
    return EXIT_FAILED_CLOSED;
  }
}

if (import.meta.main) process.exit(await runPrivacyPolicy(process.argv.slice(2)));
