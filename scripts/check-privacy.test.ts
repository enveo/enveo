import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPrivacyPolicy } from "./check-privacy";

const directories: string[] = [];
const syntheticAccount = ["account number", "123456789012"].join(": ");

function repository(): string {
  const root = join("/tmp", `enveo-privacy-${crypto.randomUUID()}`);
  directories.push(root);
  mkdirSync(root, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", root]);
  Bun.spawnSync(["git", "-C", root, "config", "user.email", "dev@example.test"]);
  Bun.spawnSync(["git", "-C", root, "config", "user.name", "Synthetic Developer"]);
  return root;
}

function commit(root: string, message: string): string {
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);
  const result = Bun.spawnSync(["git", "-C", root, "commit", "-q", "-m", message]);
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout).trim();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runPrivacyPolicy", () => {
  it("detects fine-grained GitHub tokens across all scan inputs", async () => {
    const root = repository();
    const token = ["github", "pat", "synthetic".repeat(5)].join("_");
    writeFileSync(join(root, "fixture.txt"), token);
    Bun.spawnSync(["git", "-C", root, "add", "-A"]);
    for (const args of [[], ["--staged"], ["--message", token]]) {
      const output: string[] = [];
      expect(await runPrivacyPolicy(args, output.push.bind(output), root)).toBe(1);
      expect(output.join("\n")).not.toContain(token);
    }
    commit(root, "test: synthetic token canary");
    const output: string[] = [];
    expect(await runPrivacyPolicy(["--range", "--all"], output.push.bind(output), root)).toBe(1);
    expect(output.join("\n")).not.toContain(token);
  });

  it("staged mode reads index blobs instead of differing working-tree content", async () => {
    const root = repository();
    const name = "-note\nwith-newline.txt";
    writeFileSync(join(root, name), `${syntheticAccount}\n`);
    Bun.spawnSync(["git", "-C", root, "add", "--", name]);
    writeFileSync(join(root, name), "synthetic only\n");
    const output: string[] = [];

    expect(await runPrivacyPolicy(["--staged"], output.push.bind(output), root)).toBe(1);
    expect(output.join("\n")).not.toContain("123456789012");
  });

  it("range mode scans an earlier blob removed by a later commit", async () => {
    const root = repository();
    writeFileSync(join(root, "base.txt"), "synthetic only\n");
    const base = commit(root, "chore: synthetic baseline");
    writeFileSync(join(root, "temporary.txt"), `${syntheticAccount}\n`);
    commit(root, "test: add temporary fixture");
    rmSync(join(root, "temporary.txt"));
    commit(root, "test: remove temporary fixture");

    expect(await runPrivacyPolicy(["--range", `${base}..HEAD`], () => {}, root)).toBe(1);
  });

  it("fails closed when explicitly requested known-value mode is missing", async () => {
    const root = repository();
    writeFileSync(join(root, "safe.txt"), "synthetic only\n");
    commit(root, "chore: synthetic baseline");
    expect(await runPrivacyPolicy(["--known-values", join(root, "missing.json")], () => {}, root)).toBe(2);
  });

  it("does not print malformed corpus contents when failing closed", async () => {
    const root = repository();
    const corpus = join(root, "private.json");
    const marker = "owner-private-marker";
    writeFileSync(corpus, `{broken:${marker}`);
    const output: string[] = [];
    expect(await runPrivacyPolicy(["--known-values", corpus], output.push.bind(output), root)).toBe(2);
    expect(output.join("\n")).not.toContain(marker);
    expect(output.join("\n")).not.toContain(corpus);
  });

  it("checks known private values in commit author metadata", async () => {
    const root = repository();
    writeFileSync(join(root, "safe.txt"), "synthetic only\n");
    commit(root, "chore: synthetic baseline");
    const corpus = join(root, "corpus.json");
    writeFileSync(corpus, JSON.stringify(["dev@example.test"]));
    const output: string[] = [];
    expect(await runPrivacyPolicy(["--range", "--all", "--known-values", corpus], output.push.bind(output), root)).toBe(1);
    expect(output.join("\n")).not.toContain("dev@example.test");
  });

  it("scans annotated tag messages in a full-graph range", async () => {
    const root = repository();
    writeFileSync(join(root, "safe.txt"), "synthetic only\n");
    commit(root, "chore: synthetic baseline");
    Bun.spawnSync(["git", "-C", root, "tag", "-a", "v1.0.0", "-m", syntheticAccount]);
    expect(await runPrivacyPolicy(["--range", "--all"], () => {}, root)).toBe(1);
  });

  it("scans standalone commit-message text", async () => {
    const root = repository();
    expect(await runPrivacyPolicy(["--message", syntheticAccount], () => {}, root)).toBe(1);
  });

  it("refuses message content disguised as binary evidence", async () => {
    const root = repository();
    expect(await runPrivacyPolicy(["--message", `%PDF-1.7\n${syntheticAccount}`], () => {}, root)).toBe(1);
  });

  it("checks known values in filenames and redacts the path", async () => {
    const root = repository();
    const privateValue = "owner-only-filename-marker";
    writeFileSync(join(root, `${privateValue}.txt`), "synthetic only\n");
    commit(root, "chore: synthetic baseline");
    const corpus = join(root, "corpus.json");
    writeFileSync(corpus, JSON.stringify([privateValue]));
    const output: string[] = [];
    expect(await runPrivacyPolicy(["--known-values", corpus], output.push.bind(output), root)).toBe(1);
    expect(output.join("\n")).not.toContain(privateValue);
  });

  it("rejects new documentation evidence binaries but permits public app assets", async () => {
    const root = repository();
    mkdirSync(join(root, "docs", "assets"), { recursive: true });
    mkdirSync(join(root, "packages", "web", "public"), { recursive: true });
    writeFileSync(join(root, "docs", "assets", "evidence.png"), new Uint8Array([0, 1, 2, 3]));
    writeFileSync(join(root, "packages", "web", "public", "icon.png"), new Uint8Array([0, 1, 2, 3]));
    Bun.spawnSync(["git", "-C", root, "add", "-A"]);

    expect(await runPrivacyPolicy(["--staged"], () => {}, root)).toBe(1);
  });

  it("does not confuse a filename suffix with an allowed app-icon path", async () => {
    const root = repository();
    mkdirSync(join(root, "packages", "web", "public"), { recursive: true });
    writeFileSync(join(root, "packages", "web", "public", "icon-192.png @ evidence.png"), new Uint8Array([0, 1, 2, 3]));
    Bun.spawnSync(["git", "-C", root, "add", "-A"]);
    expect(await runPrivacyPolicy(["--staged"], () => {}, root)).toBe(1);
  });

  it("rejects a tracked evidence binary in the default verification mode", async () => {
    const root = repository();
    writeFileSync(join(root, "statement.png"), new Uint8Array([0, 1, 2, 3]));
    commit(root, "test: synthetic binary");
    expect(await runPrivacyPolicy([], () => {}, root)).toBe(1);
  });
});
