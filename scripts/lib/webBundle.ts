/**
 * Initial-JavaScript budget for the web app (§3f) — pure rules.
 *
 * **What is measured, and why it is a GRAPH and not a filename.** The number that decides how
 * long a phone stares at a blank screen is not "the biggest chunk": it is every byte of
 * JavaScript the browser must download, parse and execute before the first render. Vite emits
 * a build manifest describing exactly that graph — for each chunk, its `imports` (STATIC edges,
 * fetched as modulepreload/import alongside the entry) and its `dynamicImports` (fetched only
 * when the `import()` actually runs). So the budget starts at the HTML entry, follows static
 * edges transitively, de-duplicates by chunk and sums real file bytes. Moving eager code into a
 * `vendor` chunk therefore buys nothing: the vendor chunk is a static import of the entry and
 * lands in the same closure. Only genuinely dynamic-import-only chunks (the locale files, the
 * lazy screens) fall outside it.
 *
 * **Two ceilings, both absolute** (decided 2026-08-10, do not move them): the closure is at most
 * `RAW_BYTE_LIMIT` on disk and `GZIP_BYTE_LIMIT` compressed. The gzip ceiling is the tighter of
 * the flat 170,000 target and "20% below the reviewed 209.14 kB baseline" = 167,312.
 *
 * **Compression is pinned, not borrowed from the platform.** `gzip(1)` output varies by
 * implementation and version, and even zlib's own defaults are a moving target across releases;
 * a budget whose verdict depends on which machine ran it is not a budget. Every option that
 * affects the byte count is stated explicitly in `GZIP_OPTIONS`, at the level the reviewed
 * baseline was measured with, so the comparison is like-for-like.
 *
 * Everything here is PURE — manifest text and a byte reader come from the caller. The real
 * tree is walked by `scripts/check-web-bundle.ts`; `webBundle.test.ts` drives the traversal
 * with fixtures for shared dependencies, cycles, duplicate imports, dynamic-only chunks,
 * missing assets and malformed manifests.
 */
import { gzipSync, constants as zlibConstants } from "node:zlib";

/** Build manifest, relative to the repository root. Emitted by `build.manifest: true`. */
export const MANIFEST_PATH = "packages/web/dist/.vite/manifest.json";

/** Build output directory the manifest's `file` paths are relative to. */
export const DIST_DIR = "packages/web/dist";

/**
 * Ceilings for the initial static JS closure, in bytes. DECIDED — a failing build is fixed by
 * moving code behind a dynamic import, never by raising a number here.
 */
export const RAW_BYTE_LIMIT = 500_000;
export const GZIP_BYTE_LIMIT = 167_312;

/**
 * Deterministic gzip settings. Level 6 is zlib's historical default and the basis the reviewed
 * baseline (209.14 kB) was measured on, so the 20%-below ceiling compares like with like;
 * `memLevel`/`strategy`/`windowBits` are spelled out because they change the byte count too and
 * a future zlib default must not silently move the budget.
 */
export const GZIP_OPTIONS = {
  level: 6,
  memLevel: 8,
  windowBits: 15,
  strategy: zlibConstants.Z_DEFAULT_STRATEGY,
} as const;

/** One record of a Vite build manifest, narrowed to the fields the budget depends on. */
export type ManifestChunk = Readonly<{
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  /** STATIC imports — manifest keys. These are what the closure follows. */
  imports?: readonly string[];
  /** `import()` edges — manifest keys. Deliberately NOT followed. */
  dynamicImports?: readonly string[];
}>;

export type ViteManifest = Readonly<Record<string, ManifestChunk>>;

/** A manifest that cannot be trusted to answer "what loads first" — always fatal, never a warning. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** One chunk inside the initial closure, with its measured size. */
export type Contributor = Readonly<{
  /** Manifest key — the SOURCE module, which is what a human needs to act on. */
  key: string;
  /** Emitted file, relative to the dist directory. */
  file: string;
  rawBytes: number;
  gzipBytes: number;
}>;

export type BudgetTotals = Readonly<{ rawBytes: number; gzipBytes: number }>;

export type BudgetLimits = Readonly<{ rawBytes: number; gzipBytes: number }>;

export const DEFAULT_LIMITS: BudgetLimits = { rawBytes: RAW_BYTE_LIMIT, gzipBytes: GZIP_BYTE_LIMIT };

export type BudgetReport = Readonly<{
  contributors: readonly Contributor[];
  totals: BudgetTotals;
  limits: BudgetLimits;
  /** Empty ⇔ the budget holds. */
  violations: readonly string[];
}>;

/** Extensions that count as JavaScript. `.css`/`.html`/images are not part of the JS budget. */
const JS_FILE = /\.(?:js|mjs|cjs)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEdgeList(key: string, field: "imports" | "dynamicImports", raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`manifest record ${JSON.stringify(key)} has a non-array \`${field}\``);
  for (const edge of raw) {
    if (typeof edge !== "string") throw new ManifestError(`manifest record ${JSON.stringify(key)} has a non-string entry in \`${field}\``);
  }
  return raw as readonly string[];
}

/**
 * Parse + validate a Vite manifest. Every shape problem is fatal: a manifest we cannot read
 * exactly means we do not know what the browser loads, and "assume it is fine" is how a budget
 * silently stops being enforced.
 */
export function parseManifest(text: string): ViteManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`manifest is not valid JSON — ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new ManifestError("manifest root is not an object");

  const manifest: Record<string, ManifestChunk> = {};
  for (const [key, record] of Object.entries(parsed)) {
    if (!isPlainObject(record)) throw new ManifestError(`manifest record ${JSON.stringify(key)} is not an object`);
    const { file, isEntry } = record;
    if (typeof file !== "string" || file.length === 0) throw new ManifestError(`manifest record ${JSON.stringify(key)} has no \`file\``);
    if (isEntry !== undefined && typeof isEntry !== "boolean") throw new ManifestError(`manifest record ${JSON.stringify(key)} has a non-boolean \`isEntry\``);
    manifest[key] = {
      file,
      name: typeof record.name === "string" ? record.name : undefined,
      src: typeof record.src === "string" ? record.src : undefined,
      isEntry: isEntry === true,
      imports: readEdgeList(key, "imports", record.imports),
      dynamicImports: readEdgeList(key, "dynamicImports", record.dynamicImports),
    };
  }
  return manifest;
}

/**
 * The JS chunks the browser loads before anything the user does: every entry chunk plus the
 * transitive closure of its STATIC imports.
 *
 * The visited set is what makes this correct on a real graph — a diamond (two screens sharing a
 * component chunk) counts its shared chunk once, a duplicate edge counts once, and an import
 * cycle terminates instead of recursing forever.
 *
 * Returns manifest keys in stable sorted order so the printed report is diffable.
 */
export function initialJsClosure(manifest: ViteManifest): readonly string[] {
  const roots = Object.keys(manifest)
    .filter((key) => manifest[key]?.isEntry === true && JS_FILE.test(manifest[key]?.file ?? ""))
    .sort();
  if (roots.length === 0) throw new ManifestError("manifest declares no JavaScript entry chunk — nothing to measure");

  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (visited.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) throw new ManifestError(`manifest references unknown chunk ${JSON.stringify(key)}`);
    visited.add(key);
    for (const next of chunk.imports ?? []) {
      if (!(next in manifest)) throw new ManifestError(`chunk ${JSON.stringify(key)} statically imports unknown chunk ${JSON.stringify(next)}`);
      if (!visited.has(next)) queue.push(next);
    }
  }
  // A static import edge can point at a non-JS asset record in exotic setups; the budget is
  // about JavaScript, so filter at the end rather than pruning the walk (a CSS record could
  // still sit between two JS chunks).
  return [...visited].filter((key) => JS_FILE.test(manifest[key]?.file ?? "")).sort();
}

/** Compressed size under the pinned settings. Exported so the CLI and the tests share one answer. */
export function gzipByteLength(data: Uint8Array): number {
  return gzipSync(data, GZIP_OPTIONS).byteLength;
}

/**
 * Size every chunk of the closure. `read` returns the file's bytes, or `null` when the manifest
 * names a file the build did not emit — which is fatal: a budget computed over a partial dist
 * would report a comfortable number for an app that cannot even boot.
 */
export function measureClosure(manifest: ViteManifest, keys: readonly string[], read: (file: string) => Uint8Array | null): readonly Contributor[] {
  const contributors: Contributor[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const chunk = manifest[key];
    if (!chunk) throw new ManifestError(`manifest references unknown chunk ${JSON.stringify(key)}`);
    const data = read(chunk.file);
    if (data === null) {
      missing.push(chunk.file);
      continue;
    }
    contributors.push({ key, file: chunk.file, rawBytes: data.byteLength, gzipBytes: gzipByteLength(data) });
  }
  if (missing.length > 0) throw new ManifestError(`manifest names ${missing.length} file(s) missing from the build output: ${missing.sort().join(", ")}`);
  // Largest first: the report's job is to name what to split next.
  return contributors.sort((a, b) => b.rawBytes - a.rawBytes || a.key.localeCompare(b.key));
}

/** Sum + verdict. Both ceilings are checked independently; the report names every breach. */
export function evaluateBudget(contributors: readonly Contributor[], limits: BudgetLimits = DEFAULT_LIMITS): BudgetReport {
  const totals: BudgetTotals = {
    rawBytes: contributors.reduce((sum, c) => sum + c.rawBytes, 0),
    gzipBytes: contributors.reduce((sum, c) => sum + c.gzipBytes, 0),
  };
  const violations: string[] = [];
  if (totals.rawBytes > limits.rawBytes) {
    violations.push(`initial static JS is ${totals.rawBytes} raw bytes, over the ${limits.rawBytes} limit by ${totals.rawBytes - limits.rawBytes}`);
  }
  if (totals.gzipBytes > limits.gzipBytes) {
    violations.push(`initial static JS is ${totals.gzipBytes} gzip bytes, over the ${limits.gzipBytes} limit by ${totals.gzipBytes - limits.gzipBytes}`);
  }
  return { contributors, totals, limits, violations };
}

/** Decimal kB, the same unit Vite's own build report prints — so the two are directly comparable. */
function kb(bytes: number): string {
  return `${(bytes / 1000).toFixed(2)} kB`;
}

/**
 * The report is printed on EVERY run, pass or fail: the moment it only appears on failure,
 * nobody notices the closure creeping from 380 kB to 499 kB across a dozen green PRs.
 */
export function formatReport(report: BudgetReport): string {
  const lines: string[] = [];
  const keyWidth = Math.max(20, ...report.contributors.map((c) => c.key.length));
  lines.push(`initial static JS closure — ${report.contributors.length} chunk(s), largest first:`);
  for (const c of report.contributors) {
    lines.push(`  ${c.key.padEnd(keyWidth)}  ${kb(c.rawBytes).padStart(10)}  gzip ${kb(c.gzipBytes).padStart(10)}  ${c.file}`);
  }
  lines.push(`  ${"TOTAL".padEnd(keyWidth)}  ${kb(report.totals.rawBytes).padStart(10)}  gzip ${kb(report.totals.gzipBytes).padStart(10)}`);
  lines.push(`  limits: raw ${report.totals.rawBytes}/${report.limits.rawBytes} bytes, gzip ${report.totals.gzipBytes}/${report.limits.gzipBytes} bytes`);
  if (report.violations.length > 0) {
    for (const violation of report.violations) lines.push(`  OVER BUDGET: ${violation}`);
  } else {
    const rawLeft = report.limits.rawBytes - report.totals.rawBytes;
    const gzipLeft = report.limits.gzipBytes - report.totals.gzipBytes;
    lines.push(`  OK — ${rawLeft} raw bytes and ${gzipLeft} gzip bytes of headroom`);
  }
  return lines.join("\n");
}
