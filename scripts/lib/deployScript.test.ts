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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Exit codes the script promises. Each prerequisite failure is distinguishable. */
const EXIT = { ok: 0, failed: 1, noDocker: 2, noCompose: 3, noDaemon: 4, noTool: 5, badSecret: 6 } as const;

/**
 * Coreutils the script may legitimately use. Symlinked into the sandbox one by one so the fake
 * PATH can leave out `docker`, `curl` or `openssl` — impossible with a real `/usr/bin` on PATH,
 * where this machine's actual Docker would answer.
 */
const BASE_TOOLS = ["dirname", "cp", "sed", "grep", "sleep", "cat", "tr", "head", "rm", "mv", "date"];

type Stub = "docker" | "curl" | "openssl";

/**
 * Commands the script must NEVER invoke. They are stubbed too — otherwise "it did not run apt"
 * passes for the wrong reason (`apt` is simply not on the fake PATH, so the assertion holds even
 * if the script tried). Stubbed, a call would be recorded, and only then does absence mean
 * something.
 */
const FORBIDDEN_TOOLS = ["apt-get", "apt", "sudo", "wget", "sh", "bash", "dnf", "apk"] as const;

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
if [ "\${FAKE_OPENSSL_FAIL:-0}" = "1" ]; then
  echo "openssl: unable to open random state" >&2; exit 1
fi
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
  writeFileSync(join(dir, ".env.example"), ["# fixture", "POSTGRES_PASSWORD=", "BETTER_AUTH_SECRET=", "DEPLOYMENT=selfhost", ""].join("\n"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of BASE_TOOLS) {
    const real = resolveTool(tool);
    if (real) symlinkSync(real, join(bin, tool));
  }
  for (const stub of stubs) writeStub(bin, stub);
  // Recorders for the commands that must never run. They only log and exit 0.
  for (const forbidden of FORBIDDEN_TOOLS) {
    const path = join(bin, forbidden);
    if (existsSync(path)) continue;
    writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' "${forbidden} $*" >> "$STUB_LOG"\nexit 0\n`);
    chmodSync(path, 0o755);
  }
  return { dir, bin, log: join(dir, "stub.log") };
}

type Run = { code: number; stdout: string; stderr: string; calls: string[]; env: string | null };

async function runDeploy(stubs: readonly Stub[] = ["docker", "curl", "openssl"], fake: Record<string, string> = {}): Promise<Run> {
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
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
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
    expect(output(run)).not.toMatch(/get\.docker\.com/);
    // `apt`, `sudo`, `wget` and `sh` ARE on the fake PATH as recorders, so this assertion can
    // only pass because the script did not call them.
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(run.calls.some((c) => c.startsWith(`${forbidden} `))).toBe(false);
    }
  });

  it("no run of the script — successful or not — ever invokes a package manager or sudo", async () => {
    const runs = [await runDeploy(), await runDeploy(["docker", "curl", "openssl"], { FAKE_DAEMON_OK: "0" }), await runDeploy(["docker", "openssl"])];
    for (const run of runs) {
      for (const forbidden of FORBIDDEN_TOOLS) {
        expect(run.calls.some((c) => c.startsWith(`${forbidden} `))).toBe(false);
      }
    }
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

  it("a FAILING openssl aborts before `.env` exists — never an empty password", async () => {
    // The regression this pins: with the generation inlined into another command's arguments,
    // `set -e` sees that command's status (0) and a failed openssl silently yields an EMPTY
    // value. `${POSTGRES_PASSWORD:-enveo}` in the dev compose file substitutes on empty as well
    // as unset, so the database volume would be initialised, permanently, with a well-known
    // password — and a later hand-fix of .env then fails authentication for no visible reason.
    const run = await runDeploy(undefined, { FAKE_OPENSSL_FAIL: "1" });
    expect(run.code).not.toBe(EXIT.ok);
    expect(run.env).toBeNull();
    expect(output(run)).toMatch(/openssl|secret/i);
    expect(run.calls.some((c) => c.startsWith("docker compose up"))).toBe(false);
  });

  it("`.env` is created readable by its owner only", async () => {
    const { dir, bin, log } = makeSandbox(["docker", "curl", "openssl"]);
    sandbox = dir;
    const proc = Bun.spawn(["/bin/bash", "scripts/deploy.sh"], {
      cwd: dir,
      env: { PATH: bin, HOME: dir, STUB_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("keeps secrets out of an xtrace, where a debugging operator would paste them", async () => {
    const { dir, bin, log } = makeSandbox(["docker", "curl", "openssl"]);
    sandbox = dir;
    const proc = Bun.spawn(["/bin/bash", "-x", "scripts/deploy.sh"], {
      cwd: dir,
      env: { PATH: bin, HOME: dir, STUB_LOG: log, FAKE_SECRET: "xtrace-must-not-show-this" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(`${stdout}\n${stderr}`).not.toContain("xtrace-must-not-show-this");
  });

  it("never passes a secret in another command's argv", async () => {
    // /proc/<pid>/cmdline is world-readable, so a secret in `sed`'s arguments is visible to
    // every local user for the lifetime of that process. The stubs record their argv verbatim.
    const run = await runDeploy(undefined, { FAKE_SECRET: "argv-must-not-show-this" });
    expect(run.calls.join("\n")).not.toContain("argv-must-not-show-this");
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
    // A realistic secret: 64 hex characters, as `openssl rand -hex 32` produces.
    const existingSecret = "a".repeat(64);
    const existing = `POSTGRES_PASSWORD=mine\nBETTER_AUTH_SECRET=${existingSecret}\nDEPLOYMENT=selfhost\n`;
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
    expect(stdout).not.toContain(existingSecret);
  });

  it("refuses a too-SHORT existing BETTER_AUTH_SECRET instead of booting into a refusal", async () => {
    // better-auth requires >= 32 characters and the API aborts its boot without one. Accepting
    // a 5-character value here buys the operator ~80 seconds of health polling and a generic
    // "did not become healthy". It is also not ours to overwrite: replacing a real secret signs
    // every device out.
    const { dir, bin, log } = makeSandbox(["docker", "curl", "openssl"]);
    sandbox = dir;
    const existing = "POSTGRES_PASSWORD=mine\nBETTER_AUTH_SECRET=short\n";
    writeFileSync(join(dir, ".env"), existing);
    const proc = Bun.spawn(["/bin/bash", "scripts/deploy.sh"], {
      cwd: dir,
      env: { PATH: bin, HOME: dir, STUB_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(EXIT.badSecret);
    expect(stderr).toMatch(/32/);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(existing); // not overwritten
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("docker compose up");
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
