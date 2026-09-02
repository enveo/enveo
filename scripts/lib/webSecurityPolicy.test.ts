import { describe, expect, it } from "bun:test";
import { checkWebSecuritySource } from "./webSecurityPolicy";

describe("checkWebSecuritySource", () => {
  it("reports each prohibited browser execution sink at its source line", () => {
    const fixtures = [
      ["React.tsx", "<div dangerouslySetInnerHTML={{ __html: value }} />", "react-html"],
      ["Dom.ts", "node.innerHTML = value", "dom-html"],
      ["Outer.ts", "node.outerHTML = value", "dom-html"],
      ["Adjacent.ts", 'node.insertAdjacentHTML("beforeend", value)', "dom-html"],
      ["Document.ts", "document.write(value)\ndocument.writeln(value)", "document-write"],
      ["Eval.ts", "eval(value)", "eval"],
      ["Function.ts", 'new Function("return value")', "function-constructor"],
    ] as const;

    for (const [file, source, rule] of fixtures) {
      const violations = checkWebSecuritySource(file, source);
      expect(violations.length).toBe(source.split("\n").length);
      expect(violations[0]).toMatchObject({ file, line: 1, rule });
    }
  });

  it("reports computed, compound, parenthesized, global, and JSX-spread sink forms", () => {
    const fixtures = [
      ["ComputedAssignment.ts", 'node["innerHTML"] = value', "dom-html"],
      ["CompoundAssignment.ts", "node.innerHTML += value", "dom-html"],
      ["ComputedCall.ts", 'node["insertAdjacentHTML"]("beforeend", value)', "dom-html"],
      ["ComputedDocument.ts", 'document["write"](value)', "document-write"],
      ["WindowDocument.ts", "window.document.write(value)", "document-write"],
      ["GlobalEval.ts", "globalThis.eval(value)", "eval"],
      ["ParenthesizedFunction.ts", 'new (Function)("return value")', "function-constructor"],
      ["Spread.tsx", "<div {...{ dangerouslySetInnerHTML: { __html: value } }} />", "react-html"],
    ] as const;

    for (const [file, source, rule] of fixtures) {
      expect(checkWebSecuritySource(file, source)).toEqual([expect.objectContaining({ file, line: 1, rule })]);
    }
  });

  it("reports global and computed forms of the Function constructor and JSX HTML spread", () => {
    const fixtures = [
      ["GlobalFunction.ts", 'globalThis.Function("return value")', "function-constructor"],
      ["NewGlobalFunction.ts", 'new globalThis.Function("return value")', "function-constructor"],
      ["NewComputedGlobalFunction.ts", 'new globalThis["Function"]("return value")', "function-constructor"],
      ["ComputedSpread.tsx", '<div {...{ ["dangerouslySetInnerHTML"]: { __html: value } }} />', "react-html"],
    ] as const;

    for (const [file, source, rule] of fixtures) {
      expect(checkWebSecuritySource(file, source)).toEqual([expect.objectContaining({ file, line: 1, rule })]);
    }
  });

  it("ignores comments, ordinary strings, text content, React children, and JSON html fields", () => {
    expect(checkWebSecuritySource("Comment.ts", "// never use dangerouslySetInnerHTML here")).toEqual([]);
    expect(checkWebSecuritySource("String.ts", 'const note = "document.write and eval are forbidden"')).toEqual([]);
    expect(checkWebSecuritySource("Text.ts", "node.textContent = value")).toEqual([]);
    expect(checkWebSecuritySource("React.tsx", "<div>{value}</div>")).toEqual([]);
    expect(checkWebSecuritySource("Data.ts", 'const payload = { html: "<strong>safe data</strong>" }')).toEqual([]);
  });

  it("keeps the exact file and one-based line number", () => {
    expect(checkWebSecuritySource("Bad.tsx", "const ok = true;\n<div dangerouslySetInnerHTML={{ __html: value }} />")).toEqual([
      expect.objectContaining({ file: "Bad.tsx", line: 2, rule: "react-html" }),
    ]);
  });
});
