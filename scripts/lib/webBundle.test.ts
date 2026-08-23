/**
 * The initial-JS budget rules (§3f).
 *
 * Same shape as sourcePolicy.test.ts: `describe` blocks pin the PURE traversal and verdict
 * against synthetic manifests — shared dependencies, cycles, duplicate edges, dynamic-only
 * chunks, missing assets, malformed input — and a final block runs them over the REAL build
 * output when one is present, so a developer who has just built sees the same answer the gate
 * gives. The runnable gate is `bun run bundle:budget`; these tests cover the rules without a
 * subprocess.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  DIST_DIR,
  evaluateBudget,
  formatReport,
  GZIP_BYTE_LIMIT,
  gzipByteLength,
  initialJsClosure,
  MANIFEST_PATH,
  ManifestError,
  measureClosure,
  parseManifest,
  RAW_BYTE_LIMIT,
  type ViteManifest,
} from "./webBundle";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Terse manifest builder — every fixture below is one literal, so the graph stays readable. */
const chunk = (file: string, extra: Partial<{ isEntry: boolean; imports: string[]; dynamicImports: string[] }> = {}) => JSON.stringify({ file, ...extra });

const manifestOf = (records: Record<string, string>): ViteManifest =>
  parseManifest(
    `{${Object.entries(records)
      .map(([key, value]) => `${JSON.stringify(key)}:${value}`)
      .join(",")}}`,
  );

/** Byte source for `measureClosure` — a map from emitted file to its content. */
const readerOf =
  (files: Record<string, string>) =>
  (file: string): Uint8Array | null =>
    file in files ? new TextEncoder().encode(files[file]) : null;

describe("initialJsClosure", () => {
  it("starts at the HTML entry and follows static imports transitively", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/core.ts"] }),
      "src/core.ts": chunk("assets/core.js", { imports: ["src/deep.ts"] }),
      "src/deep.ts": chunk("assets/deep.js"),
    });
    expect(initialJsClosure(manifest)).toEqual(["index.html", "src/core.ts", "src/deep.ts"]);
  });

  it("counts a SHARED dependency of two branches exactly once", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/left.ts", "src/right.ts"] }),
      "src/left.ts": chunk("assets/left.js", { imports: ["src/shared.ts"] }),
      "src/right.ts": chunk("assets/right.js", { imports: ["src/shared.ts"] }),
      "src/shared.ts": chunk("assets/shared.js"),
    });
    const closure = initialJsClosure(manifest);
    expect(closure).toEqual(["index.html", "src/left.ts", "src/right.ts", "src/shared.ts"]);
    expect(closure.filter((key) => key === "src/shared.ts")).toHaveLength(1);
  });

  it("terminates on an import CYCLE instead of recursing forever", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/a.ts"] }),
      "src/a.ts": chunk("assets/a.js", { imports: ["src/b.ts"] }),
      "src/b.ts": chunk("assets/b.js", { imports: ["src/a.ts"] }),
    });
    expect(initialJsClosure(manifest)).toEqual(["index.html", "src/a.ts", "src/b.ts"]);
  });

  it("de-duplicates a repeated edge to the same chunk", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/dup.ts", "src/dup.ts"] }),
      "src/dup.ts": chunk("assets/dup.js"),
    });
    expect(initialJsClosure(manifest)).toEqual(["index.html", "src/dup.ts"]);
  });

  it("EXCLUDES dynamic-import-only chunks and everything reachable only through them", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/eager.ts"], dynamicImports: ["src/Reports.tsx"] }),
      "src/eager.ts": chunk("assets/eager.js"),
      "src/Reports.tsx": chunk("assets/Reports.js", { imports: ["src/charts.ts"] }),
      "src/charts.ts": chunk("assets/charts.js"),
    });
    expect(initialJsClosure(manifest)).toEqual(["index.html", "src/eager.ts"]);
  });

  it("still counts a chunk that is BOTH dynamically and statically imported — the static edge wins", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/mutate.ts"], dynamicImports: ["src/mutate.ts"] }),
      "src/mutate.ts": chunk("assets/mutate.js"),
    });
    expect(initialJsClosure(manifest)).toContain("src/mutate.ts");
  });

  it("walks EVERY entry chunk, not just the first", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true }),
      "sw.ts": chunk("assets/sw.js", { isEntry: true, imports: ["src/worker.ts"] }),
      "src/worker.ts": chunk("assets/worker.js"),
    });
    expect(initialJsClosure(manifest)).toEqual(["index.html", "src/worker.ts", "sw.ts"]);
  });

  it("ignores non-JavaScript records — the budget is about scripts", () => {
    const manifest = manifestOf({
      "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/style.css"] }),
      "src/style.css": chunk("assets/style.css"),
    });
    expect(initialJsClosure(manifest)).toEqual(["index.html"]);
  });

  it("fails closed when a static import names a chunk the manifest does not describe", () => {
    const manifest = manifestOf({ "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/ghost.ts"] }) });
    expect(() => initialJsClosure(manifest)).toThrow(ManifestError);
    expect(() => initialJsClosure(manifest)).toThrow(/statically imports unknown chunk "src\/ghost\.ts"/);
  });

  it("fails closed when there is no JavaScript entry at all", () => {
    expect(() => initialJsClosure(manifestOf({ "src/orphan.ts": chunk("assets/orphan.js") }))).toThrow(/no JavaScript entry chunk/);
  });
});

describe("parseManifest", () => {
  it("rejects text that is not JSON", () => {
    expect(() => parseManifest("{oops")).toThrow(/not valid JSON/);
  });

  it("rejects a non-object root", () => {
    expect(() => parseManifest("[]")).toThrow(/root is not an object/);
    expect(() => parseManifest("null")).toThrow(/root is not an object/);
  });

  it("rejects a record that is not an object", () => {
    expect(() => parseManifest('{"index.html": "assets/index.js"}')).toThrow(/is not an object/);
  });

  it("rejects a record with no `file`", () => {
    expect(() => parseManifest('{"index.html": {"isEntry": true}}')).toThrow(/has no `file`/);
    expect(() => parseManifest('{"index.html": {"file": ""}}')).toThrow(/has no `file`/);
  });

  it("rejects a non-array `imports` and a non-string edge", () => {
    expect(() => parseManifest('{"a": {"file": "a.js", "imports": "b"}}')).toThrow(/non-array `imports`/);
    expect(() => parseManifest('{"a": {"file": "a.js", "imports": [7]}}')).toThrow(/non-string entry in `imports`/);
  });

  it("rejects a non-boolean `isEntry` rather than coercing it", () => {
    expect(() => parseManifest('{"a": {"file": "a.js", "isEntry": "yes"}}')).toThrow(/non-boolean `isEntry`/);
  });

  it("normalises absent edge lists to empty arrays", () => {
    const manifest = parseManifest('{"a": {"file": "a.js", "isEntry": true}}');
    expect(manifest.a?.imports).toEqual([]);
    expect(manifest.a?.dynamicImports).toEqual([]);
  });
});

describe("measureClosure", () => {
  const manifest = manifestOf({
    "index.html": chunk("assets/index.js", { isEntry: true, imports: ["src/small.ts"] }),
    "src/small.ts": chunk("assets/small.js"),
  });

  it("reports real bytes per chunk, largest first", () => {
    const read = readerOf({ "assets/index.js": "x".repeat(300), "assets/small.js": "y".repeat(20) });
    const contributors = measureClosure(manifest, initialJsClosure(manifest), read);
    expect(contributors.map((c) => c.key)).toEqual(["index.html", "src/small.ts"]);
    expect(contributors[0]).toMatchObject({ file: "assets/index.js", rawBytes: 300 });
    expect(contributors[1]).toMatchObject({ file: "assets/small.js", rawBytes: 20 });
  });

  it("fails closed when the manifest names a file the build did not emit", () => {
    const read = readerOf({ "assets/index.js": "x" });
    expect(() => measureClosure(manifest, initialJsClosure(manifest), read)).toThrow(ManifestError);
    expect(() => measureClosure(manifest, initialJsClosure(manifest), read)).toThrow(/missing from the build output: assets\/small\.js/);
  });

  it("gzips deterministically — the same bytes always give the same size", () => {
    const data = new TextEncoder().encode("enveo".repeat(500));
    expect(gzipByteLength(data)).toBe(gzipByteLength(data));
    expect(gzipByteLength(data)).toBeLessThan(data.byteLength);
  });
});

describe("evaluateBudget", () => {
  const contributor = (key: string, rawBytes: number, gzipBytes: number) => ({ key, file: `assets/${key}.js`, rawBytes, gzipBytes });

  it("passes under both ceilings and reports headroom", () => {
    const report = evaluateBudget([contributor("a", 100, 40), contributor("b", 50, 20)]);
    expect(report.totals).toEqual({ rawBytes: 150, gzipBytes: 60 });
    expect(report.violations).toEqual([]);
    expect(formatReport(report)).toContain("OK —");
  });

  it("flags the RAW ceiling on its own", () => {
    const report = evaluateBudget([contributor("a", RAW_BYTE_LIMIT + 1, 10)]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("raw bytes");
    expect(report.violations[0]).toContain("over the 500000 limit by 1");
  });

  it("flags the GZIP ceiling on its own", () => {
    const report = evaluateBudget([contributor("a", 10, GZIP_BYTE_LIMIT + 1)]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("gzip bytes");
  });

  it("flags both ceilings independently", () => {
    expect(evaluateBudget([contributor("a", RAW_BYTE_LIMIT + 1, GZIP_BYTE_LIMIT + 1)]).violations).toHaveLength(2);
  });

  it("pins the DECIDED ceilings — moving one is a product decision, not a build fix", () => {
    expect(DEFAULT_LIMITS).toEqual({ rawBytes: 500_000, gzipBytes: 167_312 });
  });

  it("prints the contributor table on a PASSING run too, so creep is visible", () => {
    const text = formatReport(evaluateBudget([contributor("a", 100, 40)]));
    expect(text).toContain("initial static JS closure — 1 chunk(s)");
    expect(text).toContain("assets/a.js");
    expect(text).toContain("TOTAL");
  });
});

describe("the real build output", () => {
  const manifestFile = join(REPO_ROOT, MANIFEST_PATH);

  it.skipIf(!existsSync(manifestFile))("stays inside both ceilings", () => {
    const manifest = parseManifest(readFileSync(manifestFile, "utf8"));
    const contributors = measureClosure(manifest, initialJsClosure(manifest), (file) => {
      const path = join(REPO_ROOT, DIST_DIR, file);
      return existsSync(path) ? readFileSync(path) : null;
    });
    const report = evaluateBudget(contributors);
    expect(report.violations).toEqual([]);
  });

  it.skipIf(!existsSync(manifestFile))("keeps the lazy surfaces OUT of the initial closure", () => {
    const manifest = parseManifest(readFileSync(manifestFile, "utf8"));
    const closure = initialJsClosure(manifest);
    expect(manifest["src/screens/Budget.tsx"]).toBeDefined();
    for (const lazy of [
      "src/screens/Budget.tsx",
      "src/screens/Reports.tsx",
      "src/screens/Settings.tsx",
      "src/components/ImportSheet.tsx",
      "src/components/BudgetSuggestSheet.tsx",
    ]) {
      expect(closure).not.toContain(lazy);
    }
  });

  it("keeps Budget and its closed editor behind LazyChunk boundaries", () => {
    const app = readFileSync(join(REPO_ROOT, "packages", "web", "src", "App.tsx"), "utf8");
    expect(app).toContain('const BudgetScreen = lazy(() => import("./screens/Budget").then((m) => ({ default: m.BudgetScreen })));');
    expect(app).toContain('const EnvEdit = lazy(() => import("./screens/Budget").then((m) => ({ default: m.EnvEdit })));');
    expect(app).not.toContain('import { BudgetScreen, EnvEdit } from "./screens/Budget";');
    expect(app).toContain('{screen === "budget" && (\n        <LazyChunk onDismiss={() => nav("start")}>');
    expect(app).toContain('{envEdit && (\n          <LazyChunk variant="overlay" onDismiss={() => setEnvEdit(null)}>');
  });
});
