import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Source scan for the ancestor-transform pitfall (CLAUDE.md): `Sheet`'s content div carries an
 * always-on `transform`, and on phone (or any un-hosted mount) `Surface` IS `Sheet` — so an
 * amount pad whose `AmountPadHost` renders as a DESCENDANT of a Surface/Sheet body gets its
 * `position:fixed` backdrop+numpad sized against that small sheet instead of the viewport. The
 * shipped shape (ReconcileSheet.tsx, Accounts.tsx "Starting balance") hoists the pad target into
 * the caller's state (`AmountField`'s `externalPad`) and renders `AmountPadHost` as a SIBLING of
 * the Surface. This scan makes the class un-regressable for the greppable case (the pad field and
 * its Surface in ONE file — the shape of both incidents this branch fixed): an `<AmountField>`
 * lexically inside a `<Surface>`/`<Sheet>` body must pass `externalPad`, and a raw
 * `<AmountPadHost>` must never sit inside one. Cross-file composition (a Surface body importing a
 * component that nests its own pad) is out of lexical reach — `AmountField`'s docblock carries
 * the rule for that case.
 */

const SRC_ROOT = join(import.meta.dir, "..");
const CONTAINERS = ["Surface", "Sheet"] as const;

/** Blank out comments (preserving offsets/newlines) so a `<Surface>` mention in prose never
 *  counts as a tag — the ReconcileSheet docblock alone would otherwise poison the depth count. */
function stripComments(src: string): string {
  return (
    src
      // `/*` directly before a quote is a glob inside a string (`accept="image/*"`), not a comment:
      // treating it as one blanked everything up to the next real `*/`, closers included.
      .replace(/\/\*(?!["'`])[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:"'])\/\/[^\n]*/gm, (m, prefix: string) => prefix + " ".repeat(m.length - prefix.length))
  );
}

function tsxFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".tsx") && !f.includes(".test.")).map((f) => f.split(sep).join("/"));
}

/** Lexical nesting depth of `index` inside `<name>…</name>` regions of `src`. Surface/Sheet
 *  always take children (never self-close), so opening tags and closers pair up 1:1. */
function depthAt(src: string, name: string, index: number): number {
  let depth = 0;
  for (const m of src.matchAll(new RegExp(`<${name}[\\s>]`, "g"))) if (m.index! < index) depth += 1;
  for (const m of src.matchAll(new RegExp(`</${name}>`, "g"))) if (m.index! < index) depth -= 1;
  return depth;
}

function scan() {
  const violations: string[] = [];
  const hoistedCallSites: string[] = [];
  for (const rel of tsxFiles(SRC_ROOT)) {
    const src = stripComments(readFileSync(join(SRC_ROOT, rel), "utf8"));
    for (const m of src.matchAll(/<(AmountPadHost|AmountField)[\s/>]/g)) {
      const container = CONTAINERS.find((name) => depthAt(src, name, m.index!) > 0);
      if (!container) continue;
      const line = src.slice(0, m.index!).split("\n").length;
      const at = `${rel}:${line}`;
      if (m[1] === "AmountPadHost") {
        violations.push(`${at}: <AmountPadHost> inside a <${container}> body — render it as a SIBLING of the ${container}`);
        continue;
      }
      // The self-closing tag's own text (up to its `/>`) must opt out of the internal pad.
      const tagEnd = src.indexOf("/>", m.index!);
      const tag = src.slice(m.index!, tagEnd === -1 ? undefined : tagEnd + 2);
      if (tag.includes("externalPad")) hoistedCallSites.push(rel);
      else violations.push(`${at}: <AmountField> inside a <${container}> body without externalPad — hoist the pad (see AmountField's docblock)`);
    }
  }
  return { violations, hoistedCallSites };
}

describe("amount pads under a Surface/Sheet body", () => {
  it("never nest their AmountPadHost inside the always-transformed sheet content", () => {
    // when: every shipped .tsx source is scanned for pads lexically inside a Surface/Sheet body
    const { violations } = scan();

    // then: none nests a pad without hoisting it out (the ancestor-transform pitfall)
    expect(violations).toEqual([]);
  });

  it("still sees the two reference call sites, so the scan cannot silently rot", () => {
    // given: the two hoisted-pad shapes this rule was written from
    const { hoistedCallSites } = scan();

    // then: the scanner actually finds both (a matcher regression would report neither)
    expect(hoistedCallSites).toContain("components/ReconcileSheet.tsx");
    expect(hoistedCallSites).toContain("screens/Accounts.tsx");
  });
});
