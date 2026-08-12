#!/usr/bin/env bun
/**
 * Guarded lefthook installer (§3b) — the root `prepare` entry and
 * `bun run hooks:install`.
 *
 * Docker build contexts deliberately omit `.git` (see .dockerignore), and bun
 * runs the root `prepare` script on every install, so this must skip CLEANLY
 * there: no `.git` directory AND no worktree-style `.git` file → one line,
 * exit 0, no child process. In a real checkout (either `.git` shape) it runs
 * the pinned local lefthook via an argument array and propagates failure —
 * a broken hook installation in a checkout is an error, never a shrug.
 * After the frozen install the binary is local; no network is touched.
 *
 * `ENVEO_LEFTHOOK_BIN` overrides the lefthook binary; it is a test seam so the
 * tests can stub the child at the process boundary. Real use always resolves
 * the pinned local install.
 */
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

function signalExitCode(signal: NodeJS.Signals): number {
  const number = (constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (number ?? 0);
}

async function main(): Promise<number> {
  // existsSync is true for BOTH a `.git` directory and a worktree `.git` file.
  if (!existsSync(join(process.cwd(), ".git"))) {
    console.log("hooks: no .git here (production/container install) — skipping lefthook install");
    return 0;
  }

  const lefthookBin = process.env.ENVEO_LEFTHOOK_BIN || join(process.cwd(), "node_modules", ".bin", "lefthook");
  const child = Bun.spawn([lefthookBin, "install"], { stdio: ["inherit", "inherit", "inherit"] });
  const code = await child.exited;
  if (child.signalCode) return signalExitCode(child.signalCode);
  if (code !== 0) console.error(`hooks: lefthook install failed with status ${code}`);
  return code;
}

if (import.meta.main) {
  process.exit(await main());
}
