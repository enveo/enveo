/**
 * Tests for the guarded lefthook installer (§3b).
 *
 * The installer is root `prepare`: it must skip CLEANLY (exit 0, no child)
 * when there is no `.git` at all — Docker build contexts deliberately omit it —
 * and must run the pinned lefthook (propagating failure) in a real checkout,
 * whether `.git` is a directory or a worktree-style FILE. The lefthook child is
 * stubbed only at the process boundary (`ENVEO_LEFTHOOK_BIN`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_HOOKS = new URL("./install-hooks.ts", import.meta.url).pathname;

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "enveo-hooks-"));
  tempRoots.push(dir);
  return dir;
}

function writeStubLefthook(dir: string, exitCode: number): { bin: string; argvFile: string } {
  const argvFile = join(dir, "stub-argv.json");
  const bin = join(dir, "stub-lefthook.ts");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun\n` + `await Bun.write(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n` + `process.exit(${exitCode});\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, argvFile };
}

function runInstallHooks(cwd: string, lefthookBin: string): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", INSTALL_HOOKS], {
    cwd,
    env: { ...process.env, ENVEO_LEFTHOOK_BIN: lefthookBin },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("install-hooks (guarded prepare entry)", () => {
  test("no .git at all (Docker build context) → one-line skip, exit 0, no child", () => {
    const dir = tempDir();
    const stub = writeStubLefthook(dir, 0);
    const result = runInstallHooks(dir, stub.bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("skip");
    expect(existsSync(stub.argvFile)).toBe(false);
  });

  test(".git DIRECTORY (normal checkout) → runs lefthook install, exit 0", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    const stub = writeStubLefthook(dir, 0);
    const result = runInstallHooks(dir, stub.bin);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(stub.argvFile, "utf8"))).toEqual(["install"]);
  });

  test(".git FILE (linked worktree) → still a real checkout, runs lefthook install", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere/else/.git/worktrees/wt\n");
    const stub = writeStubLefthook(dir, 0);
    const result = runInstallHooks(dir, stub.bin);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(stub.argvFile, "utf8"))).toEqual(["install"]);
  });

  test("a failing lefthook child fails the script with its exact status", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    const stub = writeStubLefthook(dir, 5);
    const result = runInstallHooks(dir, stub.bin);
    expect(result.exitCode).toBe(5);
  });
});
