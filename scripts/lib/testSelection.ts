/**
 * Argument grammar of `scripts/run-tests.ts` and its focused file selection (§3a).
 *
 * `bun test` ORs positional paths, so appending one to the runner's default roots cannot narrow
 * a run. `--files` REPLACES those roots instead, and every selected path must name a test file
 * (or a directory holding one) inside the roots: a typo must refuse, never quietly run zero or
 * all suites. Pure logic — the caller supplies the discovered test files.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { TestMode } from "./testEnv";

export const FILES_FLAG = "--files";

export type RunnerArgs = Readonly<{
  mode: TestMode;
  /** Paths after `--files`, as typed; null runs the default roots. */
  selection: readonly string[] | null;
  /** Everything else, handed to `bun test` unchanged. */
  passthrough: readonly string[];
}>;

export type ParseResult = { ok: true; args: RunnerArgs } | { ok: false; error: string };

/** `[--db] [--files <path>…] [bun test arguments…]` */
export function parseRunnerArgs(argv: readonly string[]): ParseResult {
  const mode: TestMode = argv[0] === "--db" ? "db" : "default";
  const rest = mode === "db" ? argv.slice(1) : argv;
  if (rest[0] !== FILES_FLAG) {
    if (rest.includes(FILES_FLAG)) return { ok: false, error: `${FILES_FLAG} must directly follow the mode flag` };
    return { ok: true, args: { mode, selection: null, passthrough: rest } };
  }
  let end = 1;
  while (end < rest.length && !rest[end]?.startsWith("-")) end++;
  const selection = rest.slice(1, end);
  const passthrough = rest.slice(end);
  if (selection.length === 0) return { ok: false, error: `${FILES_FLAG} needs at least one test file or directory` };
  if (passthrough.includes(FILES_FLAG)) return { ok: false, error: `${FILES_FLAG} may be given only once` };
  // bun test reads every bare token as one more path filter, ORed with the selection: a value
  // given as a separate argument (`--timeout 1000`) is indistinguishable from an unvalidated
  // extra path that would widen the run. So options after a selection take the `=` form only.
  const bare = passthrough.find((arg) => !arg.startsWith("-"));
  if (bare !== undefined) {
    return { ok: false, error: `${bare}: after ${FILES_FLAG} paths, give bun test options as --name=value (a bare argument would add an unchecked path)` };
  }
  return { ok: true, args: { mode, selection, passthrough } };
}

export type SelectionResult = { ok: true; paths: readonly string[] } | { ok: false; errors: readonly string[] };

/**
 * Map typed paths to `./`-prefixed repository paths for `bun test` (the prefix makes bun treat
 * them as paths rather than substring filters). `testFiles` are the repository-relative suites
 * under the runner's roots.
 */
export function resolveSelection(
  selection: readonly string[],
  context: Readonly<{ repoRoot: string; cwd: string; testFiles: readonly string[] }>,
): SelectionResult {
  const errors: string[] = [];
  const paths: string[] = [];
  for (const typed of selection) {
    const path = relative(context.repoRoot, resolve(context.cwd, typed)).replaceAll("\\", "/");
    if (path === "" || path === ".." || path.startsWith("../") || isAbsolute(path)) {
      errors.push(`${typed}: not a path inside the repository below its root`);
      continue;
    }
    if (!context.testFiles.some((file) => file === path || file.startsWith(`${path}/`))) {
      errors.push(`${typed}: matches no test file the runner covers`);
      continue;
    }
    paths.push(`./${path}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, paths };
}
