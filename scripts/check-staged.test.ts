/**
 * Tests for the pre-commit staged-file runner (§3b).
 *
 * Unit level: `selectBiomePaths` is pure — raw NUL-separated git output in,
 * ordered/deduped/`./`-prefixed Biome paths out. No index is touched.
 *
 * Process level: a THROWAWAY git repository plus a stub Biome binary injected
 * only at the process boundary (`ENVEO_BIOME_BIN`), asserting the exact
 * argument array and that exit statuses propagate unchanged.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BIOME_EXTENSIONS, selectBiomePaths } from "./check-staged";

const CHECK_STAGED = new URL("./check-staged.ts", import.meta.url).pathname;

function nul(...paths: string[]): Uint8Array {
  return new TextEncoder().encode(paths.map((p) => `${p}\0`).join(""));
}

describe("selectBiomePaths (pure)", () => {
  const always = () => true;
  const never = () => false;

  test("empty input selects nothing", () => {
    expect(selectBiomePaths(new Uint8Array(), always)).toEqual([]);
  });

  test("one supported path is kept and ./-prefixed", () => {
    expect(selectBiomePaths(nul("a.ts"), always)).toEqual(["./a.ts"]);
  });

  test("unsupported extensions are skipped, supported ones kept", () => {
    const raw = nul("a.ts", "README.md", "b.json", "img.png", "schema.sql", "wf.yml");
    expect(selectBiomePaths(raw, always)).toEqual(["./a.ts", "./b.json"]);
  });

  test("every allowlisted extension is accepted", () => {
    for (const ext of BIOME_EXTENSIONS) {
      expect(selectBiomePaths(nul(`file${ext}`), always)).toEqual([`./file${ext}`]);
    }
  });

  test("paths with spaces survive intact (NUL is the only separator)", () => {
    expect(selectBiomePaths(nul("src/my file.tsx"), always)).toEqual(["./src/my file.tsx"]);
  });

  test("Unicode paths survive UTF-8 decoding", () => {
    expect(selectBiomePaths(nul("koperty/żółć łóżko.ts"), always)).toEqual(["./koperty/żółć łóżko.ts"]);
  });

  test("a leading-dash filename cannot become a CLI option", () => {
    const [selected] = selectBiomePaths(nul("-rf.ts"), always);
    expect(selected).toBe("./-rf.ts");
    expect(selected!.startsWith("-")).toBe(false);
  });

  test("duplicate paths collapse to one, first occurrence wins", () => {
    expect(selectBiomePaths(nul("a.ts", "b.ts", "a.ts"), always)).toEqual(["./a.ts", "./b.ts"]);
  });

  test("git's emitted order is preserved", () => {
    expect(selectBiomePaths(nul("z.ts", "a.ts", "m.json"), always)).toEqual(["./z.ts", "./a.ts", "./m.json"]);
  });

  test("rename output: only the (existing) new path is listed and kept", () => {
    // `git diff --cached --name-only --diff-filter=ACMR -z` emits the DESTINATION
    // path of a rename; the old path is gone and never reaches the list.
    expect(selectBiomePaths(nul("renamed-to.ts"), always)).toEqual(["./renamed-to.ts"]);
  });

  test("paths that no longer exist as regular files are skipped", () => {
    expect(selectBiomePaths(nul("gone.ts", "still-here.ts"), (p) => p === "still-here.ts")).toEqual(["./still-here.ts"]);
    expect(selectBiomePaths(nul("gone.ts"), never)).toEqual([]);
  });

  test("the final NUL terminator does not produce a phantom empty path", () => {
    // nul() already appends a terminator after every record, like git does.
    expect(selectBiomePaths(nul("a.ts", "b.ts"), always)).toEqual(["./a.ts", "./b.ts"]);
  });

  test("a truncated final record (no trailing NUL) is still a path, not garbage", () => {
    const raw = new TextEncoder().encode("a.ts\0b.ts");
    expect(selectBiomePaths(raw, always)).toEqual(["./a.ts", "./b.ts"]);
  });

  test("newlines are NOT separators — a filename containing one stays whole", () => {
    const weird = "weird\nname.ts";
    expect(selectBiomePaths(nul(weird), always)).toEqual([`./${weird}`]);
  });
});

// ---------------------------------------------------------------------------
// Process level
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** A stub “Biome” recording its argv to a file and exiting with a fixed code. */
function writeStubBiome(dir: string, exitCode: number): { bin: string; argvFile: string } {
  const argvFile = join(dir, "stub-argv.json");
  const bin = join(dir, "stub-biome.ts");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun\n` + `await Bun.write(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n` + `process.exit(${exitCode});\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, argvFile };
}

function initRepo(dir: string): void {
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  expect(init.exitCode).toBe(0);
}

function stage(dir: string, ...paths: string[]): void {
  const add = Bun.spawnSync(["git", "add", "--", ...paths], { cwd: dir });
  expect(add.exitCode).toBe(0);
}

function runCheckStaged(cwd: string, biomeBin: string): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", CHECK_STAGED], {
    cwd,
    env: { ...process.env, ENVEO_BIOME_BIN: biomeBin },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("check-staged (process boundary)", () => {
  test("staged files with spaces and Unicode reach Biome as an exact argument array", () => {
    const dir = tempDir("enveo-staged-");
    initRepo(dir);
    mkdirSync(join(dir, "sub dir"));
    writeFileSync(join(dir, "sub dir", "a b.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "żółć.tsx"), "export const y = 2;\n");
    writeFileSync(join(dir, "notes.md"), "# not biome's business\n");
    stage(dir, "sub dir/a b.ts", "żółć.tsx", "notes.md");

    const stub = writeStubBiome(dir, 0);
    const result = runCheckStaged(dir, stub.bin);
    expect(result.exitCode).toBe(0);

    const argv = JSON.parse(require("node:fs").readFileSync(stub.argvFile, "utf8")) as string[];
    expect(argv).toEqual(["check", "--files-ignore-unknown=true", "./sub dir/a b.ts", "./żółć.tsx"]);
  });

  test("no supported staged files → skip message, exit 0, Biome never spawned", () => {
    const dir = tempDir("enveo-staged-");
    initRepo(dir);
    writeFileSync(join(dir, "README.md"), "docs only\n");
    stage(dir, "README.md");

    const stub = writeStubBiome(dir, 0);
    const result = runCheckStaged(dir, stub.bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Biome: no supported staged files");
    expect(require("node:fs").existsSync(stub.argvFile)).toBe(false);
  });

  test("a Biome failure propagates its exact exit status", () => {
    const dir = tempDir("enveo-staged-");
    initRepo(dir);
    writeFileSync(join(dir, "bad.ts"), "const x=1\n");
    stage(dir, "bad.ts");

    const stub = writeStubBiome(dir, 3);
    const result = runCheckStaged(dir, stub.bin);
    expect(result.exitCode).toBe(3);
  });

  test("a git failure (not a repository) propagates non-zero and skips Biome", () => {
    const dir = tempDir("enveo-nongit-");
    const stub = writeStubBiome(dir, 0);
    const result = runCheckStaged(dir, stub.bin);
    expect(result.exitCode).not.toBe(0);
    expect(require("node:fs").existsSync(stub.argvFile)).toBe(false);
  });

  test("a staged-then-deleted file is not handed to Biome", () => {
    const dir = tempDir("enveo-staged-");
    initRepo(dir);
    writeFileSync(join(dir, "kept.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "vanishes.ts"), "export const b = 2;\n");
    stage(dir, "kept.ts", "vanishes.ts");
    rmSync(join(dir, "vanishes.ts"));

    const stub = writeStubBiome(dir, 0);
    const result = runCheckStaged(dir, stub.bin);
    expect(result.exitCode).toBe(0);
    const argv = JSON.parse(require("node:fs").readFileSync(stub.argvFile, "utf8")) as string[];
    expect(argv).toEqual(["check", "--files-ignore-unknown=true", "./kept.ts"]);
  });
});
