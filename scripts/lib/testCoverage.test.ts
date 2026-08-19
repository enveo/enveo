/**
 * A test the runner never looks at is decoration, and nothing said so out loud: three suites
 * under `web/src/screens` and one under `web/src/components` sat outside `TEST_PATHS`, and the
 * Settings information-architecture suite among them had been RED since 3.10.0 without failing a
 * single gate. This asserts the property directly — every directory that holds a `*.test.ts` is
 * covered by a `TEST_PATHS` entry — so adding a suite in a new corner of the repo fails here
 * instead of silently never running.
 */
import { describe, expect, it } from "bun:test";
import { TEST_PATHS } from "../run-tests";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

async function testFileDirectories(): Promise<string[]> {
  const found = new Set<string>();
  for await (const file of new Bun.Glob("**/*.test.ts").scan({ cwd: REPO_ROOT, onlyFiles: true })) {
    if (file.includes("node_modules/")) continue;
    found.add(file.slice(0, file.lastIndexOf("/")));
  }
  return [...found].sort();
}

describe("every test file lives under a path the runner scans", () => {
  it("has no suite outside TEST_PATHS", async () => {
    const uncovered = (await testFileDirectories()).filter((dir) => !TEST_PATHS.some((root) => dir === root || dir.startsWith(`${root}/`)));
    expect(uncovered).toEqual([]);
  });

  it("names only roots that actually hold suites — a renamed directory would scan nothing", async () => {
    for (const root of TEST_PATHS) {
      const suites = await Array.fromAsync(new Bun.Glob("**/*.test.ts").scan({ cwd: `${REPO_ROOT}/${root}`, onlyFiles: true }));
      expect({ root, suites: suites.length > 0 }).toEqual({ root, suites: true });
    }
  });
});
