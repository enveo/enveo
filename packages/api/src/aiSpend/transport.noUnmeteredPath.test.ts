/**
 * There is exactly ONE operator-key path (backlog §1): every route reaches OpenAI through the
 * metered transport. This source gate fails when any module outside the allowlist references
 * the raw `openAiChatFetch` — a new/compatibility route quietly importing it would bypass the
 * spend check and record no cost, which no runtime test would notice on selfhost defaults.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("..", import.meta.url).pathname; // packages/api/src

/** Modules allowed to name the raw fetch: its home, the metered wrapper, and their tests. */
const ALLOWED = new Set([
  "openaiHttp.ts", // defines it
  "openaiHttp.test.ts", // tests it
  "aiSpend/transport.ts", // the ONE metered wrapper
  "aiSpend/transport.test.ts",
  "aiSpend/transport.noUnmeteredPath.test.ts", // this gate
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

describe("no unmetered raw operator transport path", () => {
  it("only the metered transport (and openaiHttp's own home/tests) references openAiChatFetch", () => {
    const offenders = walk(SRC)
      .filter((p) => readFileSync(p, "utf8").includes("openAiChatFetch"))
      .map((p) => p.slice(SRC.length))
      .filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  it("the allowlist itself stays honest (files exist; home and wrapper do reference the symbol)", () => {
    for (const rel of ALLOWED) {
      expect(statSync(join(SRC, rel)).isFile()).toBe(true); // a renamed file must shrink the list
    }
    for (const rel of ["openaiHttp.ts", "aiSpend/transport.ts"]) {
      expect(readFileSync(join(SRC, rel), "utf8").includes("openAiChatFetch")).toBe(true);
    }
  });
});
