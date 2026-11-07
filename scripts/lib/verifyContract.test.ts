/**
 * `verify` (local, concurrent phases) and `verify:ci` (CI, sequential chain) are two spellings of
 * one gate in root package.json. Nothing else compares them, so a phase added to one would
 * silently be missing from the other.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const scripts: Record<string, string> = JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).scripts;

const PARALLEL_PREFIX = "bun run --parallel --no-exit-on-error ";
/** CI's stricter or DB-backed variant of a local phase. */
const CI_VARIANT: Record<string, string> = { lint: "lint:ci", test: "test:db" };
/** Phases only CI runs: they need the network or a throwaway PostgreSQL. */
const CI_ONLY = ["security:audit", "e2e"];

const verifyPhases = (): string[] => {
  const command = scripts.verify ?? "";
  expect(command.startsWith(PARALLEL_PREFIX)).toBe(true);
  return command.slice(PARALLEL_PREFIX.length).split(" ");
};

const ciPhases = (): string[] =>
  (scripts["verify:ci"] ?? "").split(" && ").map((step) => {
    expect(step.startsWith("bun run ")).toBe(true);
    return step.slice("bun run ".length);
  });

describe("the local and CI verification contracts", () => {
  it("runs local phases concurrently to completion, so every failing phase reports and fails verify", () => {
    // Bun's default fail-fast mode SIGINTs the sibling phases and exits 130, hiding which
    // phase failed with which code.
    expect(scripts.verify).toStartWith(PARALLEL_PREFIX);
  });

  it("names every phase as a root script", () => {
    for (const phase of [...verifyPhases(), ...ciPhases()]) expect({ phase, defined: phase in scripts }).toEqual({ phase, defined: true });
  });

  it("covers the same phases, apart from CI's variants and CI-only phases", () => {
    const local = verifyPhases().map((phase) => CI_VARIANT[phase] ?? phase);
    const ci = ciPhases().filter((phase) => !CI_ONLY.includes(phase));

    expect([...local].sort()).toEqual([...ci].sort());
  });
});
