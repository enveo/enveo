/**
 * `scripts/deploy.sh` — the deployment bootstrap contract (§5a).
 *
 * Every case runs the REAL script in a throwaway directory whose `PATH` contains nothing but
 * symlinked coreutils and our own stubs. There is no real Docker, no daemon, no network and no
 * host `.env` anywhere in reach — which is the only way to assert the interesting half of this
 * script: what it does when a prerequisite is MISSING. The stubs record every invocation, so the
 * ORDER (prerequisites → mutation → start → health) is checked, not assumed.
 *
 * The script's source text is guarded separately, by the source policy in sourcePolicy.ts: these
 * tests prove the behaviour, that one proves nobody put `curl … | sh` back.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Exit codes the script promises. Each prerequisite failure is distinguishable. */
const EXIT = { ok: 0, failed: 1, noDocker: 2, noCompose: 3, noDaemon: 4, noTool: 5 } as const;

/**
 * Coreutils the script may legitimately use. Symlinked into the sandbox one by one so the fake
 * PATH can leave out `docker`, `curl` or `openssl` — impossible with a real `/usr/bin` on PATH,
 * where this machine's actual Docker would answer.
 */
const BASE_TOOLS = ["dirname", "cp", "sed", "grep", "sleep", "cat", "tr", "head", "rm", "mv", "date"];

type Stub = "docker" | "curl" | "openssl";

let sandbox = "";

function resolveTool(name: string): string | null {
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A fake command that appends its whole argv to `$STUB_LOG` and then behaves per environment. */
function writeStub(binDir: string, name: Stub): void {
  const bodies: Record<Stub, string> = {
    docker: `
case "$1" in
  compose)
    case "$2" in
      version)
        if [ "\${FAKE_COMPOSE_OK:-1}" != "1" ]; then
          echo "docker: 'compose' is not a docker command." >&2; exit 1
        fi
        echo "Docker Compose version v2.30.0" ;;
      *) if [ "\${FAKE_DAEMON_OK:-1}" != "1" ]; then
           echo "Cannot connect to the Docker daemon." >&2; exit 1
         fi
         echo "compose $2 ok" ;;
    esac ;;
  info)
    if [ "\${FAKE_DAEMON_OK:-1}" != "1" ]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2; exit 1
    fi
    echo "Server Version: 27.3.1" ;;
esac
exit 0`,
    curl: `
if [ "\${FAKE_HEALTH_OK:-1}" != "1" ]; then exit 7; fi
echo '{"ok":true}'
exit 0`,
    openssl: `
echo "\${FAKE_SECRET:-00000000000000000000000000000000000000000000000000000000000000ff}"
exit 0`,
  };
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${bodies[name]}\n`);
  chmodSync(path, 0o755);
}

/** A sandbox holding a copy of the script, a fixture `.env.example`, and a controlled PATH. */
function makeSandbox(stubs: readonly Stub[]): { dir: string; bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "enveo-deploy-"));
  mkdirSync(join(dir, "scripts"));
  cpSync(join(REPO_ROOT, "scripts", "deploy.sh"), join(dir, "scripts", "deploy.sh"));
  writeFileSync(
    join(dir, ".env.example"),
    ["# fixture", "POSTGRES_PASSWORD=", "BETTER_AUTH_SECRET=", "DEPLOYMENT=selfhost", ""].join("\n"),
  );
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of BASE_TOOLS) {
    const real = resolveTool(tool);
    if (real) symlinkSync(real, join(bin, tool));
  }
  for (const stub of stubs) writeStub(bin, stub);
  return { dir, bin, log: join(dir, "stub.log") };
}

type Run = { code: number; stdout: string; stderr: string; calls: string[]; env: string | null };

async function runDeploy(
  stubs: readonly Stub[] = ["docker", "curl", "openssl"],
  fake: Record<string, string> = {},
): Promise<Run> {
  const { dir, bin, log } = makeSandbox(stubs);
  sandbox = dir;
  const proc = Bun.spawn(["/bin/bash", "scripts/deploy.sh"], {
    cwd: dir,
    // A DELIBERATELY minimal environment: no inherited PATH, so nothing outside the sandbox
    // can answer, and no inherited variables from the developer's shell.
    env: { PATH: bin, HOME: dir, STUB_LOG: log, ...fake },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  const env = existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : null;
  return { code, stdout, stderr, calls, env };
}

/** Everything the script wrote or ran, for the "nothing was mutated" assertions. */
const output = (run: Run): string => `${run.stdout}\n${run.stderr}`;

beforeEach(() => {
  sandbox = "";
});
afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe("prerequisites are checked before anything is written", () => {
  it("missing docker CLI: exits with its own code and points at Docker's official docs", async () => {
    const run = await runDeploy(["curl", "openssl"]);
    expect(run.code).toBe(EXIT.noDocker);
    expect(output(run)).toContain("docs.docker.com/engine/install");
    expect(run.env).toBeNull();
  });

  it("missing docker CLI: never tries to install anything", async () => {
    const run = await runDeploy(["curl", "openssl"]);
    expect(output(run)).not.toMatch(/get\.docker\.com|\| *sh\b/);
    expect(run.calls.join("\n")).not.toMatch(/apt|sudo/);
  });

  it("missing Compose v2 plugin: a DIFFERENT failure from a missing CLI", async () => {
    const run = await runDeploy(["docker", "curl", "openssl"], { FAKE_COMPOSE_OK: "0" });
    expect(run.code).toBe(EXIT.noCompose);
    expect(output(run)).toMatch(/compose/i);
    expect(run.env).toBeNull();
  });

  it("daemon unreachable: not reported as a missing installation", async () => {
    const run = await runDeploy(["docker", "curl", "openssl"], { FAKE_DAEMON_OK: "0" });
    expect(run.code).toBe(EXIT.noDaemon);
    const text = output(run);
    expect(text).toMatch(/daemon/i);
    // The actionable causes: the service is not running, or this user is not in the group.
    expect(text).toMatch(/docker group|systemctl|not running/i);
    // It must not send the operator off to reinstall: no distribution install page here, and
    // it says so in words. (The POST-installation page is the right link and is allowed.)
    expect(text).not.toMatch(/engine\/install\/(ubuntu|debian)/);
    expect(text).toMatch(/not a missing installation/i);
    expect(run.env).toBeNull();
    expect(run.calls.join("\n")).not.toContain("compose up");
  });

  it("missing curl (the health probe) stops before `.env` exists", async () => {
    const run = await runDeploy(["docker", "openssl"]);
    expect(run.code).toBe(EXIT.noTool);
    expect(output(run)).toContain("curl");
    expect(run.env).toBeNull();
  });

  it("missing openssl (secret generation) stops before `.env` exists", async () => {
    const run = await runDeploy(["docker", "curl"]);
    expect(run.code).toBe(EXIT.noTool);
    expect(output(run)).toContain("openssl");
    expect(run.env).toBeNull();
  });
});

describe("the success path", () => {
  it("checks prerequisites, then writes `.env`, then starts, then polls health", async () => {
    const run = await runDeploy();
    expect(run.code).toBe(EXIT.ok);
    const order = run.calls.join("\n");
    const compose = order.indexOf("docker compose version");
    const info = order.indexOf("docker info");
    const up = order.indexOf("docker compose up");
    const health = order.indexOf("curl");
    expect(compose).toBeGreaterThanOrEqual(0);
    expect(info).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(Math.max(compose, info));
    expect(health).toBeGreaterThan(up);
  });

  it("generates both secrets into `.env`", async () => {
    const run = await runDeploy([...(["docker", "curl", "openssl"] as const)], { FAKE_SECRET: "abc123secret" });
    expect(run.env).toContain("POSTGRES_PASSWORD=abc123secret");
    expect(run.env).toContain("BETTER_AUTH_SECRET=abc123secret");
    expect(run.env).toContain("DEPLOYMENT=selfhost"); // the rest of .env.example survives
  });

  it("never prints a generated secret or the contents of `.env`", async () => {
    const run = await runDeploy(undefined, { FAKE_SECRET: "s3cr3t-must-not-be-logged" });
    expect(output(run)).not.toContain("s3cr3t-must-not-be-logged");
  });

  it("polls only localhost for health — the script makes no other request", async () => {
    const run = await runDeploy();
    for (const call of run.calls.filter((c) => c.startsWith("curl"))) {
      expect(call).toMatch(/https?:\/\/(127\.0\.0\.1|localhost)/);
    }
  });

  it("reports failure when the app never answers", async () => {
    const run = await runDeploy(undefined, { FAKE_HEALTH_OK: "0", ENVEO_HEALTH_ATTEMPTS: "2", ENVEO_HEALTH_DELAY: "0" });
    expect(run.code).toBe(EXIT.failed);
    expect(output(run)).toMatch(/logs/);
  });
});

describe("idempotency", () => {
  it("leaves a complete existing `.env` byte-identical", async () => {
    const { dir, bin, log } = makeSandbox(["docker", "curl", "openssl"]);
    sandbox = dir;
    const existing = "POSTGRES_PASSWORD=mine\nBETTER_AUTH_SECRET=alreadyhere\nDEPLOYMENT=selfhost\n";
    writeFileSync(join(dir, ".env"), existing);
    const proc = Bun.spawn(["/bin/bash", "scripts/deploy.sh"], {
      cwd: dir,
      env: { PATH: bin, HOME: dir, STUB_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(EXIT.ok);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(existing);
    expect(stdout).not.toContain("alreadyhere");
  });

  it("adds only a MISSING BETTER_AUTH_SECRET and keeps every other line", async () => {
    const { dir, bin, log } = makeSandbox(["docker", "curl", "openssl"]);
    sandbox = dir;
    writeFileSync(join(dir, ".env"), "POSTGRES_PASSWORD=mine\nDEPLOYMENT=selfhost\n");
    const proc = Bun.spawn(["/bin/bash", "scripts/deploy.sh"], {
      cwd: dir,
      env: { PATH: bin, HOME: dir, STUB_LOG: log, FAKE_SECRET: "generated-secret" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(EXIT.ok);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("POSTGRES_PASSWORD=mine");
    expect(env).toContain("DEPLOYMENT=selfhost");
    expect(env).toContain("BETTER_AUTH_SECRET=generated-secret");
    expect(stdout).not.toContain("generated-secret");
  });
});
