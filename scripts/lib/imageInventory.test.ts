/**
 * Pure tests for the runtime image contract (§3e).
 *
 * These pin the RULES. The rules are applied to a real built image by
 * `bun run image:inventory <ref>`, which CI runs after `docker build`.
 */
import { describe, expect, it } from "bun:test";
import { checkImage, packageNameOfStoreEntry, type Expectations, type ImageFacts } from "./imageInventory";

const MIGRATIONS = ["0000_rainy_wraith.sql", "0001_add_txn_tag.sql"] as const;

const OK_FILES = [
  "package.json",
  "packages/api/package.json",
  "packages/shared/package.json",
  "packages/api/src/index.ts",
  "packages/api/src/db/migrate.ts",
  "packages/shared/src/index.ts",
  "packages/api/drizzle/meta/_journal.json",
  ...MIGRATIONS.map((m) => `packages/api/drizzle/${m}`),
  "packages/web/dist/index.html",
  "packages/web/dist/sw.js",
  "packages/web/dist/manifest.webmanifest",
];

const OK_STORE = ["hono@4.13.1", "drizzle-orm@0.45.2+abc", "postgres@3.4.9", "better-auth@1.6.26+x", "zod@3.25.76"];

const facts = (overrides: Partial<ImageFacts> = {}): ImageFacts => ({
  appFiles: OK_FILES,
  storeEntries: OK_STORE,
  configUser: "bun",
  effectiveUid: 1000,
  appWritable: false,
  labels: {
    "org.opencontainers.image.source": "https://github.com/enveo/enveo",
    "org.opencontainers.image.revision": "abc1234",
  },
  entrypoint: ["/usr/local/bin/enveo-entrypoint"],
  buildStampSha: "abc1234",
  nativeBinaries: [],
  unresolvableImports: [],
  bunVersion: "1.3.14",
  // Recorded for the audit trail only — no rule reads it, so the value here is illustrative.
  osPackages: ["libcrypto3-3.5.7-r0", "libssl3-3.5.7-r0", "musl-1.2.5-r10"],
  ...overrides,
});

const expectations = (overrides: Partial<Expectations> = {}): Expectations => ({
  migrations: MIGRATIONS,
  sourceCommit: "abc1234",
  bunVersion: "1.3.14",
  ...overrides,
});

describe("packageNameOfStoreEntry", () => {
  it("strips the version and the resolution hash", () => {
    expect(packageNameOfStoreEntry("better-auth@1.6.26+cbc1f5e9b6df5b1d")).toBe("better-auth");
  });

  it("restores the slash in a scoped name", () => {
    expect(packageNameOfStoreEntry("@esbuild+linux-x64@0.28.2")).toBe("@esbuild/linux-x64");
  });
});

describe("checkImage — a compliant image", () => {
  it("reports no violations", () => {
    expect(checkImage(facts(), expectations())).toEqual([]);
  });
});

describe("checkImage — the runtime allowlist", () => {
  it("fails when the API entry point is missing", () => {
    const missing = OK_FILES.filter((f) => f !== "packages/api/src/index.ts");

    expect(checkImage(facts({ appFiles: missing }), expectations()).join(" ")).toContain("packages/api/src/index.ts");
  });

  it("fails when the migration journal is missing — migration ORDER comes from it", () => {
    const missing = OK_FILES.filter((f) => !f.endsWith("_journal.json"));

    expect(checkImage(facts({ appFiles: missing }), expectations()).join(" ")).toContain("_journal.json");
  });

  it("fails when the drizzle tree arrived incomplete", () => {
    const missing = OK_FILES.filter((f) => !f.endsWith("0001_add_txn_tag.sql"));

    expect(checkImage(facts({ appFiles: missing }), expectations()).join(" ")).toContain("0001_add_txn_tag.sql");
  });

  it("fails when a PWA asset is missing", () => {
    const missing = OK_FILES.filter((f) => !f.endsWith("sw.js"));

    expect(checkImage(facts({ appFiles: missing }), expectations()).join(" ")).toContain("sw.js");
  });

  it("fails when a package the API imports was pruned away", () => {
    const pruned = OK_STORE.filter((e) => !e.startsWith("hono@"));

    expect(checkImage(facts({ storeEntries: pruned }), expectations()).join(" ")).toContain("required runtime package not installed: hono");
  });
});

describe("checkImage — the denylist", () => {
  // Every one of these SHIPPED before the rule was widened from `*.test.ts` to `.test` +
  // separator. `sync.replace-recurrence.test-child.ts` wipes and re-inserts a budget's rows.
  it.each([
    ["packages/shared/src/ledger.test-support.ts", "shared test helpers (imports fast-check)"],
    ["packages/api/src/api.test-support.ts", "API test helpers"],
    ["packages/api/src/auth.signup-race.test-child.ts", "spawned DB test child"],
    ["packages/api/src/context.budget-init.test-child.ts", "spawned DB test child"],
    ["packages/api/src/db/operationLock.serialization.test-child.ts", "spawned DB test child"],
    ["packages/api/src/routes/sync.first-use-barrier.test-child.ts", "spawned DB test child"],
    ["packages/api/src/routes/sync.replace-recurrence.test-child.ts", "spawned DB test child that WIPES rows"],
  ])("rejects the test-support module %s", (path) => {
    expect(checkImage(facts({ appFiles: [...OK_FILES, path] }), expectations()).join(" ")).toContain(path);
  });

  it("does not reject a production module whose name merely contains the word test", () => {
    // `latest.ts` / `attestation.ts` must survive: the rule keys on `.test` + a separator.
    const innocent = [...OK_FILES, "packages/api/src/routes/latest.ts", "packages/api/src/attestation.ts"];

    expect(checkImage(facts({ appFiles: innocent }), expectations())).toEqual([]);
  });

  it.each([
    ["packages/api/src/context.test.ts", "test file"],
    ["packages/web/src/App.tsx", "web source"],
    ["scripts/audit.ts", "repository tooling"],
    ["docs/hosting.md", "repository metadata"],
    ["README.md", "documentation"],
    [".env", "environment file"],
    ["bun.lock", "build inputs"],
    ["packages/web/dist/assets/index-abc.js.map", "source map"],
  ])("rejects %s", (path) => {
    expect(checkImage(facts({ appFiles: [...OK_FILES, path] }), expectations()).join(" ")).toContain(path);
  });

  it("ignores a dependency's OWN bundled test files — zod publishes src/**/tests/*.test.ts", () => {
    const withVendorTests = [...OK_FILES, "node_modules/.bun/zod@4.4.3/node_modules/zod/src/v3/tests/string.test.ts"];

    expect(checkImage(facts({ appFiles: withVendorTests }), expectations())).toEqual([]);
  });

  it("still rejects an Enveo test file that merely mentions node_modules in its path", () => {
    const sneaky = [...OK_FILES, "packages/api/src/node_modules_helper.test.ts"];

    expect(checkImage(facts({ appFiles: sneaky }), expectations()).join(" ")).toContain("node_modules_helper.test.ts");
  });

  it.each(["vite@7.3.6", "typescript@5.6.3", "drizzle-kit@0.31.10", "fast-check@3.23.1", "esbuild@0.25.12", "react@18.3.1", "tsx@4.23.12"])(
    "rejects the dev/build package %s",
    (entry) => {
      const withDev = [...OK_STORE, entry];

      expect(checkImage(facts({ storeEntries: withDev }), expectations()).join(" ")).toContain(entry);
    },
  );
});

describe("checkImage — no native binaries (the two-base safety property)", () => {
  it("rejects a native addon copied forward from the glibc build stage", () => {
    const withAddon = facts({
      nativeBinaries: ["node_modules/.bun/sharp@0.35.3/node_modules/sharp/build/Release/sharp.node"],
    });

    expect(checkImage(withAddon, expectations()).join(" ")).toContain("native ELF binary");
  });

  it("rejects a bare ELF helper with no telling file extension", () => {
    // esbuild's binary is exactly this shape — no extension, pure ELF.
    const withHelper = facts({ nativeBinaries: ["node_modules/.bun/esbuild@0.25.12/bin/esbuild"] });

    expect(checkImage(withHelper, expectations()).join(" ")).toContain("must stay pure JavaScript");
  });

  it("passes when the closure is pure JavaScript", () => {
    expect(checkImage(facts({ nativeBinaries: [] }), expectations())).toEqual([]);
  });
});

describe("checkImage — every shipped module can load", () => {
  it("rejects a shipped module importing a package the prune removed", () => {
    // The name-independent backstop: this fires whatever the file is called.
    const broken = facts({
      unresolvableImports: ["packages/shared/src/ledger.test-support.ts -> fast-check"],
    });

    expect(checkImage(broken, expectations()).join(" ")).toContain("cannot resolve");
  });

  it("names the file and the specifier so the fix is obvious", () => {
    const broken = facts({ unresolvableImports: ["packages/api/src/x.ts -> drizzle-kit"] });

    expect(checkImage(broken, expectations()).join(" ")).toContain("packages/api/src/x.ts -> drizzle-kit");
  });
});

describe("checkImage — the base digest really is the pinned version", () => {
  it("rejects an image whose Bun differs from .bun-version", () => {
    // A Bun bump that pastes a stale or wrong-tag digest passes every text-vs-text check;
    // only asking the IMAGE catches it.
    const stale = facts({ bunVersion: "1.3.9" });

    expect(checkImage(stale, expectations({ bunVersion: "1.3.14" })).join(" ")).toContain("image runs Bun 1.3.9, but .bun-version pins 1.3.14");
  });

  it("passes when the image reports exactly the pinned version", () => {
    expect(checkImage(facts({ bunVersion: "1.3.14" }), expectations({ bunVersion: "1.3.14" }))).toEqual([]);
  });
});

describe("checkImage — unprivileged runtime", () => {
  it("rejects an image with no USER", () => {
    expect(checkImage(facts({ configUser: "" }), expectations()).join(" ")).toContain("runs as root");
  });

  it("rejects an explicit root USER", () => {
    expect(checkImage(facts({ configUser: "root" }), expectations()).join(" ")).toContain("runs as root");
  });

  it("rejects uid 0 measured inside the container", () => {
    expect(checkImage(facts({ effectiveUid: 0 }), expectations()).join(" ")).toContain("uid inside the container is 0");
  });

  it("rejects a writable /app — the app must not be able to rewrite its own code", () => {
    expect(checkImage(facts({ appWritable: true }), expectations()).join(" ")).toContain("/app is writable");
  });

  it("rejects a missing ENTRYPOINT", () => {
    expect(checkImage(facts({ entrypoint: [] }), expectations()).join(" ")).toContain("no ENTRYPOINT");
  });
});

describe("checkImage — release metadata", () => {
  it("requires the OCI source label", () => {
    expect(checkImage(facts({ labels: { "org.opencontainers.image.revision": "abc1234" } }), expectations()).join(" ")).toContain("image.source");
  });

  it("requires the OCI revision label to equal the passed SHA", () => {
    const wrong = { "org.opencontainers.image.source": "s", "org.opencontainers.image.revision": "0000000" };

    expect(checkImage(facts({ labels: wrong }), expectations()).join(" ")).toContain("OCI revision label");
  });

  it("requires the web build stamp to equal the SAME passed SHA", () => {
    expect(checkImage(facts({ buildStampSha: "0000000" }), expectations()).join(" ")).toContain("build stamp sha");
  });

  it("skips both metadata checks when the build passed no SHA (plain local build)", () => {
    const noSha = facts({ buildStampSha: "", labels: { "org.opencontainers.image.source": "s", "org.opencontainers.image.revision": "" } });

    expect(checkImage(noSha, expectations({ sourceCommit: null }))).toEqual([]);
  });
});
