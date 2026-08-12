#!/usr/bin/env bun
/**
 * Root test orchestrator (§3a). Single entry point for `bun run test` and `bun run test:db`.
 *
 *   bun scripts/run-tests.ts            # default mode: AI off, DB-backed groups skipped
 *   bun scripts/run-tests.ts --db       # DB mode: AI off, DB-backed groups REQUIRED
 *   bun scripts/run-tests.ts --db -t x  # anything after the mode flag goes to `bun test`
 *
 * Why a script instead of a shell prefix: `OPENAI_API_KEY= bun test …` only protects the
 * command that carries the prefix, it is invisible in CI logs, and it is not portable to
 * Windows shells. Here the decision is pure logic (`lib/testEnv.ts`) and the child is spawned
 * with an EXPLICIT environment and an ARGUMENT ARRAY — never an interpolated shell string.
 */
import { constants } from "node:os";
import { planTestEnv, type TestMode } from "./lib/testEnv";

/** Everything that must pass before Enveo ships. Shared/API/web-lib domain plus this tooling. */
export const TEST_PATHS = ["packages/shared", "packages/api", "packages/web/src/lib", "scripts"] as const;

/** Refusal to run (unsafe/incomplete configuration) — deliberately distinct from a test failure. */
const EXIT_REFUSED = 2;

function signalExitCode(signal: NodeJS.Signals): number {
  const number = (constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (number ?? 0);
}

async function main(argv: readonly string[]): Promise<number> {
  const mode: TestMode = argv[0] === "--db" ? "db" : "default";
  const passthrough = mode === "db" ? argv.slice(1) : argv;

  const planned = planTestEnv(mode, process.env);
  if (!planned.ok) {
    console.error(`\nrun-tests: refusing to start (mode=${planned.mode}):`);
    for (const error of planned.errors) console.error(`  • ${error}`);
    console.error(
      "\nCreate a FRESH throwaway PostgreSQL (never a database you care about), then:\n" +
        "  TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5495/enveo \\\n" +
        "  ENVEO_TEST_DB_ACK=throwaway bun run test:db\n",
    );
    return EXIT_REFUSED;
  }

  const args = ["test", ...TEST_PATHS, ...passthrough];
  console.log(`\nrun-tests: ${planned.plan.banner}`);
  console.log(`run-tests: bun ${args.join(" ")}\n`);

  const child = Bun.spawn(["bun", ...args], {
    // Inherit the parent environment, then FORCE the sensitive variables. The overrides win
    // over anything bun auto-loaded from .env, because they are applied last.
    env: { ...process.env, ...planned.plan.overrides },
    stdio: ["inherit", "inherit", "inherit"],
  });

  const code = await child.exited;
  const signal = child.signalCode;
  if (signal) {
    console.error(`\nrun-tests: test process terminated by ${signal}`);
    return signalExitCode(signal);
  }
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
