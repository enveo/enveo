#!/usr/bin/env bun
/**
 * Pre-commit staged-file runner (§3b) — the `10-biome-staged` hook phase.
 *
 * Runs a NON-MUTATING `biome check` over exactly the supported files that are
 * staged right now. It never rewrites or re-stages anything; developers run
 * `bun run format` themselves and review the result before committing.
 *
 * Filename handling is NUL-safe by construction: git is asked for
 * `-z` output, the ONLY separator ever honoured is NUL (a filename may
 * legally contain a newline), and every selected path is `./`-prefixed so a
 * name starting with `-` can never be parsed as a CLI option. Both children
 * are spawned with argument arrays — no shell ever sees a filename.
 *
 * `ENVEO_BIOME_BIN` overrides the Biome binary; it is a test seam so the
 * process tests can stub Biome at the process boundary and assert the exact
 * argument array. Real use always resolves the pinned local install.
 */
import { statSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

/** The file types Biome may see from the hook — everything else is skipped. */
export const BIOME_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css"] as const;

/**
 * Pure selector: raw `git diff --cached --name-only --diff-filter=ACMR -z`
 * output in, the ordered, deduplicated, `./`-prefixed Biome path list out.
 * `exists` must answer “is this currently a regular file?” — a path staged and
 * then deleted from the worktree must not reach Biome.
 */
export function selectBiomePaths(rawNulList: Uint8Array, exists: (path: string) => boolean): string[] {
  const raw = new TextDecoder().decode(rawNulList);
  if (raw.length === 0) return [];

  // NUL is the one and only separator. git terminates EVERY record with NUL,
  // so a well-formed list ends with one empty trailing element — drop exactly
  // that. A missing terminator (truncated stream) still parses as a path and
  // is then subject to the same existence check as everything else. There is
  // no newline fallback: a filename containing a newline is one filename.
  const records = raw.split("\0");
  if (records[records.length - 1] === "") records.pop();

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record === "" || seen.has(record)) continue;
    seen.add(record);
    const dot = record.lastIndexOf(".");
    if (dot < 0) continue;
    const extension = record.slice(dot).toLowerCase() as (typeof BIOME_EXTENSIONS)[number];
    if (!BIOME_EXTENSIONS.includes(extension)) continue;
    if (!exists(record)) continue;
    selected.push(`./${record}`);
  }
  return selected;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  const number = (constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (number ?? 0);
}

async function main(): Promise<number> {
  const git = Bun.spawn(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const rawNulList = new Uint8Array(await new Response(git.stdout).arrayBuffer());
  const gitCode = await git.exited;
  if (git.signalCode) return signalExitCode(git.signalCode);
  if (gitCode !== 0) {
    console.error(`check-staged: git diff --cached failed with status ${gitCode}`);
    return gitCode;
  }

  const paths = selectBiomePaths(rawNulList, isRegularFile);
  if (paths.length === 0) {
    console.log("Biome: no supported staged files");
    return 0;
  }

  const biomeBin = process.env.ENVEO_BIOME_BIN || join(process.cwd(), "node_modules", ".bin", "biome");
  const biome = Bun.spawn([biomeBin, "check", "--files-ignore-unknown=true", ...paths], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const biomeCode = await biome.exited;
  if (biome.signalCode) return signalExitCode(biome.signalCode);
  return biomeCode;
}

if (import.meta.main) {
  process.exit(await main());
}
