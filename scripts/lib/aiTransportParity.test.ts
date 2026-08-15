/**
 * Server↔browser parity of the AI transport timeout budget.
 *
 * The transports (packages/api/src/openaiHttp.ts — operator and vaulted BYOK;
 * packages/web/src/lib/openai.ts — the /api/ai mirror) once each kept a
 * private `120_000`, and the meanings drifted (the server's cap claimed to cover
 * vision while cutting it at chat speed). Since the AI-transport package the ONE
 * source of truth is @enveo/shared/aiTransport; this suite fails the build when a
 * side stops importing it or grows a hardcoded cap again.
 *
 * It also pins the WebKit<16 property: `AbortSignal.timeout` does not exist on
 * iOS 15 Safari, so NO transport file may use it — both build the same semantics
 * from AbortController + setTimeout (`timeoutSignal`).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/** Every module that opens an AI request with a timeout, on either side. */
const TRANSPORT_FILES = [
  "packages/api/src/openaiHttp.ts",
  "packages/web/src/lib/openai.ts",
  "packages/web/src/lib/api.ts",
  "packages/web/src/lib/timeoutSignal.ts",
];

describe("AI transport timeout parity (api ↔ web via @enveo/shared)", () => {
  it("the api transport takes its default cap from the shared constants", () => {
    const src = read("packages/api/src/openaiHttp.ts");
    expect(src).toContain('from "@enveo/shared"');
    expect(src).toContain("AI_CHAT_TIMEOUT_MS");
  });

  it("the web operator proxy takes its client cap from the shared constants", () => {
    const src = read("packages/web/src/lib/openai.ts");
    expect(src).toContain('from "@enveo/shared"');
    expect(src).toContain("AI_PROXY_CHAT_TIMEOUT_MS");
  });

  it("operator and vaulted-BYOK import share the server vision pipeline and the browser outwaits both cycles", () => {
    const importRoute = read("packages/api/src/routes/import.ts");
    const credentialRoute = read("packages/api/src/routes/aiCredentials.ts");
    const webApi = read("packages/web/src/lib/api.ts");
    expect(importRoute).toContain("AI_VISION_TIMEOUT_MS");
    expect(credentialRoute).toContain("extractImportForBudget");
    expect(credentialRoute).toContain("timeoutMs");
    expect(webApi.match(/AI_IMPORT_EXTRACT_TIMEOUT_MS/g)?.length).toBeGreaterThanOrEqual(3); // one import + both endpoint uses
  });

  it("no transport file hardcodes a timeout amount — the shared module is the only place the numbers exist", () => {
    for (const rel of [...TRANSPORT_FILES, "packages/api/src/routes/import.ts", "packages/api/src/routes/aiCredentials.ts"]) {
      const src = read(rel);
      expect(src).not.toMatch(/120[_ ]?000|300[_ ]?000/);
    }
  });

  it("no transport file uses AbortSignal.timeout — absent on WebKit < 16 (iOS 15 Safari)", () => {
    for (const rel of TRANSPORT_FILES) {
      expect(read(rel)).not.toContain("AbortSignal.timeout(");
    }
  });
});
