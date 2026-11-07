/**
 * Focused test selection (`bun run test --files …`): the grammar and path resolution as pure
 * logic, then the delivery through a real runner process — a narrowed run must still get the
 * forced environment, and an unusable selection must refuse before any suite starts.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { parseRunnerArgs, resolveSelection } from "./testSelection";

const REPO = "/work/enveo";
const TEST_FILES = ["scripts/lib/testEnv.test.ts", "scripts/lib/testSelection.test.ts", "packages/shared/src/budget.test.ts"];
const select = (paths: string[], cwd = REPO) => resolveSelection(paths, { repoRoot: REPO, cwd, testFiles: TEST_FILES });

describe("parseRunnerArgs", () => {
  it("keeps the default roots and passes everything through without --files", () => {
    expect(parseRunnerArgs(["-t", "budget"])).toEqual({ ok: true, args: { mode: "default", selection: null, passthrough: ["-t", "budget"] } });
    expect(parseRunnerArgs(["--db"])).toEqual({ ok: true, args: { mode: "db", selection: null, passthrough: [] } });
  });

  it("takes the paths after --files up to the first flag, in either mode", () => {
    expect(parseRunnerArgs(["--files", "scripts/lib", "packages/shared", "--test-name-pattern=carry"])).toEqual({
      ok: true,
      args: { mode: "default", selection: ["scripts/lib", "packages/shared"], passthrough: ["--test-name-pattern=carry"] },
    });
    expect(parseRunnerArgs(["--db", "--files", "scripts"])).toEqual({ ok: true, args: { mode: "db", selection: ["scripts"], passthrough: [] } });
  });

  it("refuses an empty selection", () => {
    expect(parseRunnerArgs(["--files"])).toEqual({ ok: false, error: "--files needs at least one test file or directory" });
    expect(parseRunnerArgs(["--db", "--files", "-t", "x"]).ok).toBe(false);
  });

  it("refuses a bare argument after the selection, which bun test would read as one more path", () => {
    expect(parseRunnerArgs(["--files", "scripts/lib", "--timeout", "1000", "scripts/no-such.test.ts"])).toEqual({
      ok: false,
      error: "1000: after --files paths, give bun test options as --name=value (a bare argument would add an unchecked path)",
    });
    expect(parseRunnerArgs(["--files", "scripts/lib", "--bail", "."]).ok).toBe(false);
    expect(parseRunnerArgs(["--files", "scripts/lib", "--timeout=1000", "--test-name-pattern=carry"])).toEqual({
      ok: true,
      args: { mode: "default", selection: ["scripts/lib"], passthrough: ["--timeout=1000", "--test-name-pattern=carry"] },
    });
  });

  it("refuses --files anywhere it could be mistaken for a bun test argument", () => {
    expect(parseRunnerArgs(["-t", "x", "--files", "scripts"])).toEqual({ ok: false, error: "--files must directly follow the mode flag" });
    expect(parseRunnerArgs(["--files", "scripts", "--bail", "--files", "packages"])).toEqual({ ok: false, error: "--files may be given only once" });
  });
});

describe("resolveSelection", () => {
  it("accepts test files and directories holding them, as ./-prefixed paths for bun test", () => {
    expect(select(["scripts/lib", "./packages/shared/src/budget.test.ts", `${REPO}/scripts/lib/testEnv.test.ts`])).toEqual({
      ok: true,
      paths: ["./scripts/lib", "./packages/shared/src/budget.test.ts", "./scripts/lib/testEnv.test.ts"],
    });
  });

  it("resolves relative to the working directory", () => {
    expect(select(["lib/testEnv.test.ts"], `${REPO}/scripts`)).toEqual({ ok: true, paths: ["./scripts/lib/testEnv.test.ts"] });
  });

  it("refuses a path that matches no covered test, including a mere name prefix", () => {
    expect(select(["scripts/lib/testEnv.test.tsx", "scripts/li", "packages/web"])).toEqual({
      ok: false,
      errors: [
        "scripts/lib/testEnv.test.tsx: matches no test file the runner covers",
        "scripts/li: matches no test file the runner covers",
        "packages/web: matches no test file the runner covers",
      ],
    });
  });

  it("refuses the repository root and anything outside it", () => {
    expect(select([".", "..", "/elsewhere/scripts", "../enveo-other/scripts"])).toEqual({
      ok: false,
      errors: [
        ".: not a path inside the repository below its root",
        "..: not a path inside the repository below its root",
        "/elsewhere/scripts: not a path inside the repository below its root",
        "../enveo-other/scripts: not a path inside the repository below its root",
      ],
    });
  });
});

const RUNNER = resolve(import.meta.dir, "../run-tests.ts");
const REPO_ROOT = resolve(import.meta.dir, "../..");

async function runRunner(args: string[], cwd = REPO_ROOT) {
  const child = Bun.spawn(["bun", RUNNER, ...args], {
    cwd,
    // Ambient values a developer's .env could hold: the runner must override them for the child.
    env: { ...process.env, OPENAI_API_KEY: "sk-test-ambient-must-not-arrive", TEST_DATABASE_URL: "postgres://enveo:enveo@127.0.0.1:5495/enveo" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: `${stdout}\n${stderr}` };
}

describe("run-tests.ts --files (real runner process)", () => {
  it(
    "runs only the selected suite, under the forced environment",
    async () => {
      const { code, output } = await runRunner(["--files", "scripts/lib/runner-contract.test.ts"]);

      expect(output).toContain("run-tests: bun test ./scripts/lib/runner-contract.test.ts\n");
      expect(output).toMatch(/across 1 file\./);
      // Without the runner's markers the contract suite skips itself entirely, and with the
      // ambient key delivered its first test fails — so passes and no failures prove delivery.
      expect(output).toMatch(/\n\s*[1-9]\d* pass\n/);
      expect(output).toMatch(/\n\s*0 fail\n/);
      expect(code).toBe(0);
    },
    { timeout: 30_000 },
  );

  it(
    "resolves a selection against the caller's directory and runs it from the repository root",
    async () => {
      const { code, output } = await runRunner(["--files", "lib/runner-contract.test.ts"], resolve(REPO_ROOT, "scripts"));

      expect(output).toContain("run-tests: bun test ./scripts/lib/runner-contract.test.ts\n");
      expect(output).toMatch(/across 1 file\./);
      expect(output).toMatch(/\n\s*0 fail\n/);
      expect(code).toBe(0);
    },
    { timeout: 30_000 },
  );

  it(
    "refuses an unmatched selection before starting any suite",
    async () => {
      const { code, output } = await runRunner(["--files", "scripts/lib/no-such-suite.test.ts"]);

      expect(code).toBe(2);
      expect(output).toContain("scripts/lib/no-such-suite.test.ts: matches no test file the runner covers");
      expect(output).not.toContain("run-tests: bun test");
    },
    { timeout: 30_000 },
  );
});
